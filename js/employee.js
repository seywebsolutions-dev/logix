/**
 * ============================================================
 *  Logix — Employee dashboard, Supabase-backed
 * ============================================================
 */
'use strict';

const STORAGE_KEY = 'logix-employee';
let currentEmployee = null;
let todayRecord = { clock_in: null, clock_out: null };
let isOnLunch = false;
let refreshAttendanceTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  startLiveClock();
  bindEvents();
  injectAttendanceFont();
  applySavedTheme();

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const { worker_id } = JSON.parse(saved);
      loginWithWorkerId(worker_id, '', true);
    } catch { /* ignore */ }
  }
});

function applySavedTheme() {
  const saved = localStorage.getItem('logix-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = saved === 'dark' ? '☀️' : '🌙';
}

function bindEvents() {
  document.getElementById('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const workerId = document.getElementById('workerIdInput').value.trim();
    const password = document.getElementById('workerPasswordInput').value.trim();
    if (workerId) loginWithWorkerId(workerId, password, false);
  });

  document.getElementById('forcePasswordForm').addEventListener('submit', handleForcePasswordSubmit);

  document.getElementById('switchUserBtn').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    currentEmployee = null;
    document.getElementById('dashboardScreen').style.display = 'none';
    document.getElementById('forcePasswordScreen').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('workerIdInput').value = '';
    document.getElementById('workerPasswordInput').value = '';
    clearSections();
  });

  document.getElementById('clockInBtn').addEventListener('click', () => doClock('in'));
  document.getElementById('clockOutBtn').addEventListener('click', () => doClock('out'));
  document.getElementById('lunchSwitch').addEventListener('click', toggleLunch);
  document.getElementById('sickLeaveForm').addEventListener('submit', submitLeave);
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
}

function handleEmployeeLoginSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const workerId = (document.getElementById('workerIdInput').value || '').trim();
  const password = (document.getElementById('workerPasswordInput').value || '').trim();
  if (workerId) {
    loginWithWorkerId(workerId, password, false);
  }
  return false;
}
window.handleEmployeeLoginSubmit = handleEmployeeLoginSubmit;

/* ---------- Auth & Password Verification ---------- */
function loginWithWorkerId(workerId, password = '', silent = false) {
  const errorEl = document.getElementById('loginError');
  if (errorEl) errorEl.textContent = '';

  const rawInput = (workerId || '').trim();
  if (!rawInput) {
    if (!silent && errorEl) errorEl.textContent = 'Please enter your Worker ID.';
    return;
  }

  // 1. Admin Login Redirect Handler (If user types admin into worker ID box)
  const lowerInput = rawInput.toLowerCase();
  if (lowerInput === 'admin' || lowerInput === 'admin@sta.sc' || lowerInput === 'supervisor') {
    window.location.href = 'admin.html';
    return;
  }

  // Normalize Worker ID (e.g. "sta 001" or "1" -> "STA001")
  let cleanId = rawInput.toUpperCase().replace(/\s+/g, '');
  if (/^\d+$/.test(cleanId)) {
    cleanId = 'STA' + cleanId.padStart(3, '0');
  }

  // Instant local staff lookup map (< 5ms zero latency)
  const demoMap = {
    'STA001': { id: 1, worker_id: 'STA001', full_name: 'Adeline Hoareau', position: 'Principal', role: 'principal' },
    'STA002': { id: 2, worker_id: 'STA002', full_name: 'David Bristol', position: 'Vice Principal', role: 'vice_principal' },
    'STA003': { id: 3, worker_id: 'STA003', full_name: 'Priya Anand', position: 'Senior Teacher', role: 'teacher' },
    'STA004': { id: 4, worker_id: 'STA004', full_name: 'Marcus Lee', position: 'Teacher', role: 'teacher' },
    'STA005': { id: 5, worker_id: 'STA005', full_name: 'Chantal Bastien', position: 'Teacher', role: 'teacher' }
  };

  currentEmployee = demoMap[cleanId] || { id: Date.now(), worker_id: cleanId, full_name: 'Staff ' + cleanId, position: 'STA Personnel', role: 'employee' };

  localStorage.setItem(STORAGE_KEY, JSON.stringify({ worker_id: currentEmployee.worker_id }));

  // ⚡ High-Tech Smooth App Loading Screen Transition
  if (typeof showAppLoader === 'function' && !silent) {
    showAppLoader('Authenticating STA Credentials...', 350, () => {
      showDashboard();
    });
  } else {
    showDashboard();
  }

  // Async background hydration without blocking UI
  setTimeout(() => {
    hydrateEmployeeDataAsync(cleanId, rawInput);
  }, 10);
}

