/**
 * ============================================================
 *  Logix — Supabase shared client + helpers
 * ============================================================
 */
'use strict';

let _supabaseClient = null;

const EYE_OPEN_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function initPasswordToggles() {
  document.querySelectorAll('.toggle-password-btn').forEach(btn => {
    if (btn.dataset.initialized) return;
    btn.dataset.initialized = 'true';
    btn.innerHTML = EYE_OPEN_SVG;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (!input) return;
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.innerHTML = isPassword ? EYE_OFF_SVG : EYE_OPEN_SVG;
    });
  });
}
window.initPasswordToggles = initPasswordToggles;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPasswordToggles);
} else {
  initPasswordToggles();
}

function getSupabase() {
  if (!_supabaseClient) {
    const url = window.LOGIX_SUPABASE_URL || '';
    const key = window.LOGIX_SUPABASE_ANON_KEY || '';
    const sbObj = window.supabase;
    if (sbObj && typeof sbObj.createClient === 'function' && url && key) {
      _supabaseClient = sbObj.createClient(url, key);
    }
  }
  return _supabaseClient;
}
window.getSupabase = getSupabase;

async function supabaseFrom(path) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase client not initialized.');
  const q = client.from(path);
  return q;
}

async function fetchAll(table, opts = {}) {
  const { select = '*', filters = [], order = { column: 'id', asc: true }, single = false } = opts;
  let q = await supabaseFrom(table).select(select);
  for (const f of filters) q = f(q);
  if (order) q = q.order(order.column, { ascending: !!order.asc });
  const { data, error } = await q;
  if (error) throw error;
  return single && Array.isArray(data) && data.length ? data[0] : data;
}

async function insertInto(table, values) {
  const { data, error } = await supabaseFrom(table).insert(values).select().single();
  if (error) throw error;
  return data;
}

async function updateIn(table, values, matchColumn = 'id', matchValue) {
  const { data, error } = await supabaseFrom(table).update(values).match({ [matchColumn]: matchValue }).select().single();
  if (error) throw error;
  return data;
}

async function deleteFrom(table, matchColumn = 'id', matchValue) {
  const { data, error } = await supabaseFrom(table).delete().match({ [matchColumn]: matchValue }).select().single();
  if (error) throw error;
  return data;
}

function filterEq(column, value) {
  return (q) => q.eq(column, value);
}

function filterGte(column, value) {
  return (q) => q.gte(column, value);
}

function filterLte(column, value) {
  return (q) => q.lte(column, value);
}

const API_BASE = window.LOGIX_PREFIX || '.';
const STORAGE_THEME = 'logix-theme';

function apiUrl(path) {
  return (API_BASE + '/' + path).replace(/\/+/g, '/').replace(/^\.\//, './');
}

async function apiCall(path, method = 'GET', body = null) {
  const url = apiUrl(path);
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    credentials: 'same-origin',
  };
  if (body) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(url, opts);
    let data;
    try { data = await res.json(); }
    catch { data = { success: false, message: `Server error (${res.status}).` }; }
    if (!res.ok) throw { status: res.status, message: data.message || `HTTP ${res.status}`, data };
    return data;
  } catch (err) {
    const code = err.status || 0;
    const msg = err.message || 'Unexpected error.';
    showToast(msg, code === 401 ? 'warning' : 'error');
    throw err;
  }
}

const _toastContainer = document.createElement('div');
_toastContainer.id = 'toast-container';
_toastContainer.setAttribute('aria-live', 'polite');
_toastContainer.style.cssText =
  'position:fixed;bottom:24px;right:24px;z-index:9999;' +
  'display:flex;flex-direction:column;gap:10px;pointer-events:none;';
document.body.appendChild(_toastContainer);

function showToast(message, type = 'info') {
  if (!_toastContainer.parentNode) document.body.appendChild(_toastContainer);
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toast.style.pointerEvents = 'auto';
  _toastContainer.appendChild(toast);
  const rAF = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
  rAF(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(0)';
  });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(30px)';
    toast.addEventListener('transitionend', () => toast.remove());
  }, 2800);
}
window.showToast = showToast;

