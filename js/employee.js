/**
 * ============================================================
 *  Logix — Employee portal
 * ============================================================
 *  Every privileged action goes through a Postgres RPC with a
 *  session token. The browser never decides who you are, and
 *  never decides whether you are allowed to clock in — it only
 *  reports its position and lets the server rule on it.
 */
'use strict';

let currentEmployee = null;
let sessionToken = null;
let todayRecord = { clock_in: null, clock_out: null };
let isOnLunch = false;
let lastEligibility = null;
let eligibilityTimer = null;

const SCREENS = ['loginScreen', 'forcePasswordScreen', 'dashboardScreen'];

function showScreen(id) {
  SCREENS.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  startLiveClock();
  bindEvents();

  const saved = getStoredSession();
  if (saved && saved.token) {
    try {
      const who = await rpc('whoami', { p_token: saved.token });
      const row = Array.isArray(who) ? who[0] : who;
      if (row) {
        sessionToken = saved.token;
        currentEmployee = row;
        showDashboard();
        return;
      }
    } catch { /* fall through */ }
    clearStoredSession();
  }
  showScreen('loginScreen');
});

function bindEvents() {
  document.getElementById('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    loginWithWorkerId(
      document.getElementById('workerIdInput').value.trim(),
      document.getElementById('workerPasswordInput').value
    );
  });

  document.getElementById('forcePasswordForm').addEventListener('submit', handleForcePasswordSubmit);
  document.getElementById('switchUserBtn').addEventListener('click', signOut);
  document.getElementById('clockInBtn').addEventListener('click', () => doClock('in'));
  document.getElementById('clockOutBtn').addEventListener('click', () => doClock('out'));

  const lunch = document.getElementById('lunchSwitch');
  lunch.addEventListener('click', toggleLunch);
  lunch.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleLunch(); }
  });

  document.getElementById('sickLeaveForm').addEventListener('submit', submitLeave);
  document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
}

async function handleChangePassword(e) {
  e.preventDefault();
  const errorEl = document.getElementById('changePasswordError');
  errorEl.textContent = '';

  const current = document.getElementById('currentPassword').value;
  const next = document.getElementById('changeNewPassword').value;
  const confirm = document.getElementById('changeConfirmPassword').value;

  if (!current) { errorEl.textContent = 'Enter your current password.'; return; }
  const check = validatePasswordComplexity(next);
  if (!check.valid) { errorEl.textContent = check.message; return; }
  if (next !== confirm) { errorEl.textContent = 'The new passwords do not match.'; return; }
  if (next === current) { errorEl.textContent = 'That is already your current password.'; return; }

  try {
    await rpc('change_own_password', {
      p_token: sessionToken,
      p_current_password: current,
      p_new_password: next
    });
    document.getElementById('changePasswordForm').reset();
    showToast('Password updated. Other devices have been signed out.', 'success');
  } catch (err) {
    errorEl.textContent = err?.message || 'Could not change your password.';
  }
}

/* ============================================================
   Auth
   ============================================================ */
async function loginWithWorkerId(workerId, password) {
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';

  const raw = (workerId || '').trim();
  if (!raw) { errorEl.textContent = 'Enter your Worker ID.'; return; }

  const lower = raw.toLowerCase();
  if (lower === 'admin' || lower === 'supervisor' || lower === 'admin@sta.sc') {
    window.location.href = 'admin.html';
    return;
  }
  if (!password) { errorEl.textContent = 'Enter your password or one-time code.'; return; }

  let cleanId = raw.toUpperCase().replace(/\s+/g, '');
  if (/^\d+$/.test(cleanId)) cleanId = 'STA' + cleanId.padStart(3, '0');

  try {
    const result = await rpc('verify_login', {
      p_identifier: cleanId, p_password: password, p_require_admin: false
    });
    const row = Array.isArray(result) ? result[0] : result;

    if (!row) { errorEl.textContent = 'That Worker ID and password do not match.'; return; }

    sessionToken = row.token;
    currentEmployee = row;
    storeSession({ token: row.token });

    if (row.must_change_password) { showScreen('forcePasswordScreen'); return; }

    showAppLoader('Signing in…', 320, showDashboard);
  } catch (err) {
    errorEl.textContent = err?.message || 'Could not sign in. Try again.';
  }
}

