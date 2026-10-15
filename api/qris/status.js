/* =====================================================================
   POST /api/qris/status
   ---------------------------------------------------------------------
   Proxy cek status transaksi ke provider.
   Body: { transaction_id: '...' }
   ---------------------------------------------------------------------
   Author : Fortech Executor
   ===================================================================== */

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

    const transactionId = String(body.transaction_id || '').trim();

    /* ---------- VALIDASI ---------- */
    if (!transactionId) {
      return res.status(400).json({
        success: false,
        message: 'transaction_id wajib diisi',
      });
    }

    /* ---------- ENV CHECK ---------- */
    const API_KEY = process.env.QRIS_API_KEY;
    const BASE_URL = process.env.QRIS_BASE_URL || 'http://localhost:9002';

    if (!API_KEY) {
      console.error('[status] QRIS_API_KEY belum dikonfigurasi');
      return res.status(500).json({
        success: false,
        message: 'Server belum dikonfigurasi (QRIS_API_KEY kosong)',
      });
    }

    /* ---------- KIRIM KE PROVIDER ---------- */
    let upstream;
    try {
      upstream = await fetch(`${BASE_URL}/api/qris/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': API_KEY,
        },
        body: JSON.stringify({
          transaction_id: transactionId,
        }),
      });
    } catch (fetchErr) {
      console.error('[status] fetch ke provider gagal:', fetchErr.message);
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

    /* ---------- HANDLE 404 (transaksi belum ada / belum terdaftar) ---------- */
    /* Kalau provider balikin 404, kita anggap Pending, bukan error fatal. */
    if (upstream.status === 404) {
      return res.status(200).json({
        success: true,
        data: {
          transaction_id: transactionId,
          status: 'Pending',
        },
      });
    }

    /* ---------- HANDLE ERROR LAIN ---------- */
    if (!upstream.ok) {
      console.error('[status] provider error:', upstream.status, json.message);
      return res.status(upstream.status).json({
        success: false,
        message: json.message || 'Gagal cek status ke provider',
      });
    }

    /* ---------- VALIDASI RESPON ---------- */
    if (!json.data) {
      console.error('[status] respons provider tidak lengkap:', json);
      return res.status(502).json({
        success: false,
        message: 'Respons provider tidak lengkap',
      });
    }

    /* ---------- NORMALISASI STATUS ---------- */
    /* Pastikan field status ada & format konsisten */
    if (!json.data.status) {
      json.data.status = 'Pending';
    }

    /* ---------- KIRIM KE CLIENT ---------- */
    return res.status(200).json(json);

  } catch (err) {
    console.error('[status] unexpected error:', err);
    return res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan saat cek status',
    });
  }
};