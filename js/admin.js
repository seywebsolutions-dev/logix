/**
 * ============================================================
 *  Logix — Admin dashboard
 * ============================================================
 *  Reads go through RLS-protected views. Every write goes
 *  through a SECURITY DEFINER RPC that re-checks the caller's
 *  session token and admin role in the database.
 */
'use strict';

const loginScreen = document.getElementById('adminLoginScreen');
const dashboard = document.getElementById('adminDashboard');

let adminSessionToken = null;
let adminProfile = null;
let allEmployees = [];
let currentWorksite = null;

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();

  const saved = getStoredAdminSession();
  if (saved && saved.token) {
    try {
      const who = await rpc('whoami', { p_token: saved.token });
      const row = Array.isArray(who) ? who[0] : who;
      if (row && ['super_admin', 'principal', 'hod'].includes(row.role)) {
        adminSessionToken = saved.token;
        adminProfile = row;
        showDashboard();
        return;
      }
    } catch { /* fall through */ }
  }
  localStorage.removeItem('logix-admin-session');
  loginScreen.classList.remove('hidden');
  dashboard.classList.add('hidden');
});

function getStoredAdminSession() {
  try { return JSON.parse(localStorage.getItem('logix-admin-session') || 'null'); }
  catch { return null; }
}

function bindEvents() {
  document.getElementById('adminLoginForm').addEventListener('submit', handleLogin);
  document.getElementById('adminLogoutBtn').addEventListener('click', handleLogout);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  const on = (id, evt, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  };

  on('refreshAttendanceBtn', 'click', loadAttendance);
  on('exportAllAttendanceBtn', 'click', exportAllAttendanceCSV);
  on('exportPdfAttendanceBtn', 'click', exportAttendancePDFReport);
  on('refreshLeavesBtn', 'click', loadLeaves);
  on('refreshEmployeesBtn', 'click', loadEmployees);
  on('bulkPreviewBtn', 'click', previewBulkImport);
  on('bulkImportBtn', 'click', runBulkImport);
  on('refreshAuditBtn', 'click', loadAuditTrail);
  on('refreshDeniedBtn', 'click', loadDeniedAttempts);
  on('addEmployeeForm', 'submit', addEmployee);
  on('postMessageForm', 'submit', postMessage);
  on('editEmployeeForm', 'submit', saveEditEmployee);
  on('worksiteForm', 'submit', saveWorksite);
  on('addNetworkForm', 'submit', addNetwork);
  on('useMyLocationBtn', 'click', useMyLocation);
  on('employeeSearchInput', 'input', (e) => renderEmployeesList(e.target.value));
  on('closeEditModalBtn', 'click', closeEditModal);
  on('cancelEditModalBtn', 'click', closeEditModal);
  on('closeOtpModalBtn', 'click', () => document.getElementById('resetOtpModal').classList.remove('open'));
}

/* ============================================================
   Auth
   ============================================================ */
async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('adminUsername').value.trim();
  const password = document.getElementById('adminPassword').value;
  const errorEl = document.getElementById('adminLoginError');
  errorEl.textContent = '';

  if (!username || !password) {
    errorEl.textContent = 'Enter your ID and password.';
    return;
  }

  try {
    const result = await rpc('verify_login', {
      p_identifier: username.toUpperCase(), p_password: password, p_require_admin: true
    });
    const row = Array.isArray(result) ? result[0] : result;

    if (!row) {
      errorEl.textContent = 'Those details do not match an administrator account.';
      return;
    }

    if (row.must_change_password) {
      errorEl.textContent = 'This account is still on a temporary code. Sign in on the employee portal first to set a permanent password.';
      try { await rpc('logout', { p_token: row.token }); } catch {}
      return;
    }

    adminSessionToken = row.token;
    adminProfile = row;
    localStorage.setItem('logix-admin-session', JSON.stringify({
      token: row.token, id: row.id, name: row.full_name, role: row.role
    }));

    showAppLoader('Signing in…', 320, showDashboard);
  } catch (err) {
    errorEl.textContent = err?.message || 'Could not sign in. Try again.';
  }
}

async function handleLogout() {
  if (adminSessionToken) { try { await rpc('logout', { p_token: adminSessionToken }); } catch {} }
  localStorage.removeItem('logix-admin-session');
  adminSessionToken = null;
  adminProfile = null;
  dashboard.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  document.getElementById('adminUsername').value = '';
  document.getElementById('adminPassword').value = '';
}

function showDashboard() {
  loginScreen.classList.add('hidden');
  dashboard.classList.remove('hidden');
  initChrome();

  const who = document.getElementById('adminWhoami');
  if (who && adminProfile) {
    who.textContent = `${adminProfile.full_name} · ${adminProfile.role.replace('_', ' ')}`;
  }

  loadAttendance();
  loadLeaves();
  loadEmployees();
  loadAdminMessageBoard();
  loadSecurity();
  switchTab('attendance');
  startRealtimeMessages();
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'audit') loadAuditTrail();
  if (tab === 'security') loadSecurity();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================
   Attendance
   ============================================================ */
