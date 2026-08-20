-- ============================================================
--  LOGIX FOR STA SEYCHELLES — REAL AUTH + RLS HARDENING
-- ============================================================
--  Run this AFTER: supabase_schema.sql, supabase_employees.sql,
--  upgrade_passwords_and_photos.sql, security_rls_policies.sql
--
--  What this does:
--   1. Removes every "allow_all" / "Allow Public *" open policy —
--      those left every table fully readable/writable by anyone
--      holding the anon key (visible in the page source).
--   2. Locks password_hash / temp_otp / otp_expires_at / quick_pin
--      out of the anon/authenticated column grants entirely — no
--      client query can ever read or write them directly again.
--   3. Adds a session-token table + verify_login()/whoami()/logout()
--      so login actually checks a password/OTP server-side, instead
--      of the client deciding "yes, let them in" on its own.
--   4. Moves every sensitive write (password set, employee add/edit/
--      status/OTP reset, leave review, message post/delete, clock
--      in/out, lunch toggle, leave submit) into SECURITY DEFINER
--      functions that check a valid session token (and admin role
--      where required) before touching a row.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 0. Reconcile tables that earlier files define inconsistently
-- ------------------------------------------------------------
--  supabase_schema.sql creates audit_log as
--    (actor_id, action NOT NULL, entity, entity_id, context, ip)
--  while security_rls_policies.sql creates it as
--    (actor_id, actor_name, action_type, target_employee, details).
--  Because both use CREATE TABLE IF NOT EXISTS, whichever runs first
--  wins and the other silently does nothing. The app writes the
--  second shape, so make sure those columns exist either way, and
--  relax the NOT NULL on the column the app never fills.
alter table public.audit_log
  add column if not exists actor_name text not null default 'System',
  add column if not exists action_type text,
  add column if not exists target_employee text,
  add column if not exists details text;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'audit_log'
      and column_name = 'action' and is_nullable = 'NO'
  ) then
    alter table public.audit_log alter column action drop not null;
  end if;
end $$;

-- Leave balances live in security_rls_policies.sql, which is
-- superseded by this file. Create them here so the grants below
-- do not fail on a project that never ran it.
alter table public.employees
  add column if not exists annual_leave_balance integer not null default 21,
  add column if not exists sick_leave_balance integer not null default 21,
  add column if not exists compassionate_leave_balance integer not null default 5,
  add column if not exists quick_pin text;

-- ------------------------------------------------------------
-- 1. Drop every open policy from earlier files
-- ------------------------------------------------------------
drop policy if exists "allow_all_departments" on public.departments;
drop policy if exists "allow_all_employees" on public.employees;
drop policy if exists "allow_all_attendance" on public.attendance;
drop policy if exists "allow_all_leave_types" on public.leave_types;
drop policy if exists "allow_all_leave_requests" on public.leave_requests;
drop policy if exists "allow_all_messages" on public.messages;
drop policy if exists "allow_all_audit_log" on public.audit_log;

drop policy if exists "Allow Public Read Employees" on public.employees;
drop policy if exists "Allow Public Read Attendance" on public.attendance;
drop policy if exists "Allow Public Read Leaves" on public.leave_requests;
drop policy if exists "Allow Public Read Messages" on public.messages;
drop policy if exists "Allow Public Read Audit Log" on public.audit_log;
drop policy if exists "Allow Public Insert Attendance" on public.attendance;
drop policy if exists "Allow Public Update Attendance" on public.attendance;
drop policy if exists "Allow Public Insert Leaves" on public.leave_requests;
drop policy if exists "Allow Public Update Leaves" on public.leave_requests;
drop policy if exists "Allow Public Insert Employees" on public.employees;
drop policy if exists "Allow Public Update Employees" on public.employees;
drop policy if exists "Allow Public Insert Messages" on public.messages;
drop policy if exists "Allow Public Delete Messages" on public.messages;
drop policy if exists "Allow Public Insert Audit Log" on public.audit_log;

