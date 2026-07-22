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

  try {
    const { count } = await window.getSupabase().from('employees').select('*', { count: 'exact', head: true });
    if (count > 0) showDashboard();
    else loginScreen.style.display = 'flex';
  } catch {
    loginScreen.style.display = 'flex';
  }
});

function bindEvents() {
  document.getElementById('adminLoginForm').addEventListener('submit', handleLogin);
  document.getElementById('adminLogoutBtn').addEventListener('click', handleLogout);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.dataset.tab = btn.dataset.tab;
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('refreshAttendanceBtn').addEventListener('click', loadAttendance);
  document.getElementById('refreshLeavesBtn').addEventListener('click', loadLeaves);
  document.getElementById('refreshEmployeesBtn').addEventListener('click', loadEmployees);
  document.getElementById('addEmployeeForm').addEventListener('submit', addEmployee);
  document.getElementById('postMessageForm').addEventListener('submit', postMessage);
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
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

/* ---------- Auth ---------- */
async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('adminUsername').value.trim();
  const password = document.getElementById('adminPassword').value;
  const errorEl = document.getElementById('adminLoginError');
  errorEl.textContent = '';

  if (!window.getSupabase()) {
    errorEl.textContent = 'Supabase is not configured.';
    return;
  }

  try {
    const { data, error } = await window.getSupabase().auth.signInWithPassword({
      email: username,
      password
    });
    if (error) throw error;
    if (!data.session) throw new Error('No session returned.');
    showDashboard();
  } catch (err) {
    errorEl.textContent = err?.message || 'Invalid credentials.';
  }
}

async function handleLogout() {
  try { await window.getSupabase().auth.signOut(); } catch {}
  dashboard.style.display = 'none';
  loginScreen.style.display = 'flex';
  document.getElementById('adminUsername').value = '';
  document.getElementById('adminPassword').value = '';
}

function showDashboard() {
  loginScreen.style.display = 'none';
  dashboard.style.display = 'block';
  loadAttendance();
  loadLeaves();
  loadEmployees();
  loadAdminMessageBoard();
  switchTab('attendance');
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
}

/* ---------- Attendance ---------- */
async function loadAttendance() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const start = new Date(y, m - 1, 1).toISOString().split('T')[0];
  const end = new Date(y, m, 0).toISOString().split('T')[0];

  try {
    const { data: attendance, error } = await window.getSupabase()
      .from('attendance')
      .select('employee_id,clock_in,clock_out,is_on_lunch,date,employees(full_name,worker_id,position)')
      .gte('date', start)
      .lte('date', end);

    if (error) throw error;

    const todayRecords = (attendance || []).filter(x => x.date === end).reduce((acc, x) => {
      acc[x.employee_id] = x;
      return acc;
    }, {});

    const { data: employeeCounts } = await Promise.all(
      (attendance || []).reduce((map, x) => { map[x.employee_id] = (map[x.employee_id] || 0) + 1; return map; }, {})
    );

    const { data: employees } = await window.getSupabase()
      .from('employees')
      .select('id,full_name,worker_id,position,status');

    const body = document.getElementById('attendanceTableBody');
    if (!body) return;
    if (!employees || !employees.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty-state">No active employees this period.</td></tr>';
      return;
    }

    const presentMap = {};
    (attendance || []).forEach(x => {
      if (!presentMap[x.employee_id]) presentMap[x.employee_id] = { total: 0, present: 0 };
      presentMap[x.employee_id].total += 1;
      if (x.clock_in && x.clock_out) presentMap[x.employee_id].present += 1;
    });

    body.innerHTML = employees.map(emp => {
      const today = todayRecords[emp.id];
      const status = today?.is_on_lunch
        ? '<span class="pill warning">🍽 On lunch</span>'
        : today?.clock_out
          ? '<span class="pill success">✅ Clocked out</span>'
          : today?.clock_in
            ? '<span class="pill info">⏳ Working</span>'
            : '<span class="pill" style="background:var(--bg-secondary);color:var(--text-muted)">—</span>';

      const hoursWorked = computeHours(today?.clock_in, today?.clock_out);
      const pct = presentMap[emp.id]?.total ? Math.round((presentMap[emp.id].present / presentMap[emp.id].total) * 100) : 0;
      const pctColor = pct >= 90 ? 'var(--success)' : pct >= 75 ? 'var(--warning)' : 'var(--danger)';

      return `
        <tr>
          <td><strong>${escapeHtml(emp.full_name)}</strong><br><span style="font-size:0.78rem;color:var(--text-muted)">${escapeHtml(emp.worker_id)}<br>${escapeHtml(emp.position || '')}</span></td>
          <td style="font-family:var(--font-mono);font-size:12px">${formatTime(today?.clock_in)}</td>
          <td style="font-family:var(--font-mono);font-size:12px">${formatTime(today?.clock_out)}</td>
          <td style="font-family:var(--font-mono);font-size:12px;font-weight:600">${hoursWorked}</td>
          <td>${status}</td>
          <td style="text-align:center;font-weight:700;color:${pctColor}">${pct}%</td>
          <td><span style="font-size:11px;color:var(--text-muted)">Supabase</span></td>
        </tr>`;
    }).join('');
  } catch (err) {
    showToast(err?.message || 'Could not load attendance.', 'error');
  }
}

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

