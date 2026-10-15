/* =====================================================================
   GET /api/account?role=member&transaction_id=...
   ---------------------------------------------------------------------
   Alur:
   1) Cek idempotency  → kalau tx_id ini sudah pernah diambil, balikin sama
   2) Verifikasi ke provider bahwa transaksi benar-benar Success
   3) Reserve slot berikutnya via Lua script ATOMIC (Upstash Redis)
   4) Ambil akun dari file {role}.txt index = slot
   5) Simpan mapping tx → akun (TTL 30 hari)
   6) Kirim notif Telegram ke owner
   ---------------------------------------------------------------------
   Author : Fortech Executor
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

/* ---------- Mapping file & label ---------- */
const ROLE_FILE = {
  member:   'member.txt',
  reseller: 'reseller.txt',
  owner:    'owner.txt',
};

const ROLE_LABEL = {
  member:   'Member',
  reseller: 'Reseller',
  owner:    'Owner',
};

/* ---------- Lua Script: reserve slot berikutnya (ATOMIC) ---------- */
/* Return nomor slot (1-indexed) kalau berhasil, -1 kalau stok habis. */
const RESERVE_SCRIPT = `
local counter = redis.call('INCR', KEYS[1])
if counter > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return -1
end
return counter
`;

/* =====================================================================
   HELPER — parsing & reading
   ===================================================================== */

function parseAccountLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;

  // Dukung pemisah: "|", ":", ";" atau TAB
  let sep = null;
  for (const s of ['|', ':', ';', '\t']) {
    if (raw.includes(s)) { sep = s; break; }
  }
  if (!sep) return { username: raw, password: '' };

  const idx = raw.indexOf(sep);
  const username = raw.slice(0, idx).trim();
  const password = raw.slice(idx + 1).trim();
  if (!username) return null;
  return { username, password };
}

function readAccountList(file) {
  const candidates = [
    path.join(process.cwd(), 'api', file),
    path.join(process.cwd(), file),
    path.join(__dirname, file),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8');
        return content
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
      }
    } catch (_) { /* coba path berikutnya */ }
  }
  throw new Error(`File ${file} tidak ditemukan`);
}

function safeJsonParse(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/* =====================================================================
   HELPER — formatting & Telegram
   ===================================================================== */

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
  }[c]));
}

function rupiah(n) {
  const num = Number(n) || 0;
  return 'Rp ' + num.toLocaleString('id-ID');
}

function formatWIB(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).replace(/\./g, ':') + ' WIB';
  } catch {
    return new Date().toISOString();
  }
}