async function handleForcePasswordSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById('forcePasswordError');
  errorEl.textContent = '';

  const newPass = document.getElementById('newPasswordInput').value;
  const confirmPass = document.getElementById('confirmPasswordInput').value;

  const check = validatePasswordComplexity(newPass);
  if (!check.valid) { errorEl.textContent = check.message; return; }
  if (newPass !== confirmPass) { errorEl.textContent = 'Those passwords do not match.'; return; }

  try {
    await rpc('set_employee_password', { p_token: sessionToken, p_new_password: newPass });
    currentEmployee.must_change_password = false;
    showToast('Password saved.', 'success');
    showDashboard();
  } catch (err) {
    errorEl.textContent = err?.message || 'Could not save your password. Try again.';
  }
}

async function signOut() {
  if (sessionToken) { try { await rpc('logout', { p_token: sessionToken }); } catch {} }
  clearStoredSession();
  currentEmployee = null;
  sessionToken = null;
  if (eligibilityTimer) { clearInterval(eligibilityTimer); eligibilityTimer = null; }
  document.getElementById('workerIdInput').value = '';
  document.getElementById('workerPasswordInput').value = '';
  showScreen('loginScreen');
}

/* ============================================================
   Dashboard
   ============================================================ */
function showDashboard() {
  showScreen('dashboardScreen');
  initChrome();

  const initials = (currentEmployee.full_name || '??')
    .split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  document.getElementById('idAvatar').textContent = initials || '--';
  document.getElementById('idFullName').textContent = currentEmployee.full_name || '—';
  document.getElementById('idPosition').textContent = currentEmployee.position || '—';
  document.getElementById('idWorkerId').textContent = currentEmployee.worker_id || '—';

  const today = new Date().toISOString().split('T')[0];
  const startEl = document.getElementById('leaveStartDate');
  const endEl = document.getElementById('leaveEndDate');
  if (startEl) startEl.min = today;
  if (endEl) endEl.min = today;

  refreshToday();
  loadAttendance();
  loadMyLeaveRequests();
  startMessages();

  refreshEligibility();
  if (!eligibilityTimer) eligibilityTimer = setInterval(refreshEligibility, 60000);
}

async function refreshToday() {
  try {
    const todayStr = new Date().toISOString().split('T')[0];
    const { data, error } = await getSupabase()
      .from('attendance')
      .select('clock_in, clock_out, is_on_lunch')
      .eq('employee_id', currentEmployee.id)
      .eq('date', todayStr)
      .maybeSingle();
    if (error) throw error;

    todayRecord = data || { clock_in: null, clock_out: null };
    isOnLunch = !!data?.is_on_lunch;
  } catch { /* non-fatal */ }
  updateClockUI();
  updateLunchUI();
}

/* ============================================================
   On-site verification
   ============================================================ */
async function refreshEligibility() {
  const banner = document.getElementById('verifyBanner');
  const text = document.getElementById('verifyText');
  if (!banner || !sessionToken) return;

  try {
    const pos = await getPosition();
    const res = await rpc('check_clock_eligibility', {
      p_token: sessionToken,
      p_lat: pos ? pos.lat : null,
      p_lng: pos ? pos.lng : null
    });
    lastEligibility = res;

    if (!res.enforced) {
      banner.className = 'verify pending';
      text.innerHTML = '<strong>Site checks are not configured yet.</strong> Clock-ins are being accepted from anywhere until an administrator registers the campus network.';
    } else if (res.allowed) {
      banner.className = 'verify ok';
      const near = res.distance_meters != null
        ? ` You are about ${Math.round(res.distance_meters)} m from the campus centre.`
        : '';
      text.innerHTML = `<strong>Verified on site.</strong>${near}`;
    } else {
      banner.className = 'verify blocked';
      const why = pos ? '' : ' Location access is switched off — turn it on and reload.';
      text.innerHTML = `<strong>Not on the academy network.</strong> You can only clock in from campus.${why}`;
    }
  } catch (err) {
    banner.className = 'verify pending';
    text.textContent = 'Could not confirm your location right now.';
  }
  updateClockUI();
}

/* ============================================================
   Clock
   ============================================================ */
function startLiveClock() {
  const tick = () => {
    const now = new Date();
    const t = document.getElementById('liveClock');
    const d = document.getElementById('liveDate');
    if (t) t.textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (d) d.textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };
  tick();
  setInterval(tick, 1000);
}