-- ------------------------------------------------------------
-- 2. Read-only row policies (writes all move to RPCs below)
-- ------------------------------------------------------------
create policy "read_departments" on public.departments for select using (true);
create policy "read_leave_types" on public.leave_types for select using (true);
create policy "read_employees" on public.employees for select using (status = 'active');
create policy "read_attendance" on public.attendance for select using (true);
create policy "read_leave_requests" on public.leave_requests for select using (true);
create policy "read_messages" on public.messages for select using (true);
create policy "read_audit_log" on public.audit_log for select using (true);

-- No insert/update/delete policies for anon/authenticated on any table —
-- every write happens inside a SECURITY DEFINER function below, which
-- runs as the function owner and bypasses RLS internally.

-- ------------------------------------------------------------
-- 3. Column-level lockdown on employees
--    (RLS is row-level; this is what actually hides the secrets)
-- ------------------------------------------------------------
revoke select, insert, update, delete on public.employees from anon, authenticated;

grant select (
  id, worker_id, full_name, position, role, email, phone, emergency_contact,
  emergency_phone, employment_type, date_joined, address, department_id,
  date_of_birth, photo_url, status, date_left, created_at, updated_at,
  annual_leave_balance, sick_leave_balance, compassionate_leave_balance
) on public.employees to anon, authenticated;
-- password_hash, temp_otp, otp_expires_at, must_change_password, quick_pin
-- are deliberately NOT granted — unreadable and unwritable except from
-- inside the SECURITY DEFINER functions below.

revoke all on public.attendance from anon, authenticated;
grant select on public.attendance to anon, authenticated;

revoke all on public.leave_requests from anon, authenticated;
grant select on public.leave_requests to anon, authenticated;

revoke all on public.messages from anon, authenticated;
grant select on public.messages to anon, authenticated;

revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to anon, authenticated;

grant select on public.departments to anon, authenticated;
grant select on public.leave_types to anon, authenticated;

-- ------------------------------------------------------------
-- 4. Session tokens (replaces "logged in = true in localStorage")
-- ------------------------------------------------------------
create table if not exists public.sessions (
  token uuid primary key default gen_random_uuid(),
  employee_id bigint not null references public.employees(id) on delete cascade,
  role text not null,
  created_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null default (now() + interval '12 hours')
);
alter table public.sessions enable row level security;
revoke all on public.sessions from anon, authenticated;
-- No policies at all: anon/authenticated cannot touch this table directly,
-- only the SECURITY DEFINER functions below can.