async function loadAttendance() {
  const body = document.getElementById('attendanceTableBody');
  if (!body) return;

  try {
    const todayStr = new Date().toISOString().split('T')[0];
    const [attRes, empRes] = await Promise.all([
      getSupabase().from('attendance').select('*').eq('date', todayStr),
      getSupabase().from('employees').select('*').eq('status', 'active').order('worker_id')
    ]);

    const records = (attRes?.data || []).reduce((acc, x) => { acc[x.employee_id] = x; return acc; }, {});
    const employees = empRes?.data || [];

    let onDuty = 0, lunch = 0, done = 0, absent = 0;

    if (!employees.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty-state">No active staff yet.</td></tr>';
    } else {
      body.innerHTML = employees.map(emp => {
        const t = records[emp.id];
        let badge;
        if (t?.is_on_lunch) { badge = '<span class="badge warning">On lunch</span>'; lunch++; }
        else if (t?.clock_out) { badge = '<span class="badge success">Finished</span>'; done++; }
        else if (t?.clock_in) { badge = '<span class="badge info">On duty</span>'; onDuty++; }
        else { badge = '<span class="badge">Not arrived</span>'; absent++; }

        return `
          <tr>
            <td data-label="Employee">
              <div class="who">
                ${avatarFor(emp)}
                <div>
                  <div class="name">${escapeHtml(emp.full_name)}</div>
                  <div class="sub">${escapeHtml(emp.worker_id)} · ${escapeHtml(emp.position || '')}</div>
                </div>
              </div>
            </td>
            <td data-label="In" class="mono tnum">${formatTime(t?.clock_in)}</td>
            <td data-label="Out" class="mono tnum">${formatTime(t?.clock_out)}</td>
            <td data-label="Hours" class="mono tnum">${computeHours(t?.clock_in, t?.clock_out)}</td>
            <td data-label="Status">${badge}</td>
            <td data-label="">
              <button class="btn sm" onclick="exportEmployeeAttendanceCSV(${emp.id}, '${escapeHtml(emp.full_name).replace(/'/g, "\\'")}')">CSV</button>
            </td>
          </tr>`;
      }).join('');
    }

    setText('statOnDuty', onDuty);
    setText('statLunch', lunch);
    setText('statDone', done);
    setText('statAbsent', absent);
  } catch (err) {
    showToast(err?.message || 'Could not load attendance.', 'error');
  }
}

function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
}

function avatarFor(emp) {
  if (emp.photo_url) {
    return `<img class="avatar sm" src="${escapeHtml(emp.photo_url)}" alt="">`;
  }
  const initials = (emp.full_name || '??').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return `<div class="avatar sm">${escapeHtml(initials)}</div>`;
}

function computeHours(inStr, outStr) {
  if (!inStr || !outStr) return '–';
  const a = new Date(inStr), b = new Date(outStr);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '–';
  return ((b - a) / 3600000).toFixed(1) + ' h';
}

/* ---------- Exports ---------- */
async function exportEmployeeAttendanceCSV(empId, empName) {
  try {
    const { data, error } = await getSupabase()
      .from('attendance').select('*').eq('employee_id', empId).order('date', { ascending: false });
    if (error) throw error;
    if (!data?.length) { showToast(`No records for ${empName}.`, 'warning'); return; }

    let csv = 'Date,Employee,Clock In,Clock Out,Hours,On Lunch\n';
    data.forEach(r => {
      csv += [
        r.date, empName, formatTime(r.clock_in), formatTime(r.clock_out),
        computeHours(r.clock_in, r.clock_out), r.is_on_lunch ? 'Yes' : 'No'
      ].map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',') + '\n';
    });

    downloadCSV(csv, `STA_Attendance_${empName.replace(/\s+/g, '_')}.csv`);
    showToast(`Exported ${empName}'s record.`, 'success');
  } catch (err) {
    showToast(err?.message || 'Could not export.', 'error');
  }
}
window.exportEmployeeAttendanceCSV = exportEmployeeAttendanceCSV;

async function exportAllAttendanceCSV() {
  try {
    const [attRes, empRes] = await Promise.all([
      getSupabase().from('attendance').select('*').order('date', { ascending: false }),
      getSupabase().from('employees').select('id,full_name,worker_id,position')
    ]);
    const empMap = (empRes?.data || []).reduce((a, x) => { a[x.id] = x; return a; }, {});
    const rows = attRes?.data || [];
    if (!rows.length) { showToast('No attendance recorded yet.', 'warning'); return; }

    let csv = 'Date,Worker ID,Employee,Position,Clock In,Clock Out,Hours\n';
    rows.forEach(r => {
      const e = empMap[r.employee_id] || {};
      csv += [
        r.date, e.worker_id || r.employee_id, e.full_name || '', e.position || '',
        formatTime(r.clock_in), formatTime(r.clock_out), computeHours(r.clock_in, r.clock_out)
      ].map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',') + '\n';
    });

    downloadCSV(csv, `STA_Attendance_All.csv`);
    showToast('Full attendance export ready.', 'success');
  } catch (err) {
    showToast(err?.message || 'Could not export.', 'error');
  }
}

