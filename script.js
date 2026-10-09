/* ═══════════════════════════════════════════════════
   SIPALARUS — SISTEM PASPOR HILANG DAN RUSAK
   KANTOR IMIGRASI KELAS I TPI TANJUNGPINANG
   Seksi Intelijen dan Penindakan Keimigrasian (Inteldakim)
   ROBUST JAVASCRIPT ENGINE (BUG-FREE & RESILIENT)
═══════════════════════════════════════════════════ */

/* ── CONFIGURATION ── */
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwllvyhNopLfSV7HObyfRin0E0TSK-CYTe1A0BteWcdGEvOzW4nVxifZGk-oDnLXruM/exec';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_SLOTS = 1; // 1 Petugas Pemeriksa (1 Pemohon per Sesi)
const SESSION_KEY = 'baper_session';
const DRAFT_KEY = 'bap_form_draft_v2';
const LOCAL_REGS_KEY = 'bap_local_records_v2';
const COMPRESS_MAX_W = 1280;
const COMPRESS_QUAL = 0.8;

const SLOT_DEFS = [
  { id: 'A', label: '08:00 – 10:00 WIB', title: 'Sesi Pagi I', start: 8, end: 10 },
  { id: 'B', label: '10:00 – 12:00 WIB', title: 'Sesi Pagi II', start: 10, end: 12 },
  { id: 'C', label: '13:30 – 15:00 WIB', title: 'Sesi Siang I', start: 13.5, end: 15 },
  { id: 'D', label: '15:30 – 17:00 WIB', title: 'Sesi Siang II', start: 15.5, end: 17 },
];

/* ── RUNTIME STATE ── */
let currentStep = 1;
let selectedSlot = null;
let registrationData = {};
let slotBookingCache = {};
let slotCacheFetched = {};
let holidayInfoCache = {}; // dateStr -> { is_holiday, holiday_name }
let disabledSlotsCache = {}; // dateStr -> ['A', ...]
let activeUploads = 0;
let rsSelectedSlot = null;
let currentRegData = null;

function getDayName(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  return days[d.getDay()] || '';
}

const uploadedFiles = {
  ktp: null,
  kk: null,
  akta: null,
  fotoPaspor: null,
  suratPolisi: null,
  suratKelurahan: null,
  suratPemerintah: null,
  pendukung: null
};

/* ═══════════════════════════════════════════════════
   TIMEZONE (WIB / UTC+7) & DATE UTILITIES (FIX BUG)
═══════════════════════════════════════════════════ */

/**
 * Returns a date object accurately represented in WIB (UTC+7)
 */
function getWIBNow() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 7));
}

/**
 * Returns 'YYYY-MM-DD' formatted strictly in WIB timezone
 */
function getWIBDateString(date = null) {
  const d = date ? new Date(date) : getWIBNow();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Calculates next available business day (Monday–Friday) in WIB
 */
function getNextBusinessDay(fromDate = null) {
  const d = fromDate ? new Date(fromDate) : getWIBNow();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * Format YYYY-MM-DD ke bahasa Indonesia (manual, tidak bergantung locale browser/perangkat)
 * Contoh: "Selasa, 6 Oktober 2026"
 */
const NAMA_HARI_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const NAMA_BULAN_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

function formatIndonesianDate(dateStr, withDay = true) {
  if (!dateStr) return '-';
  try {
    const m = String(dateStr).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return String(dateStr);
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, dd = parseInt(m[3], 10);
    const d = new Date(y, mo, dd, 12, 0, 0);
    const tgl = `${dd} ${NAMA_BULAN_ID[mo]} ${y}`;
    return withDay ? `${NAMA_HARI_ID[d.getDay()]}, ${tgl}` : tgl;
  } catch (e) {
    return String(dateStr);
  }
}

/* ═══════════════════════════════════════════════════
   SESSION & DRAFT STORAGE
═══════════════════════════════════════════════════ */
function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}
function setSession(user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}
function getUserToken() {
  const sess = getSession();
  return (sess && sess.token) ? String(sess.token).trim() : '';
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  try {
    localStorage.removeItem('bap_local_records_v2');
  } catch {}
}
function isLoggedIn() {
  return getSession() !== null;
}

/* Form Auto-save Draft */
function saveDraft() {
  try {
    const draft = {
      nama: document.getElementById('nama')?.value || '',
      tempatLahir: document.getElementById('tempatLahir')?.value || '',
      tanggalLahir: document.getElementById('tanggalLahir')?.value || '',
      jenisKelamin: document.getElementById('jenisKelamin')?.value || '',
      hp: document.getElementById('hp')?.value || '',
      jenisPermohonan: document.getElementById('jenisPermohonan')?.value || '',
      jenisPaspor: document.getElementById('jenisPaspor')?.value || '',
      tujuan: document.getElementById('tujuan')?.value || '',
      tanggal: document.getElementById('tanggal')?.value || '',
      selectedSlot: selectedSlot,
      uploadedFiles: uploadedFiles
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    const box = document.getElementById('draftIndicatorBox');
    if (box) box.style.display = 'flex';
  } catch (e) { }
}

function restoreDraftIfAvailable() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return false;
    const draft = JSON.parse(raw);
    if (!draft) return false;

    if (draft.nama && document.getElementById('nama')) document.getElementById('nama').value = draft.nama;
    if (draft.tempatLahir && document.getElementById('tempatLahir')) document.getElementById('tempatLahir').value = draft.tempatLahir;
    if (draft.tanggalLahir && document.getElementById('tanggalLahir')) document.getElementById('tanggalLahir').value = draft.tanggalLahir;
    if (draft.jenisKelamin && document.getElementById('jenisKelamin')) document.getElementById('jenisKelamin').value = draft.jenisKelamin;
    if (draft.hp && document.getElementById('hp')) document.getElementById('hp').value = draft.hp;
    if (draft.jenisPermohonan && document.getElementById('jenisPermohonan')) {
      document.getElementById('jenisPermohonan').value = draft.jenisPermohonan;
      onJenisPermohonanChange();
    }
    if (draft.jenisPaspor && document.getElementById('jenisPaspor')) document.getElementById('jenisPaspor').value = draft.jenisPaspor;
    if (draft.tujuan && document.getElementById('tujuan')) document.getElementById('tujuan').value = draft.tujuan;
    if (draft.tanggal && document.getElementById('tanggal')) {
      const todayStr = getWIBDateString(getWIBNow());
      if (draft.tanggal > todayStr) {
        document.getElementById('tanggal').value = draft.tanggal;
      } else {
        document.getElementById('tanggal').value = getWIBDateString(getNextBusinessDay());
      }
    }

    if (draft.uploadedFiles) {
      Object.keys(draft.uploadedFiles).forEach(k => {
        if (draft.uploadedFiles[k]) {
          uploadedFiles[k] = draft.uploadedFiles[k];
          renderFileBoxAsDone(k, draft.uploadedFiles[k]);
        }
      });
    }

    const box = document.getElementById('draftIndicatorBox');
    if (box) box.style.display = 'flex';
    return true;
  } catch (e) {
    return false;
  }
}

function clearDraftData() {
  localStorage.removeItem(DRAFT_KEY);
  const box = document.getElementById('draftIndicatorBox');
  if (box) box.style.display = 'none';
  showToast('info', 'Draf Dibersihkan', 'Isian draf lokal telah dihapus.');
}

/* ═══════════════════════════════════════════════════
   TOAST & MODAL DIALOGS
═══════════════════════════════════════════════════ */
function showToast(type, title, message, duration = 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const item = document.createElement('div');
  item.className = `toast-message-item ${type}`;

  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️'
  };

  item.innerHTML = `
    <div class="tmi-icon">${icons[type] || '🔔'}</div>
    <div class="tmi-content">
      <div class="tmi-title">${title}</div>
      <div class="tmi-msg">${message}</div>
    </div>
  `;

  container.appendChild(item);

  setTimeout(() => {
    item.classList.add('hide');
    setTimeout(() => item.remove(), 350);
  }, duration);
}

function showConfirmModal({ title, message, confirmText = 'Lanjutkan', cancelText = 'Batal', onConfirm }) {
  const modal = document.getElementById('customConfirmModal');
  document.getElementById('confirmDialogTitle').textContent = title;
  document.getElementById('confirmDialogMsg').textContent = message;

  const btnOk = document.getElementById('btnConfirmOk');
  const btnCancel = document.getElementById('btnConfirmCancel');

  btnOk.textContent = confirmText;
  btnCancel.textContent = cancelText;

  const closeFn = () => {
    modal.classList.remove('show');
    btnOk.onclick = null;
    btnCancel.onclick = null;
  };

  btnCancel.onclick = closeFn;
  btnOk.onclick = () => {
    closeFn();
    if (typeof onConfirm === 'function') onConfirm();
  };

  modal.classList.add('show');
}

function togglePasswordVisibility(fieldId, btn) {
  const inp = document.getElementById(fieldId);
  if (!inp) return;
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.textContent = '🙈';
  } else {
    inp.type = 'password';
    btn.textContent = '👁️';
  }
}

function copyRegCode() {
  const code = document.getElementById('regCode')?.textContent;
  if (code && navigator.clipboard) {
    navigator.clipboard.writeText(code).then(() => {
      showToast('success', 'Disalin!', `Nomor Registrasi ${code} tersimpan di clipboard.`);
    }).catch(() => {
      showToast('info', 'Nomor Registrasi', code);
    });
  }
}

let dashRefreshTimer = null;
function startDashboardAutoRefresh() {
  stopDashboardAutoRefresh();
  dashRefreshTimer = setInterval(() => {
    const p = document.getElementById('userDashboardPage');
    if (p && p.classList.contains('active') && !document.hidden) {
      loadUserRegistration(false);
    }
  }, 25000);
}
function stopDashboardAutoRefresh() {
  if (dashRefreshTimer) {
    clearInterval(dashRefreshTimer);
    dashRefreshTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    const p = document.getElementById('userDashboardPage');
    if (p && p.classList.contains('active')) {
      loadUserRegistration(false);
    }
  }
});

/* ═══════════════════════════════════════════════════
   PAGE NAVIGATION
═══════════════════════════════════════════════════ */
function hideAllPages() {
  stopDashboardAutoRefresh();
  ['landingPage', 'authPage', 'userDashboardPage', 'mainApp'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('active');
      el.style.display = 'none';
    }
  });
}

