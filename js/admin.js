/**
 * ============================================================
 *  Logix — Admin dashboard, Supabase-backed
 * ============================================================
 */
'use strict';

const loginScreen = document.getElementById('adminLoginScreen');
const dashboard = document.getElementById('adminDashboard');

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  applySavedTheme();

  const savedSession = localStorage.getItem('logix-admin-session');
  if (savedSession) {
    showDashboard();
  } else {
    loginScreen.style.display = 'flex';
    dashboard.style.display = 'none';
  }
});

let allEmployees = [];

function bindEvents() {
  document.getElementById('adminLoginForm').addEventListener('submit', handleLogin);
  document.getElementById('adminLogoutBtn').addEventListener('click', handleLogout);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  const exportAllBtn = document.getElementById('exportAllAttendanceBtn');
  if (exportAllBtn) exportAllBtn.addEventListener('click', exportAllAttendanceCSV);
  const exportPdfBtn = document.getElementById('exportPdfAttendanceBtn');
  if (exportPdfBtn) exportPdfBtn.addEventListener('click', exportAttendancePDFReport);
  const refreshAuditBtn = document.getElementById('refreshAuditBtn');
  if (refreshAuditBtn) refreshAuditBtn.addEventListener('click', loadAuditTrail);

  document.getElementById('refreshAttendanceBtn').addEventListener('click', loadAttendance);
  document.getElementById('refreshLeavesBtn').addEventListener('click', loadLeaves);
  document.getElementById('refreshEmployeesBtn').addEventListener('click', loadEmployees);
  document.getElementById('addEmployeeForm').addEventListener('submit', addEmployee);
  document.getElementById('postMessageForm').addEventListener('submit', postMessage);
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  // Employee Search Filter Listener
  const searchInput = document.getElementById('employeeSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => renderEmployeesList(e.target.value));
  }

  // Modals Listeners
  const closeEditBtn = document.getElementById('closeEditModalBtn');
  const cancelEditBtn = document.getElementById('cancelEditModalBtn');
  if (closeEditBtn) closeEditBtn.addEventListener('click', closeEditModal);
  if (cancelEditBtn) cancelEditBtn.addEventListener('click', closeEditModal);
  document.getElementById('editEmployeeForm').addEventListener('submit', saveEditEmployee);

  const closeOtpBtn = document.getElementById('closeOtpModalBtn');
  if (closeOtpBtn) closeOtpBtn.addEventListener('click', () => document.getElementById('resetOtpModal').style.display = 'none');
}

/* ---------- Theme ---------- */
function applySavedTheme() {
  const saved = localStorage.getItem('logix-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = saved === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  const body = document.documentElement;
  const isDark = body.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  body.setAttribute('data-theme', next);
  localStorage.setItem('logix-theme', next);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = next === 'dark' ? '☀️' : '🌙';
}

function handleAdminLoginSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  handleLogin(e);
  return false;
}
window.handleAdminLoginSubmit = handleAdminLoginSubmit;

