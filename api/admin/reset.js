/* =====================================================================
   GET /api/admin/reset?role=member&key=ADMIN_SECRET
   ---------------------------------------------------------------------
   Reset counter stok role tertentu ke 0.
   Tanpa ?role= akan reset semua role (member, reseller, owner).
   ---------------------------------------------------------------------
   Author : Fortech Executor
   ===================================================================== */

const { Redis } = require('@upstash/redis');
const redis = Redis.fromEnv();

const VALID_ROLES = ['member', 'reseller', 'owner'];

module.exports = async (req, res) => {
  /* ---------- HEADERS ---------- */
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  /* ---------- METHOD GUARD ---------- */
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed',
    });
  }

  /* ---------- AUTH ---------- */
  const key = String(req.query.key || '');
  const ADMIN_SECRET = process.env.ADMIN_SECRET;

  if (!ADMIN_SECRET) {
    console.error('[admin/reset] ADMIN_SECRET belum dikonfigurasi');
    return res.status(500).json({
      success: false,
      message: 'ADMIN_SECRET belum dikonfigurasi di server',
    });
  }

  if (key !== ADMIN_SECRET) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden — kunci admin salah',
    });
  }

  /* ---------- VALIDASI ROLE ---------- */
  const role = String(req.query.role || '').toLowerCase().trim();

  if (role && !VALID_ROLES.includes(role)) {
    return res.status(400).json({
      success: false,
      message: `Role tidak valid. Pilih: ${VALID_ROLES.join(', ')}`,
    });
  }

  /* ---------- EKSEKUSI RESET ---------- */
  try {
    const targets = role ? [role] : VALID_ROLES;
    const result = {};

    for (const r of targets) {
      const counterKey = `belibadak:counter:${r}`;
      const deleted = await redis.del(counterKey);
      result[r] = deleted > 0 ? 'reset' : 'already_empty';
    }

    return res.status(200).json({
      success: true,
      message: role
        ? `Counter role "${role}" berhasil di-reset`
        : 'Semua counter berhasil di-reset',
      data: result,
      reset_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[admin/reset] error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Gagal reset counter',
    });
  }
};