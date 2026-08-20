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
  dismissBootScreen();
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

  window.addEventListener('online', () => { updateQueueBanner(); flushClockQueue(); });
  window.addEventListener('offline', updateQueueBanner);
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
  loadLeaveBalances();
  startMessages();

  updateQueueBanner();
  flushClockQueue();

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

const CLOCK_QUEUE_KEY = 'logix-clock-queue';

// Campus WiFi drops. Rather than losing the tap, the action is held with the
// position and the time it actually happened, and sent when the network comes
// back. The server bounds how old a queued action may be and re-checks the
// geofence against the saved position, so this is a delivery mechanism, not a
// way around the rules.
function readClockQueue() {
  try { return JSON.parse(localStorage.getItem(CLOCK_QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function writeClockQueue(items) {
  try { localStorage.setItem(CLOCK_QUEUE_KEY, JSON.stringify(items)); }
  catch { /* private mode or quota: nothing useful to do */ }
}

function queueClockAction(action, pos) {
  const queue = readClockQueue();
  queue.push({
    action,
    occurred_at: new Date().toISOString(),
    lat: pos ? pos.lat : null,
    lng: pos ? pos.lng : null,
    accuracy: pos ? pos.accuracy : null,
    worker_id: currentEmployee ? currentEmployee.worker_id : null
  });
  writeClockQueue(queue);
  updateQueueBanner();
}

// Offline is the network being down, not the request having failed. A rejection
// from Postgres (outside the geofence, session expired) must not be retried
// forever, so only transport-level failures queue.
function looksOffline(err) {
  if (!navigator.onLine) return true;
  const msg = String(err && err.message || err || '').toLowerCase();
  return msg.includes('failed to fetch')
      || msg.includes('networkerror')
      || msg.includes('load failed')
      || msg.includes('network request failed');
}

async function flushClockQueue() {
  let queue = readClockQueue();
  if (!queue.length || !sessionToken || !navigator.onLine) return;

  const remaining = [];
  let sent = 0;

  for (const item of queue) {
    // Someone else signed in on this device; their queued taps are not ours.
    if (item.worker_id && currentEmployee && item.worker_id !== currentEmployee.worker_id) {
      continue;
    }
    try {
      await rpc('clock_action', {
        p_token: sessionToken,
        p_action: item.action,
        p_lat: item.lat,
        p_lng: item.lng,
        p_accuracy: item.accuracy,
        p_occurred_at: item.occurred_at
      });
      sent++;
    } catch (err) {
      if (looksOffline(err)) {
        remaining.push(item);   // still no network — keep for next time
      } else {
        // The server refused it. Say why once, then drop it: retrying a
        // rejected action just repeats the same refusal every load.
        showToast(err?.message || 'A saved clock-in could not be recorded.', 'error');
      }
    }
  }

  writeClockQueue(remaining);
  updateQueueBanner();

  if (sent) {
    showToast(sent === 1
      ? 'Your saved clock-in has been recorded.'
      : `${sent} saved clock-ins have been recorded.`, 'success');
    refreshToday();
    loadAttendance();
  }
}

function updateQueueBanner() {
  const el = document.getElementById('clockQueueBanner');
  if (!el) return;
  const n = readClockQueue().length;
  if (!n) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = n === 1
    ? 'One clock-in is saved on this device and will be sent when you are back online.'
    : `${n} clock-ins are saved on this device and will be sent when you are back online.`;
}

async function doClock(action) {
  if (!currentEmployee) return;
  const inBtn = document.getElementById('clockInBtn');
  const outBtn = document.getElementById('clockOutBtn');
  inBtn.disabled = true; outBtn.disabled = true;

  let pos = null;
  try {
    pos = await getPosition();
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
    if (looksOffline(err)) {
      queueClockAction(action, pos);
      showToast(
        pos
          ? 'No connection. Saved on this device and will be sent automatically.'
          : 'No connection, and no location available — this may be refused when it is sent.',
        'warning'
      );
    } else {
      showToast(err?.message || 'Could not record that.', 'error');
    }
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

// Entitlement is decided in Postgres, not here. This only shows what the
// database reports, so the figures cannot drift from what it will enforce.
async function loadLeaveBalances() {
  const container = document.getElementById('leaveBalances');
  if (!container) return;

  try {
    const rows = await rpc('my_leave_balances', { p_token: sessionToken });
    if (!rows || !rows.length) { container.innerHTML = ''; return; }

    container.innerHTML = rows.map(r => {
      const remaining = Number(r.remaining) || 0;
      const entitled = Number(r.entitled) || 0;
      const pending = Number(r.pending) || 0;
      const available = Math.max(remaining - pending, 0);
      const pct = entitled > 0 ? Math.round((available / entitled) * 100) : 0;
      const low = available <= 0 ? ' none' : (pct <= 25 ? ' low' : '');

      return `
        <div class="leave-balance${low}">
          <div class="leave-balance-head">
            <span class="leave-balance-name">${escapeHtml(r.leave_name)}</span>
            <span class="leave-balance-count">
              <strong>${formatDays(available)}</strong> of ${formatDays(entitled)}
            </span>
          </div>
          <div class="leave-balance-bar" role="img"
               aria-label="${formatDays(available)} of ${formatDays(entitled)} days left">
            <span style="width:${pct}%; background:${escapeHtml(r.color || 'var(--accent)')};"></span>
          </div>
          ${pending > 0
            ? `<p class="leave-balance-note">${formatDays(pending)} awaiting approval</p>`
            : ''}
        </div>`;
    }).join('');
  } catch {
    // A balance panel is not worth blocking the form over.
    container.innerHTML = '';
  }
}

// 1 -> "1 day", 1.5 -> "1.5 days". Avoids "1 days" and a trailing ".0".
function formatDays(n) {
  const v = Number(n) || 0;
  const text = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return `${text} ${v === 1 ? 'day' : 'days'}`;
}

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
    loadLeaveBalances();
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
    // The wordmark breathing, not a spinner. Same family as the sign-in
    // loader, and it needs no CSS that pretends to measure progress.
    el.innerHTML = '<div class="loader-card"><div class="logo-mark lg breathing">LX</div></div>';
    document.body.appendChild(el);
  }
  el.classList.add('active');
}
function hideLoading() {
  const el = document.getElementById('inlineLoading');
  if (el) el.classList.remove('active');
}
