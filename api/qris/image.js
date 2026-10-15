/* =====================================================================
   GET /api/qris/image?tid=...&mid=...
   ---------------------------------------------------------------------
   Proxy render gambar QRIS dari provider.
   Tujuan: client gak perlu tau BASE_URL provider & API key tetep aman.
   ---------------------------------------------------------------------
   Author : Fortech Executor
   ===================================================================== */

module.exports = async (req, res) => {
  /* ---------- CACHE & HEADERS ---------- */
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  /* ---------- METHOD GUARD ---------- */
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed',
    });
  }

  try {
    /* ---------- AMBIL QUERY PARAMS ---------- */
    const { tid, mid } = req.query || {};

    if (!tid || !mid) {
      return res.status(400).json({
        success: false,
        message: 'Parameter tid & mid wajib diisi',
      });
    }

    /* ---------- VALIDASI FORMAT ---------- */
    const tidStr = String(tid).trim();
    const midStr = String(mid).trim();

    if (!tidStr || !midStr) {
      return res.status(400).json({
        success: false,
        message: 'Parameter tid & mid tidak boleh kosong',
      });
    }

    /* ---------- ENV CHECK ---------- */
    const BASE_URL = process.env.QRIS_BASE_URL || 'http://localhost:9002';

    /* ---------- BUILD URL PROVIDER ---------- */
    const url = `${BASE_URL}/api/qris/image?tid=${encodeURIComponent(tidStr)}&mid=${encodeURIComponent(midStr)}`;

    /* ---------- FETCH KE PROVIDER ---------- */
    let upstream;
    try {
      upstream = await fetch(url);
    } catch (fetchErr) {
      console.error('[image] fetch ke provider gagal:', fetchErr.message);
      return res.status(502).json({
        success: false,
        message: 'Tidak dapat terhubung ke provider QRIS',
      });
    }

    /* ---------- HANDLE ERROR PROVIDER ---------- */
    if (!upstream.ok) {
      console.error('[image] provider error:', upstream.status);
      return res.status(upstream.status).json({
        success: false,
        message: `Gagal memuat gambar QR (${upstream.status})`,
      });
    }

    /* ---------- AMBIL BUFFER GAMBAR ---------- */
    const contentType = upstream.headers.get('content-type') || 'image/png';

    /* ---------- VALIDASI CONTENT TYPE ---------- */
    if (!contentType.startsWith('image/')) {
      console.error('[image] content-type tidak valid:', contentType);
      return res.status(502).json({
        success: false,
        message: 'Provider tidak mengembalikan gambar',
      });
    }

    const arrayBuf = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    if (!buffer || buffer.length === 0) {
      return res.status(502).json({
        success: false,
        message: 'Gambar kosong dari provider',
      });
    }

    /* ---------- KIRIM KE CLIENT ---------- */
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    return res.status(200).send(buffer);

  } catch (err) {
    console.error('[image] unexpected error:', err);
    return res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan saat memuat gambar QR',
    });
  }
};