-- ============================================================
--  LOGIX FOR STA SEYCHELLES — PASSWORD SECURITY
-- ============================================================
--  Run AFTER geofence_and_network.sql
--
--  WHAT WAS WRONG
--    Passwords were stored as plain SHA-256: unsalted, one pass.
--    SHA-256 is built to be FAST, which is the opposite of what
--    password storage needs. Commodity hardware tests billions of
--    SHA-256 guesses a second, so a stolen `employees` table would
--    give up most real-world passwords quickly. Unsalted also means
--    two people who choose the same password store the same hash,
--    so cracking one cracks both, and precomputed rainbow tables
--    apply directly.
--
--  WHAT THIS DOES
--    1. Moves to bcrypt (pgcrypto's crypt/gen_salt) at cost 12:
--       a unique random salt per password and a deliberate ~250ms
--       work factor, which collapses offline guessing rates from
--       billions/sec to a few thousand/sec.
--    2. Migrates existing hashes transparently — an old SHA-256
--       hash still verifies once, and is silently re-hashed to
--       bcrypt on that first successful sign-in. Nobody is locked
--       out and nobody has to be told anything.
--    3. Locks an account for 15 minutes after 5 wrong attempts,
--       which is what actually stops online guessing. Work factor
--       protects a stolen database; lockout protects the login form.
--    4. Enforces password rules in the DATABASE. They were only
--       checked in JavaScript, which anyone can skip by calling
--       the API directly.
--    5. Stores one-time codes hashed and expiring, instead of as
--       readable plaintext in a column any admin query could see.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. Lockout bookkeeping
-- ------------------------------------------------------------
alter table public.employees
  add column if not exists failed_login_attempts integer not null default 0,
  add column if not exists locked_until timestamp with time zone,
  add column if not exists password_changed_at timestamp with time zone;

-- Keep these out of reach of the client entirely.
revoke select (failed_login_attempts, locked_until) on public.employees from anon, authenticated;

-- ------------------------------------------------------------
-- 2. Server-side password rules
-- ------------------------------------------------------------
--  Mirrors the browser check, but this one cannot be bypassed.
create or replace function public.validate_password(p_password text)
returns text
language plpgsql immutable as $$
begin
  if p_password is null or length(p_password) < 8 then
    return 'Password must be at least 8 characters.';
  end if;
  if length(p_password) > 72 then
    -- bcrypt silently ignores anything past 72 bytes; refuse rather
    -- than accept a password whose tail does nothing.
    return 'Password must be 72 characters or fewer.';
  end if;
  if p_password !~ '[A-Z]' then
    return 'Password must contain an uppercase letter.';
  end if;
  if p_password !~ '[a-z]' then
    return 'Password must contain a lowercase letter.';
  end if;
  if p_password !~ '[0-9]' then
    return 'Password must contain a number.';
  end if;
  if p_password !~ '[^A-Za-z0-9]' then
    return 'Password must contain a symbol.';
  end if;
  if lower(p_password) in (
    'password','password1','passw0rd','12345678','123456789','qwertyui',
    'sta12345','seychelles','logix123','welcome1','abcd1234'
  ) then
    return 'That password is too common. Choose something else.';
  end if;
  return null; -- valid
end;
$$;

-- ------------------------------------------------------------
-- 3. Hash + verify helpers
-- ------------------------------------------------------------
create or replace function public.hash_password(p_password text) returns text
language sql volatile set search_path = public, extensions as $$
  select crypt(p_password, gen_salt('bf', 12));
$$;

--  Accepts either a modern bcrypt hash or a legacy SHA-256 hex
--  digest, so the migration needs no coordinated cutover.
create or replace function public.password_matches(p_password text, p_hash text)
returns boolean
language plpgsql immutable set search_path = public, extensions as $$
begin
  if p_hash is null or p_password is null then
    return false;
  end if;

  if p_hash like '$2%' then                       -- bcrypt
    return crypt(p_password, p_hash) = p_hash;
  end if;

  if p_hash ~ '^[0-9a-f]{64}$' then               -- legacy SHA-256
    return encode(digest(p_password, 'sha256'), 'hex') = p_hash;
  end if;

  return false;
end;
$$;

create or replace function public.is_legacy_hash(p_hash text) returns boolean
language sql immutable as $$
  select p_hash is not null and p_hash ~ '^[0-9a-f]{64}$';
$$;

revoke all on function public.hash_password(text) from public;
revoke all on function public.password_matches(text, text) from public;

-- ------------------------------------------------------------
-- 4. Login: bcrypt, lockout, silent hash upgrade
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
  v_token uuid;
  v_ok boolean := false;
  v_via_otp boolean := false;
  v_max_attempts constant integer := 5;
  v_lock_minutes constant integer := 15;
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
    -- Spend comparable time on a miss so response timing does not
    -- reveal whether a Worker ID exists.
    perform crypt(p_password, gen_salt('bf', 12));
    return;
  end if;

  if v_emp.locked_until is not null and v_emp.locked_until > now() then
    raise exception 'Too many failed attempts. Try again in % minutes.',
      greatest(1, ceil(extract(epoch from (v_emp.locked_until - now())) / 60));
  end if;

  if p_require_admin and v_emp.role not in ('super_admin', 'principal', 'hod') then
    return;
  end if;

  -- One-time code (hashed, and only while unexpired)
  if v_emp.temp_otp is not null
     and (v_emp.otp_expires_at is null or v_emp.otp_expires_at > now())
     and public.password_matches(p_password, v_emp.temp_otp) then
    v_ok := true;
    v_via_otp := true;
  elsif public.password_matches(p_password, v_emp.password_hash) then
    v_ok := true;
  end if;

  if not v_ok then
    update public.employees
    set failed_login_attempts = failed_login_attempts + 1,
        locked_until = case
          when failed_login_attempts + 1 >= v_max_attempts
          then now() + (v_lock_minutes || ' minutes')::interval
          else locked_until end
    where employees.id = v_emp.id;

    if v_emp.failed_login_attempts + 1 >= v_max_attempts then
      insert into public.audit_log (actor_id, actor_name, action_type, target_employee, details)
      values (v_emp.id, 'System', 'ACCOUNT_LOCKED', v_emp.full_name,
              format('Locked for %s minutes after %s failed attempts', v_lock_minutes, v_max_attempts));
    end if;
    return;
  end if;

  -- Success. Transparently upgrade a legacy hash now that we hold
  -- the plaintext and know it is correct.
  if not v_via_otp and public.is_legacy_hash(v_emp.password_hash) then
    update public.employees
    set password_hash = public.hash_password(p_password),
        password_changed_at = coalesce(password_changed_at, now())
    where employees.id = v_emp.id;
  end if;

  update public.employees
  set failed_login_attempts = 0, locked_until = null
  where employees.id = v_emp.id;

  insert into public.sessions (employee_id, role) values (v_emp.id, v_emp.role)
  returning sessions.token into v_token;

  return query select v_token, v_emp.id, v_emp.worker_id, v_emp.full_name,
                      v_emp.position, v_emp.role, v_emp.must_change_password;
end;
$$;
revoke all on function public.verify_login(text, text, boolean) from public;
grant execute on function public.verify_login(text, text, boolean) to anon, authenticated;

-- ------------------------------------------------------------
-- 5. Setting a password
-- ------------------------------------------------------------
create or replace function public.set_employee_password(
  p_token uuid,
  p_new_password text
) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_problem text;
  v_current text;
begin
  select * into v_session from public._require_session(p_token, false);

  v_problem := public.validate_password(p_new_password);
  if v_problem is not null then
    raise exception '%', v_problem;
  end if;

  -- Refuse a "new" password identical to the current one.
  select password_hash into v_current from public.employees where id = v_session.employee_id;
  if v_current is not null and public.password_matches(p_new_password, v_current) then
    raise exception 'That is already your current password.';
  end if;

  update public.employees
  set password_hash = public.hash_password(p_new_password),
      temp_otp = null,
      otp_expires_at = null,
      must_change_password = false,
      failed_login_attempts = 0,
      locked_until = null,
      password_changed_at = now(),
      updated_at = now()
  where id = v_session.employee_id;

  -- Every other device is signed out when the password changes.
  delete from public.sessions
  where employee_id = v_session.employee_id and token <> p_token;

  return true;
end;
$$;
revoke all on function public.set_employee_password(uuid, text) from public;
grant execute on function public.set_employee_password(uuid, text) to anon, authenticated;

-- Change password while knowing the old one (self-service, no admin).
create or replace function public.change_own_password(
  p_token uuid, p_current_password text, p_new_password text
) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_emp record;
  v_problem text;
begin
  select * into v_session from public._require_session(p_token, false);
  select * into v_emp from public.employees where id = v_session.employee_id;

  if not public.password_matches(p_current_password, v_emp.password_hash) then
    raise exception 'Your current password is not correct.';
  end if;

  v_problem := public.validate_password(p_new_password);
  if v_problem is not null then
    raise exception '%', v_problem;
  end if;

  update public.employees
  set password_hash = public.hash_password(p_new_password),
      password_changed_at = now(), updated_at = now()
  where id = v_emp.id;

  delete from public.sessions where employee_id = v_emp.id and token <> p_token;
  return true;
end;
$$;
revoke all on function public.change_own_password(uuid, text, text) from public;
grant execute on function public.change_own_password(uuid, text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 6. Forgotten password — admin-issued one-time code
-- ------------------------------------------------------------
--  The code is stored HASHED and expires. The plaintext exists only
--  in the admin's browser at the moment it is generated, which is
--  why the dialog says to write it down before closing.
create or replace function public.admin_reset_employee_otp(
  p_token uuid, p_employee_id bigint, p_new_otp text
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
  v_actor_name text;
  v_target_name text;
begin
  select * into v_session from public._require_session(p_token, true);
  select full_name into v_actor_name from public.employees where id = v_session.employee_id;
  select full_name into v_target_name from public.employees where id = p_employee_id;

  update public.employees
  set temp_otp = public.hash_password(p_new_otp),
      otp_expires_at = now() + interval '48 hours',
      password_hash = null,
      must_change_password = true,
      failed_login_attempts = 0,
      locked_until = null,
      updated_at = now()
  where id = p_employee_id;

  -- Signing out everywhere matters here: if the account was taken
  -- over, a reset that leaves the intruder's session alive is not
  -- a reset.
  delete from public.sessions where employee_id = p_employee_id;

  insert into public.audit_log (actor_id, actor_name, action_type, target_employee, details)
  values (v_session.employee_id, coalesce(v_actor_name, 'Admin'), 'RESET_OTP',
          coalesce(v_target_name, ''), 'Issued a one-time code, valid 48 hours');
end;
$$;
revoke all on function public.admin_reset_employee_otp(uuid, bigint, text) from public;
grant execute on function public.admin_reset_employee_otp(uuid, bigint, text) to anon, authenticated;

-- New staff also get a hashed, expiring code.
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
    email, phone, photo_url, temp_otp, otp_expires_at, must_change_password, status
  ) values (
    upper(p_worker_id), p_full_name, p_position, p_date_of_birth, p_department_id, p_employment_type,
    nullif(p_email, ''), nullif(p_phone, ''), p_photo_url,
    public.hash_password(p_temp_otp), now() + interval '7 days', true, 'active'
  ) returning * into v_row;

  insert into public.audit_log (actor_id, actor_name, action_type, target_employee, details)
  values (v_session.employee_id, coalesce(v_actor_name, 'Admin'), 'ADD_EMPLOYEE',
          v_row.full_name, 'Registered ' || v_row.worker_id);

  return v_row;
end;
$$;
revoke all on function public.admin_add_employee(uuid, text, text, text, date, bigint, text, text, text, text, text) from public;
grant execute on function public.admin_add_employee(uuid, text, text, text, date, bigint, text, text, text, text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 7. Existing plaintext codes are now unusable — clear them
-- ------------------------------------------------------------
--  Any temp_otp written before this migration is stored in the
--  clear and will no longer verify. Blank them so nobody is left
--  holding a code that silently fails, and so the plaintext stops
--  sitting in the table.
update public.employees
set temp_otp = null, otp_expires_at = null
where temp_otp is not null and temp_otp !~ '^\$2';

-- ============================================================
-- AFTER RUNNING THIS
--
--  Seeded demo staff had the plaintext code 'STA-1234'. It no
--  longer works. Re-issue codes from Admin → Staff → "Reset code",
--  or for the very first administrator run this once:
--
--    update public.employees
--    set temp_otp = public.hash_password('STA-Setup-2026'),
--        otp_expires_at = now() + interval '48 hours',
--        must_change_password = true
--    where worker_id = 'STA001';
--
--  Then sign in as STA001 with STA-Setup-2026 and set a real
--  password immediately. Change that string to something only you
--  know before running it.
-- ============================================================
