-- ============================================================
--  LOGIX — MANUAL ATTENDANCE ENTRY
--  Run this AFTER bulk_staff_import.sql (migration 10 of 10).
--
--  Until now nothing could put a missed clock-in right. A flat
--  battery, a forgotten tap, a GPS fix that never arrived, or a
--  queued action older than the eighteen-hour window all left a
--  permanent hole in someone's record — and the offline error
--  messages told staff to "ask a supervisor to enter it", which
--  was advice pointing at a door that did not exist.
--
--  A manual entry is a supervisor asserting something happened
--  that the system did not witness. It is not the same kind of
--  fact as a verified clock-in, so it is never disguised as one:
--  every manual row records who entered it, when, and why, shows
--  as corrected in the admin table and on the exports, and is
--  written to the audit trail.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Provenance on the attendance row
-- ------------------------------------------------------------
alter table public.attendance
  add column if not exists manual_entry  boolean not null default false,
  add column if not exists manual_by     bigint references public.employees(id) on delete set null,
  add column if not exists manual_reason text,
  add column if not exists manual_at     timestamptz;

comment on column public.attendance.manual_entry is
  'True when a supervisor entered or corrected these times by hand rather than the employee clocking in.';
comment on column public.attendance.manual_reason is
  'Why the correction was made. Required - a manual entry without a reason is unauditable.';


-- ------------------------------------------------------------
-- 2. Enter or correct a day
-- ------------------------------------------------------------
-- Times arrive as plain clock times ('08:15') against a date, which is
-- how a supervisor thinks about it. They are interpreted in Seychelles
-- time and stored as timestamptz like every other row.
--
-- Passing null for both times clears the day. Passing null for one
-- leaves that half alone unless p_clear_missing is set, which lets a
-- supervisor genuinely remove a wrong clock-out.
create or replace function public.admin_set_attendance(
  p_token          uuid,
  p_employee_id    bigint,
  p_date           date,
  p_clock_in       time    default null,
  p_clock_out      time    default null,
  p_reason         text    default null,
  p_clear_missing  boolean default false
) returns public.attendance
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session   record;
  v_actor     text;
  v_target    text;
  v_row       public.attendance;
  v_existing  public.attendance;
  v_in        timestamptz;
  v_out       timestamptz;
  v_reason    text;
  v_now       timestamptz := now();
  c_zone      constant text := 'Indian/Mahe';
begin
  select * into v_session from public._require_session(p_token, true);

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'Give a reason for the correction, so the record explains itself later';
  end if;
  if length(v_reason) > 300 then
    raise exception 'Keep the reason under 300 characters';
  end if;

  if p_date is null then
    raise exception 'Which date is this for?';
  end if;
  if p_date > (v_now at time zone c_zone)::date then
    raise exception 'That date has not happened yet';
  end if;
  -- A year back is generous for a payroll correction and still stops a
  -- typo in the year field rewriting something from 2019.
  if p_date < (v_now at time zone c_zone)::date - interval '1 year' then
    raise exception 'That date is more than a year ago';
  end if;

  if not exists (select 1 from public.employees e where e.id = p_employee_id) then
    raise exception 'No such member of staff';
  end if;

  select * into v_existing from public.attendance a
   where a.employee_id = p_employee_id and a.date = p_date;

  -- Build the new timestamps, keeping whatever is already there unless
  -- told otherwise.
  if p_clock_in is not null then
    v_in := (p_date + p_clock_in) at time zone c_zone;
  elsif p_clear_missing then
    v_in := null;
  else
    v_in := v_existing.clock_in;
  end if;

  if p_clock_out is not null then
    v_out := (p_date + p_clock_out) at time zone c_zone;
  elsif p_clear_missing then
    v_out := null;
  else
    v_out := v_existing.clock_out;
  end if;

  if v_in is not null and v_out is not null and v_out <= v_in then
    raise exception 'The finish time must be after the start time';
  end if;

  insert into public.attendance (
    employee_id, date, clock_in, clock_out,
    manual_entry, manual_by, manual_reason, manual_at, updated_at
  ) values (
    p_employee_id, p_date, v_in, v_out,
    true, v_session.employee_id, v_reason, v_now, v_now
  )
  on conflict (employee_id, date) do update set
    clock_in      = v_in,
    clock_out     = v_out,
    manual_entry  = true,
    manual_by     = v_session.employee_id,
    manual_reason = v_reason,
    manual_at     = v_now,
    updated_at    = v_now
  returning * into v_row;

  select e.full_name into v_actor  from public.employees e where e.id = v_session.employee_id;
  select e.full_name into v_target from public.employees e where e.id = p_employee_id;

  insert into public.audit_log (actor_id, actor_name, action_type, target_employee, details)
  values (
    v_session.employee_id, coalesce(v_actor, 'Admin'), 'MANUAL_ATTENDANCE',
    coalesce(v_target, ''),
    format('%s on %s set to %s - %s',
      case when v_existing.id is null then 'Entered' else 'Corrected' end,
      to_char(p_date, 'DD Mon YYYY'),
      case
        when v_in is null and v_out is null then 'cleared'
        else coalesce(to_char(v_in at time zone c_zone, 'HH24:MI'), '--:--')
             || ' to ' ||
             coalesce(to_char(v_out at time zone c_zone, 'HH24:MI'), '--:--')
      end,
      v_reason)
  );

  return v_row;
end;
$$;

revoke all on function public.admin_set_attendance(uuid, bigint, date, time, time, text, boolean) from public;
grant execute on function public.admin_set_attendance(uuid, bigint, date, time, time, text, boolean)
  to anon, authenticated;


-- ------------------------------------------------------------
-- 3. Read one person's day, for the correction form
-- ------------------------------------------------------------
-- Lets the form open showing what is currently recorded, so a
-- supervisor corrects rather than overwrites blind.
create or replace function public.admin_get_attendance_day(
  p_token uuid, p_employee_id bigint, p_date date
) returns table (
  clock_in      time,
  clock_out     time,
  manual_entry  boolean,
  manual_reason text,
  manual_by     text,
  manual_at     timestamptz
)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session record;
begin
  select * into v_session from public._require_session(p_token, true);

  return query
    select
      (a.clock_in  at time zone 'Indian/Mahe')::time,
      (a.clock_out at time zone 'Indian/Mahe')::time,
      a.manual_entry,
      a.manual_reason,
      e.full_name,
      a.manual_at
    from public.attendance a
    left join public.employees e on e.id = a.manual_by
    where a.employee_id = p_employee_id and a.date = p_date;
end;
$$;

revoke all on function public.admin_get_attendance_day(uuid, bigint, date) from public;
grant execute on function public.admin_get_attendance_day(uuid, bigint, date) to anon, authenticated;


-- ------------------------------------------------------------
-- 4. Reading the new columns
-- ------------------------------------------------------------
-- No grant needed. harden_auth_and_rls.sql grants SELECT on the whole
-- attendance table, which covers columns added afterwards, and the
-- read_attendance policy still governs which rows come back. Writes
-- remain impossible from the browser: only the function above can set
-- these, and it checks for an admin session first.