function updateClockUI() {
  const pill = document.getElementById('clockStatusPill');
  const inBtn = document.getElementById('clockInBtn');
  const outBtn = document.getElementById('clockOutBtn');
  if (!pill || !inBtn || !outBtn) return;

  const blocked = lastEligibility && lastEligibility.enforced && !lastEligibility.allowed;

  if (todayRecord.clock_in && !todayRecord.clock_out) {
    pill.className = 'status-pill on';
    pill.innerHTML = `<span class="dot"></span> On duty since ${formatTime(todayRecord.clock_in)}`;
    inBtn.disabled = true;
    outBtn.disabled = false;
  } else if (todayRecord.clock_in && todayRecord.clock_out) {
    pill.className = 'status-pill';
    pill.innerHTML = `<span class="dot"></span> ${formatTime(todayRecord.clock_in)} – ${formatTime(todayRecord.clock_out)}`;
    inBtn.disabled = true;
    outBtn.disabled = true;
  } else {
    pill.className = 'status-pill off';
    pill.innerHTML = `<span class="dot"></span> Not clocked in`;
    inBtn.disabled = !!blocked;
    outBtn.disabled = true;
  }

  inBtn.title = blocked ? 'You must be on the academy network to clock in.' : '';
}

async function doClock(action) {
  if (!currentEmployee) return;
  const inBtn = document.getElementById('clockInBtn');
  const outBtn = document.getElementById('clockOutBtn');
  inBtn.disabled = true; outBtn.disabled = true;

  try {
    const pos = await getPosition();
    const data = await rpc('clock_action', {
      p_token: sessionToken,
      p_action: action,
      p_lat: pos ? pos.lat : null,
      p_lng: pos ? pos.lng : null,
      p_accuracy: pos ? pos.accuracy : null
    });

    todayRecord.clock_in = data.clock_in;
    todayRecord.clock_out = data.clock_out;

    if (action === 'in') {
      showToast(`Clocked in at ${formatTime(data.clock_in)}.`, 'success');
    } else {
      isOnLunch = false;
      updateLunchUI();
      showToast(`Clocked out at ${formatTime(data.clock_out)}.`, 'success');
    }
    loadAttendance();
  } catch (err) {
    showToast(err?.message || 'Could not record that.', 'error');
  } finally {
    updateClockUI();
    refreshEligibility();
  }
}

/* ============================================================
   Lunch
   ============================================================ */
function updateLunchUI() {
  const sw = document.getElementById('lunchSwitch');
  const label = document.getElementById('lunchLabel');
  if (!sw || !label) return;
  sw.classList.toggle('on', isOnLunch);
  sw.setAttribute('aria-checked', String(isOnLunch));
  label.textContent = isOnLunch ? 'On lunch now' : 'Not on lunch';
}

async function toggleLunch() {
  if (!todayRecord.clock_in || todayRecord.clock_out) {
    showToast('Clock in first to record a lunch break.', 'warning');
    return;
  }
  const next = !isOnLunch;
  try {
    await rpc('toggle_lunch', { p_token: sessionToken, p_on: next });
    isOnLunch = next;
    updateLunchUI();
    showToast(next ? 'Lunch started.' : 'Welcome back.', 'success');
  } catch (err) {
    showToast(err?.message || 'Could not update lunch status.', 'error');
  }
}

/* ============================================================
   Attendance
   ============================================================ */
async function loadAttendance() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

  try {
    const { data, error } = await getSupabase()
      .from('attendance')
      .select('clock_in, clock_out, date')
      .eq('employee_id', currentEmployee.id)
      .gte('date', start)
      .lte('date', end);
    if (error) throw error;

    const total = data?.length || 0;
    const present = data?.filter(x => x.clock_in && x.clock_out).length || 0;
    const pct = total ? Math.round((present / total) * 100) : 0;

    const ring = document.getElementById('attendanceRingContainer');
    const headline = document.getElementById('attendanceHeadline');
    if (ring) {
      const colour = pct >= 75 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)';
      renderAttendanceRing(ring, pct, colour);
    }
    if (headline) {
      headline.textContent = total
        ? `${present} of ${total} days`
        : 'No days recorded yet';
    }
  } catch { /* non-fatal */ }
}

