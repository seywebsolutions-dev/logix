-- ============================================================
--  LOGIX FOR STA SEYCHELLES — SUPABASE SEED DATA
-- ============================================================

-- Remove duplicate schemas if adjusting
-- alter table public.employees add column if not exists auth_uid uuid unique;

update public.employees set auth_uid = gen_random_uuid() where auth_uid is null;

-- Seed departments if not already seeded
insert into public.departments (name, code, description)
values
  ('Administration', 'ADM', 'School administration and management'),
  ('Teaching Staff', 'TCH', 'Academic teaching staff'),
  ('Support Staff', 'SUP', 'Operational support staff')
on conflict (code) do nothing;

-- Seed leave types if not already seeded
insert into public.leave_types (name, code, color, paid)
values
  ('Sick Leave', 'SL', '#ef4444', true),
  ('Casual Leave', 'CL', '#3b82f6', true),
  ('Maternity Leave', 'ML', '#8b5cf6', true),
  ('Paternity Leave', 'PL', '#06b6d4', true),
  ('Annual Leave', 'AL', '#10b981', true),
  ('Study Leave', 'STL', '#f59e0b', true),
  ('Emergency Leave', 'EL', '#f97316', true)
on conflict (code) do nothing;

-- Seed employees
insert into public.employees
  (worker_id, full_name, position, role, email, phone, emergency_contact, emergency_phone, employment_type, date_joined, address, department_id, status)
values
  ('W001', 'Aarav D.', 'System Administrator', 'super_admin', 'aarav@example.com', '+248 0000 001', '-', '-', 'full_time', '2022-01-15', 'Victoria', 1, 'active'),
  ('W002', 'Mira B.', 'Principal', 'principal', 'mira@example.com', '+248 0000 002', '-', '-', 'full_time', '2023-06-01', 'Victoria', 2, 'active'),
  ('W003', 'Jayesh K.', 'HOD - Teaching', 'hod', 'jayesh@example.com', '+248 0000 003', '-', '-', 'full_time', '2023-08-15', 'Anse Etoile', 2, 'active'),
  ('W004', 'Priya S.', 'Senior Teacher', 'teacher', 'priya@example.com', '+248 0000 004', '-', '-', 'full_time', '2024-02-01', 'Bel Ombre', 2, 'active'),
  ('W005', 'Lucas R.', 'Support Officer', 'worker', 'lucas@example.com', '+248 0000 005', '-', '-', 'full_time', '2024-05-10', 'Cascade', 3, 'active')
on conflict (worker_id) do nothing;

-- Assign auth_uids after insert if not set
update public.employees
set auth_uid = id
where auth_uid is null;

-- Sample attendance for current month
insert into public.attendance (employee_id, clock_in, clock_out, date)
select
  e.id,
  make_time(8, 0, 0)::time,
  make_time(17, 0, 0)::time,
  d
from public.employees e
cross join generate_series(
  date_trunc('month', current_date)::date,
  current_date,
  '1 day'
) as g(d)
where e.role in ('worker', 'teacher', 'super_admin', 'principal', 'hod')
  and e.status = 'active'
  and extract(dow from d) not in (0, 6)
on conflict (employee_id, date) do update set
  clock_in = excluded.clock_in,
  clock_out = excluded.clock_out;

-- Sample published announcement
insert into public.messages (author_id, title, body, priority, published)
select e.id, 'Welcome to Logix', 'Attendance and leave system is now live.', 'important', true
from public.employees e
where e.worker_id = 'W001'
limit 1;