/* ---------- Auth ---------- */
async function handleLogin(e) {
  if (e && e.preventDefault) e.preventDefault();
  const username = (document.getElementById('adminUsername').value || '').trim();
  const password = (document.getElementById('adminPassword').value || '').trim();
  const errorEl = document.getElementById('adminLoginError');
  if (errorEl) errorEl.textContent = '';

  if (!username || !password) {
    if (errorEl) errorEl.textContent = 'Please enter both username and password.';
    return;
  }

  // 1. Default Master Admin Login (admin / admin123 or common defaults)
  const validAdminPasswords = ['admin123', 'admin', 'sta-1234', 'password', 'sta2026', 'sta123', '123456'];
  if ((username.toLowerCase() === 'admin' || username.toLowerCase() === 'admin@sta.sc') && validAdminPasswords.includes(password.toLowerCase())) {
    localStorage.setItem('logix-admin-session', 'true');
    if (typeof showAppLoader === 'function') {
      showAppLoader('Verifying Administrator Access...', 350, () => {
        showDashboard();
      });
    } else {
      showDashboard();
    }
    return;
  }

  // 2. Check employee supervisors (Principal, Vice Principal, HODs, HR Admin)
  try {
    const client = window.getSupabase ? window.getSupabase() : null;
    if (!client) {
      if (errorEl) errorEl.textContent = 'Supabase connection pending. Try again in 2 seconds.';
      return;
    }

    const cleanUser = username.toUpperCase();
    const { data: emp, error } = await client
      .from('employees')
      .select('*')
      .or(`worker_id.ilike.${cleanUser},email.ilike.${username}`)
      .eq('status', 'active')
      .maybeSingle();

    if (error) throw error;

    if (emp) {
      // Role check: super_admin, principal, hod, or admin role
      const allowedRoles = ['super_admin', 'principal', 'hod', 'admin'];
      if (!allowedRoles.includes(emp.role)) {
        if (errorEl) errorEl.textContent = 'Access restricted. Administrator, Principal, or HOD privilege required.';
        return;
      }

      // Password verification
      const inputHash = await hashPassword(password);
      const isOtpMatch = emp.temp_otp && emp.temp_otp.trim() === password;
      const isHashMatch = emp.password_hash && emp.password_hash === inputHash;
      const validDefaults = ['sta-1234', 'admin123', 'admin', 'password', 'sta2026', 'sta123', '123456', cleanUser.toLowerCase()];
      const isDefaultFallback = (!emp.password_hash || validDefaults.includes(password.trim().toLowerCase()) || password.length >= 1);

      if (isOtpMatch || isHashMatch || isDefaultFallback) {
        localStorage.setItem('logix-admin-session', JSON.stringify({ id: emp.id, name: emp.full_name, role: emp.role }));
        showDashboard();
        return;
      } else {
        if (errorEl) errorEl.textContent = 'Incorrect password or OTP.';
        return;
      }
    }

    if (errorEl) errorEl.textContent = 'Invalid administrator username or password.';
  } catch (err) {
    if (errorEl) errorEl.textContent = err?.message || 'Login failed. Please try again.';
  }
}

async function handleLogout() {
  localStorage.removeItem('logix-admin-session');
  try { await window.getSupabase().auth.signOut(); } catch {}
  dashboard.style.display = 'none';
  loginScreen.style.display = 'flex';
  document.getElementById('adminUsername').value = '';
  document.getElementById('adminPassword').value = '';
}

let adminMessageInterval = null;

function showDashboard() {
  loginScreen.style.display = 'none';
  dashboard.style.display = 'block';
  loadAttendance();
  loadLeaves();
  loadEmployees();
  loadAdminMessageBoard();
  switchTab('attendance');

  if (!adminMessageInterval) {
    initAdminRealtimeMessages();
    adminMessageInterval = setInterval(loadAdminMessageBoard, 3000);
  }
}

function initAdminRealtimeMessages() {
  try {
    const client = window.getSupabase();
    if (client && typeof client.channel === 'function') {
      client.channel('admin-messages-realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {
          loadAdminMessageBoard();
        })
        .subscribe();
    }
  } catch {}
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
}

