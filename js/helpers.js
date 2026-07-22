/**
 * ============================================================
 *  Logix — Supabase shared client + helpers
 * ============================================================
 */
'use strict';

const SUPABASE_URL = window.LOGIX_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.LOGIX_SUPABASE_ANON_KEY || '';
let supabase = null;

try {
  if (typeof supabase !== 'undefined' && window.supabase) {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
} catch {}

function getSupabase() {
  return supabase;
}

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
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toast.style.pointerEvents = 'auto';
  _toastContainer.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(0)';
  });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(30px)';
    toast.addEventListener('transitionend', () => toast.remove());
  }, 2800);
}

function formatTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso.replace(' ', 'T'));
  if (Number.isNaN(d)) return '--:--';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T'));
  if (Number.isNaN(d)) return '';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