function showLanding() {
  hideAllPages();
  const p = document.getElementById('landingPage');
  p.classList.add('active');
  p.style.display = 'block';
  updateNavAndLandingUser();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showAuthPage(openRegister = false) {
  hideAllPages();
  const p = document.getElementById('authPage');
  p.classList.add('active');
  p.style.display = 'block';
  switchAuthTab(openRegister ? 'register' : 'login');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function switchAuthTab(mode) {
  const tabLogin = document.getElementById('tabBtnLogin');
  const tabReg = document.getElementById('tabBtnRegister');
  const panelLogin = document.getElementById('loginPanel');
  const panelReg = document.getElementById('registerPanel');
  const alertBox = document.getElementById('authGlobalAlert');

  if (alertBox) alertBox.style.display = 'none';

  if (mode === 'register') {
    tabLogin.classList.remove('active');
    tabReg.classList.add('active');
    panelLogin.style.display = 'none';
    panelReg.style.display = 'block';
  } else {
    tabReg.classList.remove('active');
    tabLogin.classList.add('active');
    panelReg.style.display = 'none';
    panelLogin.style.display = 'block';
  }
}

function showMainApp() {
  hideAllPages();
  const p = document.getElementById('mainApp');
  p.classList.add('active');
  p.style.display = 'block';

  const sess = getSession();
  if (sess) {
    if (document.getElementById('nama')) document.getElementById('nama').value = sess.nama || '';
    if (document.getElementById('jenisKelamin')) document.getElementById('jenisKelamin').value = sess.jenis_kelamin || '';
    if (document.getElementById('headerUserName')) document.getElementById('headerUserName').textContent = sess.nama ? sess.nama.split(' ')[0] : 'Pemohon';
  }

  initDateField();
  restoreDraftIfAvailable();
  goStep(1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function showUserDashboard() {
  hideAllPages();
  const p = document.getElementById('userDashboardPage');
  p.classList.add('active');
  p.style.display = 'block';

  const sess = getSession();
  if (sess) {
    if (document.getElementById('dashUserName')) document.getElementById('dashUserName').textContent = sess.nama || '—';
    if (document.getElementById('dashUserNik')) document.getElementById('dashUserNik').textContent = sess.nik || '—';
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
  startDashboardAutoRefresh();
  await loadUserRegistration();
}

function backToLanding() {
  if (currentStep > 1) {
    goStep(currentStep - 1);
    return;
  }
  showConfirmModal({
    title: 'Keluar Formulir SIPALARUS?',
    message: 'Isian formulir Anda tersimpan di draf lokal dan dapat dilanjutkan kapan saja.',
    confirmText: 'Keluar ke Beranda',
    onConfirm: () => showLanding()
  });
}

function goToRegistration() {
  showMainApp();
}

function goToDashboard() {
  document.getElementById('successOverlay')?.classList.remove('show');
  showUserDashboard();
}

function scrollToSection(sectionId) {
  const el = document.getElementById(sectionId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ═══════════════════════════════════════════════════
   AUTH & USER BAR
═══════════════════════════════════════════════════ */
function updateNavAndLandingUser() {
  const sess = getSession();
  const navGuest = document.getElementById('navGuestActions');
  const navUser = document.getElementById('navUserChip');
  const landingBar = document.getElementById('landingUserBar');
  const ctaText = document.getElementById('ctaTextLabel');

  if (sess) {
    if (navGuest) navGuest.style.display = 'none';
    if (navUser) {
      navUser.style.display = 'flex';
      document.getElementById('navUserName').textContent = sess.nama ? sess.nama.split(' ')[0] : 'Pemohon';
    }
    if (landingBar) {
      landingBar.style.display = 'flex';
      document.getElementById('landingUserName').textContent = sess.nama;
      document.getElementById('landingUserNik').textContent = `NIK: ${sess.nik}`;
    }
    if (ctaText) ctaText.textContent = 'Akses Layanan SIPALARUS';
  } else {
    if (navGuest) navGuest.style.display = 'flex';
    if (navUser) navUser.style.display = 'none';
    if (landingBar) landingBar.style.display = 'none';
    if (ctaText) ctaText.textContent = 'Mulai Pendaftaran SIPALARUS';
  }
}

async function onCtaClick() {
  if (!isLoggedIn()) {
    showAuthPage(false);
    return;
  }
  showLoading('Memeriksa Profil...', 'Mengambil status permohonan Anda...');
  try {
    const sess = getSession();
    const res = await queryUserRegistration(sess.nik);
    hideLoading();
    if (res && res.found) {
      showUserDashboard();
    } else {
      showMainApp();
    }
  } catch (e) {
    hideLoading();
    showMainApp();
  }
}

function doLogout() {
  showConfirmModal({
    title: 'Konfirmasi Keluar',
    message: 'Apakah Anda yakin ingin keluar dari akun SIPALARUS ini?',
    confirmText: 'Ya, Keluar',
    onConfirm: async () => {
      const token = getUserToken();
      if (token) {
        try {
          await postToServer({ action: 'userLogout', token: token });
        } catch (e) {
          // Best-effort remote revocation
        }
      }
      clearSession();
      currentRegData = null;
      updateNavAndLandingUser();
      showLanding();
      showToast('info', 'Sampai Jumpa', 'Anda telah berhasil keluar dari akun.');
    }
  });
}

/* ═══════════════════════════════════════════════════
   AUTH ACTIONS (LOGIN & REGISTER)
═══════════════════════════════════════════════════ */
function showAuthAlert(msg, type = 'error') {
  const el = document.getElementById('authGlobalAlert');
  const icon = document.getElementById('authAlertIcon');
  const text = document.getElementById('authAlertMsg');
  if (!el || !text) return;

  text.textContent = msg;
  icon.textContent = type === 'success' ? '✅' : '⚠️';
  el.className = `auth-alert-box ${type}`;
  el.style.display = 'flex';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function doLogin() {
  const nik = document.getElementById('loginNik').value.trim();
  const password = document.getElementById('loginPassword').value;

  let valid = true;
  const setErr = (id, cond) => {
    const el = document.getElementById('err-' + id);
    const inp = document.getElementById(id);
    if (!cond) {
      el.classList.add('show');
      inp.classList.add('is-invalid');
      valid = false;
    } else {
      el.classList.remove('show');
      inp.classList.remove('is-invalid');
    }
  };

  setErr('loginNik', nik.length === 16 && /^\d+$/.test(nik));
  setErr('loginPassword', password.length >= 1);
  if (!valid) return;

  const btn = document.getElementById('btnLogin');
  btn.disabled = true;
  showLoading('Memverifikasi Identitas...', 'Memeriksa NIK dan kata sandi...');

  try {
    const res = await postToServer({ action: 'login', nik, password });
    hideLoading();
    btn.disabled = false;

    if (!res.ok) {
      showAuthAlert(res.error || 'Login gagal. Periksa NIK dan kata sandi Anda.', 'error');
      return;
    }

    setSession({ ...res.user, token: res.token });
    updateNavAndLandingUser();
    showToast('success', 'Login Berhasil', `Selamat datang, ${res.user.nama}`);

    // Check if user already registered
    showLoading('Memuat Layanan...', 'Membuka portal SIPALARUS Anda...');
    const regCheck = await queryUserRegistration();
    hideLoading();

    if (regCheck && regCheck.found) {
      showUserDashboard();
    } else {
      showMainApp();
    }
  } catch (err) {
    hideLoading();
    btn.disabled = false;
    showAuthAlert('Tidak dapat terhubung ke server. Silakan coba lagi.', 'error');
  }
}

async function doRegister() {
  const nama = document.getElementById('regNama').value.trim();
  const nik = document.getElementById('regNik').value.trim();
  const tglLahir = document.getElementById('regTglLahir').value;
  const jk = document.getElementById('regJK').value;
  const password = document.getElementById('regPassword').value;

  let valid = true;
  const setErr = (id, cond) => {
    const el = document.getElementById('err-' + id);
    const inp = document.getElementById(id);
    if (!cond) {
      el.classList.add('show');
      inp.classList.add('is-invalid');
      valid = false;
    } else {
      el.classList.remove('show');
      inp.classList.remove('is-invalid');
    }
  };

  setErr('regNama', nama.length >= 3);
  setErr('regNik', nik.length === 16 && /^\d+$/.test(nik));
  setErr('regTglLahir', tglLahir !== '');
  setErr('regJK', jk !== '');
  setErr('regPassword', password.length >= 6);
  if (!valid) return;

  const btn = document.getElementById('btnRegister');
  btn.disabled = true;
  showLoading('Mendaftarkan Akun...', 'Menyimpan identitas NIK resmi...');

  try {
    const res = await postToServer({
      action: 'register',
      nama,
      nik,
      tanggal_lahir: tglLahir,
      jenis_kelamin: jk,
      password
    });
    hideLoading();
    btn.disabled = false;

    if (!res.ok) {
      showAuthAlert(res.error || 'Pendaftaran akun gagal.', 'error');
      return;
    }

    showAuthAlert('Pendaftaran akun berhasil! Silakan masuk dengan kata sandi Anda.', 'success');
    showToast('success', 'Akun Dibuat', 'Silakan masuk menggunakan akun baru Anda.');
    setTimeout(() => {
      switchAuthTab('login');
      document.getElementById('loginNik').value = nik;
    }, 1200);
  } catch (err) {
    hideLoading();
    btn.disabled = false;
    showAuthAlert('Tidak dapat terhubung ke server. Pendaftaran gagal.', 'error');
  }
}

/* ═══════════════════════════════════════════════════
   QUICK STATUS TRACKER (ON LANDING PAGE)
═══════════════════════════════════════════════════ */
async function doQuickTrack() {
  const query = document.getElementById('quickTrackInput').value.trim();
  const resBox = document.getElementById('quickTrackResult');
  if (!query) {
    showToast('warning', 'Input Kosong', 'Masukkan Nomor Registrasi (contoh: BAP-20261009-0001).');
    return;
  }

  resBox.style.display = 'block';
  resBox.innerHTML = `
    <div style="text-align:center;padding:16px;">
      <div class="dash-spinner"></div>
      <p style="font-size:13px;color:var(--text-secondary);">Mencari data permohonan ${query}...</p>
    </div>
  `;

  try {
    const res = await publicTrackRegistration(query);
    if (res && res.found) {
      const data = res.data;
      const tglFmt = formatIndonesianDate(data.tanggal);
      const statusBadge = getStatusBadgeHtml(data.status || 'Menunggu');

      resBox.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
          <div>
            <div style="font-size:11px;color:var(--gold-400);font-weight:700;letter-spacing:0.06em;">DATA DITEMUKAN</div>
            <div style="font-family:var(--font-display);font-size:18px;font-weight:800;color:white;">${data.no_registrasi || 'BAP-00000000-0000'}</div>
          </div>
          ${statusBadge}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:12px;padding:14px;background:rgba(255,255,255,0.04);border-radius:10px;">
          <div><span style="font-size:11px;color:var(--text-muted);display:block;">Nama Pemohon:</span><strong style="font-size:13px;color:white;">${data.nama || '-'}</strong></div>
          <div><span style="font-size:11px;color:var(--text-muted);display:block;">Status:</span><span style="font-size:12px;color:white;">${data.status || '-'}</span></div>
          <div><span style="font-size:11px;color:var(--text-muted);display:block;">Jadwal Pemeriksaan:</span><strong style="font-size:13px;color:var(--gold-400);">${tglFmt}, ${data.jam || '-'}</strong></div>
          <div><span style="font-size:11px;color:var(--text-muted);display:block;">Lokasi:</span><span style="font-size:12px;color:var(--text-secondary);">Kanim Kelas I TPI Tanjungpinang</span></div>
        </div>
        <div style="margin-top:14px;display:flex;justify-content:flex-end;">
          <button class="btn-cta-primary" style="padding:10px 18px;font-size:13px;" onclick="showAuthPage(false)">
            Masuk ke Akun untuk Rincian Lengkap &rarr;
          </button>
        </div>
      `;
    } else {
      resBox.innerHTML = `
        <div style="text-align:center;padding:14px;">
          <div style="font-size:26px;margin-bottom:6px;">⚠️</div>
          <strong style="color:white;font-size:14px;">Permohonan Tidak Ditemukan</strong>
          <p style="font-size:12.5px;color:var(--text-secondary);margin-top:4px;">Tidak ada data terdaftar untuk "${query}". Pastikan nomor registrasi (contoh: BAP-20261009-0001) benar.</p>
        </div>
      `;
    }
  } catch (e) {
    resBox.innerHTML = `
      <div style="text-align:center;padding:14px;color:var(--rose-400);font-size:13px;">
        Gagal menghubungi server pendaftaran. Silakan periksa koneksi internet Anda.
      </div>
    `;
  }
}

/* ═══════════════════════════════════════════════════
   DASHBOARD LOAD & RENDER
═══════════════════════════════════════════════════ */
async function queryUserRegistration() {
  const token = getUserToken();
  if (!token) return { ok: false, found: false, needLogin: true };

  // DATA HARUS LANGSUNG dari server / Google Sheets (Live Data).
  // Server-first dan fail-closed: Google Sheets adalah Single Source of Truth.
  try {
    const timestamp = Date.now();
    const res = await fetchWithTimeout(`${APPS_SCRIPT_URL}?action=getUserRegistration&token=${encodeURIComponent(token)}&_t=${timestamp}`, {}, 10000);
    if (res && res.ok) {
      const json = await res.json();
      if (json && json.needLogin) {
        clearSession();
        updateNavAndLandingUser();
        showToast('error', 'Sesi Berakhir', 'Sesi Anda telah berakhir. Silakan masuk kembali.');
        return { ok: false, found: false, needLogin: true };
      }
      if (json && json.ok && json.found && json.data) {
        return { ok: true, found: true, data: json.data };
      }
      return { ok: true, found: false };
    }
    return { ok: false, found: false, error: 'SERVER_ERROR' };
  } catch (e) {
    console.warn('Fetch server registration gagal:', e);
    return { ok: false, found: false, error: 'NETWORK_ERROR' };
  }
}
// ── PUBLIC QUICK TRACK (landing page, WITHOUT login) ──────────────
// Menggunakan endpoint server-side `publicTrack` yang mengembalikan
// data *minimal* saja: no_registrasi, nama (mask), tanggal, jam, status,
// note, foto_ulang_tanggal. NIK / HP / tujuan / dokumen tidak dikembalikan.
async function publicTrackRegistration(noRegistrasi) {
  if (!noRegistrasi) return { ok: false, found: false };

  try {
    const timestamp = Date.now();
    const res = await fetchWithTimeout(`${APPS_SCRIPT_URL}?action=publicTrack&no_registrasi=${encodeURIComponent(noRegistrasi)}&_t=${timestamp}`, {}, 8000);
    if (res && res.ok) {
      const json = await res.json();
      if (json && json.ok && json.found && json.data) {
        return { ok: true, found: true, data: json.data };
      }
      return { ok: true, found: false };
    }
    if (res && res.status === 401) {
      showToast('error', 'Sesi telah berakhir', 'Silakan masuk kembali ke akun Anda.');
    } else {
      showToast('error', 'Gagal terhubung ke server', 'Periksa koneksi internet Anda dan coba lagi.');
    }
    return { ok: false, found: false };
  } catch (e) {
    console.warn('Public track fetch gagal:', e);
    showToast('error', 'Gagal terhubung ke server', 'Periksa koneksi internet Anda dan coba lagi.');
    return { ok: false, found: false };
  }
}

async function loadUserRegistration(isManualRefresh = false) {
  const sess = getSession();
  if (!sess) return;

  const loadCard = document.getElementById('dashLoadingState');
  const contCard = document.getElementById('dashContent');
  const emptyCard = document.getElementById('noRegState');
  const regContainer = document.getElementById('regCardContainer');
  const refreshBtn = document.getElementById('btnRefreshDash') || document.querySelector('.btn-refresh-dash');

  // Indikator visual saat tombol Segarkan ditekan
  if (isManualRefresh && refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('refreshing');
    const svgIcon = refreshBtn.querySelector('svg');
    if (svgIcon) svgIcon.classList.add('spin-anim');
  } else if (!isManualRefresh && (!regContainer || regContainer.children.length === 0)) {
    loadCard.style.display = 'block';
    contCard.style.display = 'none';
  }

  try {
    const res = await queryUserRegistration();
    loadCard.style.display = 'none';
    contCard.style.display = 'block';

    if (res.needLogin) {
      showAuthPage(false);
      return;
    }

    if (res.ok && res.found) {
      currentRegData = res.data;
      emptyCard.style.display = 'none';
      renderRegCard(res.data);
      if (isManualRefresh) {
        showToast('success', 'Data Diperbarui', `Status permohonan: ${res.data.status || 'Menunggu'}`);
      }
    } else if (res.ok && !res.found) {
      // Data telah dihapus di Google Sheets atau belum mendaftar
      currentRegData = null;
      emptyCard.style.display = 'block';
      regContainer.innerHTML = '';
      if (isManualRefresh) {
        showToast('info', 'Data Tidak Ditemukan', 'Belum ada berkas pendaftaran aktif untuk akun ini.');
      }
    } else {
      // Server gagal / offline: jangan anggap berhasil atau tampilkan data palsu
      if (!currentRegData) {
        regContainer.innerHTML = `
          <div style="padding:24px;text-align:center;color:var(--rose-400);font-size:13px;">
            Server sedang tidak dapat dihubungi. Klik Segarkan untuk mencoba lagi.
          </div>
        `;
      }
      if (isManualRefresh) {
        showToast('error', 'Gagal Memperbarui', 'Tidak dapat terhubung ke server. Silakan coba lagi.');
      }
    }
  } catch (e) {
    loadCard.style.display = 'none';
    contCard.style.display = 'block';
    if (!currentRegData) {
      regContainer.innerHTML = `
        <div style="padding:24px;text-align:center;color:var(--rose-400);font-size:13px;">
          Gagal memuat status pendaftaran. Periksa koneksi internet Anda.
        </div>
      `;
    }
    if (isManualRefresh) {
      showToast('error', 'Gagal Memperbarui', 'Periksa koneksi internet Anda.');
    }
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('refreshing');
      const svgIcon = refreshBtn.querySelector('svg');
      if (svgIcon) svgIcon.classList.remove('spin-anim');
    }
  }
}

function getStatusBadgeHtml(status) {
  const s = String(status || '').trim();
  const normalized = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const map = {
    'Menunggu': '<span class="status-badge-modern s-menunggu">⏳ Menunggu Verifikasi</span>',
    'Dikonfirmasi': '<span class="status-badge-modern s-dikonfirmasi">✅ Terverifikasi Petugas</span>',
    'Selesai': '<span class="status-badge-modern s-selesai">🏆 BAP Selesai</span>',
    'Pending Reschedule': '<span class="status-badge-modern s-pending-rs">🔄 Reschedule Diajukan</span>',
    'Pending reschedule': '<span class="status-badge-modern s-pending-rs">🔄 Reschedule Diajukan</span>'
  };
  return map[s] || map[normalized] || `<span class="status-badge-modern s-menunggu">${status}</span>`;
}

function renderRegCard(data) {
  const container = document.getElementById('regCardContainer');
  const status = data.status || 'Menunggu';
  const rsStatus = data.reschedule_status || '';
  const rsCount = parseInt(data.reschedule_count || '0', 10);
  const tglFormatted = formatIndonesianDate(data.tanggal);

  let konfirmasiCallout = '';
  if (status === 'Dikonfirmasi') {
    konfirmasiCallout = `
      <div class="callout-banner approved" style="background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.3);">
        <span style="font-size:18px;">✅</span>
        <div>
          <strong style="color: #34d399;">Jadwal Pemeriksaan Telah Dikonfirmasi Petugas</strong>
          <p>Berkas permohonan Anda telah diverifikasi dan disetujui. Silakan hadir di Kantor Imigrasi Kelas I TPI Tanjungpinang pada: <strong>${tglFormatted}, ${data.jam || '-'}</strong>. Harap hadir 15 menit sebelum waktu kedatangan dan membawa seluruh dokumen fisik asli.</p>
        </div>
      </div>
    `;
  }

  let noteCallout = '';
  if (data.note && String(data.note).trim() !== '') {
    noteCallout = `
      <div class="callout-banner" style="background: rgba(59, 130, 246, 0.08); border-color: rgba(59, 130, 246, 0.3); margin-top: 10px;">
        <span style="font-size:18px;">📝</span>
        <div>
          <strong style="color: var(--primary-light, #60a5fa);">Catatan Petugas:</strong>
          <p style="margin-top: 2px;">${data.note}</p>
        </div>
      </div>
    `;
  }

  let rsCallout = '';
  if (rsStatus === 'Pending') {
    const rsTgl = formatIndonesianDate(data.reschedule_tanggal);
    rsCallout = `
      <div class="callout-banner pending">
        <span style="font-size:18px;">⏳</span>
        <div>
          <strong>Permintaan Reschedule Sedang Ditinjau Petugas</strong>
          <p>Jadwal baru yang diajukan: <strong>${rsTgl}, ${data.reschedule_jam || '-'}</strong>. Harap tunggu konfirmasi sebelum datang.</p>
        </div>
      </div>
    `;
  } else if (rsStatus === 'Disetujui') {
    rsCallout = `
      <div class="callout-banner approved">
        <span style="font-size:18px;">✅</span>
        <div>
          <strong>Reschedule Disetujui Petugas!</strong>
          <p>Jadwal pemeriksaan Anda telah resmi diperbarui. Silakan hadir sesuai jadwal baru.</p>
        </div>
      </div>
    `;
  } else if (rsStatus === 'Ditolak') {
    rsCallout = `
      <div class="callout-banner rejected">
        <span style="font-size:18px;">❌</span>
        <div>
          <strong>Pengajuan Reschedule Ditolak</strong>
          <p>Jadwal lama tetap berlaku. Harap tetap hadir pada jadwal yang ditetapkan.</p>
        </div>
      </div>
    `;
  }

  let fotoUlangCallout = '';
  if (status === 'Selesai' && data.foto_ulang_tanggal) {
    const fuTgl = formatIndonesianDate(data.foto_ulang_tanggal);
    fotoUlangCallout = `
      <div class="callout-banner fotoulang">
        <span style="font-size:18px;">📄</span>
        <div>
          <strong>Jadwal Pengambilan Surat Keputusan Hasil BAP</strong>
          <p>Pemeriksaan BAP telah selesai. Mohon hadir kembali ke Kantor Imigrasi untuk mengambil surat keputusan Berita Acara Pemeriksaan pada: <strong>${fuTgl.toUpperCase()}</strong>, bertempat di Ruang Inteldakim Kantor Imigrasi Kelas I TPI Tanjungpinang.</p>
        </div>
      </div>
    `;
  }

  const canReschedule = rsCount < 1 && status !== 'Selesai' && rsStatus !== 'Pending' && rsStatus !== 'Disetujui';
  const rsDisabledReason = rsCount >= 1 ? 'Maksimal 1 kali' : (status === 'Selesai' ? 'Pemeriksaan Selesai' : (rsStatus === 'Pending' ? 'Menunggu Review' : ''));

  const rsBtn = canReschedule
    ? `<button class="btn-card-action reschedule" onclick="openRescheduleModal()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        <span>Ajukan Reschedule</span>
       </button>`
    : `<button class="btn-card-action reschedule" disabled title="${rsDisabledReason}">
        <span>Reschedule (${rsDisabledReason || 'Terkunci'})</span>
       </button>`;

  container.innerHTML = `
    <div class="reg-card">
      <div class="reg-card-header">
        <div>
          <span style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Nomor Registrasi Resmi</span>
          <div class="rc-code">${data.no_registrasi || 'BAP-00000000-0000'}</div>
        </div>
        ${getStatusBadgeHtml(status)}
      </div>

      ${konfirmasiCallout}
      ${noteCallout}
      ${rsCallout}
      ${fotoUlangCallout}

      <div class="reg-card-body">
        <div class="reg-grid-details">
          <div class="rg-item"><span class="rg-label">Nama Pemohon</span><span class="rg-val">${data.nama || '-'}</span></div>
          <div class="rg-item"><span class="rg-label">Jenis Permohonan</span><span class="rg-val">${data.jenis_permohonan || '-'}</span></div>
          <div class="rg-item"><span class="rg-label">Jenis Buku Paspor</span><span class="rg-val">${data.jenis_paspor || '-'}</span></div>
          <div class="rg-item"><span class="rg-label">Jadwal Pemeriksaan</span><span class="rg-val gold">${tglFormatted}</span></div>
          <div class="rg-item"><span class="rg-label">Sesi Kedatangan</span><span class="rg-val gold">${data.jam || '-'}</span></div>
          <div class="rg-item"><span class="rg-label">No. WhatsApp</span><span class="rg-val">${data.hp || '-'}</span></div>
          <div class="rg-item"><span class="rg-label">Tempat / Tgl Lahir</span><span class="rg-val">${data.ttl || '-'}</span></div>
          <div class="rg-item"><span class="rg-label">Waktu Pendaftaran</span><span class="rg-val">${data.waktu_daftar || '-'}</span></div>
          <div class="rg-item"><span class="rg-label">Status Reschedule</span><span class="rg-val">${rsCount > 0 ? `${rsCount}x Digunakan` : 'Belum Pernah'}</span></div>
        </div>
      </div>

      <div class="reg-card-actions">
        ${rsBtn}
        <button class="btn-card-action download" onclick="downloadBuktiPDFFromDash()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>Download Bukti PDF</span>
        </button>
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════
   RESCHEDULE MODAL LOGIC
═══════════════════════════════════════════════════ */
function openRescheduleModal() {
  rsSelectedSlot = null;
  document.getElementById('rsTanggal').value = '';
  document.getElementById('rsAlasan').value = '';
  document.getElementById('rsSlotArea').innerHTML = `
    <div class="slot-loading-state" style="padding:16px;">
      <p>Silakan tentukan tanggal baru terlebih dahulu</p>
    </div>
  `;
  ['err-rsTanggal', 'err-rsSlot', 'err-rsAlasan'].forEach(id => {
    document.getElementById(id)?.classList.remove('show');
  });

  if (currentRegData) {
    const tgl = formatIndonesianDate(currentRegData.tanggal);
    document.getElementById('rsCurrentSched').textContent = `${tgl}, ${currentRegData.jam || '-'}`;
  }

  // Min date: tomorrow (H+1)
  const tomorrow = new Date(getWIBNow());
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minDateStr = getWIBDateString(tomorrow);
  document.getElementById('rsTanggal').min = minDateStr;

  const nextBizDay = getNextBusinessDay();
  document.getElementById('rsTanggal').value = getWIBDateString(nextBizDay);

  document.getElementById('rescheduleModal').classList.add('show');
  document.body.style.overflow = 'hidden';
  onRsDateChange();
}

function closeRescheduleModal() {
  document.getElementById('rescheduleModal').classList.remove('show');
  document.body.style.overflow = '';
}

async function onRsDateChange() {
  const dateStr = document.getElementById('rsTanggal').value;
  rsSelectedSlot = null;
  document.getElementById('err-rsSlot')?.classList.remove('show');
  if (!dateStr) return;

  const todayStr = getWIBDateString(getWIBNow());
  if (dateStr <= todayStr) {
    document.getElementById('rsSlotArea').innerHTML = `
      <div class="slot-loading-state" style="background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.3);">
        <p style="color:var(--rose-400);font-weight:600;">❌ Reschedule jadwal hanya dapat dipilih mulai hari selanjutnya (H+1).</p>
      </div>
    `;
    return;
  }

  const dayOfWeek = new Date(dateStr + 'T00:00:00').getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    document.getElementById('rsSlotArea').innerHTML = `
      <div class="slot-loading-state" style="background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.3);">
        <p style="color:var(--rose-400);">❌ Sabtu & Minggu kantor tutup. Silakan pilih Senin – Jumat.</p>
      </div>
    `;
    return;
  }

  document.getElementById('rsSlotArea').innerHTML = `
    <div class="slot-loading-state" style="padding:16px;">
      <div class="slot-spinner"></div>
      <p>Memeriksa ketersediaan sesi kedatangan...</p>
    </div>
  `;

  await fetchSlotData(dateStr);

  const holInfo = holidayInfoCache[dateStr];
  if (holInfo && holInfo.is_holiday) {
    const dayName = getDayName(dateStr);
    const dateFormatted = formatIndonesianDate(dateStr);
    document.getElementById('rsSlotArea').innerHTML = `
      <div class="holiday-card-user" role="alert">
        <div class="hcu-top">
          <div class="hcu-date-box">
            <span class="hcu-date">${dateFormatted}</span>
            <span class="hcu-day">${dayName}</span>
          </div>
          <div class="hcu-badge">🔴 HARI LIBUR</div>
        </div>
        <div class="hcu-body">
          <h4 class="hcu-title">${escHtml(holInfo.holiday_name || 'Hari Libur')}</h4>
          <p class="hcu-desc">Kantor tidak menerima jadwal kedatangan pada tanggal ini. Silakan pilih tanggal hari kerja lain.</p>
        </div>
      </div>
    `;
    return;
  }

  renderRsSlotCards(dateStr);
}

function renderRsSlotCards(dateStr) {
  const area = document.getElementById('rsSlotArea');
  const now = getWIBNow();
  const todayStr = getWIBDateString(now);
  const isToday = dateStr === todayStr;
  const nowHour = now.getHours() + now.getMinutes() / 60;
  const disabledSlots = disabledSlotsCache[dateStr] || [];

  const html = SLOT_DEFS.map(s => {
    const booked = slotBookingCache[`${dateStr}:${s.id}`] || 0;
    const isPast = isToday && nowHour >= s.end;
    const isClosed = disabledSlots.includes(s.id);
    const isFull = booked >= MAX_SLOTS;
    const isUnavailable = isClosed || isPast || isFull;
    const isSelected = rsSelectedSlot && rsSelectedSlot.id === s.id;

    let cls = 'slot-card-v2';
    let badge = '';
    let clickFn = '';
    let statusText = '';
    let statusDotClass = 'available';

    if (isUnavailable) {
      cls += ' disabled';
      if (isClosed) {
        cls += ' closed';
        badge = '<span class="sc-badge unavail">Slot Tidak Tersedia</span>';
        statusText = 'Slot Tidak Tersedia (Ditutup Petugas)';
      } else if (isPast) {
        cls += ' past';
        badge = '<span class="sc-badge past">Selesai</span>';
        statusText = 'Slot Tidak Tersedia (Sesi Berakhir)';
      } else {
        cls += ' full';
        badge = '<span class="sc-badge unavail">Slot Tidak Tersedia</span>';
        statusText = 'Slot Tidak Tersedia (Sudah Terisi)';
      }
      statusDotClass = 'unavailable';
    } else {
      if (isSelected) {
        cls += ' selected';
        badge = '<span class="sc-badge sel">Dipilih</span>';
      } else {
        badge = '<span class="sc-badge avail">Slot Tersedia</span>';
      }
      clickFn = `onclick="pickRsSlot(this,'${s.id}','${s.label}')"`;
      statusText = 'Slot Tersedia';
    }

    return `
      <div class="${cls}" data-id="${s.id}" ${clickFn}>
        <div class="sc-header-row">
          <span class="sc-session-name">${s.title}</span>
          ${badge}
        </div>
        <div class="sc-time">${s.label}</div>
        <div class="sc-avail-text" style="color:${isUnavailable ? 'var(--text-muted)' : 'var(--emerald-400)'}">
          <span class="sc-status-dot ${statusDotClass}"></span>
          <span>${statusText}</span>
        </div>
      </div>
    `;
  }).join('');

  area.innerHTML = `<div class="slots-grid">${html}</div>`;
}

function pickRsSlot(el, id, label) {
  document.querySelectorAll('#rsSlotArea .slot-card-v2').forEach(c => {
    c.classList.remove('selected');
    const b = c.querySelector('.sc-badge');
    if (b && !c.classList.contains('disabled')) {
      b.className = 'sc-badge avail';
      b.textContent = 'Slot Tersedia';
    }
  });
  el.classList.add('selected');
  rsSelectedSlot = { id, time: label };
  const badge = el.querySelector('.sc-badge');
  if (badge) {
    badge.className = 'sc-badge sel';
    badge.textContent = 'Dipilih';
  }
  document.getElementById('err-rsSlot')?.classList.remove('show');
}

async function submitReschedule() {
  const sess = getSession();
  if (!sess || !currentRegData) {
    showToast('error', 'Sesi Habis', 'Silakan masuk kembali ke akun Anda.');
    closeRescheduleModal();
    return;
  }

  const tanggal = document.getElementById('rsTanggal').value;
  const alasan = document.getElementById('rsAlasan').value.trim();

  const todayStr = getWIBDateString(getWIBNow());
  if (tanggal && tanggal <= todayStr) {
    showToast('error', 'Tanggal Tidak Valid', 'Reschedule hanya dapat dipilih mulai hari selanjutnya (H+1).');
    return;
  }

  // Validasi Hari Libur pada Reschedule
  if (holidayInfoCache[tanggal]?.is_holiday) {
    showToast('error', 'Hari Libur', 'Tanggal yang dipilih merupakan hari libur. Silakan pilih hari kerja lain.');
    return;
  }

  let valid = true;
  if (!tanggal) { document.getElementById('err-rsTanggal').classList.add('show'); valid = false; } else { document.getElementById('err-rsTanggal').classList.remove('show'); }
  if (!rsSelectedSlot) { document.getElementById('err-rsSlot').classList.add('show'); valid = false; } else { document.getElementById('err-rsSlot').classList.remove('show'); }
  if (alasan.length < 10) { document.getElementById('err-rsAlasan').classList.add('show'); valid = false; } else { document.getElementById('err-rsAlasan').classList.remove('show'); }
  if (!valid) return;

  const btn = document.getElementById('btnRsSubmit');
  btn.disabled = true;
  closeRescheduleModal();

  showLoading('Mengirim Permohonan Reschedule...', 'Memperbarui data antrian BAP...');

  try {
    const res = await postToServer({
      action: 'requestReschedule',
      token: getUserToken(),
      reschedule_tanggal: tanggal,
      reschedule_jam: rsSelectedSlot.time,
      reschedule_slot_id: rsSelectedSlot.id,
      reschedule_alasan: alasan,
    });

    hideLoading();
    btn.disabled = false;

    if (!res.ok) {
      showToast('error', res.error === 'HOLIDAY' ? 'Hari Libur' : 'Gagal', res.message || res.error || 'Pengajuan reschedule ditolak.');
      return;
    }

    showToast('success', 'Berhasil Dikirim', 'Permohonan reschedule telah diajukan ke petugas.');
    await loadUserRegistration(true);
  } catch (e) {
    hideLoading();
    btn.disabled = false;
    // Gagal ditolak (fail closed) — tidak menyimpan data lokal
    showToast('error', 'Gagal mengirim', 'Server tidak dapat diterima. Periksa koneksi dan coba lagi.');
    await loadUserRegistration();
  }
}

/* ═══════════════════════════════════════════════════
   MULTI-STEP FORM NAVIGATION
═══════════════════════════════════════════════════ */
function tryNavigateStep(n) {
  if (n > currentStep && !validateStep(currentStep)) return;
  goStep(n);
}

function goStep(n) {
  if (n > currentStep && !validateStep(currentStep)) return;
  currentStep = n;
  updateStepperUI();
  saveDraft();
  window.scrollTo({ top: 120, behavior: 'smooth' });
}

function updateStepperUI() {
  // Switch Step Panels
  document.querySelectorAll('.form-step-panel').forEach(p => {
    const stepNum = parseInt(p.dataset.step, 10);
    if (stepNum === currentStep) {
      p.classList.add('active');
      p.style.display = 'block';
    } else {
      p.classList.remove('active');
      p.style.display = 'none';
    }
  });

  // Update Stepper Sidebar
  document.getElementById('stepCounterBadge').textContent = `Langkah ${currentStep} dari 4`;

  for (let i = 1; i <= 4; i++) {
    const vstep = document.getElementById('vstep-' + i);
    const circle = document.getElementById('sc' + i);
    const vline = document.getElementById('vline-' + i);

    vstep.className = 'v-step';
    circle.innerHTML = i;

    if (i < currentStep) {
      vstep.classList.add('done');
      circle.innerHTML = '✓';
      if (vline) vline.className = 'v-line done';
    } else if (i === currentStep) {
      vstep.classList.add('active');
      if (vline) vline.className = 'v-line';
    } else {
      if (vline) vline.className = 'v-line';
    }
  }

  if (currentStep === 4) {
    fillSummaryTable();
  }
}

/* Validation Per Step */
function validateStep(step) {
  let ok = true;
  const setErr = (id, errId, cond) => {
    const el = document.getElementById(id);
    const em = document.getElementById(errId);
    if (!cond) {
      el?.classList.add('is-invalid');
      em?.classList.add('show');
      ok = false;
    } else {
      el?.classList.remove('is-invalid');
      em?.classList.remove('show');
    }
  };

  if (step === 1) {
    setErr('nama', 'err-nama', (document.getElementById('nama')?.value.trim() || '').length >= 3);
    setErr('tempatLahir', 'err-tempatLahir', (document.getElementById('tempatLahir')?.value.trim() || '').length >= 2);
    setErr('tanggalLahir', 'err-tanggalLahir', (document.getElementById('tanggalLahir')?.value || '') !== '');
    setErr('jenisKelamin', 'err-jenisKelamin', (document.getElementById('jenisKelamin')?.value || '') !== '');
    setErr('hp', 'err-hp', (document.getElementById('hp')?.value.trim() || '').length >= 8);
    setErr('jenisPermohonan', 'err-jenis_permohonan', (document.getElementById('jenisPermohonan')?.value || '') !== '');
    setErr('jenisPaspor', 'err-jenis_paspor', (document.getElementById('jenisPaspor')?.value || '') !== '');
    setErr('tujuan', 'err-tujuan', (document.getElementById('tujuan')?.value.trim() || '').length >= 5);
  }

  if (step === 2) {
    const tgl = document.getElementById('tanggal')?.value;
    const todayStr = getWIBDateString(getWIBNow());
    if (!tgl || tgl <= todayStr) {
      showToast('warning', 'Pilihan Tanggal Tidak Valid', 'Pendaftaran jadwal hanya dapat dipilih mulai hari selanjutnya (H+1). Tidak dapat memilih hari ini atau tanggal lampau.');
      ok = false;
      return false;
    }
    if (holidayInfoCache[tgl]?.is_holiday) {
      showToast('error', 'Hari Libur', 'Tanggal yang dipilih merupakan hari libur. Silakan pilih hari kerja lain.');
      ok = false;
      return false;
    }
    if (!selectedSlot) {
      document.getElementById('err-slot')?.classList.add('show');
      ok = false;
    } else {
      document.getElementById('err-slot')?.classList.remove('show');
    }
  }

  if (step === 3) {
    if (activeUploads > 0) {
      showToast('warning', 'Tunggu Sebentar', 'Mohon tunggu hingga proses upload berkas selesai.');
      return false;
    }

    const checkUpload = (key, errId, boxId) => {
      const box = document.getElementById(boxId);
      const em = document.getElementById(errId);
      if (!uploadedFiles[key]) {
        box?.classList.add('error-border');
        em?.classList.add('show');
        ok = false;
      } else {
        box?.classList.remove('error-border');
        em?.classList.remove('show');
      }
    };

    checkUpload('ktp', 'err-ktp', 'up-ktp');
    checkUpload('kk', 'err-kk', 'up-kk');
    checkUpload('akta', 'err-akta', 'up-akta');

    const jenis = document.getElementById('jenisPermohonan')?.value;
    if (jenis === 'BAP Paspor Rusak') {
      checkUpload('fotoPaspor', 'err-fotoPaspor', 'up-fotoPaspor');
    } else if (jenis === 'BAP Perubahan Data') {
      checkUpload('suratPemerintah', 'err-suratPemerintah', 'up-suratPemerintah');
    } else if (jenis === 'BAP Paspor Hilang') {
      const suratType = document.getElementById('jenisSuratHilang')?.value;
      if (!suratType) {
        document.getElementById('err-jenisSuratHilang')?.classList.add('show');
        ok = false;
      } else {
        document.getElementById('err-jenisSuratHilang')?.classList.remove('show');
        if (suratType === 'polisi') checkUpload('suratPolisi', 'err-suratPolisi', 'up-suratPolisi');
        if (suratType === 'kelurahan') checkUpload('suratKelurahan', 'err-suratKelurahan', 'up-suratKelurahan');
      }
    }
  }

  if (!ok) {
    const firstErr = document.querySelector('.is-invalid, .field-error-msg.show, .error-border');
    if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return ok;
}

function onJenisPermohonanChange() {
  const val = document.getElementById('jenisPermohonan')?.value;
  const grpRusak = document.getElementById('grp-rusak');
  const grpHilang = document.getElementById('grp-hilang');
  const grpPerubahan = document.getElementById('grp-perubahan');

  if (grpRusak) grpRusak.style.display = val === 'BAP Paspor Rusak' ? 'block' : 'none';
  if (grpHilang) grpHilang.style.display = val === 'BAP Paspor Hilang' ? 'block' : 'none';
  if (grpPerubahan) grpPerubahan.style.display = val === 'BAP Perubahan Data' ? 'block' : 'none';
}

function renderSuratHilang() {
  const val = document.getElementById('jenisSuratHilang')?.value;
  const wrapPolisi = document.getElementById('wrap-suratPolisi');
  const wrapKelurahan = document.getElementById('wrap-suratKelurahan');

  if (wrapPolisi) wrapPolisi.style.display = val === 'polisi' ? 'block' : 'none';
  if (wrapKelurahan) wrapKelurahan.style.display = val === 'kelurahan' ? 'block' : 'none';
}

/* ═══════════════════════════════════════════════════
   SLOT PICKER LOGIC (STEP 2)
═══════════════════════════════════════════════════ */
function initDateField() {
  const inp = document.getElementById('tanggal');
  if (!inp) return;

  const tomorrow = new Date(getWIBNow());
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minDateStr = getWIBDateString(tomorrow);

  const nextBizDay = getNextBusinessDay();
  const nextBizDayStr = getWIBDateString(nextBizDay);

  inp.min = minDateStr;
  inp.value = nextBizDayStr;

  loadSlotSelection();
}

function onDateChange() {
  const dateStr = document.getElementById('tanggal')?.value;
  selectedSlot = null;
  document.getElementById('err-slot')?.classList.remove('show');

  const todayStr = getWIBDateString(getWIBNow());
  if (dateStr && dateStr <= todayStr) {
    const area = document.getElementById('slotArea');
    if (area) {
      area.innerHTML = `
        <div class="slot-loading-state" style="background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.3);">
          <p style="color:var(--rose-400);font-weight:600;">❌ Pendaftaran jadwal hanya dapat dipilih mulai hari selanjutnya (H+1). Tidak dapat memilih jadwal pada hari pendaftaran.</p>
        </div>
      `;
    }
    return;
  }

  loadSlotSelection();
  saveDraft();
}

async function fetchSlotData(dateStr) {
  if (slotCacheFetched[dateStr]) return;
  try {
    const res = await fetchWithTimeout(`${APPS_SCRIPT_URL}?action=getSlots&date=${dateStr}`, {}, 6000);
    const json = await res.json();
    if (json) {
      if (json.is_holiday) {
        holidayInfoCache[dateStr] = { is_holiday: true, holiday_name: json.holiday_name || 'Hari Libur' };
      } else {
        holidayInfoCache[dateStr] = { is_holiday: false, holiday_name: '' };
      }
      if (Array.isArray(json.disabled_slots)) {
        disabledSlotsCache[dateStr] = json.disabled_slots;
      }
      if (json.slots) {
        Object.entries(json.slots).forEach(([id, count]) => {
          slotBookingCache[`${dateStr}:${id}`] = count;
        });
      }
    }
  } catch (e) {
    console.warn('Slot fetch offline:', e);
  }

  slotCacheFetched[dateStr] = true;
}

async function loadSlotSelection() {
  const dateStr = document.getElementById('tanggal')?.value;
  const area = document.getElementById('slotArea');
  if (!dateStr || !area) return;

  const todayStr = getWIBDateString(getWIBNow());
  if (dateStr <= todayStr) {
    selectedSlot = null;
    area.innerHTML = `
      <div class="slot-loading-state" style="background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.3);">
        <p style="color:var(--rose-400);font-weight:600;">❌ Pendaftaran jadwal hanya dapat dipilih mulai hari selanjutnya (H+1). Tidak dapat memilih jadwal pada hari pendaftaran.</p>
      </div>
    `;
    return;
  }

  const dayOfWeek = new Date(dateStr + 'T00:00:00').getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    area.innerHTML = `
      <div class="slot-loading-state" style="background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.3);">
        <p style="color:var(--rose-400);">❌ Tidak ada layanan BAP pada hari Sabtu & Minggu. Silakan pilih hari kerja (Senin–Jumat).</p>
      </div>
    `;
    return;
  }

  area.innerHTML = `
    <div class="slot-loading-state">
      <div class="slot-spinner"></div>
      <p>Memeriksa ketersediaan sesi kedatangan pada ${formatIndonesianDate(dateStr)}...</p>
    </div>
  `;

  await fetchSlotData(dateStr);

  const holInfo = holidayInfoCache[dateStr];
  if (holInfo && holInfo.is_holiday) {
    selectedSlot = null;
    const dayName = getDayName(dateStr);
    const dateFormatted = formatIndonesianDate(dateStr);
    area.innerHTML = `
      <div class="holiday-card-user" role="alert">
        <div class="hcu-top">
          <div class="hcu-date-box">
            <span class="hcu-date">${dateFormatted}</span>
            <span class="hcu-day">${dayName}</span>
          </div>
          <div class="hcu-badge">🔴 HARI LIBUR</div>
        </div>
        <div class="hcu-body">
          <h4 class="hcu-title">${escHtml(holInfo.holiday_name || 'Hari Libur')}</h4>
          <p class="hcu-desc">Kantor tidak menerima jadwal kedatangan pada tanggal ini.</p>
        </div>
        <div class="hcu-footer">
          <span class="hcu-icon">🔒</span>
          <span>Jadwal tidak tersedia &bull; Seluruh sesi kedatangan ditutup pada hari libur. Silakan pilih tanggal hari kerja lainnya.</span>
        </div>
      </div>
    `;
    return;
  }

  renderSlotGrid(dateStr);
}

function renderSlotGrid(dateStr) {
  const area = document.getElementById('slotArea');
  const now = getWIBNow();
  const todayStr = getWIBDateString(now);
  const isToday = dateStr === todayStr;
  const nowHour = now.getHours() + now.getMinutes() / 60;
  const disabledSlots = disabledSlotsCache[dateStr] || [];

  const html = SLOT_DEFS.map(s => {
    const booked = slotBookingCache[`${dateStr}:${s.id}`] || 0;
    const isPast = isToday && nowHour >= s.end;
    const isClosed = disabledSlots.includes(s.id);
    const isFull = booked >= MAX_SLOTS;
    const isUnavailable = isClosed || isPast || isFull;
    const isSelected = selectedSlot && selectedSlot.id === s.id;

    let cls = 'slot-card-v2';
    let badge = '';
    let clickFn = '';
    let statusText = '';
    let statusDotClass = 'available';

    if (isUnavailable) {
      cls += ' disabled';
      if (isClosed) {
        cls += ' closed';
        badge = '<span class="sc-badge unavail">Slot Tidak Tersedia</span>';
        statusText = 'Slot Tidak Tersedia (Ditutup Petugas)';
      } else if (isPast) {
        cls += ' past';
        badge = '<span class="sc-badge past">Selesai</span>';
        statusText = 'Slot Tidak Tersedia (Sesi Berakhir)';
      } else {
        cls += ' full';
        badge = '<span class="sc-badge unavail">Slot Tidak Tersedia</span>';
        statusText = 'Slot Tidak Tersedia (Sudah Terisi)';
      }
      statusDotClass = 'unavailable';
    } else {
      if (isSelected) {
        cls += ' selected';
        badge = '<span class="sc-badge sel">Dipilih</span>';
      } else {
        badge = '<span class="sc-badge avail">Slot Tersedia</span>';
      }
      clickFn = `onclick="pickSlot(this,'${s.id}','${s.label}')"`;
      statusText = 'Slot Tersedia';
    }

    return `
      <div class="${cls}" data-id="${s.id}" ${clickFn}>
        <div class="sc-header-row">
          <span class="sc-session-name">${s.title}</span>
          ${badge}
        </div>
        <div class="sc-time">${s.label}</div>
        <div class="sc-avail-text" style="color:${isUnavailable ? 'var(--text-muted)' : 'var(--emerald-400)'}">
          <span class="sc-status-dot ${statusDotClass}"></span>
          <span>${statusText}</span>
        </div>
      </div>
    `;
  }).join('');

  area.innerHTML = `<div class="slots-grid">${html}</div>`;
}

function pickSlot(el, id, label) {
  document.querySelectorAll('#slotArea .slot-card-v2').forEach(c => {
    c.classList.remove('selected');
    const b = c.querySelector('.sc-badge');
    if (b && !c.classList.contains('disabled')) {
      b.className = 'sc-badge avail';
      b.textContent = 'Slot Tersedia';
    }
  });
  el.classList.add('selected');
  selectedSlot = { id, time: label };
  const badge = el.querySelector('.sc-badge');
  if (badge) {
    badge.className = 'sc-badge sel';
    badge.textContent = 'Dipilih';
  }
  document.getElementById('err-slot')?.classList.remove('show');
  saveDraft();
}

/* ═══════════════════════════════════════════════════
   UPLOAD SYSTEM (DRAG & DROP, COMPRESSION, LIGHTBOX)
═══════════════════════════════════════════════════ */
function handleDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');
}

function handleDrop(e, key) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    processUploadedFile(files[0], key);
  }
}

function handleFileNew(input, key) {
  const file = input.files[0];
  if (file) {
    processUploadedFile(file, key);
  }
}

function showFileAlert(key, msg) {
  const el = document.getElementById('filealert-' + key);
  if (!el) return;
  el.textContent = `⚠️ ${msg}`;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 5000);
}

function compressImage(file, maxWidth = COMPRESS_MAX_W, quality = COMPRESS_QUAL) {
  return new Promise((resolve, reject) => {
    if (file.type === 'application/pdf') {
      resolve(file); // PDFs are kept as-is
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxWidth) {
          h = Math.round(h * (maxWidth / w));
          w = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (!blob) { resolve(file); return; }
          resolve(blob);
        }, 'image/jpeg', quality);
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

async function uploadToGoogleDrive(blob, originalName, docKey, mimeType) {
  const token = getUserToken();
  if (!token) throw new Error('Sesi login pemohon tidak ditemukan. Silakan login terlebih dahulu.');

  const base64Data = await fileToBase64(blob);
  if (!base64Data) throw new Error('Gagal membaca data berkas.');

  const payload = {
    action: 'uploadDocument',
    token: token,
    base64: base64Data,
    fileName: originalName || 'dokumen',
    docKey: docKey || 'lampiran',
    mimeType: mimeType || (blob.type || 'image/jpeg')
  };

  const res = await postToServer(payload);
  if (!res || !res.ok) {
    throw new Error((res && res.error) ? res.error : 'Gagal mengunggah berkas ke server');
  }
  return res.url; // URL pratinjau langsung Google Drive
}

function fileToBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

async function processUploadedFile(file, key) {
  const box = document.getElementById('up-' + key);
  const trigger = document.getElementById('trigger-' + key);
  const prog = document.getElementById('prog-' + key);
  const fill = document.getElementById('progfill-' + key);
  const preview = document.getElementById('preview-' + key);
  const errEl = document.getElementById('err-' + key);
  const alertEl = document.getElementById('filealert-' + key);

  if (alertEl) alertEl.classList.remove('show');
  if (errEl) errEl.classList.remove('show');
  if (box) box.classList.remove('error-border');

  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
  if (!allowed.includes(file.type)) {
    showFileAlert(key, 'Format berkas tidak didukung. Gunakan JPG, PNG, WEBP, atau PDF.');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showFileAlert(key, `Ukuran berkas terlalu besar. Maksimal 10MB.`);
    return;
  }

  activeUploads++;
  box.classList.add('uploading');
  box.classList.remove('done');
  if (trigger) trigger.style.display = 'none';
  if (prog) prog.style.display = 'block';
  if (preview) preview.style.display = 'none';

  // Realistic smooth progress animation
  let p = 15;
  if (fill) fill.style.width = p + '%';
  const iv = setInterval(() => {
    if (p < 85) {
      p += Math.random() * 12;
      if (fill) fill.style.width = Math.min(85, p) + '%';
    }
  }, 250);

  try {
    const compressedBlob = await compressImage(file);
    let previewUrl = '';
    if (file.type.startsWith('image/')) {
      previewUrl = URL.createObjectURL(file);
    }

    const finalUrl = await uploadToGoogleDrive(compressedBlob, file.name, key, file.type);

    clearInterval(iv);
    if (fill) fill.style.width = '100%';
    await new Promise(r => setTimeout(r, 200));

    uploadedFiles[key] = {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      url: finalUrl,
      previewUrl: previewUrl || finalUrl
    };

    box.classList.remove('uploading');
    box.classList.add('done');
    if (prog) prog.style.display = 'none';

    renderFileBoxAsDone(key, uploadedFiles[key]);
    saveDraft();
  } catch (err) {
    clearInterval(iv);
    console.error('File process error:', err);
    box.classList.remove('uploading', 'done');
    if (trigger) trigger.style.display = 'flex';
    if (prog) prog.style.display = 'none';
    showFileAlert(key, 'Gagal memproses berkas. Silakan coba lagi.');
  } finally {
    activeUploads = Math.max(0, activeUploads - 1);
  }
}

function renderFileBoxAsDone(key, fileInfo) {
  const box = document.getElementById('up-' + key);
  const trigger = document.getElementById('trigger-' + key);
  const preview = document.getElementById('preview-' + key);
  if (!box || !preview) return;

  box.classList.add('done');
  if (trigger) trigger.style.display = 'none';

  const isPdf = fileInfo.fileType === 'application/pdf';
  const sizeLabel = fileInfo.fileSize
    ? (fileInfo.fileSize < 1048576 ? (fileInfo.fileSize / 1024).toFixed(0) + ' KB' : (fileInfo.fileSize / 1048576).toFixed(1) + ' MB')
    : 'Dokumen Sah';

  preview.innerHTML = `
    <div class="preview-thumb-box" onclick="openLightbox('${key}')">
      ${isPdf ? '<span style="font-size:26px;">📑</span>' : `<img src="${fileInfo.previewUrl}" class="preview-thumb-img" alt="Preview">`}
    </div>
    <div class="preview-meta-box">
      <div class="preview-fname">${fileInfo.fileName}</div>
      <div class="preview-fsize">${sizeLabel} &bull; Siap Diverifikasi</div>
      <div class="preview-badge-done">✓ Berkas Terunggah</div>
    </div>
    <div class="preview-actions-box">
      ${!isPdf ? `<button type="button" class="btn-preview-zoom" onclick="openLightbox('${key}')">🔍 Perbesar</button>` : ''}
      <button type="button" class="btn-remove-file" onclick="removeUploadedFile('${key}')">🗑️ Ganti</button>
    </div>
  `;
  preview.style.display = 'flex';
}

function removeUploadedFile(key) {
  uploadedFiles[key] = null;
  const box = document.getElementById('up-' + key);
  const trigger = document.getElementById('trigger-' + key);
  const preview = document.getElementById('preview-' + key);
  const input = document.getElementById('file-' + key);

  if (box) box.classList.remove('done', 'uploading', 'error-border');
  if (trigger) trigger.style.display = 'flex';
  if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
  if (input) input.value = '';

  saveDraft();
}

function openLightbox(key) {
  const file = uploadedFiles[key];
  if (!file || !file.previewUrl) return;

  const modal = document.getElementById('imageLightboxModal');
  const img = document.getElementById('lightboxImg');
  const title = document.getElementById('lightboxTitle');

  title.textContent = `Pratinjau: ${file.fileName}`;
  img.src = file.previewUrl;
  modal.classList.add('show');
}

function closeImageLightbox() {
  document.getElementById('imageLightboxModal')?.classList.remove('show');
}

/* ═══════════════════════════════════════════════════
   SUMMARY (STEP 4) & FINAL SUBMIT
═══════════════════════════════════════════════════ */
function fillSummaryTable() {
  const sess = getSession();
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '—';
  };

  setVal('sum-nik', sess?.nik || '—');
  setVal('sum-nama', document.getElementById('nama')?.value.trim());

  const tmpat = document.getElementById('tempatLahir')?.value.trim();
  const tglLahir = document.getElementById('tanggalLahir')?.value;
  const ttlFmt = tglLahir ? `${tmpat || '-'}, ${formatIndonesianDate(tglLahir, false)}` : tmpat;
  setVal('sum-ttl', ttlFmt);

  setVal('sum-jk', document.getElementById('jenisKelamin')?.value);
  setVal('sum-hp', document.getElementById('hp')?.value.trim());
  setVal('sum-jenis_permohonan', document.getElementById('jenisPermohonan')?.value);
  setVal('sum-jenis_paspor', document.getElementById('jenisPaspor')?.value);
  setVal('sum-tujuan', document.getElementById('tujuan')?.value.trim());

  const tglBAP = document.getElementById('tanggal')?.value;
  const jadwalFmt = tglBAP ? `${formatIndonesianDate(tglBAP)}, ${selectedSlot?.time || '-'}` : '-';
  setVal('sum-jadwal', jadwalFmt);

  const docs = [];
  if (uploadedFiles.ktp) docs.push('E-KTP');
  if (uploadedFiles.kk) docs.push('KK');
  if (uploadedFiles.akta) docs.push('Akta/Ijazah/Buku Nikah');
  if (uploadedFiles.fotoPaspor) docs.push('Foto Paspor Rusak');
  if (uploadedFiles.suratPolisi) docs.push('Surat Ket. Polisi');
  if (uploadedFiles.suratKelurahan) docs.push('Surat Ket. Kelurahan');
  if (uploadedFiles.suratPemerintah) docs.push('Surat Penetapan Pemerintah');
  if (uploadedFiles.pendukung) docs.push('Dok. Pendukung');
  setVal('sum-dok', docs.join(', ') || 'Belum ada berkas');

  toggleSubmitButtonState();
}

function toggleSubmitButtonState() {
  const chk = document.getElementById('chkAgreement');
  const btn = document.getElementById('btnSubmit');
  if (btn) {
    btn.disabled = !(chk && chk.checked);
  }
}

async function submitForm() {
  const sess = getSession();
  if (!sess) {
    showToast('error', 'Sesi Berakhir', 'Silakan masuk kembali untuk melanjutkan.');
    showAuthPage(false);
    return;
  }

  const btnSubmit = document.getElementById('btnSubmit');
  btnSubmit.disabled = true;

  showLoading('Mengirim Pendaftaran SIPALARUS...', 'Menyimpan berkas & menjadwalkan pemeriksaan...');

  try {
    const tglLahir = document.getElementById('tanggalLahir').value;
    const tmpat = document.getElementById('tempatLahir').value.trim();
    const ttlStr = tglLahir ? `${tmpat}, ${formatIndonesianDate(tglLahir, false)}` : tmpat;
    const tglBAP = document.getElementById('tanggal').value;
    const todayStr = getWIBDateString(getWIBNow());
    if (!tglBAP || tglBAP <= todayStr) {
      hideLoading();
      btnSubmit.disabled = false;
      showToast('error', 'Tanggal Tidak Valid', 'Pendaftaran jadwal hanya dapat dipilih mulai hari selanjutnya (H+1).');
      return;
    }
    const jadwalStr = `${formatIndonesianDate(tglBAP)}, ${selectedSlot?.time || '-'}`;

    const docs = [];
    if (uploadedFiles.ktp) docs.push('E-KTP');
    if (uploadedFiles.kk) docs.push('KK');
    if (uploadedFiles.akta) docs.push('Akta/Ijazah/Buku Nikah');
    if (uploadedFiles.fotoPaspor) docs.push('Foto Paspor Rusak');
    if (uploadedFiles.suratPolisi) docs.push('Surat Ket. Polisi');
    if (uploadedFiles.suratKelurahan) docs.push('Surat Ket. Kelurahan');
    if (uploadedFiles.suratPemerintah) docs.push('Surat Pemerintah');
    if (uploadedFiles.pendukung) docs.push('Dok. Pendukung');

    const nowWIB = getWIBNow();
    const waktuDaftar = `${formatIndonesianDate(getWIBDateString(nowWIB))}, ${String(nowWIB.getHours()).padStart(2, '0')}:${String(nowWIB.getMinutes()).padStart(2, '0')} WIB`;

    const jPermohonan = document.getElementById('jenisPermohonan').value;
    const jPaspor = document.getElementById('jenisPaspor').value;

    registrationData = {
      nama: document.getElementById('nama').value.trim(),
      nik: sess.nik,
      tempatLahir: tmpat,
      tanggalLahir: tglLahir,
      ttl: ttlStr,
      jk: document.getElementById('jenisKelamin').value,
      hp: document.getElementById('hp').value.trim(),
      jenisPermohonan: jPermohonan,
      jenis_permohonan: jPermohonan,
      jenisPaspor: jPaspor,
      jenis_paspor: jPaspor,
      tujuan: document.getElementById('tujuan').value.trim(),
      tanggal: tglBAP,
      jam: selectedSlot?.time,
      slot_id: selectedSlot?.id,
      jadwal: jadwalStr,
      dokumen: docs.join(', ') || '-',
      waktuDaftar: waktuDaftar,
      waktu_daftar: waktuDaftar,
      status: 'Menunggu',
      url_ktp: uploadedFiles.ktp?.url || null,
      url_kk: uploadedFiles.kk?.url || null,
      url_akta: uploadedFiles.akta?.url || null,
      url_foto_paspor: uploadedFiles.fotoPaspor?.url || null,
      url_surat_polisi: uploadedFiles.suratPolisi?.url || null,
      url_surat_kelurahan: uploadedFiles.suratKelurahan?.url || null,
      url_surat_pemerintah: uploadedFiles.suratPemerintah?.url || null,
      url_pendukung: uploadedFiles.pendukung?.url || null
    };

    const token = getUserToken();
    if (!token) {
      hideLoading();
      btnSubmit.disabled = false;
      showToast('error', 'Sesi Berakhir', 'Sesi Anda telah kedaluwarsa. Silakan masuk kembali.');
      showAuthPage(false);
      return;
    }

    const payload = {
      action: 'submitRegistration',
      token: token,
      ...registrationData
    };

    const serverJson = await postToServer(payload);
    if (!serverJson || !serverJson.ok || !serverJson.no_registrasi) {
      throw new Error(serverJson?.error || serverJson?.message || 'Pendaftaran ditolak oleh server');
    }

    const code = serverJson.no_registrasi;
    registrationData.no_registrasi = code;
    registrationData.nomorRegistrasi = code;
    currentRegData = registrationData;

    // Clear saved draft
    localStorage.removeItem(DRAFT_KEY);

    hideLoading();
    document.getElementById('regCode').textContent = code;
    document.getElementById('successOverlay').classList.add('show');
    showToast('success', 'Pendaftaran Diterima!', `Nomor Registrasi SIPALARUS: ${code}`);
  } catch (err) {
    hideLoading();
    btnSubmit.disabled = false;
    showToast('error', 'Pendaftaran Ditolak', err.message || 'Terjadi kesalahan sistem. Silakan ulangi pengiriman.');
  }
}

/* ═══════════════════════════════════════════════════
   OFFICIAL PDF GENERATOR (WITH DIGITAL QR CODE)
═══════════════════════════════════════════════════ */
async function downloadBuktiPDF() {
  await generatePDF(registrationData);
}

async function downloadBuktiPDFFromDash() {
  if (!currentRegData) return;

  const rsStatus = currentRegData.reschedule_status || '';
  let activeTgl = currentRegData.tanggal;
  let activeJam = currentRegData.jam;
  if (rsStatus === 'Disetujui' && currentRegData.reschedule_tanggal) {
    activeTgl = currentRegData.reschedule_tanggal;
    activeJam = currentRegData.reschedule_jam;
  }

  const d = {
    nomorRegistrasi: currentRegData.no_registrasi || 'BAP-00000000-0000',
    nama: currentRegData.nama,
    nik: currentRegData.nik,
    ttl: currentRegData.ttl,
    jk: currentRegData.jk,
    hp: currentRegData.hp,
    jenisPermohonan: currentRegData.jenis_permohonan,
    jenisPaspor: currentRegData.jenis_paspor,
    tujuan: currentRegData.tujuan,
    jadwal: `${formatIndonesianDate(activeTgl)}, ${activeJam || '-'}`,
    dokumen: currentRegData.dokumen || 'Dokumen Persyaratan Sah Terunggah',
    waktuDaftar: currentRegData.waktu_daftar || '-',
    reschedule: rsStatus ? {
      status: rsStatus,
      tanggalLama: `${formatIndonesianDate(currentRegData.tanggal_lama || currentRegData.tanggal)}, ${currentRegData.jam_lama || currentRegData.jam || '-'}`,
      tanggalBaru: `${formatIndonesianDate(currentRegData.reschedule_tanggal)}, ${currentRegData.reschedule_jam || '-'}`,
      alasan: currentRegData.reschedule_alasan || '-'
    } : null,
    fotoUlang: (currentRegData.status === 'Selesai' && currentRegData.foto_ulang_tanggal)
      ? formatIndonesianDate(currentRegData.foto_ulang_tanggal)
      : null
  };

  await generatePDF(d);
}

/**
 * Generates an ultra-official, authentic Indonesian Immigration BAP Proof of Registration PDF
 */
async function generatePDF(d) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('error', 'Pustaka PDF Tidak Ditemukan', 'Gagal memuat modul PDF.');
    return;
  }

  showLoading('Menyiapkan Lembar Bukti SIPALARUS...', 'Menerbitkan QR Code verifikasi...');

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = 210, H = 297, margin = 16, contentW = W - margin * 2;

    // Palette
    const cNavy = [10, 25, 47];
    const cGold = [212, 175, 55];
    const cInk = [15, 23, 42];
    const cSub = [71, 85, 105];
    const cLine = [226, 232, 240];
    const cBoxBg = [248, 250, 252];

    let y = margin;

    // ── KOP SURAT RESMI KANTOR IMIGRASI ──
    doc.setTextColor(...cNavy);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('KEMENTERIAN IMIGRASI DAN PERMASYARAKATAN', margin, y);
    y += 5;

    doc.setFontSize(10.5);
    doc.text('DIREKTORAT JENDERAL IMIGRASI', margin, y);
    y += 5;

    doc.setFontSize(12.5);
    doc.setTextColor(3, 105, 161);
    doc.text('KANTOR IMIGRASI KELAS I TPI TANJUNGPINANG', margin, y);
    y += 5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...cSub);
    doc.text('Seksi Intelijen dan Penindakan Keimigrasian (Inteldakim) · Jl. Teuku Umar No. 25, Kota Tanjungpinang', margin, y);
    y += 4.5;

    // Double rule (Navy & Gold)
    doc.setDrawColor(...cNavy);
    doc.setLineWidth(0.8);
    doc.line(margin, y, margin + contentW, y);
    y += 1.2;
    doc.setDrawColor(...cGold);
    doc.setLineWidth(0.4);
    doc.line(margin, y, margin + contentW, y);
    y += 8;

    // ── TITLE OF DOCUMENT ──
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13.5);
    doc.setTextColor(...cInk);
    doc.text('TANDA BUKTI PENDAFTARAN RESMI SIPALARUS', margin, y);
    y += 5.5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...cSub);
    doc.text('Sistem Paspor Hilang Dan Rusak · Layanan Mandiri BAP Paspor RI', margin, y);
    y += 8;

    // ── REGISTRATION NUMBER & QR CODE CARD ──
    const regBoxH = 22;
    doc.setFillColor(...cBoxBg);
    doc.rect(margin, y, contentW, regBoxH, 'F');
    doc.setDrawColor(...cLine);
    doc.setLineWidth(0.3);
    doc.rect(margin, y, contentW, regBoxH, 'S');

    // Left accent bar in box
    doc.setFillColor(3, 105, 161);
    doc.rect(margin, y, 2.5, regBoxH, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...cSub);
    doc.text('KODE REGISTRASI RESMI SIPALARUS:', margin + 7, y + 6.5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(3, 105, 161);
    doc.text(d.nomorRegistrasi || 'BAP-00000000-0000', margin + 7, y + 14);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...cSub);
    doc.text(`Waktu Registrasi: ${d.waktuDaftar || '-'}`, margin + 7, y + 18.5);

    // Generate Verification QR Code
    try {
      const qrContainer = document.getElementById('qrCodeBuffer');
      if (qrContainer && window.QRCode) {
        qrContainer.innerHTML = '';
        const qrData = `KANIM_TPI:SIPALARUS:${d.nomorRegistrasi}:NIK_${d.nik}`;
        new QRCode(qrContainer, {
          text: qrData,
          width: 80,
          height: 80,
          correctLevel: QRCode.CorrectLevel.M
        });
        const qrCanvas = qrContainer.querySelector('canvas');
        if (qrCanvas) {
          const qrDataUrl = qrCanvas.toDataURL('image/png');
          doc.addImage(qrDataUrl, 'PNG', margin + contentW - 20, y + 1.5, 19, 19);
        }
      }
    } catch (e) {
      console.warn('QR code generate skipped', e);
    }

    y += regBoxH + 8;

    // Helper: section title
    const printSectionHeader = (title) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(3, 105, 161);
      doc.text(title.toUpperCase(), margin, y);
      y += 3.5;
      doc.setDrawColor(...cLine);
      doc.setLineWidth(0.3);
      doc.line(margin, y, margin + contentW, y);
      y += 5.5;
    };

    // Helper: 2-column label-value row
    const labelW = 48;
    const printRow = (label, val, isHighlight = false) => {
      const lines = doc.splitTextToSize(String(val || '-'), contentW - labelW - 2);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...cSub);
      doc.text(label, margin, y + 3.5);

      doc.setFont('helvetica', isHighlight ? 'bold' : 'normal');
      doc.setTextColor(...(isHighlight ? [3, 105, 161] : cInk));
      doc.text(lines, margin + labelW, y + 3.5);
      y += Math.max(6.2, lines.length * 4.2 + 2);
    };

    // 1. Data Pemohon
    printSectionHeader('1. Data Identitas Pemohon');
    printRow('Nomor Induk Kependudukan (NIK)', d.nik, true);
    printRow('Nama Lengkap', d.nama);
    printRow('Tempat / Tanggal Lahir', d.ttl);
    printRow('Jenis Kelamin', d.jk);
    printRow('Nomor HP / WhatsApp', d.hp);
    y += 2;

    // 2. Detail Permohonan
    printSectionHeader('2. Detail Permohonan BAP');
    printRow('Jenis Permohonan BAP', d.jenisPermohonan, true);
    printRow('Jenis Buku Paspor', d.jenisPaspor);
    printRow('Tujuan Pembuatan', d.tujuan);
    y += 2;

    // 3. Jadwal Kedatangan
    printSectionHeader('3. Jadwal Pemeriksaan BAP');
    printRow('Hari, Tanggal & Sesi Jam', d.jadwal, true);
    printRow('Lokasi Ruang Pemeriksaan', 'Seksi Inteldakim, Kanim Kelas I TPI Tanjungpinang');
    if (d.fotoUlang) {
      printRow('Jadwal Pengambilan SK Hasil BAP', d.fotoUlang, true);
      printRow('Tempat Pengambilan', 'Ruang Inteldakim, Kanim Kelas I TPI Tanjungpinang');
    }
    y += 2;

    // 4. Riwayat Reschedule jika ada
    if (d.reschedule) {
      const rs = d.reschedule;
      printSectionHeader('4. Informasi Reschedule Jadwal');
      printRow('Status Reschedule', rs.status, true);
      printRow('Jadwal Semula', rs.tanggalLama);
      printRow('Jadwal Baru Diajukan', rs.tanggalBaru);
      printRow('Alasan Perubahan', rs.alasan);
      y += 2;
    }

    // 5. Dokumen Terlampir
    printSectionHeader(d.reschedule ? '5. Dokumen Persyaratan Terunggah' : '4. Dokumen Persyaratan Terunggah');
    const docLines = doc.splitTextToSize(d.dokumen || '-', contentW);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...cInk);
    doc.text(docLines, margin, y + 3.5);
    y += docLines.length * 4.2 + 6;

    // Catatan Penting
    const noteLines = doc.splitTextToSize(
      'Pemohon WAJIB hadir 15 menit sebelum sesi kedatangan di Kantor Imigrasi Kelas I TPI Tanjungpinang dengan membawa dokumen asli lengkap (KTP, KK, Akta/Ijazah, Paspor Lama/Surat Laporan Kehilangan Kepolisian). Berpakaian sopan berkerah dan bersepatu. Menunggu instruksi verifikasi lanjutan dari petugas melalui WhatsApp.',
      contentW - 12
    );
    const noteH = noteLines.length * 3.8 + 10;
    doc.setFillColor(254, 243, 199); // Amber soft
    doc.rect(margin, y, contentW, noteH, 'F');
    doc.setDrawColor(245, 158, 11);
    doc.setLineWidth(0.4);
    doc.rect(margin, y, contentW, noteH, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(146, 64, 14);
    doc.text('CATATAN PENTING KEHADIRAN PEMOHON:', margin + 6, y + 5.5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(120, 53, 15);
    doc.text(noteLines, margin + 6, y + 10);

    // Official Footer Sign-off
    const footerY = H - 18;
    doc.setDrawColor(...cLine);
    doc.setLineWidth(0.3);
    doc.line(margin, footerY, margin + contentW, footerY);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...cSub);
    doc.text('Dokumen Bukti Pendaftaran SIPALARUS ini sah diterbitkan secara elektronik oleh Kementerian Imigrasi Dan Permasyarakatan — Kantor Imigrasi Kelas I TPI Tanjungpinang.', margin, footerY + 4.5);
    doc.text('Dihasilkan secara digital oleh Sistem SIPALARUS. Verifikasi keaslian dokumen dapat dipindai melalui QR Code resmi di atas.', margin, footerY + 8.5);

    doc.save(`Bukti_SIPALARUS_${d.nomorRegistrasi || 'Imigrasi'}.pdf`);
    hideLoading();
    showToast('success', 'PDF Terunduh', 'Lembar Bukti SIPALARUS siap dicetak.');
  } catch (err) {
    hideLoading();
    console.error('PDF error', err);
    showToast('error', 'Gagal Membuat PDF', 'Terjadi kendala saat memformat dokumen.');
  }
}