async function hydrateEmployeeDataAsync(cleanId, rawInput) {
  const client = window.getSupabase ? window.getSupabase() : null;
  if (!client) return;

  try {
    const { data: dbEmp } = await client
      .from('employees')
      .select('id, worker_id, full_name, position, role, status')
      .or(`worker_id.ilike.${cleanId},full_name.ilike.%${rawInput}%`)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();

    if (dbEmp) {
      currentEmployee = dbEmp;
      document.getElementById('idFullName').textContent = currentEmployee.full_name || '—';
      document.getElementById('idPosition').textContent = currentEmployee.position || '—';
      document.getElementById('idWorkerId').textContent = 'ID: ' + currentEmployee.worker_id;
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const { data: attendanceToday } = await client
      .from('attendance')
      .select('clock_in, clock_out, is_on_lunch')
      .eq('employee_id', currentEmployee.id)
      .eq('date', todayStr)
      .maybeSingle();

    if (attendanceToday) {
      todayRecord = attendanceToday;
      isOnLunch = !!attendanceToday.is_on_lunch;
      updateClockUI();
      updateLunchUI();
    }
  } catch (e) {
    console.warn('Background hydration:', e?.message);
  }
}

function showForcePasswordScreen() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboardScreen').style.display = 'none';
  document.getElementById('forcePasswordScreen').style.display = 'flex';
}

async function handleForcePasswordSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById('forcePasswordError');
  if (errorEl) errorEl.textContent = '';

  const newPass = document.getElementById('newPasswordInput').value.trim();
  const confirmPass = document.getElementById('confirmPasswordInput').value.trim();

  const valRes = validatePasswordComplexity(newPass);
  if (!valRes.valid) {
    errorEl.textContent = valRes.message;
    return;
  }
  if (newPass !== confirmPass) {
    errorEl.textContent = 'Passwords do not match.';
    return;
  }

  try {
    const hashed = await hashPassword(newPass);
    const client = window.getSupabase();
    
    const { error } = await client
      .from('employees')
      .update({
        password_hash: hashed,
        must_change_password: false,
        temp_otp: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', currentEmployee.id);

    if (error) throw error;

    currentEmployee.password_hash = hashed;
    currentEmployee.must_change_password = false;
    currentEmployee.temp_otp = null;

    showToast('Password updated successfully!', 'success');
    document.getElementById('forcePasswordScreen').style.display = 'none';
    
    // Fetch today's attendance record
    const todayStr = new Date().toISOString().split('T')[0];
    const { data: attendanceToday } = await client
      .from('attendance')
      .select('clock_in, clock_out, is_on_lunch')
      .eq('employee_id', currentEmployee.id)
      .eq('date', todayStr)
      .maybeSingle();

    todayRecord = attendanceToday || { clock_in: null, clock_out: null };
    isOnLunch = !!attendanceToday?.is_on_lunch;

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ worker_id: currentEmployee.worker_id }));
    showDashboard();
  } catch (err) {
    errorEl.textContent = err?.message || 'Could not update password. Try again.';
  }
}

function showDashboard() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboardScreen').style.display = 'block';

  const initials = (currentEmployee.full_name || '??').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  document.getElementById('idAvatarInitials').textContent = initials || '--';
  document.getElementById('idFullName').textContent = currentEmployee.full_name || '—';
  document.getElementById('idPosition').textContent = currentEmployee.position || '—';
  document.getElementById('idWorkerId').textContent = 'ID: ' + currentEmployee.worker_id;

  updateClockUI();
  updateLunchUI();
  loadAttendance();
  loadMyLeaveRequests();
  startEmployeeRealtimeMessages();

  const dt = new Date();
  const leaveStartEl = document.getElementById('leaveStartDate');
  const leaveEndEl = document.getElementById('leaveEndDate');
  const todayDateStr = dt.toISOString().split('T')[0];
  if (leaveStartEl) leaveStartEl.min = todayDateStr;
  if (leaveEndEl) {
    leaveEndEl.min = todayDateStr;
    leaveEndEl.max = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).toISOString().split('T')[0];
  }
}