function downloadCSV(content, fileName) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function exportAttendancePDFReport() {
  try {
    const todayStr = new Date().toISOString().split('T')[0];
    const [attRes, empRes] = await Promise.all([
      getSupabase().from('attendance').select('*').eq('date', todayStr),
      getSupabase().from('employees').select('*').eq('status', 'active').order('worker_id')
    ]);
    const records = (attRes?.data || []).reduce((a, x) => { a[x.employee_id] = x; return a; }, {});

    const rows = (empRes?.data || []).map(emp => {
      const t = records[emp.id];
      const status = t?.is_on_lunch ? 'On lunch' : t?.clock_out ? 'Finished' : t?.clock_in ? 'On duty' : 'Not arrived';
      return [emp.worker_id, emp.full_name, emp.position || '', formatTime(t?.clock_in), formatTime(t?.clock_out), computeHours(t?.clock_in, t?.clock_out), status];
    });

    printGovernmentPDFReport(`Daily attendance — ${todayStr}`,
      ['Worker ID', 'Name', 'Position', 'In', 'Out', 'Hours', 'Status'], rows);
    logAuditTrail('EXPORT_PDF', 'All staff', `Daily attendance report for ${todayStr}`);
  } catch (err) {
    showToast(err?.message || 'Could not build the report.', 'error');
  }
}

/* ============================================================
   Leave
   ============================================================ */
async function loadLeaves() {
  const body = document.getElementById('leavesTableBody');
  if (!body) return;

  try {
    const { data, error } = await getSupabase()
      .from('leave_requests')
      .select('id,employee_id,start_date,end_date,reason,status,is_half_day,review_comment,employees(full_name,position,worker_id),leave_types(code,name)')
      .order('requested_at', { ascending: false });
    if (error) throw error;

    if (!data?.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty-state">No leave requests.</td></tr>';
      return;
    }

    body.innerHTML = data.map(r => {
      const dates = r.start_date === r.end_date
        ? formatDate(r.start_date)
        : `${formatDate(r.start_date)} → ${formatDate(r.end_date)}`;
      return `
        <tr>
          <td data-label="Employee">
            <div class="name">${escapeHtml(r.employees?.full_name || '')}</div>
            <div class="sub">${escapeHtml(r.employees?.worker_id || '')} · ${escapeHtml(r.employees?.position || '')}</div>
          </td>
          <td data-label="Type">
            <span class="badge info">${escapeHtml(r.leave_types?.name || 'Leave')}</span>
            <div class="sub" style="margin-top:4px;">${dates}${r.is_half_day ? ' · half day' : ''}</div>
            ${r.status === 'pending' && r.leave_types?.code
              ? `<div class="sub balance-slot" data-emp="${r.employee_id}" data-code="${escapeHtml(r.leave_types.code)}" data-year="${new Date(r.start_date).getFullYear()}"></div>`
              : ''}
          </td>
          <td data-label="Reason">${escapeHtml(r.reason || '—')}</td>
          <td data-label="Status"><span class="badge ${r.status}">${escapeHtml(r.status)}</span></td>
          <td data-label="Note">${escapeHtml(r.review_comment || '—')}</td>
          <td data-label="">
            ${r.status === 'pending' ? `
              <div class="row-actions">
                <button class="btn sm success" onclick="reviewLeave(${r.id}, 'approved')">Approve</button>
                <button class="btn sm danger" onclick="reviewLeave(${r.id}, 'denied')">Decline</button>
              </div>` : '—'}
          </td>
        </tr>`;
    }).join('');

    fillLeaveBalanceSlots();
  } catch (err) {
    showToast(err?.message || 'Could not load leave requests.', 'error');
  }
}

// Shows how much of the allowance is left next to each pending request, so a
// decision is not made blind. One lookup per employee/year, not per row.
async function fillLeaveBalanceSlots() {
  const slots = Array.from(document.querySelectorAll('.balance-slot'));
  if (!slots.length) return;

  const keys = [...new Set(slots.map(el => `${el.dataset.emp}|${el.dataset.year}`))];

  await Promise.all(keys.map(async key => {
    const [empId, year] = key.split('|');
    let rows;
    try {
      rows = await rpc('admin_leave_balances', {
        p_token: adminSessionToken,
        p_employee_id: Number(empId),
        p_year: Number(year)
      });
    } catch {
      return; // a missing balance should not break the review table
    }

    const byCode = new Map((rows || []).map(r => [r.leave_code, r]));

    slots
      .filter(el => el.dataset.emp === empId && el.dataset.year === year)
      .forEach(el => {
        const b = byCode.get(el.dataset.code);
        if (!b) { el.textContent = 'No annual limit'; return; }

        const available = Math.max((Number(b.remaining) || 0) - (Number(b.pending) || 0), 0);
        const entitled = Number(b.entitled) || 0;
        el.textContent = `${available} of ${entitled} days left`;
        if (available <= 0) el.classList.add('balance-none');
        else if (entitled > 0 && available / entitled <= 0.25) el.classList.add('balance-low');
      });
  }));
}

