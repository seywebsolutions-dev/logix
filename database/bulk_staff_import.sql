-- ============================================================
--  LOGIX — BULK STAFF IMPORT
--  Run this AFTER offline_clockin.sql (migration 9 of 9).
--
--  Adding staff one at a time is fine for a new hire and painful
--  for an opening roll. STA has somewhere around seventy people;
--  at roughly a minute each that is an afternoon of form-filling,
--  and seventy one-time codes to copy down by hand without losing
--  one. This takes a spreadsheet instead.
--
--  What it will not do: overwrite anybody. A row matching someone
--  already on file is skipped and reported, so running the same
--  file twice is safe and a half-finished import can be re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Next free worker ID
-- ------------------------------------------------------------
-- Reads the highest STA<digits> on file and continues from there.
-- Ignores anything not in that shape so a hand-typed oddity cannot
-- push the sequence somewhere silly.
create or replace function public._next_worker_number()
returns int
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(
    max((substring(worker_id from '^STA0*([0-9]+)$'))::int),
    0
  ) + 1
  from public.employees
  where worker_id ~ '^STA0*[0-9]+$';
$$;

revoke all on function public._next_worker_number() from anon, authenticated;


-- ------------------------------------------------------------
-- 2. The import
-- ------------------------------------------------------------
-- p_rows is a JSON array. Each object may carry:
--   full_name        required
--   position         required
--   worker_id        optional - assigned automatically when absent
--   temp_otp         required - the plaintext one-time code, hashed here
--   email, phone     optional
--   employment_type  optional, defaults to full_time
--   department       optional, matched on department name or code
--
-- Returns one row per input row so the administrator can see exactly
-- what happened, including the codes to hand out.
create or replace function public.admin_bulk_add_employees(
  p_token uuid, p_rows jsonb
) returns table (
  line       int,
  worker_id  text,
  full_name  text,
  temp_otp   text,
  outcome    text,
  detail     text
)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session   record;
  v_actor     text;
  v_row       jsonb;
  v_i         int := 0;
  v_next      int;
  v_wid       text;
  v_name      text;
  v_pos       text;
  v_email     text;
  v_dept      bigint;
  v_deptname  text;
  v_otp       text;
  v_added     int := 0;
  v_skipped   int := 0;
begin
  select * into v_session from public._require_session(p_token, true);
  select e.full_name into v_actor from public.employees e where e.id = v_session.employee_id;

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Expected a list of staff rows';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'There is nothing to import';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'Import at most 500 people at a time';
  end if;

  v_next := public._next_worker_number();

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;

    v_name  := btrim(coalesce(v_row->>'full_name', ''));
    v_pos   := btrim(coalesce(v_row->>'position', ''));
    v_email := nullif(btrim(lower(coalesce(v_row->>'email', ''))), '');
    v_otp   := nullif(btrim(coalesce(v_row->>'temp_otp', '')), '');
    v_wid   := nullif(upper(btrim(coalesce(v_row->>'worker_id', ''))), '');

    -- Validation, per row. One bad line does not sink the batch.
    if v_name = '' then
      line := v_i; worker_id := v_wid; full_name := null; temp_otp := null;
      outcome := 'skipped'; detail := 'No name given';
      v_skipped := v_skipped + 1; return next; continue;
    end if;

    if v_pos = '' then
      line := v_i; worker_id := v_wid; full_name := v_name; temp_otp := null;
      outcome := 'skipped'; detail := 'No position given';
      v_skipped := v_skipped + 1; return next; continue;
    end if;

    if v_otp is null then
      line := v_i; worker_id := v_wid; full_name := v_name; temp_otp := null;
      outcome := 'skipped'; detail := 'No one-time code supplied';
      v_skipped := v_skipped + 1; return next; continue;
    end if;

    -- Already on file? Match on email first, then on name and position
    -- together, which is the best a spreadsheet without emails allows.
    if v_email is not null
       and exists (select 1 from public.employees e where lower(e.email) = v_email) then
      line := v_i; worker_id := v_wid; full_name := v_name; temp_otp := null;
      outcome := 'skipped'; detail := 'Someone already has that email address';
      v_skipped := v_skipped + 1; return next; continue;
    end if;

    if exists (
      select 1 from public.employees e
      where lower(btrim(e.full_name)) = lower(v_name)
        and lower(btrim(e.position))  = lower(v_pos)
    ) then
      line := v_i; worker_id := v_wid; full_name := v_name; temp_otp := null;
      outcome := 'skipped'; detail := 'Already on file with that name and position';
      v_skipped := v_skipped + 1; return next; continue;
    end if;

    -- Worker ID: honour one that was supplied, otherwise take the next free.
    if v_wid is null then
      loop
        v_wid := 'STA' || lpad(v_next::text, 3, '0');
        exit when not exists (select 1 from public.employees e where e.worker_id = v_wid);
        v_next := v_next + 1;
      end loop;
      v_next := v_next + 1;
    elsif exists (select 1 from public.employees e where e.worker_id = v_wid) then
      line := v_i; worker_id := v_wid; full_name := v_name; temp_otp := null;
      outcome := 'skipped'; detail := 'That Worker ID is already taken';
      v_skipped := v_skipped + 1; return next; continue;
    end if;

    -- Department by name or code; unknown is not fatal, just reported.
    v_dept := null;
    v_deptname := nullif(btrim(coalesce(v_row->>'department', '')), '');
    if v_deptname is not null then
      select d.id into v_dept from public.departments d
       where lower(d.name) = lower(v_deptname) or lower(d.code) = lower(v_deptname)
       limit 1;
    end if;

    insert into public.employees (
      worker_id, full_name, position, employment_type, email, phone,
      department_id, temp_otp, otp_expires_at, must_change_password, status
    ) values (
      v_wid, v_name, v_pos,
      coalesce(nullif(btrim(coalesce(v_row->>'employment_type','')), ''), 'full_time'),
      v_email,
      nullif(btrim(coalesce(v_row->>'phone', '')), ''),
      v_dept,
      public.hash_password(v_otp),
      now() + interval '7 days',
      true, 'active'
    );

    v_added := v_added + 1;
    line := v_i;
    worker_id := v_wid;
    full_name := v_name;
    temp_otp := v_otp;      -- returned once, never readable again
    outcome := 'added';
    detail := case
                when v_deptname is not null and v_dept is null
                then 'Added, but no department matched "' || v_deptname || '"'
                else null
              end;
    return next;
  end loop;

  insert into public.audit_log (actor_id, actor_name, action_type, target_employee, details)
  values (v_session.employee_id, coalesce(v_actor, 'Admin'), 'BULK_ADD_EMPLOYEES', '',
          format('%s added, %s skipped, from a file of %s',
                 v_added, v_skipped, jsonb_array_length(p_rows)));
end;
$$;

revoke all on function public.admin_bulk_add_employees(uuid, jsonb) from public;
grant execute on function public.admin_bulk_add_employees(uuid, jsonb) to anon, authenticated;