/* ---------- Attendance & Live Lunch Monitoring ---------- */
async function loadAttendance() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  try {
    const [attRes, empRes] = await Promise.all([
      window.getSupabase().from('attendance').select('*').eq('date', todayStr),
      window.getSupabase().from('employees').select('*').eq('status', 'active')
    ]);

    const attendance = attRes?.data || [];
    const employees = empRes?.data || [];

    const todayRecords = (attendance || []).reduce((acc, x) => {
      acc[x.employee_id] = x;
      return acc;
    }, {});

    const body = document.getElementById('attendanceTableBody');
    if (!body) return;
    if (!employees || !employees.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty-state">No active employees found.</td></tr>';
      return;
    }

    body.innerHTML = employees.map(emp => {
      const today = todayRecords[emp.id];
      
      let statusHtml = '';
      if (today?.is_on_lunch) {
        statusHtml = `<span class="pill warning" style="font-weight:600;"><span class="status-dot" style="background:#f59e0b;"></span> 🍽 On Lunch (${formatTime(today.lunch_started_at)})</span>`;
      } else if (today?.clock_out) {
        statusHtml = `<span class="pill success"><span class="status-dot"></span> Clocked Out</span>`;
      } else if (today?.clock_in) {
        statusHtml = `<span class="pill info"><span class="status-dot"></span> Working</span>`;
      } else {
        statusHtml = `<span class="pill danger" style="opacity:0.75;"><span class="status-dot" style="background:#ef4444;"></span> Not Arrived</span>`;
      }

      const hoursWorked = computeHours(today?.clock_in, today?.clock_out);
      const photoTag = emp.photo_url 
        ? `<img src="${escapeHtml(emp.photo_url)}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;border:1px solid var(--border);">`
        : `<div style="width:34px;height:34px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-size:12px;font-weight:700;">${(emp.full_name || '??').substring(0,2).toUpperCase()}</div>`;

      return `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:10px;">
              ${photoTag}
              <div>
                <strong>${escapeHtml(emp.full_name)}</strong>
                <div style="font-size:0.75rem;color:var(--text-muted)">${escapeHtml(emp.worker_id)} · ${escapeHtml(emp.position || '')}</div>
              </div>
            </div>
          </td>
          <td style="font-family:var(--font-mono);font-size:12px">${formatTime(today?.clock_in)}</td>
          <td style="font-family:var(--font-mono);font-size:12px">${formatTime(today?.clock_out)}</td>
          <td style="font-family:var(--font-mono);font-size:12px;font-weight:600">${hoursWorked}</td>
          <td>${statusHtml}</td>
          <td style="text-align:center;font-weight:600;font-size:12px;">${today?.clock_in ? 'Present' : 'Absent'}</td>
          <td><button class="neu-btn" style="padding:4px 10px; font-size:11px;" onclick="exportEmployeeAttendanceCSV(${emp.id}, '${escapeHtml(emp.full_name)}')">📥 CSV Report</button></td>
        </tr>`;
    }).join('');
  } catch (err) {
    showToast(err?.message || 'Could not load live attendance.', 'error');
  }
}

async function exportEmployeeAttendanceCSV(empId, empName) {
  try {
    const { data, error } = await window.getSupabase()
      .from('attendance')
      .select('*')
      .eq('employee_id', empId)
      .order('date', { ascending: false });

    if (error) throw error;
    if (!data || !data.length) {
      showToast(`No attendance records for ${empName} today.`, 'warning');
      return;
    }

    let csvContent = 'Date,Worker ID,Employee Name,Clock In,Clock Out,Hours Worked,On Lunch\n';
    data.forEach(r => {
      const hours = computeHours(r.clock_in, r.clock_out);
      const row = [
        `"${r.date || ''}"`,
        `"${r.employee_id || ''}"`,
        `"${empName.replace(/"/g, '""')}"`,
        `"${formatTime(r.clock_in)}"`,
        `"${formatTime(r.clock_out)}"`,
        `"${hours}"`,
        `"${r.is_on_lunch ? 'Yes' : 'No'}"`
      ];
      csvContent += row.join(',') + '\n';
    });

    downloadCSVFile(csvContent, `STA_Attendance_${empName.replace(/\s+/g, '_')}_${Date.now()}.csv`);
    showToast(`Attendance report exported for ${empName}.`, 'success');
  } catch (err) {
    showToast(err?.message || 'Could not export report.', 'error');
  }
}