async function reviewLeave(id, status) {
  const comment = status === 'approved'
    ? prompt('Note for the employee (optional):')
    : prompt('Why is this being declined?');
  if (status === 'denied' && comment === null) return;

  try {
    await rpc('admin_review_leave', {
      p_token: adminSessionToken, p_leave_id: id, p_status: status, p_comment: comment || ''
    });
    showToast(`Request ${status}.`, 'success');
    loadLeaves();
  } catch (err) {
    showToast(err?.message || 'Could not update the request.', 'error');
  }
}
window.reviewLeave = reviewLeave;

/* ============================================================
   Staff
   ============================================================ */
async function loadEmployees() {
  try {
    const [empRes, deptRes] = await Promise.all([
      getSupabase().from('employees').select('*').eq('status', 'active').order('worker_id'),
      getSupabase().from('departments').select('id,name,code')
    ]);

    allEmployees = empRes?.data || [];
    const departments = deptRes?.data || [];
    const options = '<option value="">Select department</option>' +
      departments.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');

    ['newDepartment', 'editDepartment'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = options;
    });

    renderEmployeesList();
  } catch (err) {
    showToast(err?.message || 'Could not load staff.', 'error');
  }
}

function renderEmployeesList(filter = '') {
  const container = document.getElementById('employeesList');
  if (!container) return;

  const q = filter.trim().toLowerCase();
  const list = allEmployees.filter(e => !q ||
    [e.full_name, e.worker_id, e.position, e.email].some(f => (f || '').toLowerCase().includes(q)));

  if (!list.length) {
    container.innerHTML = '<div class="empty-state">No matching staff.</div>';
    return;
  }

  container.innerHTML = list.map(emp => {
    const age = calculateAge(emp.date_of_birth);
    const safeName = escapeHtml(emp.full_name).replace(/'/g, "\\'");
    return `
      <div class="row-item">
        <div class="who">
          ${avatarFor(emp)}
          <div>
            <div class="name">${escapeHtml(emp.full_name)}</div>
            <div class="sub">${escapeHtml(emp.position || '')} · ${escapeHtml(emp.worker_id)}${age !== null ? ` · ${age}` : ''}</div>
            <div class="tiny">${escapeHtml(emp.email || 'No email')}</div>
          </div>
        </div>
        <div class="row-actions">
          <button class="btn sm" onclick="openEditModal(${emp.id})">Edit</button>
          <button class="btn sm" onclick="resetEmployeePassword(${emp.id}, '${safeName}')">Reset code</button>
          <button class="btn sm danger" onclick="removeEmployee(${emp.id}, '${safeName}')">Remove</button>
        </div>
      </div>`;
  }).join('');
}

async function addEmployee(e) {
  e.preventDefault();
  const val = (id) => document.getElementById(id).value.trim();

  try {
    const tempOtp = generateTempOTP();
    const photoFile = document.getElementById('newPhoto')?.files[0];
    const photoUrl = photoFile ? await uploadPhotoFile(photoFile, val('newWorkerId')) : null;
    const dept = document.getElementById('newDepartment').value;

    await rpc('admin_add_employee', {
      p_token: adminSessionToken,
      p_worker_id: val('newWorkerId').toUpperCase(),
      p_full_name: val('newFullName'),
      p_position: val('newPosition'),
      p_date_of_birth: val('newDob') || null,
      p_department_id: dept ? Number(dept) : null,
      p_employment_type: document.getElementById('newEmploymentType').value,
      p_email: val('newEmail') || null,
      p_phone: val('newPhone') || null,
      p_photo_url: photoUrl,
      p_temp_otp: tempOtp
    });

    document.getElementById('addEmployeeForm').reset();
    showOtpModal(tempOtp, val('newEmail')
      ? `Send this to ${val('newEmail')}.`
      : 'Give this code to the employee.');
    showToast('Staff member added.', 'success');
    loadEmployees();
    loadAttendance();
  } catch (err) {
    showToast(err?.message || 'Could not add that person.', 'error');
  }
}

function showOtpModal(otp, notice) {
  document.getElementById('generatedOtpDisplay').textContent = otp;
  document.getElementById('otpEmailNotice').textContent = notice || '';
  document.getElementById('resetOtpModal').classList.add('open');
}

async function uploadPhotoFile(file, prefix) {
  try {
    const client = getSupabase();
    const ext = file.name.split('.').pop();
    const path = `${prefix}_${Date.now()}.${ext}`;
    const { error } = await client.storage.from('employee-photos').upload(path, file, { upsert: true });
    if (error) throw error;
    return client.storage.from('employee-photos').getPublicUrl(path).data.publicUrl;
  } catch {
    // Storage bucket missing — fall back to an inline data URL.
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
  }
}

function openEditModal(id) {
  const emp = allEmployees.find(x => x.id === id);
  if (!emp) return;
  document.getElementById('editEmployeeId').value = emp.id;
  document.getElementById('editWorkerId').value = emp.worker_id;
  document.getElementById('editFullName').value = emp.full_name || '';
  document.getElementById('editDob').value = emp.date_of_birth || '';
  document.getElementById('editPosition').value = emp.position || '';
  document.getElementById('editDepartment').value = emp.department_id || '';
  document.getElementById('editEmail').value = emp.email || '';
  document.getElementById('editEmployeeModal').classList.add('open');
}
window.openEditModal = openEditModal;

function closeEditModal() {
  document.getElementById('editEmployeeModal').classList.remove('open');
}

async function saveEditEmployee(e) {
  e.preventDefault();
  const id = Number(document.getElementById('editEmployeeId').value);
  const val = (x) => document.getElementById(x).value.trim();

  try {
    const photoFile = document.getElementById('editPhoto')?.files[0];
    const emp = allEmployees.find(x => x.id === id);
    const photoUrl = photoFile ? await uploadPhotoFile(photoFile, emp?.worker_id || 'EMP') : null;
    const dept = document.getElementById('editDepartment').value;

    await rpc('admin_update_employee', {
      p_token: adminSessionToken,
      p_employee_id: id,
      p_full_name: val('editFullName'),
      p_date_of_birth: val('editDob') || null,
      p_position: val('editPosition'),
      p_department_id: dept ? Number(dept) : null,
      p_email: val('editEmail') || null,
      p_photo_url: photoUrl
    });

    showToast('Profile updated.', 'success');
    closeEditModal();
    loadEmployees();
    loadAttendance();
  } catch (err) {
    showToast(err?.message || 'Could not save those changes.', 'error');
  }
}

async function resetEmployeePassword(id, name) {
  if (!confirm(`Reset the password for ${name}? They will get a new one-time code.`)) return;
  try {
    const otp = generateTempOTP();
    await rpc('admin_reset_employee_otp', {
      p_token: adminSessionToken, p_employee_id: id, p_new_otp: otp
    });
    showOtpModal(otp, `${name} must set a new password at their next sign-in.`);
    loadEmployees();
  } catch (err) {
    showToast(err?.message || 'Could not reset that password.', 'error');
  }
}
window.resetEmployeePassword = resetEmployeePassword;

async function removeEmployee(id, name) {
  if (!confirm(`Remove ${name} from active staff? Their history is kept.`)) return;
  try {
    await rpc('admin_set_employee_status', {
      p_token: adminSessionToken, p_employee_id: id, p_status: 'inactive'
    });
    showToast(`${name} moved to inactive.`, 'success');
    loadEmployees();
    loadAttendance();
  } catch (err) {
    showToast(err?.message || 'Could not remove that person.', 'error');
  }
}
window.removeEmployee = removeEmployee;

/* ============================================================
   Announcements
   ============================================================ */
async function postMessage(e) {
  e.preventDefault();
  const el = document.getElementById('newMessageText');
  const message = el.value.trim();
  if (!message) { showToast('Write something first.', 'warning'); return; }

  try {
    const title = message.length > 60 ? message.slice(0, 60) + '…' : message;
    await rpc('admin_post_message', {
      p_token: adminSessionToken, p_title: title, p_body: message, p_priority: 'normal'
    });
    el.value = '';
    showToast('Announcement posted.', 'success');
    loadAdminMessageBoard();
  } catch (err) {
    showToast(err?.message || 'Could not post that.', 'error');
  }
}

async function loadAdminMessageBoard() {
  const container = document.getElementById('adminMessageBoard');
  if (!container) return;

  try {
    const { data, error } = await getSupabase()
      .from('messages')
      .select('id,body,created_at,author:employees(full_name)')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;

    if (!data?.length) {
      container.innerHTML = '<div class="empty-state">Nothing posted yet.</div>';
      return;
    }

    container.innerHTML = data.map(m => `
      <article class="announcement">
        <div style="display:flex; justify-content:space-between; gap:var(--sp-3); align-items:flex-start;">
          <div>
            <div class="meta">${escapeHtml(m.author?.full_name || 'Management')} · ${formatDate(m.created_at)}</div>
            <div class="body">${escapeHtml(m.body || '')}</div>
          </div>
          <button class="btn sm danger" onclick="deleteMessage(${m.id})">Delete</button>
        </div>
      </article>
    `).join('');
  } catch (err) {
    showToast(err?.message || 'Could not load announcements.', 'error');
  }
}

async function deleteMessage(id) {
  if (!confirm('Delete this announcement?')) return;
  try {
    await rpc('admin_delete_message', { p_token: adminSessionToken, p_message_id: id });
    showToast('Announcement deleted.', 'success');
    loadAdminMessageBoard();
  } catch (err) {
    showToast(err?.message || 'Could not delete that.', 'error');
  }
}
window.deleteMessage = deleteMessage;

function startRealtimeMessages() {
  try {
    const client = getSupabase();
    if (client && typeof client.channel === 'function') {
      client.channel('admin-messages')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, loadAdminMessageBoard)
        .subscribe();
    }
  } catch { /* realtime optional */ }
}