async function sendTelegram(account, extra = {}) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8732880108';

  if (!TOKEN) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN belum diset, skip notif');
    return { ok: false, reason: 'no_token' };
  }

  const roleLabel = ROLE_LABEL[account.role] || account.role;

  const lines = [
    '🎉 <b>PEMBELIAN BARU</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `🎭 <b>Role</b>     : ${escHtml(roleLabel)}`,
    `👤 <b>Username</b> : <code>${escHtml(account.username)}</code>`,
    `🔑 <b>Password</b> : <code>${escHtml(account.password)}</code>`,
    `🔢 <b>Slot</b>     : #${escHtml(account.slot)}`,
  ];

  if (extra.total_amount != null) {
    lines.push(`💰 <b>Total</b>    : ${escHtml(rupiah(extra.total_amount))}`);
  }
  if (extra.unique_code != null && extra.unique_code !== 0) {
    lines.push(`✨ <b>Kode Unik</b>: +${escHtml(extra.unique_code)}`);
  }

  lines.push(`🆔 <b>TX ID</b>    : <code>${escHtml(account.transaction_id)}</code>`);
  lines.push(`🕐 <b>Waktu</b>    : ${escHtml(formatWIB(account.paid_at))}`);
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('✅ Akun otomatis terkirim ke pembeli');

  const text = lines.join('\n');

  try {
    const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
      console.error('[telegram] kirim gagal:', data);
      return { ok: false, reason: data.description || `HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('[telegram] error:', err.message);
    return { ok: false, reason: err.message };
  }
}

/* =====================================================================
   HANDLER
   ===================================================================== */

module.exports = async (req, res) => {
  /* ---------- HEADERS ---------- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const role = String(req.query.role || '').toLowerCase();
    const transactionId = String(req.query.transaction_id || '').trim();

    /* ---------- VALIDASI ---------- */
    if (!ROLE_FILE[role]) {
      return res.status(400).json({ success: false, message: 'Role tidak valid' });
    }
    if (!transactionId) {
      return res.status(400).json({ success: false, message: 'transaction_id wajib' });
    }

    /* ============ STEP 1: IDEMPOTENCY ============ */
    const txKey = `belibadak:tx:${transactionId}`;
    const cachedRaw = await redis.get(txKey);
    const cached = safeJsonParse(cachedRaw);

    if (cached && cached.username) {
      /* Sudah pernah dialokasikan → balikin yang sama, TIDAK kirim notif lagi */
      return res.status(200).json({
        success: true,
        data: cached,
        cached: true,
      });
    }

    /* ============ STEP 2: VERIFIKASI PEMBAYARAN ============ */
    const API_KEY = process.env.QRIS_API_KEY;
    const BASE_URL = process.env.QRIS_BASE_URL || 'http://localhost:9002';

    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        message: 'QRIS_API_KEY belum dikonfigurasi',
      });
    }

    let upstream;
    try {
      upstream = await fetch(`${BASE_URL}/api/qris/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': API_KEY,
        },
        body: JSON.stringify({ transaction_id: transactionId }),
      });
    } catch (fetchErr) {
      console.error('[account] fetch ke provider gagal:', fetchErr.message);
      return res.status(502).json({
        success: false,
        message: 'Tidak dapat terhubung ke provider QRIS',
      });
    }

    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); }
    catch { json = { success: false }; }

    const status = json && json.data && json.data.status;
    if (!upstream.ok || !status || String(status).toLowerCase() !== 'success') {
      return res.status(402).json({
        success: false,
        message: 'Transaksi belum terkonfirmasi',
      });
    }

    /* ============ STEP 3: BACA STOK ============ */
    const file = ROLE_FILE[role];
    let list;
    try {
      list = readAccountList(file);
    } catch (fileErr) {
      console.error('[account] file stok error:', fileErr.message);
      return res.status(500).json({
        success: false,
        message: `Stok akun ${role} belum tersedia`,
      });
    }

    if (!list.length) {
      return res.status(409).json({
        success: false,
        message: `Stok akun ${role} habis`,
      });
    }

    /* ============ STEP 4: RESERVE SLOT (ATOMIC) ============ */
    const counterKey = `belibadak:counter:${role}`;
    let slot;
    try {
      slot = await redis.eval(RESERVE_SCRIPT, [counterKey], [String(list.length)]);
    } catch (redisErr) {
      console.error('[account] redis error:', redisErr.message);
      return res.status(500).json({
        success: false,
        message: 'Gagal mengalokasikan akun',
      });
    }

    if (slot === -1 || slot === null || slot === undefined) {
      return res.status(409).json({
        success: false,
        message: `Stok akun ${role} habis`,
      });
    }

    /* ============ STEP 5: AMBIL AKUN ============ */
    const idx = Number(slot) - 1;
    const parsed = parseAccountLine(list[idx]);
    if (!parsed) {
      return res.status(500).json({
        success: false,
        message: 'Format akun tidak valid',
      });
    }

    const accountData = {
      role,
      username: parsed.username,
      password: parsed.password,
      transaction_id: transactionId,
      slot: Number(slot),
      paid_at: (json.data && json.data.paid_at) || null,
      total_amount: (json.data && json.data.total_amount) || null,
      unique_code:  (json.data && json.data.unique_code) || 0,
    };

    /* ============ STEP 6: SIMPAN MAPPING (IDEMPOTENT, TTL 30 HARI) ============ */
    try {
      await redis.set(txKey, JSON.stringify(accountData), { ex: 60 * 60 * 24 * 30 });
    } catch (e) {
      console.warn('[account] gagal simpan mapping:', e.message);
      /* bukan fatal — akun tetap dikirim ke user */
    }

    /* ============ STEP 7: KIRIM NOTIF TELEGRAM ============ */
    /* Fire & forget — jangan sampai gagal notif bikin user gak dapet akun */
    try {
      const tg = await sendTelegram(accountData, {
        total_amount: accountData.total_amount,
        unique_code:  accountData.unique_code,
      });
      if (!tg.ok) console.warn('[account] telegram notif gagal:', tg.reason);
    } catch (e) {
      console.warn('[account] telegram error:', e.message);
    }

    /* ============ RESPON KE CLIENT ============ */
    return res.status(200).json({
      success: true,
      data: accountData,
    });

  } catch (err) {
    console.error('[account] unexpected error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Gagal mengambil akun',
    });
  }
};