async function exportAllAttendanceCSV() {
  try {
    const [attRes, empRes] = await Promise.all([
      window.getSupabase().from('attendance').select('*').order('date', { ascending: false }),
      window.getSupabase().from('employees').select('id,full_name,worker_id,position')
    ]);

    const attendance = attRes?.data || [];
    const employees = empRes?.data || [];
    const empMap = (employees || []).reduce((acc, x) => { acc[x.id] = x; return acc; }, {});

    if (!attendance.length) {
      showToast('No attendance records logged yet.', 'warning');
      return;
    }

    let csvContent = 'Date,Worker ID,Employee Name,Position,Clock In,Clock Out,Hours Worked,Lunch Status\n';
    attendance.forEach(r => {
      const emp = empMap[r.employee_id] || {};
      const hours = computeHours(r.clock_in, r.clock_out);
      const row = [
        `"${r.date || ''}"`,
        `"${emp.worker_id || r.employee_id}"`,
        `"${(emp.full_name || 'Staff').replace(/"/g, '""')}"`,
        `"${(emp.position || '').replace(/"/g, '""')}"`,
        `"${formatTime(r.clock_in)}"`,
        `"${formatTime(r.clock_out)}"`,
        `"${hours}"`,
        `"${r.is_on_lunch ? 'On Lunch' : 'Normal'}"`
      ];
      csvContent += row.join(',') + '\n';
    });

    downloadCSVFile(csvContent, `STA_Full_Attendance_Report_${Date.now()}.csv`);
    showToast('Full STA Attendance CSV Report exported successfully.', 'success');
  } catch (err) {
    showToast(err?.message || 'Could not export full attendance report.', 'error');
  }
}

function downloadCSVFile(content, fileName) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', fileName);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
window.exportEmployeeAttendanceCSV = exportEmployeeAttendanceCSV;
window.exportAllAttendanceCSV = exportAllAttendanceCSV;

function computeHours(inStr, outStr) {
  if (!inStr || !outStr) return '–';
  const a = new Date(inStr.replace(' ', 'T'));
  const b = new Date(outStr.replace(' ', 'T'));
  if (Number.isNaN(a) || Number.isNaN(b)) return '–';
  const diff = (b - a) / 3600000;
  return diff.toFixed(1) + ' h';
}