/* ============================================================
   Site security
   ============================================================ */
async function loadSecurity() {
  try {
    const [siteRes, netRes] = await Promise.all([
      getSupabase().from('worksites').select('*').order('id').limit(1),
      getSupabase().from('worksite_networks').select('*').order('id')
    ]);

    currentWorksite = siteRes?.data?.[0] || null;
    renderEnforcementNotice(currentWorksite, netRes?.data || []);

    if (currentWorksite) {
      document.getElementById('worksiteId').value = currentWorksite.id;
      document.getElementById('worksiteName').value = currentWorksite.name || '';
      document.getElementById('worksiteLat').value = currentWorksite.latitude ?? '';
      document.getElementById('worksiteLng').value = currentWorksite.longitude ?? '';
      document.getElementById('worksiteRadius').value = currentWorksite.radius_meters ?? 200;
      document.getElementById('requireNetwork').checked = !!currentWorksite.require_network;
      document.getElementById('requireLocation').checked = !!currentWorksite.require_location;
    }

    renderNetworks(netRes?.data || []);
    loadCurrentIp();
    loadDeniedAttempts();
  } catch (err) {
    showToast(err?.message || 'Could not load the security settings.', 'error');
  }
}

function renderEnforcementNotice(site, networks) {
  const el = document.getElementById('enforcementNotice');
  if (!el) return;

  if (!site || !site.is_active) {
    el.innerHTML = `<div class="notice">
      <strong>Enforcement is off.</strong> Until you save a campus site below, staff can
      clock in from anywhere — including from home.
    </div>`;
  } else if (site.require_network && !networks.length) {
    el.innerHTML = `<div class="notice">
      <strong>No networks registered.</strong> You require the academy network but have not
      added any addresses, so every clock-in will be refused. Add your campus address below.
    </div>`;
  } else {
    el.innerHTML = '';
  }
}

