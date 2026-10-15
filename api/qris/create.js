/* =====================================================================
   POST /api/qris/create
   ---------------------------------------------------------------------
   Proxy pembuatan QRIS ke provider (API key di server, tidak bocor).
   Body: { role: 'member' | 'reseller' | 'owner' }
   ---------------------------------------------------------------------
   Author : Fortech Executor
   ===================================================================== */

const ROLE_PRICE = {
  member:   3000,
  reseller: 4000,
  owner:    5000,
};

module.exports = async (req, res) => {
  /* ---------- CORS & CACHE ---------- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  /* ---------- METHOD GUARD ---------- */
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed',
    });
  }

  try {
    /* ---------- PARSE BODY ---------- */
    let body;
    if (typeof req.body === 'string') {
      try { body = JSON.parse(req.body); }
      catch { body = {}; }
    } else {
      body = req.body || {};
    }

    const role = String(body.role || '').toLowerCase().trim();

    /* ---------- VALIDASI ROLE ---------- */
    if (!ROLE_PRICE[role]) {
      return res.status(400).json({
        success: false,
        message: 'Role tidak valid. Pilih: member, reseller, atau owner.',
      });
    }

    /* ---------- ENV CHECK ---------- */
    const API_KEY = process.env.QRIS_API_KEY;
    const BASE_URL = process.env.QRIS_BASE_URL || 'http://localhost:9002';

    if (!API_KEY) {
      console.error('[create] QRIS_API_KEY belum dikonfigurasi');
      return res.status(500).json({
        success: false,
        message: 'Server belum dikonfigurasi (QRIS_API_KEY kosong)',
      });
    }

    /* ---------- GENERATE EXTERNAL ID UNIK ---------- */
    const ts = Date.now();
    const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
    const externalId = `BBD-${role.toUpperCase()}-${ts}-${rnd}`;

    const amount = ROLE_PRICE[role];

    /* ---------- KIRIM KE PROVIDER ---------- */
    let upstream;
    try {
      upstream = await fetch(`${BASE_URL}/api/qris/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': API_KEY,
        },
        body: JSON.stringify({
          amount,
          external_id: externalId,
        }),
      });
    } catch (fetchErr) {
      console.error('[create] fetch ke provider gagal:', fetchErr.message);
      return res.status(502).json({
        success: false,
        message: 'Tidak dapat terhubung ke provider QRIS',
      });
    }

    /* ---------- PARSE RESPON PROVIDER ---------- */
    const text = await upstream.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = {
        success: false,
        message: text || 'Respons provider tidak valid',
      };
    }

    /* ---------- HANDLE ERROR DARI PROVIDER ---------- */
    if (!upstream.ok || json.success === false) {
      console.error('[create] provider error:', upstream.status, json.message);
      return res.status(upstream.status || 502).json({
        success: false,
        message: json.message || 'Gagal membuat QRIS di provider',
      });
    }

    /* ---------- VALIDASI RESPON SUKSES ---------- */
    if (!json.data || !json.data.transaction_id) {
      console.error('[create] respons provider tidak lengkap:', json);
      return res.status(502).json({
        success: false,
        message: 'Respons provider tidak lengkap',
      });
    }

    /* ---------- TAMBAHKAN INFO ROLE ---------- */
    json.data.role = role;

    /* ---------- KIRIM KE CLIENT ---------- */
    return res.status(200).json(json);

  } catch (err) {
    console.error('[create] unexpected error:', err);
    return res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan saat membuat QRIS',
    });
  }
};