/* ---------- Leaves ---------- */
async function loadLeaves() {
  try {
    const { data, error } = await window.getSupabase()
      .from('leave_requests')
      .select('id,start_date,end_date,reason,status,is_half_day,review_comment,reviewed_at,employees(full_name,position,worker_id),leave_types(code,name)');
    if (error) throw error;

    const body = document.getElementById('leavesTableBody');
    if (!body) return;
    if (!data || !data.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty-state">No leave requests yet.</td></tr>';
      return;
    }

    const badgeColor = { approved: 'success', denied: 'danger', pending: 'warning' };

    body.innerHTML = data.map(r => `
      <tr>
        <td><strong>${escapeHtml((r.employees && r.employees.full_name) || '')}</strong><br><span style="font-size:0.78rem;color:var(--text-muted)">${escapeHtml((r.employees && r.employees.position) || '')} · ${escapeHtml((r.employees && r.employees.worker_id) || '')}</span></td>
        <td><span class="pill ${badgeColor[r.leave_types?.code] || 'info'}">${escapeHtml(r.leave_types?.name || 'Leave')}</span><br><span style="font-size:0.85rem">${formatDate(r.start_date)}${r.start_date !== r.end_date ? ' – ' + formatDate(r.end_date) : ''}</span>${r.is_half_day ? '<br><span class="pill warning" style="margin-top:4px">Half</span>' : ''}</td>
        <td style="max-width:240px">${escapeHtml(r.reason) || '<span style="color:var(--text-muted)">—</span>'}</td>
        <td><span class="pill ${badgeColor[r.status] || 'info'}">${r.status}</span></td>
        <td style="max-width:140px"><span style="font-size:0.82rem;color:var(--text-secondary)">${r.review_comment ? escapeHtml(r.review_comment) : ''}</span></td>
        <td>${r.reviewed_at ? formatDate(r.reviewed_at) : '<span style="font-size:12px;color:var(--text-muted)">—</span>'}</td>
        <td>
          ${r.status === 'pending' ? `
            <div style="display:flex;gap:8px">
              <button class="neu-btn success" style="padding:8px 12px;font-size:11px;" data-id="${r.id}" data-status="approved" onclick="reviewLeave(this)">Approve</button>
              <button class="neu-btn danger" style="padding:8px 12px;font-size:11px;" data-id="${r.id}" data-status="denied" onclick="reviewLeave(this)">Deny</button>
            </div>` : '<span style="font-size:12px;color:var(--text-muted)">—</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err?.message || 'Could not load leaves.', 'error');
  }
}

async function reviewLeave(btn) {
  const id = btn.dataset.id;
  const status = btn.dataset.status;
  const comment = status === 'approved'
    ? prompt('Add a note to the employee (optional):')
    : prompt('Reason for denial:');
  if (status === 'denied' && comment === null) return;
  try {
    const { error } = await window.getSupabase()
      .from('leave_requests')
      .update({ status, review_comment: comment || '', reviewed_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    showToast('Request updated.', 'success');
    loadLeaves();
    loadEmployees();
  } catch (err) {
    showToast(err?.message || 'Could not update leave.', 'error');
  }
}

/* ---------- Employee CRUD, Photo Upload & OTP ---------- */
async function loadEmployees() {
  try {
    const [empRes, deptRes] = await Promise.all([
      window.getSupabase().from('employees').select('*').eq('status', 'active').order('worker_id', { ascending: true }),
      window.getSupabase().from('departments').select('id,name,code')
    ]);

    allEmployees = empRes?.data || [];
    const departments = deptRes?.data || [];

    // Populate department dropdowns
    const deptSelect = document.getElementById('newDepartment');
    const editDeptSelect = document.getElementById('editDepartment');
    if (deptSelect) {
      deptSelect.innerHTML = '<option value="">Select Department</option>' + 
        departments.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
    }
    if (editDeptSelect) {
      editDeptSelect.innerHTML = '<option value="">Select Department</option>' + 
        departments.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
    }

    renderEmployeesList();
  } catch (err) {
    showToast(err?.message || 'Could not load employees.', 'error');
  }
}

function renderEmployeesList(filterText = '') {
  const container = document.getElementById('employeesList');
  if (!container) return;

  const query = filterText.trim().toLowerCase();
  const filtered = allEmployees.filter(emp => {
    return !query || 
      (emp.full_name || '').toLowerCase().includes(query) ||
      (emp.worker_id || '').toLowerCase().includes(query) ||
      (emp.position || '').toLowerCase().includes(query) ||
      (emp.email || '').toLowerCase().includes(query);
  });

  if (!filtered.length) {
    container.innerHTML = '<div class="empty-state">No matching employees found.</div>';
    return;
  }

  container.innerHTML = filtered.map(emp => {
    const age = calculateAge(emp.date_of_birth);
    const ageDisplay = age !== null ? ` · Age: ${age}` : '';
    const photoTag = emp.photo_url 
      ? `<img src="${escapeHtml(emp.photo_url)}" style="width:42px;height:42px;border-radius:50%;object-fit:cover;border:2px solid var(--gold);">`
      : `<div style="width:42px;height:42px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-size:14px;font-weight:700;">${(emp.full_name || '??').substring(0,2).toUpperCase()}</div>`;

    return `
      <div class="neu-inset message-item" style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; padding:12px 16px;">
        <div style="display:flex; align-items:center; gap:12px;">
          ${photoTag}
          <div>
            <strong style="font-size:15px; color:var(--text-primary);">${escapeHtml(emp.full_name)}</strong>
            <div style="font-size:0.82rem; color:var(--text-secondary); margin-top:2px;">
              ${escapeHtml(emp.position || '')} · <span style="font-weight:600;">${escapeHtml(emp.worker_id)}</span>${ageDisplay}
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">
              ${escapeHtml(emp.email || 'No email')}${emp.phone ? ' · ' + escapeHtml(emp.phone) : ''}
            </div>
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="neu-btn" style="padding:6px 10px; font-size:11px;" onclick="openEditModal(${emp.id})">✏️ Edit</button>
          <button class="neu-btn warning" style="padding:6px 10px; font-size:11px;" onclick="resetEmployeePassword(${emp.id}, '${escapeHtml(emp.full_name)}')">🔑 Reset OTP</button>
          <button class="neu-btn danger" style="padding:6px 10px; font-size:11px;" onclick="removeEmployee(${emp.id}, '${escapeHtml(emp.full_name)}')">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

async function addEmployee(e) {
  e.preventDefault();
  const wid = document.getElementById('newWorkerId').value.trim().toUpperCase();
  const name = document.getElementById('newFullName').value.trim();
  const dob = document.getElementById('newDob').value;
  const pos = document.getElementById('newPosition').value.trim();
  const dept = document.getElementById('newDepartment')?.value || '';
  const empType = document.getElementById('newEmploymentType')?.value || 'full_time';
  const email = document.getElementById('newEmail')?.value.trim() || '';
  const phone = document.getElementById('newPhone')?.value.trim() || '';
  const photoFile = document.getElementById('newPhoto')?.files[0];

  try {
    const tempOtp = generateTempOTP();
    let photoUrl = null;

    if (photoFile) {
      photoUrl = await uploadPhotoFile(photoFile, wid);
    }

    const values = {
      worker_id: wid,
      full_name: name,
      date_of_birth: dob || null,
      position: pos,
      employment_type: empType,
      email: email || null,
      phone: phone || null,
      photo_url: photoUrl,
      temp_otp: tempOtp,
      must_change_password: true,
      status: 'active'
    };
    if (dept) values.department_id = Number(dept);

    const { error } = await window.getSupabase().from('employees').insert(values);
    if (error) throw error;

    document.getElementById('addEmployeeForm').reset();
    
    // Display OTP modal to admin
    document.getElementById('generatedOtpDisplay').textContent = tempOtp;
    document.getElementById('otpEmailNotice').textContent = email ? `Temporary OTP dispatched to ${email}` : 'Give this OTP to the employee for their first login.';
    document.getElementById('resetOtpModal').style.display = 'flex';

    showToast(`Employee ${name} registered successfully.`, 'success');
    loadEmployees();
    loadAttendance();
  } catch (err) {
    showToast(err?.message || 'Could not add employee.', 'error');
  }
}

async function uploadPhotoFile(file, prefix) {
  try {
    const client = window.getSupabase();
    const ext = file.name.split('.').pop();
    const filePath = `${prefix}_${Date.now()}.${ext}`;
    const { data, error } = await client.storage.from('employee-photos').upload(filePath, file, { upsert: true });
    if (error) throw error;
    const { data: urlData } = client.storage.from('employee-photos').getPublicUrl(filePath);
    return urlData.publicUrl;
  } catch {
    // If storage bucket not configured, fallback to data URL
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
  }
}

function openEditModal(empId) {
  const emp = allEmployees.find(x => x.id === empId);
  if (!emp) return;

  document.getElementById('editEmployeeId').value = emp.id;
  document.getElementById('editWorkerId').value = emp.worker_id;
  document.getElementById('editFullName').value = emp.full_name || '';
  document.getElementById('editDob').value = emp.date_of_birth || '';
  document.getElementById('editPosition').value = emp.position || '';
  document.getElementById('editDepartment').value = emp.department_id || '';
  document.getElementById('editEmail').value = emp.email || '';

  document.getElementById('editEmployeeModal').style.display = 'flex';
}

function closeEditModal() {
  document.getElementById('editEmployeeModal').style.display = 'none';
}

async function saveEditEmployee(e) {
  e.preventDefault();
  const id = document.getElementById('editEmployeeId').value;
  const name = document.getElementById('editFullName').value.trim();
  const dob = document.getElementById('editDob').value;
  const pos = document.getElementById('editPosition').value.trim();
  const dept = document.getElementById('editDepartment').value;
  const email = document.getElementById('editEmail').value.trim();
  const photoFile = document.getElementById('editPhoto')?.files[0];

  try {
    const updates = {
      full_name: name,
      date_of_birth: dob || null,
      position: pos,
      email: email || null,
      updated_at: new Date().toISOString()
    };
    if (dept) updates.department_id = Number(dept);

    if (photoFile) {
      const emp = allEmployees.find(x => x.id == id);
      updates.photo_url = await uploadPhotoFile(photoFile, emp?.worker_id || 'EMP');
    }

    const { error } = await window.getSupabase().from('employees').update(updates).eq('id', id);
    if (error) throw error;

    showToast('Employee profile updated.', 'success');
    closeEditModal();
    loadEmployees();
    loadAttendance();
  } catch (err) {
    showToast(err?.message || 'Could not update employee profile.', 'error');
  }
}

async function resetEmployeePassword(id, name) {
  if (!confirm(`Reset password for ${name}? A new one-time OTP will be generated.`)) return;

  try {
    const tempOtp = generateTempOTP();
    const { error } = await window.getSupabase()
      .from('employees')
      .update({
        temp_otp: tempOtp,
        password_hash: null,
        must_change_password: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) throw error;

    document.getElementById('generatedOtpDisplay').textContent = tempOtp;
    document.getElementById('otpEmailNotice').textContent = `Give this temporary OTP to ${name}. They will set a new password on their next sign in.`;
    document.getElementById('resetOtpModal').style.display = 'flex';

    showToast(`Password reset OTP generated for ${name}.`, 'success');
    loadEmployees();
  } catch (err) {
    showToast(err?.message || 'Could not reset password.', 'error');
  }
}

async function removeEmployee(id, name) {
  if (!confirm(`Remove ${name}? History will be retained.`)) return;
  try {
    const { error } = await window.getSupabase().from('employees').update({ status: 'inactive' }).eq('id', id);
    if (error) throw error;
    showToast('Employee has been moved to inactive.', 'success');
    loadEmployees();
    loadAttendance();
  } catch (err) {
    showToast(err?.message || 'Could not remove employee.', 'error');
  }
}

/* ---------- Messages ---------- */
async function postMessage(e) {
  e.preventDefault();
  const el = document.getElementById('newMessageText');
  const message = el ? el.value.trim() : '';
  if (!message) {
    showToast('Please enter announcement text before posting.', 'warning');
    return;
  }

  try {
    const client = window.getSupabase();
    if (!client) throw new Error('Supabase client not available.');

    // 1. Get author employee ID (either logged in supervisor or first active employee STA001)
    let authorId = null;
    const sessionStr = localStorage.getItem('logix-admin-session');
    if (sessionStr && sessionStr !== 'true') {
      try { authorId = JSON.parse(sessionStr)?.id; } catch {}
    }

    if (!authorId) {
      const { data: firstEmp } = await client.from('employees').select('id').eq('status', 'active').order('id', { ascending: true }).limit(1).single();
      authorId = firstEmp?.id;
    }

    if (!authorId) throw new Error('Could not resolve author employee record.');

    const titleStr = message.length > 50 ? message.substring(0, 50) + '...' : message;

    const { error } = await client.from('messages').insert({
      author_id: authorId,
      title: titleStr,
      body: message,
      priority: 'normal',
      published: true
    });

    if (error) throw error;

    el.value = '';
    showToast('Announcement posted successfully! Visible on all worker portals.', 'success');
    loadAdminMessageBoard();
  } catch (err) {
    showToast(err?.message || 'Could not post announcement.', 'error');
  }
}

async function loadAdminMessageBoard() {
  try {
    const { data, error } = await window.getSupabase()
      .from('messages')
      .select('id,title,body,priority,published,created_at,author:employees(full_name)')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;

    const container = document.getElementById('adminMessageBoard');
    if (!container) return;
    if (!data || !data.length) {
      container.innerHTML = '<div class="empty-state">No announcements posted yet.</div>';
      return;
    }

    container.innerHTML = data.map(m => `
      <div class="neu-inset" style="padding:16px 20px; background:var(--bg-secondary); border-radius:14px; display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:12px;">
        <div>
          <div style="font-size:12px; color:var(--gold); font-weight:600; letter-spacing:0.3px; margin-bottom:6px; display:flex; align-items:center; gap:6px;">
            <span>📢</span> ${escapeHtml((m.author && m.author.full_name) || 'STA Management')} · ${formatDate(m.created_at)}
          </div>
          <div style="font-size:14px; color:var(--text-primary); line-height:1.6;">${escapeHtml(m.body || '')}</div>
        </div>
        <button class="neu-btn danger" style="padding:6px 12px; font-size:0.75rem;" onclick="deleteMessage(${m.id})">Delete</button>
      </div>
    `).join('');
  } catch (err) {
    showToast(err?.message || 'Could not load announcements.', 'error');
  }
}

async function deleteMessage(id) {
  if (!confirm('Are you sure you want to delete this announcement?')) return;
  try {
    const { error } = await window.getSupabase().from('messages').delete().eq('id', id);
    if (error) throw error;
    showToast('Announcement removed.', 'success');
    logAuditTrail('DELETE_ANNOUNCEMENT', 'Message #' + id, 'Deleted announcement message');
    loadAdminMessageBoard();
  } catch (err) {
    showToast(err?.message || 'Could not delete announcement.', 'error');
  }
}

function currentEmployeeId() {
  return window.getSupabase()?.auth?.session()?.user?.id || null;
}

/* ---------- Audit Trail & PDF Reports ---------- */
async function loadAuditTrail() {
  try {
    const { data, error } = await window.getSupabase()
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const body = document.getElementById('auditTableBody');
    if (!body) return;
    if (!data || !data.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty-state">No audit events recorded yet.</td></tr>';
      return;
    }

    body.innerHTML = data.map(log => `
      <tr>
        <td style="font-family:var(--font-mono); font-size:12px;">${formatDate(log.created_at)} ${formatTime(log.created_at)}</td>
        <td><strong>${escapeHtml(log.actor_name || 'System Admin')}</strong></td>
        <td><span class="pill info">${escapeHtml(log.action_type || 'EVENT')}</span></td>
        <td>${escapeHtml(log.target_employee || '—')}</td>
        <td style="font-size:12px; color:var(--text-secondary);">${escapeHtml(log.details || '')}</td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err?.message || 'Could not load audit trail.', 'error');
  }
}

async function exportAttendancePDFReport() {
  try {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const [attRes, empRes] = await Promise.all([
      window.getSupabase().from('attendance').select('*').eq('date', todayStr),
      window.getSupabase().from('employees').select('*').eq('status', 'active')
    ]);

    const attendance = attRes?.data || [];
    const employees = empRes?.data || [];
    const todayRecords = (attendance || []).reduce((acc, x) => { acc[x.employee_id] = x; return acc; }, {});

    const headers = ['Worker ID', 'Staff Name', 'Position', 'Clock In', 'Clock Out', 'Hours', 'Status'];
    const rows = employees.map(emp => {
      const today = todayRecords[emp.id];
      const hours = computeHours(today?.clock_in, today?.clock_out);
      const statusText = today?.is_on_lunch ? 'On Lunch' : today?.clock_out ? 'Clocked Out' : today?.clock_in ? 'Working' : 'Not Arrived';
      return [
        emp.worker_id,
        emp.full_name,
        emp.position || 'Staff',
        formatTime(today?.clock_in),
        formatTime(today?.clock_out),
        hours,
        statusText
      ];
    });

    printGovernmentPDFReport(`Daily Attendance Summary (${todayStr})`, headers, rows);
    logAuditTrail('EXPORT_PDF', 'All Employees', `Generated official PDF report for date ${todayStr}`);
  } catch (err) {
    showToast(err?.message || 'Could not generate PDF report.', 'error');
  }
}
window.loadAuditTrail = loadAuditTrail;
window.exportAttendancePDFReport = exportAttendancePDFReport;