async function loadCurrentIp() {
  const el = document.getElementById('currentIpNotice');
  if (!el) return;
  try {
    const info = await rpc('my_network_info', { p_token: adminSessionToken });
    const ip = info?.ip;
    if (!ip) { el.textContent = 'Could not detect your current address.'; return; }
    el.innerHTML = `Your device is connecting from <strong class="mono">${escapeHtml(ip)}</strong>.
      If you are on the STA WiFi right now,
      <a href="#" id="useMyIpLink">use this address</a>.`;
    const link = document.getElementById('useMyIpLink');
    if (link) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('networkCidr').value = ip;
        document.getElementById('networkLabel').focus();
      });
    }
  } catch {
    el.textContent = 'Could not detect your current address.';
  }
}

function renderNetworks(networks) {
  const container = document.getElementById('networksList');
  if (!container) return;

  if (!networks.length) {
    container.innerHTML = '<div class="empty-state">No networks registered yet.</div>';
    return;
  }

  container.innerHTML = networks.map(n => `
    <div class="row-item">
      <div>
        <div class="name mono">${escapeHtml(n.cidr)}</div>
        <div class="sub">${escapeHtml(n.label || 'Unlabelled')}</div>
      </div>
      <button class="btn sm danger" onclick="deleteNetwork(${n.id})">Remove</button>
    </div>
  `).join('');
}

async function useMyLocation() {
  const btn = document.getElementById('useMyLocationBtn');
  btn.disabled = true;
  btn.textContent = 'Locating…';
  const pos = await getPosition();
  btn.disabled = false;
  btn.textContent = 'Use my current location';

  if (!pos) {
    showToast('Could not read your location. Check that location access is allowed.', 'warning');
    return;
  }
  document.getElementById('worksiteLat').value = pos.lat.toFixed(6);
  document.getElementById('worksiteLng').value = pos.lng.toFixed(6);
  showToast(`Location set (±${Math.round(pos.accuracy)} m).`, 'success');
}

async function saveWorksite(e) {
  e.preventDefault();
  const num = (id) => {
    const v = document.getElementById(id).value.trim();
    return v === '' ? null : Number(v);
  };

  try {
    await rpc('admin_save_worksite', {
      p_token: adminSessionToken,
      p_id: document.getElementById('worksiteId').value ? Number(document.getElementById('worksiteId').value) : null,
      p_name: document.getElementById('worksiteName').value.trim(),
      p_lat: num('worksiteLat'),
      p_lng: num('worksiteLng'),
      p_radius: num('worksiteRadius'),
      p_require_network: document.getElementById('requireNetwork').checked,
      p_require_location: document.getElementById('requireLocation').checked,
      p_is_active: true
    });
    showToast('Site saved. Enforcement is live.', 'success');
    logAuditTrail('SAVE_WORKSITE', document.getElementById('worksiteName').value.trim(), 'Updated clock-in site rules');
    loadSecurity();
  } catch (err) {
    showToast(err?.message || 'Could not save the site.', 'error');
  }
}

