/* =====================================================================
   Belibadak — Premium Access Store
   Frontend Logic · Vanilla JS
   Author : Fortech Executor
   ===================================================================== */

(() => {
  'use strict';

  /* ============ KONFIG ============ */
  const CONFIG = {
    POLL_INTERVAL: 5000,            // 5 detik
    POLL_TIMEOUT: 15 * 60 * 1000,   // 15 menit
    APK_URL: 'https://cloudwaves.my.id/R1kNjxEX.apk',
    AUTO_DOWNLOAD_DELAY: 8,         // detik sebelum auto buka APK
    STORAGE_KEY: 'belibadak.lastRole',
  };

  const ROLES = {
    member:   { label: 'Member',   price: 3000 },
    reseller: { label: 'Reseller', price: 4000 },
    owner:    { label: 'Owner',    price: 5000 },
  };

  /* ============ STATE ============ */
  const state = {
    role: null,
    price: 0,
    transactionId: null,
    totalAmount: 0,
    uniqueCode: 0,
    baseAmount: 0,
    qrUrl: null,
    expiryAt: null,
    pollTimer: null,
    countdownTimer: null,
    autoDownloadTimer: null,
    autoDownloadCancelled: false,
    paid: false,
    lastAccount: null,
  };

  /* ============ DOM HELPERS ============ */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const el = {
    sections: {
      role:    $('#section-role'),
      payment: $('#section-payment'),
      success: $('#section-success'),
    },
    roleCards:     $$('.role-card'),
    btnBackRole:   $('#btn-back-role'),
    btnRefresh:    $('#btn-refresh'),
    btnDownloadQR: $('#btn-download-qr'),
    btnDownloadApp:$('#btn-download-app'),
    btnCancelAuto: $('#btn-cancel-auto'),
    btnRestart:    $('#btn-restart'),
    orderRole:     $('#order-role'),
    orderId:       $('#order-id'),
    orderBase:     $('#order-base'),
    orderUnique:   $('#order-unique'),
    orderTotal:    $('#order-total'),
    qrImage:       $('#qr-image'),
    qrSkeleton:    $('#qr-skeleton'),
    qrTimer:       $('#qr-timer'),
    timerText:     $('#timer-text'),
    statusPill:    $('#status-pill'),
    statusText:    $('#status-text'),
    accRole:       $('#acc-role'),
    accUsername:   $('#acc-username'),
    accPassword:   $('#acc-password'),
    autoCount:     $('#auto-count'),
    toast:         $('#toast-container'),
    loader:        $('#global-loader'),
    loaderText:    $('#loader-text'),
    year:          $('#year'),
  };

  /* ============ ICON REFRESH ============ */
  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  /* ============ TOAST ============ */
  function toast(message, type = 'info', duration = 3200) {
    const icons = {
      success: 'check-circle-2',
      error:   'alert-circle',
      info:    'info',
    };

    const node = document.createElement('div');
    node.className = `toast toast--${type}`;
    node.innerHTML = `
      <i data-lucide="${icons[type] || 'info'}"></i>
      <span>${escapeHtml(message)}</span>
    `;
    el.toast.appendChild(node);
    refreshIcons();

    setTimeout(() => {
      node.classList.add('hide');
      setTimeout(() => node.remove(), 320);
    }, duration);
  }

  /* ============ LOADER ============ */
  function showLoader(text = 'Memproses...') {
    el.loaderText.textContent = text;
    el.loader.hidden = false;
  }
  function hideLoader() {
    el.loader.hidden = true;
  }

  /* ============ HELPERS ============ */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function formatRupiah(n) {
    const num = Number(n) || 0;
    return 'Rp ' + num.toLocaleString('id-ID');
  }

  function formatMMSS(ms) {
    if (ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function showSection(name) {
    Object.values(el.sections).forEach((s) => s.classList.remove('is-active'));
    if (el.sections[name]) {
      el.sections[name].classList.add('is-active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    refreshIcons();
  }

  /* ============ API WRAPPER ============ */
  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Respons tidak valid (${res.status})`);
    }

    if (!res.ok || data.success === false) {
      throw new Error(data.message || data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  /* ============ STEP 1: PILIH ROLE ============ */
  function bindRoleSelection() {
    el.roleCards.forEach((card) => {
      card.addEventListener('click', () => {
        const role = card.dataset.role;
        const price = Number(card.dataset.price);
        if (!ROLES[role]) return;

        state.role = role;
        state.price = price;

        try { localStorage.setItem(CONFIG.STORAGE_KEY, role); } catch {}

        startPaymentFlow(role, price);
      });
    });
  }

  /* ============ STEP 2: MULAI PEMBAYARAN ============ */
  async function startPaymentFlow(role, price) {
    resetPaymentState();
    showSection('payment');

    el.orderRole.textContent   = ROLES[role].label;
    el.orderId.textContent     = '-';
    el.orderBase.textContent   = formatRupiah(price);
    el.orderUnique.textContent = '-';
    el.orderTotal.textContent  = formatRupiah(price);

    setStatus('pending', 'Membuat QRIS...');
    showQrSkeleton(true);
    el.btnDownloadQR.disabled = true;

    showLoader('Membuat QRIS...');
    try {
      const result = await api('/api/qris/create', {
        method: 'POST',
        body: JSON.stringify({ role }),
      });

      const d = result.data || {};
      state.transactionId = d.transaction_id || d.external_id;
      state.baseAmount    = d.base_amount    || price;
      state.uniqueCode    = d.unique_code    || 0;
      state.totalAmount   = d.total_amount   || price;
      state.expiryAt      = d.expiry_at ? new Date(d.expiry_at).getTime() : (Date.now() + 15 * 60 * 1000);

      el.orderId.textContent     = state.transactionId || '-';
      el.orderBase.textContent   = formatRupiah(state.baseAmount);
      el.orderUnique.textContent = state.uniqueCode ? `+${state.uniqueCode}` : '-';
      el.orderTotal.textContent  = formatRupiah(state.totalAmount);

      const qrImageUrl = buildQrImageUrl(state.transactionId, d.qr_url);
      state.qrUrl = qrImageUrl;

      await loadQrImage(qrImageUrl);

      hideLoader();
      setStatus('pending', 'Menunggu pembayaran...');
      startCountdown();
      startPolling();
    } catch (err) {
      hideLoader();
      showQrSkeleton(false);
      setStatus('error', 'Gagal membuat QRIS');
      toast(err.message || 'Gagal membuat transaksi', 'error', 4200);
    }
  }

  function buildQrImageUrl(tid, rawQrUrl) {
    let mid = '';
    if (rawQrUrl) {
      try {
        const u = new URL(rawQrUrl, window.location.origin);
        mid = u.searchParams.get('mid') || '';
      } catch {}
    }
    if (!mid) mid = 'MERCHANT_UID';
    return `/api/qris/image?tid=${encodeURIComponent(tid)}&mid=${encodeURIComponent(mid)}`;
  }

  function loadQrImage(url) {
    return new Promise((resolve, reject) => {
      const img = el.qrImage;
      img.onload = () => {
        showQrSkeleton(false);
        img.hidden = false;
        el.btnDownloadQR.disabled = false;
        resolve();
      };
      img.onerror = () => {
        showQrSkeleton(false);
        reject(new Error('Gagal memuat gambar QR'));
      };
      img.src = url;
    });
  }

  function showQrSkeleton(show) {
    el.qrSkeleton.style.display = show ? 'grid' : 'none';
    if (show) el.qrImage.hidden = true;
  }

  /* ============ COUNTDOWN ============ */
  function startCountdown() {
    stopCountdown();
    tickCountdown();
    state.countdownTimer = setInterval(tickCountdown, 1000);
  }

  function tickCountdown() {
    const remaining = (state.expiryAt || 0) - Date.now();
    el.timerText.textContent = formatMMSS(remaining);
    el.qrTimer.classList.remove('is-warning', 'is-danger');

    if (remaining <= 0) {
      stopCountdown();
      stopPolling();
      setStatus('error', 'QRIS kadaluarsa');
      toast('QRIS kadaluarsa, silakan buat ulang', 'error', 4200);
      return;
    }
    if (remaining < 60 * 1000)          el.qrTimer.classList.add('is-danger');
    else if (remaining < 5 * 60 * 1000) el.qrTimer.classList.add('is-warning');
  }

  function stopCountdown() {
    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
  }

  /* ============ POLLING ============ */
  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(pollStatus, CONFIG.POLL_INTERVAL);
    pollStatus(); // langsung cek sekali
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function pollStatus() {
    if (state.paid || !state.transactionId) return;

    // stop kalau udah lewat expiry
    if (state.expiryAt && Date.now() > state.expiryAt) {
      stopPolling();
      return;
    }

    try {
      const result = await api('/api/qris/status', {
        method: 'POST',
        body: JSON.stringify({ transaction_id: state.transactionId }),
      });

      const status = (result.data && result.data.status) || '';
      if (status.toLowerCase() === 'success') {
        onPaid(result.data || {});
      } else {
        setStatus('pending', 'Menunggu pembayaran...');
      }
    } catch (err) {
      // jangan spam toast untuk error polling biasa
      console.warn('[poll]', err.message);
    }
  }

  /* ============ SAAT SUDAH DIBAYAR ============ */
  async function onPaid(data) {
    if (state.paid) return;
    state.paid = true;

    stopPolling();
    stopCountdown();
    setStatus('success', 'Pembayaran terkonfirmasi');

    showLoader('Menyiapkan akun...');
    try {
      const acc = await api(`/api/account?role=${encodeURIComponent(state.role)}&transaction_id=${encodeURIComponent(state.transactionId)}`);
      const payload = acc.data || {};
      hideLoader();

      state.lastAccount = payload;

      el.accRole.textContent     = ROLES[state.role]?.label || '-';
      el.accUsername.value       = payload.username || '-';
      el.accPassword.value       = payload.password || '-';
      el.accPassword.type        = 'password';

      // Reset ikon eye ke default
      $$('.eye-btn').forEach((b) => {
        b.innerHTML = '<i data-lucide="eye"></i>';
      });

      showSection('success');
      toast('Pembayaran berhasil!', 'success', 3600);
      startAutoDownload();
    } catch (err) {
      hideLoader();
      toast(err.message || 'Gagal mengambil akun', 'error', 4200);
    }
  }

  /* ============ AUTO DOWNLOAD APK ============ */
  function startAutoDownload() {
    state.autoDownloadCancelled = false;
    let remain = CONFIG.AUTO_DOWNLOAD_DELAY;
    el.autoCount.textContent = remain;

    stopAutoDownload();
    state.autoDownloadTimer = setInterval(() => {
      remain -= 1;
      el.autoCount.textContent = remain;

      if (remain <= 0) {
        stopAutoDownload();
        if (!state.autoDownloadCancelled) triggerDownload();
      }
    }, 1000);
  }

  function stopAutoDownload() {
    if (state.autoDownloadTimer) {
      clearInterval(state.autoDownloadTimer);
      state.autoDownloadTimer = null;
    }
  }

  function triggerDownload() {
    try {
      const w = window.open(CONFIG.APK_URL, '_blank', 'noopener');
      if (!w) {
        // fallback kalau popup diblokir
        window.location.href = CONFIG.APK_URL;
      }
    } catch {
      window.location.href = CONFIG.APK_URL;
    }
  }

  /* ============ STATUS PILL ============ */
  function setStatus(kind, text) {
    el.statusPill.classList.remove('is-success', 'is-error');
    if (kind === 'success') el.statusPill.classList.add('is-success');
    if (kind === 'error')   el.statusPill.classList.add('is-error');
    el.statusText.textContent = text;
  }

  /* ============ RESET ============ */
  function resetPaymentState() {
    stopPolling();
    stopCountdown();
    stopAutoDownload();
    state.transactionId = null;
    state.totalAmount = 0;
    state.baseAmount = 0;
    state.uniqueCode = 0;
    state.qrUrl = null;
    state.expiryAt = null;
    state.paid = false;
    el.qrImage.hidden = true;
    el.qrImage.removeAttribute('src');
    showQrSkeleton(true);
  }

  function resetAll() {
    resetPaymentState();
    state.role = null;
    state.price = 0;
    state.lastAccount = null;
    el.orderRole.textContent   = '-';
    el.orderId.textContent     = '-';
    el.orderBase.textContent   = '-';
    el.orderUnique.textContent = '-';
    el.orderTotal.textContent  = '-';
    el.accUsername.value = '-';
    el.accPassword.value = '-';
    el.accPassword.type = 'password';
    showSection('role');
  }

  /* ============ BINDING ============ */
  function bindMisc() {
    el.btnBackRole?.addEventListener('click', () => {
      resetPaymentState();
      showSection('role');
    });

    el.btnRefresh?.addEventListener('click', async () => {
      if (!state.transactionId) return;
      setStatus('pending', 'Memeriksa status...');
      await pollStatus();
      toast('Status diperbarui', 'info', 1600);
    });

    el.btnDownloadQR?.addEventListener('click', async () => {
      if (!state.qrUrl) return;
      try {
        const res = await fetch(state.qrUrl);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `qris-${state.transactionId || 'belibadak'}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('QR berhasil diunduh', 'success', 2200);
      } catch {
        toast('Gagal mengunduh QR', 'error', 2600);
      }
    });

    el.btnDownloadApp?.addEventListener('click', () => {
      stopAutoDownload();
      triggerDownload();
    });

    el.btnCancelAuto?.addEventListener('click', () => {
      state.autoDownloadCancelled = true;
      stopAutoDownload();
      toast('Auto-download dibatalkan', 'info', 2000);
    });

    el.btnRestart?.addEventListener('click', () => {
      resetAll();
    });

    // Copy buttons
    $$('.copy-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const targetId = btn.dataset.copy;
        const input = document.getElementById(targetId);
        if (!input || !input.value || input.value === '-') {
          toast('Tidak ada data untuk disalin', 'error', 2200);
          return;
        }
        try {
          await navigator.clipboard.writeText(input.value);
          btn.classList.add('copied');
          const old = btn.innerHTML;
          btn.innerHTML = '<i data-lucide="check"></i>';
          refreshIcons();
          toast('Disalin ke clipboard', 'success', 1800);
          setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = old;
            refreshIcons();
          }, 1500);
        } catch {
          toast('Gagal menyalin', 'error', 2200);
        }
      });
    });

    // Eye toggle password
    $$('.eye-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.eye;
        const input = document.getElementById(targetId);
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.innerHTML = `<i data-lucide="${isPassword ? 'eye-off' : 'eye'}"></i>`;
        refreshIcons();
      });
    });

    // Handle visibility change — kalau user balik ke tab, langsung poll
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.transactionId && !state.paid) {
        pollStatus();
      }
    });

    // Handle page unload — bersihin timer
    window.addEventListener('beforeunload', () => {
      stopPolling();
      stopCountdown();
      stopAutoDownload();
    });
  }

  /* ============ INIT ============ */
  function init() {
    if (el.year) el.year.textContent = new Date().getFullYear();
    refreshIcons();
    bindRoleSelection();
    bindMisc();
    showSection('role');
  }

  document.addEventListener('DOMContentLoaded', init);
})();