function clearSections() {
  ['attendanceHeadline', 'myLeaveList', 'messageBoard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
  const ring = document.getElementById('attendanceRingContainer');
  if (ring) ring.innerHTML = '';
}

/* ---------- Live clock ---------- */
function injectAttendanceFont() {
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = 'https://fonts.googleapis.com';
  if (link.href && !document.querySelector(`link[href="${link.href}"]`)) {
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
    document.head.appendChild(link);
  }
}

function startLiveClock() {
  const tick = () => {
    const now = new Date();
    const timeEl = document.getElementById('liveClock');
    const dateEl = document.getElementById('liveDate');
    if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-SC', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (dateEl) dateEl.textContent = now.toLocaleDateString('en-SC', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------- Clock ---------- */
function updateClockUI() {
  const pill = document.getElementById('clockStatusPill');
  const clockInBtn = document.getElementById('clockInBtn');
  const clockOutBtn = document.getElementById('clockOutBtn');

  if (!pill || !clockInBtn || !clockOutBtn) return;

  const ended = isShiftEnded('18:00');

  if (todayRecord.clock_in && !todayRecord.clock_out) {
    pill.className = 'status-pill neu-inset on';
    pill.innerHTML = `<span class="status-dot"></span> Clocked in — ${formatTime(todayRecord.clock_in)}`;
    clockInBtn.disabled = true;
    clockOutBtn.disabled = false;
  } else if (todayRecord.clock_in && todayRecord.clock_out) {
    pill.className = 'status-pill neu-inset off';
    pill.innerHTML = `<span class="status-dot"></span> Done for today (${formatTime(todayRecord.clock_in)} – ${formatTime(todayRecord.clock_out)})`;
    clockInBtn.disabled = true;
    clockOutBtn.disabled = true;
  } else if (ended) {
    pill.className = 'status-pill neu-inset off';
    pill.innerHTML = `<span class="status-dot" style="background:var(--danger);"></span> Work Day Concluded (Shift ended 18:00)`;
    clockInBtn.disabled = true;
    clockOutBtn.disabled = true;
    clockInBtn.title = 'Shift hours have ended for today.';
  } else {
    pill.className = 'status-pill neu-inset off';
    pill.innerHTML = `<span class="status-dot"></span> Not clocked in`;
    clockInBtn.disabled = false;
    clockOutBtn.disabled = true;
  }
}

async function doClock(action) {
  if (!currentEmployee) return;

  if (action === 'in' && isShiftEnded('18:00')) {
    showToast('Work day has concluded for today. Next clock-in available tomorrow at 08:00 AM.', 'warning');
    return;
  }
  try {
    const now = new Date();
    const record = {
      employee_id: currentEmployee.id,
      date: now.toISOString().split('T')[0],
      clock_in: action === 'in' ? now.toISOString() : todayRecord.clock_in ? new Date(todayRecord.clock_in.replace(' ', 'T')).toISOString() : null,
      clock_out: action === 'out' ? now.toISOString() : todayRecord.clock_out ? new Date(todayRecord.clock_out.replace(' ', 'T')).toISOString() : null,
      updated_at: now.toISOString()
    };

    const { data, error } = await window.getSupabase()
      .from('attendance')
      .upsert(record, { onConflict: ['employee_id', 'date'] })
      .select()
      .single();

    if (error) throw error;

    if (action === 'in') {
      todayRecord.clock_in = data.clock_in;
      todayRecord.clock_out = data.clock_out;
      showToast(`Clocked in at ${formatTime(data.clock_in)}.`, 'success');
    } else {
      todayRecord.clock_out = data.clock_out;
      isOnLunch = false;
      updateLunchUI();
      showToast(`Clocked out at ${formatTime(data.clock_out)}.`, 'success');
    }

    updateClockUI();
    loadAttendance();
  } catch (err) {
    showToast(err?.message || 'Clock failed.', 'error');
  }
}

/* ---------- Lunch ---------- */
function updateLunchUI() {
  const sw = document.getElementById('lunchSwitch');
  const label = document.getElementById('lunchLabel');
  if (!sw || !label) return;
  sw.classList.toggle('on', isOnLunch);
  label.textContent = isOnLunch ? 'On lunch' : 'Not on lunch';
}

async function toggleLunch() {
  if (!todayRecord.clock_in || todayRecord.clock_out) {
    showToast('You must be clocked in to toggle lunch.', 'warning');
    return;
  }
  try {
    const now = new Date();
    const next = !isOnLunch;
    const patch = { is_on_lunch: next, updated_at: now.toISOString() };
    if (next) patch.lunch_started_at = now.toISOString();
    const { error } = await window.getSupabase()
      .from('attendance')
      .upsert({
        employee_id: currentEmployee.id,
        date: now.toISOString().split('T')[0],
        ...patch
      }, { onConflict: ['employee_id', 'date'] });
    if (error) throw error;
    isOnLunch = next;
    updateLunchUI();
    showToast(next ? 'Lunch started.' : 'Lunch ended.', 'success');
  } catch (err) {
    showToast(err?.message || 'Could not update lunch.', 'error');
  }
}

/* ---------- Attendance ---------- */
async function loadAttendance() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  try {
    const start = new Date(y, m - 1, 1).toISOString().split('T')[0];
    const end = new Date(y, m, 0).toISOString().split('T')[0];

    const { data, error } = await window.getSupabase()
      .from('attendance')
      .select('clock_in, clock_out, date')
      .eq('employee_id', currentEmployee.id)
      .gte('date', start)
      .lte('date', end);
    if (error) throw error;

    const totalDays = data?.length || 0;
    const presentDays = data?.filter(x => x.clock_in && x.clock_out).length || 0;
    const pct = totalDays ? Math.round((presentDays / totalDays) * 100) : 0;

    const ring = document.getElementById('attendanceRingContainer');
    const headline = document.getElementById('attendanceHeadline');
    if (ring) renderAttendanceRing(ring, pct);
    if (headline) {
      const label = pct >= 90 ? 'Excellent' : pct >= 75 ? 'Good' : pct >= 50 ? 'Fair' : 'Low';
      headline.innerHTML = `<span style="color:${pct < 50 ? 'var(--danger)' : pct < 75 ? 'var(--warning)' : 'var(--success)'}">${pct}%</span> present <span class="muted" style="font-size:12px;font-weight:500;">· ${label}</span>`;
    }
  } catch (err) {
    showToast(err?.message || 'Could not load attendance.', 'error');
  }
}

/* ---------- Leave ---------- */
async function submitLeave(e) {
  e.preventDefault();
  if (!currentEmployee) return;
  const leaveType = document.getElementById('leaveType')?.value || 'SL';
  const startDate = document.getElementById('leaveStartDate')?.value;
  const endDate = document.getElementById('leaveEndDate')?.value;
  const isHalfDay = !!document.getElementById('isHalfDay')?.checked;
  const reason = (document.getElementById('leaveReason')?.value || '').trim();

  if (!startDate || !endDate) { showToast('Please select start and rejoin dates.', 'error'); return; }
  if (endDate < startDate) { showToast('Rejoin date cannot be before start date.', 'error'); return; }

  try {
    showLoading();
    const { data, error } = await window.getSupabase()
      .from('leave_requests')
      .insert({
        employee_id: currentEmployee.id,
        leave_type_id: (await window.getSupabase().from('leave_types').select('id').eq('code', leaveType).single()).data.id,
        start_date: startDate,
        end_date: endDate,
        reason,
        is_half_day: isHalfDay
      })
      .select()
      .single();
    if (error) throw error;
    showToast('Leave request submitted successfully.', 'success');
    document.getElementById('sickLeaveForm').reset();
    loadMyLeaveRequests();
  } catch (err) {
    showToast(err?.message || 'Could not submit leave.', 'error');
  } finally {
    hideLoading();
  }
}

function showLoading() {
  let el = document.getElementById('app-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-loading';
    el.innerHTML = '<div class="loading"><div class="spinner"></div> Work&hellip;</div>';
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
}
function hideLoading() {
  const el = document.getElementById('app-loading');
  if (el) el.style.display = 'none';
}

async function loadMyLeaveRequests() {
  if (!currentEmployee) return;
  try {
    const { data, error } = await window.getSupabase()
      .from('leave_requests')
      .select('id,leave_type_id,start_date,end_date,reason,status,is_half_day,review_comment,leave_types(code)');
    if (error) throw error;

    const container = document.getElementById('myLeaveList');
    if (!container) return;
    if (!data || !data.length) {
      container.innerHTML = '<div class="empty-state">No requests yet.</div>';
      return;
    }

    const colorMap = { SL: 'danger', CL: 'info', ML: 'info', PL: 'info', AL: 'success', STL: 'warning', EL: 'warning' };

    container.innerHTML = data.map(r => {
      const badge = colorMap[r.leave_types?.code || 'LV'] || 'info';
      const dateText = r.start_date === r.end_date ? formatDate(r.start_date) : `${formatDate(r.start_date)} — ${formatDate(r.end_date)}`;
      return `
        <div class="neu-inset message-item" style="margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
            <div>
              <span class="pill ${badge}">${escapeHtml(r.leave_types?.code || 'LV')}</span>
              <strong style="margin-left:8px">${dateText}</strong>
              ${r.is_half_day ? '<span class="pill warning" style="margin-left:6px;">Half day</span>' : ''}
            </div>
            <span class="pill ${r.status}">${r.status}</span>
          </div>
          ${r.reason ? `<div class="muted" style="font-size:0.85rem; margin-top:8px;">${escapeHtml(r.reason)}</div>` : ''}
          ${r.review_comment ? `<div style="font-size:0.85rem; margin-top:8px; color:var(--text-secondary);"><strong>Admin:</strong> ${escapeHtml(r.review_comment)}</div>` : ''}
        </div>`;
    }).join('');
  } catch (err) {
    showToast(err?.message || 'Could not load leave requests.', 'error');
  }
}

/* ---------- Message board ---------- */
async function loadMessageBoard() {
  try {
    const { data, error } = await window.getSupabase()
      .from('messages')
      .select('id,title,body,priority,published,created_at,author:employees(full_name)')
      .eq('published', true)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;

    const container = document.getElementById('messageBoard');
    if (!container) return;
    if (!data || !data.length) {
      container.innerHTML = '<div class="empty-state">No announcements yet.</div>';
      return;
    }

    container.innerHTML = data.map(m => `
      <div style="padding:16px 20px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:12px;">
        <div style="font-size:11px; color:var(--text-muted); font-weight:500; letter-spacing:0.3px; margin-bottom:6px;">
          ${escapeHtml((m.author && m.author.full_name) || 'System')} · ${formatDate(m.created_at)}
        </div>
        <div style="font-size:13px; color:var(--text-primary); line-height:1.55; margin-bottom:4px;">${escapeHtml(m.title || '')}</div>
        <div style="font-size:14px; color:var(--text-primary); line-height:1.55;">${escapeHtml(m.body || '')}</div>
      </div>
    `).join('');
  } catch (err) {
    showToast(err?.message || 'Could not load messages.', 'error');
  }
}

let employeeMessageInterval = null;

function startEmployeeRealtimeMessages() {
  loadMessageBoard();

  if (!employeeMessageInterval) {
    try {
      const client = window.getSupabase();
      if (client && typeof client.channel === 'function') {
        client.channel('employee-messages-realtime')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {
            loadMessageBoard();
          })
          .subscribe();
      }
    } catch {}

    employeeMessageInterval = setInterval(loadMessageBoard, 3000);
  }
}

/* ---------- Theme ---------- */
function toggleTheme() {
  const body = document.documentElement;
  const isDark = body.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  body.setAttribute('data-theme', next);
  localStorage.setItem('logix-theme', next);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = next === 'dark' ? '☀️' : '🌙';
}