async function addNetwork(e) {
  e.preventDefault();
  if (!currentWorksite) {
    showToast('Save the campus site first, then add its networks.', 'warning');
    return;
  }
  try {
    await rpc('admin_add_network', {
      p_token: adminSessionToken,
      p_worksite_id: currentWorksite.id,
      p_cidr: document.getElementById('networkCidr').value.trim(),
      p_label: document.getElementById('networkLabel').value.trim() || null
    });
    document.getElementById('addNetworkForm').reset();
    showToast('Network added.', 'success');
    loadSecurity();
  } catch (err) {
    showToast(err?.message || 'Could not add that network.', 'error');
  }
}

async function deleteNetwork(id) {
  if (!confirm('Remove this network? Staff on it will no longer be able to clock in.')) return;
  try {
    await rpc('admin_delete_network', { p_token: adminSessionToken, p_id: id });
    showToast('Network removed.', 'success');
    loadSecurity();
  } catch (err) {
    showToast(err?.message || 'Could not remove that network.', 'error');
  }
}
window.deleteNetwork = deleteNetwork;

async function loadDeniedAttempts() {
  const body = document.getElementById('deniedTableBody');
  if (!body) return;

  try {
    const { data, error } = await getSupabase()
      .from('clock_events')
      .select('id,action,ip,denial_reason,created_at,employee_id,allowed')
      .eq('allowed', false)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    if (!data?.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty-state">No blocked attempts. Good sign.</td></tr>';
      return;
    }

    const byId = allEmployees.reduce((a, e) => { a[e.id] = e; return a; }, {});

    body.innerHTML = data.map(ev => {
      const emp = byId[ev.employee_id];
      return `
        <tr>
          <td data-label="When" class="mono">${formatDate(ev.created_at)} ${formatTime(ev.created_at)}</td>
          <td data-label="Employee">${escapeHtml(emp ? emp.full_name : 'Unknown')}</td>
          <td data-label="Action"><span class="badge">Clock ${escapeHtml(ev.action)}</span></td>
          <td data-label="Address" class="mono">${escapeHtml(ev.ip || '—')}</td>
          <td data-label="Reason">${escapeHtml(ev.denial_reason || '')}</td>
        </tr>`;
    }).join('');
  } catch (err) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state">Could not load blocked attempts.</td></tr>';
  }
}

/* ============================================================
   Audit trail
   ============================================================ */
async function loadAuditTrail() {
  const body = document.getElementById('auditTableBody');
  if (!body) return;

  try {
    const { data, error } = await getSupabase()
      .from('audit_log').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;

    if (!data?.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty-state">No events recorded yet.</td></tr>';
      return;
    }

    body.innerHTML = data.map(log => `
      <tr>
        <td data-label="When" class="mono">${formatDate(log.created_at)} ${formatTime(log.created_at)}</td>
        <td data-label="Administrator">${escapeHtml(log.actor_name || 'System')}</td>
        <td data-label="Action"><span class="badge info">${escapeHtml(log.action_type || 'EVENT')}</span></td>
        <td data-label="Target">${escapeHtml(log.target_employee || '—')}</td>
        <td data-label="Detail">${escapeHtml(log.details || '')}</td>
      </tr>
    `).join('');
  } catch (err) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state">Could not load the audit trail.</td></tr>';
  }
}

/* ============================================================
   Bulk staff import
   ------------------------------------------------------------
   Seventy people through the single-add form is an afternoon, and
   seventy one-time codes copied down by hand is a lost code. This
   takes a paste from a spreadsheet instead, and hands back a file
   of codes to distribute.

   The codes are generated here, the same way the single-add form
   does it, and hashed by the database. They are shown once.
   ============================================================ */

let bulkParsed = [];

// A pragmatic CSV line reader: handles quoted fields containing commas,
// and doubled quotes inside a quoted field. Anything more exotic than
// that belongs in a spreadsheet, not here.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',' || ch === '\t') {
      out.push(cur.trim()); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

const BULK_HEADINGS = ['name', 'full name', 'full_name', 'staff', 'employee'];