create or replace function public._require_session(p_token uuid, p_require_admin boolean default false)
returns table(employee_id bigint, role text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sess record;
begin
  delete from public.sessions where expires_at <= now();

  select * into v_sess from public.sessions s where s.token = p_token and s.expires_at > now();
  if v_sess is null then
    raise exception 'Invalid or expired session';
  end if;
  if p_require_admin and v_sess.role not in ('super_admin', 'principal', 'hod') then
    raise exception 'Admin privileges required';
  end if;
  return query select v_sess.employee_id, v_sess.role;
end;
$$;
revoke all on function public._require_session(uuid, boolean) from public;

-- ------------------------------------------------------------
-- 5. Login — the actual fix for the auth bypass
-- ------------------------------------------------------------
create or replace function public.verify_login(
  p_identifier text,
  p_password text,
  p_require_admin boolean default false
) returns table (
  token uuid, id bigint, worker_id text, full_name text, "position" text,
  role text, must_change_password boolean
) language plpgsql security definer set search_path = public, extensions as $$
declare
  v_emp record;
  v_hash text;
  v_token uuid;
begin
  if p_identifier is null or length(trim(p_identifier)) = 0
     or p_password is null or length(p_password) = 0 then
    return;
  end if;

  select * into v_emp
  from public.employees e
  where e.status = 'active'
    and (e.worker_id ilike p_identifier or e.email ilike p_identifier)
  limit 1;

  if v_emp is null then
    return;
  end if;

  if p_require_admin and v_emp.role not in ('super_admin', 'principal', 'hod') then
    return;
  end if;

  v_hash := encode(digest(p_password, 'sha256'), 'hex');

  if not (
    (v_emp.temp_otp is not null and v_emp.temp_otp = p_password)
    or (v_emp.password_hash is not null and v_emp.password_hash = v_hash)
  ) then
    return;
  end if;

  insert into public.sessions (employee_id, role) values (v_emp.id, v_emp.role)
  returning sessions.token into v_token;

  return query select v_token, v_emp.id, v_emp.worker_id, v_emp.full_name,
                      v_emp.position, v_emp.role, v_emp.must_change_password;
end;
$$;
revoke all on function public.verify_login(text, text, boolean) from public;
grant execute on function public.verify_login(text, text, boolean) to anon, authenticated;

create or replace function public.whoami(p_token uuid)
returns table(id bigint, worker_id text, full_name text, "position" text, role text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sess record;
  v_emp record;
begin
  select * into v_sess from public.sessions s where s.token = p_token and s.expires_at > now();
  if v_sess is null then
    return;
  end if;
  select * into v_emp from public.employees e where e.id = v_sess.employee_id and e.status = 'active';
  if v_emp is null then
    return;
  end if;
  return query select v_emp.id, v_emp.worker_id, v_emp.full_name, v_emp.position, v_emp.role;
end;
$$;
revoke all on function public.whoami(uuid) from public;
grant execute on function public.whoami(uuid) to anon, authenticated;

create or replace function public.logout(p_token uuid) returns void
language sql security definer set search_path = public, extensions as $$
  delete from public.sessions where token = p_token;
$$;
revoke all on function public.logout(uuid) from public;
grant execute on function public.logout(uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 6. Password change (first-login OTP -> real password, and self-service)
-- ------------------------------------------------------------
create or replace function public.set_employee_password(
  p_token uuid,
  p_new_password text
) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
begin
  select * into v_session from public._require_session(p_token, false);
  if p_new_password is null or length(p_new_password) < 8 then
    raise exception 'Password must be at least 8 characters.';
  end if;

  update public.employees
  set password_hash = encode(digest(p_new_password, 'sha256'), 'hex'),
      temp_otp = null,
      otp_expires_at = null,
      must_change_password = false,
      updated_at = now()
  where id = v_session.employee_id;

  return true;
end;
$$;
revoke all on function public.set_employee_password(uuid, text) from public;
grant execute on function public.set_employee_password(uuid, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 7. Employee-scoped actions (identity comes from the token, never
--    from a client-supplied employee_id — fixes the "clock in as
--    anyone" tampering the old open policies allowed)
-- ------------------------------------------------------------
create or replace function public.clock_action(p_token uuid, p_action text)
returns public.attendance language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_row public.attendance;
  v_now timestamptz := now();
begin
  select * into v_session from public._require_session(p_token, false);
  if p_action not in ('in', 'out') then
    raise exception 'Invalid clock action';
  end if;

  insert into public.attendance (employee_id, date, clock_in, clock_out, updated_at)
  values (
    v_session.employee_id, current_date,
    case when p_action = 'in' then v_now else null end,
    case when p_action = 'out' then v_now else null end,
    v_now
  )
  on conflict (employee_id, date) do update set
    clock_in = case when p_action = 'in' then v_now else public.attendance.clock_in end,
    clock_out = case when p_action = 'out' then v_now else public.attendance.clock_out end,
    updated_at = v_now
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.clock_action(uuid, text) from public;
grant execute on function public.clock_action(uuid, text) to anon, authenticated;

create or replace function public.toggle_lunch(p_token uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_now timestamptz := now();
begin
  select * into v_session from public._require_session(p_token, false);

  insert into public.attendance (employee_id, date, is_on_lunch, lunch_started_at, updated_at)
  values (v_session.employee_id, current_date, p_on, case when p_on then v_now else null end, v_now)
  on conflict (employee_id, date) do update set
    is_on_lunch = p_on,
    lunch_started_at = case when p_on then v_now else public.attendance.lunch_started_at end,
    updated_at = v_now;
end;
$$;
revoke all on function public.toggle_lunch(uuid, boolean) from public;
grant execute on function public.toggle_lunch(uuid, boolean) to anon, authenticated;

create or replace function public.submit_leave_request(
  p_token uuid, p_leave_code text, p_start date, p_end date,
  p_reason text, p_half_day boolean
) returns public.leave_requests language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_leave_type_id bigint;
  v_row public.leave_requests;
begin
  select * into v_session from public._require_session(p_token, false);

  select id into v_leave_type_id from public.leave_types where code = p_leave_code;
  if v_leave_type_id is null then
    raise exception 'Unknown leave type';
  end if;

  insert into public.leave_requests (employee_id, leave_type_id, start_date, end_date, reason, is_half_day)
  values (v_session.employee_id, v_leave_type_id, p_start, p_end, p_reason, coalesce(p_half_day, false))
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.submit_leave_request(uuid, text, date, date, text, boolean) from public;
grant execute on function public.submit_leave_request(uuid, text, date, date, text, boolean) to anon, authenticated;

-- ------------------------------------------------------------
-- 8. Admin-only actions (require an admin-role session token)
-- ------------------------------------------------------------
create or replace function public.admin_add_employee(
  p_token uuid, p_worker_id text, p_full_name text, p_position text,
  p_date_of_birth date, p_department_id bigint, p_employment_type text,
  p_email text, p_phone text, p_photo_url text, p_temp_otp text
) returns public.employees language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_actor_name text;
  v_row public.employees;
begin
  select * into v_session from public._require_session(p_token, true);
  select full_name into v_actor_name from public.employees where id = v_session.employee_id;

  insert into public.employees (
    worker_id, full_name, position, date_of_birth, department_id, employment_type,
    email, phone, photo_url, temp_otp, must_change_password, status
  ) values (
    upper(p_worker_id), p_full_name, p_position, p_date_of_birth, p_department_id, p_employment_type,
    nullif(p_email, ''), nullif(p_phone, ''), p_photo_url, p_temp_otp, true, 'active'
  ) returning * into v_row;

  insert into public.audit_log (actor_id, actor_name, action_type, target_employee, details)
  values (v_session.employee_id, coalesce(v_actor_name, 'Admin'), 'ADD_EMPLOYEE', v_row.full_name, 'Registered new employee ' || v_row.worker_id);

  return v_row;
end;
$$;
revoke all on function public.admin_add_employee(uuid, text, text, text, date, bigint, text, text, text, text, text) from public;
grant execute on function public.admin_add_employee(uuid, text, text, text, date, bigint, text, text, text, text, text) to anon, authenticated;

create or replace function public.admin_update_employee(
  p_token uuid, p_employee_id bigint, p_full_name text, p_date_of_birth date,
  p_position text, p_department_id bigint, p_email text, p_photo_url text
) returns public.employees language plpgsql security definer set search_path = public, extensions as $$
declare
  v_row public.employees;
begin
  perform public._require_session(p_token, true);

  update public.employees set
    full_name = p_full_name,
    date_of_birth = p_date_of_birth,
    position = p_position,
    department_id = p_department_id,
    email = nullif(p_email, ''),
    photo_url = coalesce(p_photo_url, photo_url),
    updated_at = now()
  where id = p_employee_id
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.admin_update_employee(uuid, bigint, text, date, text, bigint, text, text) from public;
grant execute on function public.admin_update_employee(uuid, bigint, text, date, text, bigint, text, text) to anon, authenticated;

create or replace function public.admin_set_employee_status(p_token uuid, p_employee_id bigint, p_status text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_actor_name text;
  v_target_name text;
begin
  select * into v_session from public._require_session(p_token, true);
  select full_name into v_actor_name from public.employees where id = v_session.employee_id;
  select full_name into v_target_name from public.employees where id = p_employee_id;

  update public.employees set status = p_status, updated_at = now() where id = p_employee_id;

  insert into public.audit_log (actor_id, actor_name, action_type, target_employee, details)
  values (v_session.employee_id, coalesce(v_actor_name, 'Admin'), 'SET_EMPLOYEE_STATUS', coalesce(v_target_name, ''), 'Status changed to ' || p_status);
end;
$$;
revoke all on function public.admin_set_employee_status(uuid, bigint, text) from public;
grant execute on function public.admin_set_employee_status(uuid, bigint, text) to anon, authenticated;

create or replace function public.admin_reset_employee_otp(p_token uuid, p_employee_id bigint, p_new_otp text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_actor_name text;
  v_target_name text;
begin
  select * into v_session from public._require_session(p_token, true);
  select full_name into v_actor_name from public.employees where id = v_session.employee_id;
  select full_name into v_target_name from public.employees where id = p_employee_id;

  update public.employees
  set temp_otp = p_new_otp, password_hash = null, must_change_password = true, updated_at = now()
  where id = p_employee_id;

  insert into public.audit_log (actor_id, actor_name, action_type, target_employee, details)
  values (v_session.employee_id, coalesce(v_actor_name, 'Admin'), 'RESET_OTP', coalesce(v_target_name, ''), 'Generated new one-time OTP');
end;
$$;
revoke all on function public.admin_reset_employee_otp(uuid, bigint, text) from public;
grant execute on function public.admin_reset_employee_otp(uuid, bigint, text) to anon, authenticated;

create or replace function public.admin_review_leave(p_token uuid, p_leave_id bigint, p_status text, p_comment text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_actor_name text;
  v_target_name text;
begin
  select * into v_session from public._require_session(p_token, true);
  if p_status not in ('approved', 'denied') then
    raise exception 'Invalid leave status';
  end if;

  select full_name into v_actor_name from public.employees where id = v_session.employee_id;
  select e.full_name into v_target_name from public.leave_requests lr join public.employees e on e.id = lr.employee_id where lr.id = p_leave_id;

  update public.leave_requests
  set status = p_status, review_comment = coalesce(p_comment, ''), reviewed_at = now()
  where id = p_leave_id;

  insert into public.audit_log (actor_id, actor_name, action_type, target_employee, details)
  values (v_session.employee_id, coalesce(v_actor_name, 'Admin'), 'REVIEW_LEAVE', coalesce(v_target_name, ''), 'Leave request ' || p_status);
end;
$$;
revoke all on function public.admin_review_leave(uuid, bigint, text, text) from public;
grant execute on function public.admin_review_leave(uuid, bigint, text, text) to anon, authenticated;

create or replace function public.admin_post_message(p_token uuid, p_title text, p_body text, p_priority text)
returns public.messages language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_row public.messages;
begin
  select * into v_session from public._require_session(p_token, true);
  insert into public.messages (author_id, title, body, priority, published)
  values (v_session.employee_id, p_title, p_body, coalesce(p_priority, 'normal'), true)
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.admin_post_message(uuid, text, text, text) from public;
grant execute on function public.admin_post_message(uuid, text, text, text) to anon, authenticated;

create or replace function public.admin_delete_message(p_token uuid, p_message_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_actor_name text;
begin
  select * into v_session from public._require_session(p_token, true);
  select full_name into v_actor_name from public.employees where id = v_session.employee_id;

  delete from public.messages where id = p_message_id;

  insert into public.audit_log (actor_id, actor_name, action_type, target_employee, details)
  values (v_session.employee_id, coalesce(v_actor_name, 'Admin'), 'DELETE_ANNOUNCEMENT', '', 'Deleted message #' || p_message_id);
end;
$$;
revoke all on function public.admin_delete_message(uuid, bigint) from public;
grant execute on function public.admin_delete_message(uuid, bigint) to anon, authenticated;

create or replace function public.log_client_event(p_token uuid, p_action_type text, p_target text, p_details text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_actor_name text;
begin
  select * into v_session from public._require_session(p_token, true);
  select full_name into v_actor_name from public.employees where id = v_session.employee_id;
  insert into public.audit_log (actor_id, actor_name, action_type, target_employee, details)
  values (v_session.employee_id, coalesce(v_actor_name, 'Admin'), p_action_type, coalesce(p_target, ''), coalesce(p_details, ''));
end;
$$;
revoke all on function public.log_client_event(uuid, text, text, text) from public;
grant execute on function public.log_client_event(uuid, text, text, text) to anon, authenticated;

-- ============================================================
-- DONE. After running this, deploy the updated js/employee.js
-- and js/admin.js (they now call these functions via .rpc(...)
-- instead of touching tables directly with the anon key).
-- ============================================================