/* ---------- Employees ---------- */
async function addEmployee(e) {
  e.preventDefault();
  const wid = document.getElementById('newWorkerId').value.trim();
  const name = document.getElementById('newFullName').value.trim();
  const pos = document.getElementById('newPosition').value.trim();
  const dept = document.getElementById('newDepartment')?.value || '';
  const email = document.getElementById('newEmail')?.value.trim() || '';
  const phone = document.getElementById('newPhone')?.value.trim() || '';

  try {
    const values = { worker_id: wid, full_name: name, position: pos, email: email || null, phone: phone || null, status: 'active' };
    if (dept) values.department_id = Number(dept);
    const { error } = await window.getSupabase().from('employees').insert(values);
    if (error) throw error;
    showToast(`Employee ${name} added.`, 'success');
    document.getElementById('addEmployeeForm').reset();
    loadEmployees();
    loadAttendance();
  } catch (err) {
    showToast(err?.message || 'Could not add employee.', 'error');
  }
}

async function loadEmployees() {
  try {
    const [empRes, deptRes] = await Promise.all([
      window.getSupabase().from('employees').select('id,full_name,position,worker_id,email,phone,department_id'),
      window.getSupabase().from('departments').select('id,name,code')
    ]);

    const employees = empRes?.data || [];
    const departments = deptRes?.data || [];

    const container = document.getElementById('employeesList');
    if (!container) return;
    if (!employees.length) {
      container.innerHTML = '<div class="empty-state">No employees yet.</div>';
      return;
    }

    const deptName = (id) => {
      const d = departments.find(x => x.id == id);
      return d ? d.name : '—';
    };

    container.innerHTML = employees.map(emp => `
      <div class="neu-inset message-item" style="display:flex; align-items:center; justify-content:space-between; gap:14px; margin-bottom:10px;">
        <div>
          <strong>${escapeHtml(emp.full_name)}</strong>
          <div style="font-size:0.82rem; color:var(--text-secondary); margin-top:2px;">${escapeHtml(emp.position || '')} · ${escapeHtml(deptName(emp.department_id))} · ${escapeHtml(emp.worker_id)}</div>
          <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${escapeHtml(emp.email || '')}${emp.phone ? ' · ' + escapeHtml(emp.phone) : ''}</div>
        </div>
        <button class="neu-btn danger" style="padding:8px 12px;font-size:0.78rem;" onclick="removeEmployee(${emp.id}, ${escapeHtml(JSON.stringify(emp.full_name))})">Remove</button>
      </div>
    `).join('');
  } catch (err) {
    showToast(err?.message || 'Could not load employees.', 'error');
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
  const message = el.value.trim();
  if (!message || !currentEmployeeId()) return;

  try {
    const actual = await window.getSupabase().from('employees').select('id').eq('worker_id', 'W001').single();
    const author = actual.data?.id;
    if (!author) throw new Error('Missing author.');

    const { error } = await window.getSupabase().from('messages').insert({
      author_id: author,
      title: message,
      body: message,
      priority: 'normal',
      published: true
    });
    if (error) throw error;
    el.value = '';
    showToast('Announcement posted.', 'success');
    loadAdminMessageBoard();
  } catch (err) {
    showToast(err?.message || 'Could not post message.', 'error');
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
      container.innerHTML = '<div class="empty-state">No announcements.</div>';
      return;
    }

    container.innerHTML = data.map(m => `
      <div style="padding:16px 20px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:12px; display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:10px;">
        <div>
          <div style="font-size:12px; color:var(--text-muted); font-weight:500; letter-spacing:0.3px; margin-bottom:6px;">
            ${escapeHtml((m.author && m.author.full_name) || 'System')} · ${formatDate(m.created_at)}
          </div>
          <div style="font-size:14px; color:var(--text-primary); line-height:1.55;">${escapeHtml(m.body || '')}</div>
        </div>
        <button class="neu-btn danger" style="padding:8px 12px; font-size:0.75rem;" onclick="deleteMessage(${m.id})">Delete</button>
      </div>
    `).join('');
  } catch (err) {
    showToast(err?.message || 'Could not load messages.', 'error');
  }
}

async function deleteMessage(id) {
  try {
    const { error } = await window.getSupabase().from('messages').delete().eq('id', id);
    if (error) throw error;
    showToast('Removed.', 'success');
    loadAdminMessageBoard();
  } catch (err) {
    showToast(err?.message || 'Could not delete message.', 'error');
  }
}

function currentEmployeeId() {
  return window.getSupabase()?.auth?.session()?.user?.id || null;
}