function parseBulkPaste(text) {
  const rows = [];
  const problems = [];

  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;

    const cells = parseCsvLine(line);

    // Let people paste a spreadsheet with its header row still attached.
    if (idx === 0 && BULK_HEADINGS.includes((cells[0] || '').toLowerCase())) return;

    const [full_name, position, email, phone, department] = cells;

    if (!full_name) { problems.push(`Line ${idx + 1}: no name`); return; }
    if (!position)  { problems.push(`Line ${idx + 1}: ${full_name} has no position`); return; }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      problems.push(`Line ${idx + 1}: "${email}" does not look like an email address`);
      return;
    }

    rows.push({
      full_name, position,
      email: email || '',
      phone: phone || '',
      department: department || '',
      employment_type: 'full_time',
      temp_otp: generateTempOTP()
    });
  });

  // A name appearing twice in the same paste is a copy-and-paste slip. Report
  // it and drop the repeat, so the count in the preview is the truth.
  const seen = new Set();
  const deduped = rows.filter(r => {
    const key = `${r.full_name}|${r.position}`.toLowerCase();
    if (seen.has(key)) {
      problems.push(`${r.full_name} (${r.position}) appears more than once — the repeat was dropped`);
      return false;
    }
    seen.add(key);
    return true;
  });

  return { rows: deduped, problems };
}

function previewBulkImport() {
  const text = document.getElementById('bulkPaste').value;
  const summary = document.getElementById('bulkSummary');
  const result = document.getElementById('bulkResult');
  const importBtn = document.getElementById('bulkImportBtn');

  if (!text.trim()) {
    summary.textContent = 'Nothing pasted yet.';
    importBtn.classList.add('hidden');
    result.innerHTML = '';
    return;
  }

  const { rows, problems } = parseBulkPaste(text);
  bulkParsed = rows;

  summary.textContent = `${rows.length} ready` + (problems.length ? `, ${problems.length} to fix` : '');
  importBtn.classList.toggle('hidden', rows.length === 0);

  result.innerHTML = `
    ${problems.length ? `
      <div class="notice">
        <div>
          <strong>These lines were left out:</strong>
          <ul style="margin:6px 0 0; padding-left:18px;">
            ${problems.map(p => `<li>${escapeHtml(p)}</li>`).join('')}
          </ul>
        </div>
      </div>` : ''}
    ${rows.length ? `
      <div class="table-wrap" style="margin-top:12px;">
        <table class="table">
          <thead><tr><th>Name</th><th>Position</th><th>Email</th><th>Department</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${escapeHtml(r.full_name)}</td>
                <td>${escapeHtml(r.position)}</td>
                <td>${escapeHtml(r.email || '—')}</td>
                <td>${escapeHtml(r.department || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="muted" style="margin-top:8px;">
        Worker IDs are assigned automatically, continuing from the highest already on file.
      </p>` : ''}`;
}

async function runBulkImport() {
  if (!bulkParsed.length) return;

  const btn = document.getElementById('bulkImportBtn');
  btn.disabled = true;

  try {
    const results = await rpc('admin_bulk_add_employees', {
      p_token: adminSessionToken,
      p_rows: bulkParsed
    });

    const added = (results || []).filter(r => r.outcome === 'added');
    const skipped = (results || []).filter(r => r.outcome !== 'added');

    document.getElementById('bulkResult').innerHTML = `
      <div class="notice ${added.length ? 'ok' : ''}">
        <div>
          <strong>${added.length} added${skipped.length ? `, ${skipped.length} skipped` : ''}.</strong>
          ${added.length ? ' Save the codes below now — they cannot be shown again.' : ''}
        </div>
      </div>
      ${added.length ? `
        <div style="margin:12px 0;">
          <button type="button" class="btn primary sm" id="bulkDownloadBtn">Download the codes</button>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Worker ID</th><th>Name</th><th>One-time code</th></tr></thead>
            <tbody>
              ${added.map(r => `
                <tr>
                  <td class="mono">${escapeHtml(r.worker_id)}</td>
                  <td>${escapeHtml(r.full_name)}</td>
                  <td class="mono"><strong>${escapeHtml(r.temp_otp)}</strong></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
      ${skipped.length ? `
        <div class="table-wrap" style="margin-top:12px;">
          <table class="table">
            <thead><tr><th>Name</th><th>Why it was skipped</th></tr></thead>
            <tbody>
              ${skipped.map(r => `
                <tr>
                  <td>${escapeHtml(r.full_name || '—')}</td>
                  <td>${escapeHtml(r.detail || 'Skipped')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}`;

    const dl = document.getElementById('bulkDownloadBtn');
    if (dl) {
      dl.addEventListener('click', () => {
        let csv = 'Worker ID,Name,One-time code\n';
        added.forEach(r => {
          csv += `${r.worker_id},"${(r.full_name || '').replace(/"/g, '""')}",${r.temp_otp}\n`;
        });
        downloadCSV(csv, 'STA_Staff_Sign_In_Codes.csv');
      });
    }

    document.getElementById('bulkPaste').value = '';
    document.getElementById('bulkSummary').textContent = '';
    btn.classList.add('hidden');
    bulkParsed = [];
    loadEmployees();
  } catch (err) {
    showToast(err?.message || 'The import did not go through.', 'error');
  } finally {
    btn.disabled = false;
  }
}