/* ============================================================
   Leave
   ============================================================ */
async function submitLeave(e) {
  e.preventDefault();
  if (!currentEmployee) return;

  const type = document.getElementById('leaveType').value;
  const start = document.getElementById('leaveStartDate').value;
  const end = document.getElementById('leaveEndDate').value;
  const halfDay = document.getElementById('isHalfDay').checked;
  const reason = document.getElementById('leaveReason').value.trim();

  if (!start || !end) { showToast('Choose both dates.', 'error'); return; }
  if (end < start) { showToast('The return date cannot be before the first day away.', 'error'); return; }

  try {
    showLoading();
    await rpc('submit_leave_request', {
      p_token: sessionToken,
      p_leave_code: type,
      p_start: start,
      p_end: end,
      p_reason: reason,
      p_half_day: halfDay
    });
    showToast('Request submitted for review.', 'success');
    document.getElementById('sickLeaveForm').reset();
    loadMyLeaveRequests();
  } catch (err) {
    showToast(err?.message || 'Could not submit your request.', 'error');
  } finally {
    hideLoading();
  }
}

async function loadMyLeaveRequests() {
  const container = document.getElementById('myLeaveList');
  if (!container || !currentEmployee) return;

  try {
    const { data, error } = await getSupabase()
      .from('leave_requests')
      .select('id,start_date,end_date,reason,status,is_half_day,review_comment,leave_types(code,name)')
      .eq('employee_id', currentEmployee.id)
      .order('requested_at', { ascending: false })
      .limit(15);
    if (error) throw error;

    if (!data || !data.length) {
      container.innerHTML = '<div class="empty-state">No requests yet.</div>';
      return;
    }

    container.innerHTML = data.map(r => {
      const dates = r.start_date === r.end_date
        ? formatDate(r.start_date)
        : `${formatDate(r.start_date)} → ${formatDate(r.end_date)}`;
      return `
        <div class="row-item">
          <div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <span class="badge info">${escapeHtml(r.leave_types?.code || 'LV')}</span>
              <span class="name">${dates}</span>
              ${r.is_half_day ? '<span class="badge">Half day</span>' : ''}
            </div>
            ${r.reason ? `<div class="sub" style="margin-top:4px;">${escapeHtml(r.reason)}</div>` : ''}
            ${r.review_comment ? `<div class="tiny" style="margin-top:4px;">Reviewer: ${escapeHtml(r.review_comment)}</div>` : ''}
          </div>
          <span class="badge ${r.status}">${escapeHtml(r.status)}</span>
        </div>`;
    }).join('');
  } catch {
    container.innerHTML = '<div class="empty-state">Could not load your requests.</div>';
  }
}

/* ============================================================
   Announcements
   ============================================================ */
async function loadMessageBoard() {
  const container = document.getElementById('messageBoard');
  if (!container) return;

  try {
    const { data, error } = await getSupabase()
      .from('messages')
      .select('id,title,body,created_at,author:employees(full_name)')
      .eq('published', true)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;

    if (!data || !data.length) {
      container.innerHTML = '<div class="empty-state">No announcements yet.</div>';
      return;
    }

    container.innerHTML = data.map(m => `
      <article class="announcement">
        <div class="meta">${escapeHtml(m.author?.full_name || 'Management')} · ${formatDate(m.created_at)}</div>
        <div class="body">${escapeHtml(m.body || '')}</div>
      </article>
    `).join('');
  } catch {
    container.innerHTML = '<div class="empty-state">Could not load announcements.</div>';
  }
}

function startMessages() {
  loadMessageBoard();
  try {
    const client = getSupabase();
    if (client && typeof client.channel === 'function') {
      client.channel('employee-messages')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, loadMessageBoard)
        .subscribe();
    }
  } catch { /* realtime optional */ }
}

/* ---------- Small loading overlay ---------- */
function showLoading() {
  let el = document.getElementById('inlineLoading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'inlineLoading';
    el.className = 'app-loader';
    el.innerHTML = '<div class="loader-card"><div class="spinner"></div></div>';
    document.body.appendChild(el);
  }
  el.classList.add('active');
}
function hideLoading() {
  const el = document.getElementById('inlineLoading');
  if (el) el.classList.remove('active');
}