/* ═══════════════════════════════════════════════════
   LOADING OVERLAY HELPERS
═══════════════════════════════════════════════════ */
function showLoading(title = 'Memproses...', status = 'Mohon tunggu sebentar...') {
  const overlay = document.getElementById('loadingOverlay');
  const titleEl = document.getElementById('loadingTitle');
  const statusEl = document.getElementById('loadingStatus');
  if (overlay) {
    if (titleEl) titleEl.textContent = title;
    if (statusEl) statusEl.textContent = status;
    overlay.classList.add('show');
  }
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.classList.remove('show');
}

/* ═══════════════════════════════════════════════════
   SERVER HELPER WITH TIMEOUT & ROBUST FALLBACK
═══════════════════════════════════════════════════ */
function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request Timeout')), timeoutMs);
    fetch(url, options)
      .then(res => { clearTimeout(timer); resolve(res); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

async function postToServer(payload) {
  const res = await fetchWithTimeout(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload)
  }, 12000);
  if (!res.ok) {
    throw new Error(`Server merespons status ${res.status}`);
  }
  return await res.json();
}

/* ═══════════════════════════════════════════════════
   BUTTON INTERACTION & TACTILE RIPPLE ENGINE
   Universal, high-performance click animation system
═══════════════════════════════════════════════════ */
function initButtonInteractionEffects() {
  const BUTTON_SELECTOR = 'button, [role="button"], .btn-cta-primary, .btn-cta-secondary, .btn-nav-outline, .btn-nav-gold, .btn-nav-dash, .btn-nav-logout, .btn-nav-toggle, .btn-huc-dash, .btn-huc-logout, .btn-track-submit, .btn-icon-back, .btn-breadcrumb-back, .btn-fhb-back, .auth-tab-btn, .btn-auth-submit, .btn-toggle-pwd, .btn-dash-logout, .btn-refresh-dash, .btn-card-action, .btn-clear-draft, .btn-form-next, .btn-form-back, .btn-form-submit, .btn-preview-zoom, .btn-remove-file, .btn-close-modal, .btn-modal-cancel, .btn-modal-confirm, .lightbox-close-btn, .btn-confirm-cancel, .btn-confirm-ok, .btn-copy-code, .btn-download-pdf-gold, .btn-view-status, .v-step, .dash-action-card';

  function spawnRipple(btn, clientX, clientY) {
    if (!btn || btn.disabled || btn.classList.contains('disabled') || btn.getAttribute('aria-disabled') === 'true') {
      return;
    }

    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const x = clientX !== undefined ? (clientX - rect.left - size / 2) : (rect.width / 2 - size / 2);
    const y = clientY !== undefined ? (clientY - rect.top - size / 2) : (rect.height / 2 - size / 2);

    // Determine color variant
    let rippleType = 'ripple-dark';
    const isGold = btn.classList.contains('btn-nav-gold') || btn.classList.contains('btn-download-pdf-gold');
    const isDanger = btn.classList.contains('btn-nav-logout') || btn.classList.contains('btn-dash-logout') || btn.classList.contains('btn-clear-draft') || btn.classList.contains('btn-remove-file') || btn.classList.contains('btn-confirm-ok');
    const isDark = btn.classList.contains('btn-cta-primary') || btn.classList.contains('btn-track-submit') || btn.classList.contains('btn-auth-submit') || btn.classList.contains('btn-form-next') || btn.classList.contains('btn-form-submit') || btn.classList.contains('btn-modal-confirm') || btn.classList.contains('btn-nav-outline');

    if (isGold) {
      rippleType = 'ripple-accent';
    } else if (isDanger) {
      rippleType = 'ripple-danger';
    } else if (isDark) {
      rippleType = 'ripple-light';
    } else {
      try {
        const bg = window.getComputedStyle(btn).backgroundColor;
        const rgb = bg.match(/\d+/g);
        if (rgb && rgb.length >= 3) {
          const brightness = (parseInt(rgb[0]) * 299 + parseInt(rgb[1]) * 587 + parseInt(rgb[2]) * 114) / 1000;
          rippleType = brightness < 150 ? 'ripple-light' : 'ripple-dark';
        }
      } catch (_) {
        rippleType = 'ripple-dark';
      }
    }

    const ripple = document.createElement('span');
    ripple.className = `btn-ripple ${rippleType}`;
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;

    btn.appendChild(ripple);

    ripple.addEventListener('animationend', () => {
      ripple.remove();
    });

    setTimeout(() => {
      if (ripple.parentNode) ripple.remove();
    }, 600);
  }

  // Pointer press & ripple
  let currentPressedBtn = null;

  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest(BUTTON_SELECTOR);
    if (!btn || btn.disabled || btn.classList.contains('disabled')) return;

    currentPressedBtn = btn;
    btn.classList.add('btn-is-pressed');
    spawnRipple(btn, e.clientX, e.clientY);
  }, { passive: true });

  const clearPressed = () => {
    if (currentPressedBtn) {
      currentPressedBtn.classList.remove('btn-is-pressed');
      currentPressedBtn = null;
    }
  };

  document.addEventListener('pointerup', clearPressed, { passive: true });
  document.addEventListener('pointercancel', clearPressed, { passive: true });

  // Keyboard accessibility (Enter / Space)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const activeEl = document.activeElement;
      if (activeEl && activeEl.matches && activeEl.matches(BUTTON_SELECTOR)) {
        if (activeEl.disabled || activeEl.classList.contains('disabled')) return;
        activeEl.classList.add('btn-is-pressed');
        spawnRipple(activeEl);
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      clearPressed();
      const activeEl = document.activeElement;
      if (activeEl && activeEl.classList) {
        activeEl.classList.remove('btn-is-pressed');
      }
    }
  });
}

/* ═══════════════════════════════════════════════════
   INIT & EVENT LISTENERS
═══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initButtonInteractionEffects();
  updateNavAndLandingUser();
  updateStepperUI();

  // Close modals on backdrop click
  document.getElementById('rescheduleModal')?.addEventListener('click', function (e) {
    if (e.target === this) closeRescheduleModal();
  });
  document.getElementById('customConfirmModal')?.addEventListener('click', function (e) {
    if (e.target === this) this.classList.remove('show');
  });

  // Listen to form input changes for auto-draft
  ['nama', 'tempatLahir', 'tanggalLahir', 'jenisKelamin', 'hp', 'jenisPermohonan', 'jenisPaspor', 'tujuan'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => saveDraft());
  });
});