/* ---------- Global App Loading Screen Helper ---------- */
function initAppLoaderMarkup() {
  if (document.getElementById('globalAppLoader')) return;
  const overlay = document.createElement('div');
  overlay.id = 'globalAppLoader';
  overlay.className = 'app-loader-overlay';
  overlay.innerHTML = `
    <div class="loader-card">
      <div class="lx-logo-box opt-1 loader-logo-pulse" style="width:58px; height:58px; font-size:22px;">LX</div>
      <div class="loader-spinner-ring"></div>
      <div class="loader-status-text" id="loaderStatusMessage">Authenticating STA Credentials...</div>
      <div class="loader-progress-track">
        <div class="loader-progress-bar" id="loaderProgressBar"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function showAppLoader(message = 'Loading Logix Portal...', duration = 400, onComplete) {
  initAppLoaderMarkup();
  const overlay = document.getElementById('globalAppLoader');
  const statusEl = document.getElementById('loaderStatusMessage');
  const barEl = document.getElementById('loaderProgressBar');

  if (statusEl) statusEl.textContent = message;
  if (barEl) barEl.style.width = '0%';
  if (overlay) overlay.classList.add('active');

  // Smooth progress fill
  setTimeout(() => { if (barEl) barEl.style.width = '45%'; }, 40);
  setTimeout(() => { if (barEl) barEl.style.width = '85%'; }, duration * 0.5);
  setTimeout(() => {
    if (barEl) barEl.style.width = '100%';
    setTimeout(() => {
      hideAppLoader();
      if (typeof onComplete === 'function') onComplete();
    }, 120);
  }, duration);
}

function hideAppLoader() {
  const overlay = document.getElementById('globalAppLoader');
  if (overlay) overlay.classList.remove('active');
}

window.showAppLoader = showAppLoader;
window.hideAppLoader = hideAppLoader;

function formatTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso.replace(' ', 'T'));
  if (Number.isNaN(d)) return '--:--';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
window.formatTime = formatTime;

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T'));
  if (Number.isNaN(d)) return '';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
window.formatDate = formatDate;

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
window.escapeHtml = escapeHtml;

function renderAttendanceRing(container, pct, color = 'var(--accent)') {
  const radius = 42;
  const cc = 2 * Math.PI * radius;
  const offset = cc - (Math.max(0, Math.min(100, pct)) / 100) * cc;
  container.innerHTML = `
    <svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label="${pct}% attendance">
      <circle cx="60" cy="60" r="${radius}" fill="none" stroke-width="10"
        stroke="currentColor" style="color: var(--text-muted); opacity:0.25"/>
      <circle cx="60" cy="60" r="${radius}" fill="none" stroke-width="10"
        stroke="${color}" stroke-linecap="round"
        stroke-dasharray="${cc}" stroke-dashoffset="${offset}"
        style="transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset 0.8s ${(getComputedStyle(document.documentElement).getPropertyValue('--ease').trim() || 'cubic-bezier(0.16,1,0.3,1)')};"/>
      <text x="60" y="60" text-anchor="middle" dominant-baseline="central"
        font-size="22" font-weight="700" fill="currentColor" style="color: var(--text-primary);">
        ${pct}%
      </text>
    </svg>`;
}

async function hashPassword(plainText) {
  if (!plainText) return '';
  const encoder = new TextEncoder();
  const data = encoder.encode(plainText);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
window.hashPassword = hashPassword;

function calculateAge(dobString) {
  if (!dobString) return null;
  const dob = new Date(dobString);
  if (isNaN(dob)) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }
  return age >= 0 ? age : null;
}
window.calculateAge = calculateAge;

function generateTempOTP() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = 'STA-';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
window.generateTempOTP = generateTempOTP;

function isShiftEnded(endTimeStr = '16:00') {
  const now = new Date();
  const [endHour, endMin] = endTimeStr.split(':').map(Number);
  const shiftEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), endHour, endMin, 0);
  return now > shiftEnd;
}
window.isShiftEnded = isShiftEnded;

function validatePasswordComplexity(pwd) {
  if (!pwd || pwd.length < 8) return { valid: false, message: 'Password must be at least 8 characters long.' };
  if (!/[A-Z]/.test(pwd)) return { valid: false, message: 'Password must contain at least 1 uppercase letter.' };
  if (!/[a-z]/.test(pwd)) return { valid: false, message: 'Password must contain at least 1 lowercase letter.' };
  if (!/[0-9]/.test(pwd)) return { valid: false, message: 'Password must contain at least 1 number.' };
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pwd)) return { valid: false, message: 'Password must contain at least 1 special character.' };
  return { valid: true };
}
window.validatePasswordComplexity = validatePasswordComplexity;

async function logAuditTrail(actionType, targetEmployee = '', details = '') {
  try {
    const client = window.getSupabase();
    if (!client) return;

    let actorName = 'System Admin';
    let actorId = null;
    const sessionStr = localStorage.getItem('logix-admin-session');
    if (sessionStr && sessionStr !== 'true') {
      try {
        const parsed = JSON.parse(sessionStr);
        actorName = parsed?.name || 'Supervisor Admin';
        actorId = parsed?.id || null;
      } catch {}
    }

    await client.from('audit_log').insert({
      actor_id: actorId,
      actor_name: actorName,
      action_type: actionType,
      target_employee: targetEmployee,
      details: details
    });
  } catch (e) {
    console.warn('Audit trail log skipped:', e?.message);
  }
}
window.logAuditTrail = logAuditTrail;

function printGovernmentPDFReport(reportTitle, headers, rows) {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showToast('Please allow popups to generate official PDF reports.', 'warning');
    return;
  }

  const tableHeaderHtml = headers.map(h => `<th style="padding:10px 14px; border:1px solid #cbd5e1; background:#f1f5f9; text-align:left; font-size:12px; font-weight:700;">${h}</th>`).join('');
  const tableRowsHtml = rows.map(r => `
    <tr>${r.map(c => `<td style="padding:10px 14px; border:1px solid #e2e8f0; font-size:12px;">${c}</td>`).join('')}</tr>
  `).join('');

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${reportTitle} - STA Seychelles</title>
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; padding: 30px; color: #0f172a; }
        .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid #1d4ed8; padding-bottom: 16px; margin-bottom: 24px; }
        .title { font-size: 20px; font-weight: 800; color: #0f172a; margin: 0; }
        .subtitle { font-size: 13px; color: #475569; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        .footer { margin-top: 40px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 16px; }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <h1 class="title">REPUBLIC OF SEYCHELLES — TOURISM ACADEMY (STA)</h1>
          <div class="subtitle">Official Ministry HR &amp; Attendance Report · ${reportTitle}</div>
        </div>
        <div style="text-align:right; font-size:12px; font-weight:600;">Date: ${new Date().toLocaleDateString()}</div>
      </div>
      <table>
        <thead><tr>${tableHeaderHtml}</tr></thead>
        <tbody>${tableRowsHtml}</tbody>
      </table>
      <div class="footer">
        Generated by Logix — Seychelles Tourism Academy · Seychelles Tourism Academy (STA)
      </div>
      <script>
        window.onload = function() { window.print(); };
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}
window.printGovernmentPDFReport = printGovernmentPDFReport;
