-- ============================================================
--  LOGIX — DEFERRED (OFFLINE) CLOCK-IN
--  Run this AFTER leave_balances.sql (migration 8 of 8).
--
--  Campus WiFi drops. When it does, a member of staff taps Clock In,
--  nothing happens, and the day is lost. The browser can now hold the
--  action and send it when the connection returns — but the recorded
--  time must be when the button was pressed, not when the network came
--  back, so clock_action needs to accept a timestamp.
--
--  Two things cannot be trusted about a deferred action, and both are
--  handled rather than ignored:
--
--  1. The time comes from the device. It is bounded: never in the
--     future, never older than the window below, and always flagged.
--  2. The IP seen at sync time is wherever the person is *now*, which
--     says nothing about where they were. So the network check is not
--     applied to deferred actions — the geofence carries them instead,
--     and a deferred action with no usable GPS fix is refused outright.
--
--  The effect: offline clock-in works, but only for someone whose
--  device recorded them inside the campus boundary at the time.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Mark deferred entries
-- ------------------------------------------------------------
alter table public.clock_events
  add column if not exists deferred boolean not null default false,
  add column if not exists recorded_at timestamptz;

comment on column public.clock_events.deferred is
  'True when the device was offline at the moment of the action and sent it later.';
comment on column public.clock_events.recorded_at is
  'When the server actually received a deferred action. Null for live ones.';


-- ------------------------------------------------------------
-- 2. evaluate_onsite gains a switch for the network requirement
-- ------------------------------------------------------------
-- Dropped and recreated rather than overloaded: a defaulted fourth
-- parameter alongside the old three-argument version would make every
-- existing three-argument call ambiguous.
drop function if exists public.evaluate_onsite(inet, double precision, double precision);

create or replace function public.evaluate_onsite(
  p_ip inet,
  p_lat double precision,
  p_lng double precision,
  p_check_network boolean default true
) returns table(allowed boolean, reason text, distance_meters double precision)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_site record;
  v_dist double precision;
  v_net_ok boolean;
  v_any_site boolean := false;
begin
  for v_site in select * from public.worksites where is_active order by id loop
    v_any_site := true;

    -- Network check
    v_net_ok := true;
    if v_site.require_network and p_check_network then
      if p_ip is null then
        v_net_ok := false;
      else
        select exists (
          select 1 from public.worksite_networks wn
          where wn.worksite_id = v_site.id and p_ip <<= wn.cidr
        ) into v_net_ok;
      end if;
    end if;

    -- Location check
    v_dist := null;
    if v_site.require_location and v_site.latitude is not null then
      if p_lat is null or p_lng is null then
        continue;
      end if;
      v_dist := public.haversine_meters(p_lat, p_lng, v_site.latitude, v_site.longitude);
      if v_dist > v_site.radius_meters then
        continue;
      end if;
    end if;

    if v_net_ok then
      return query select true, null::text, v_dist;
      return;
    end if;
  end loop;

  if not v_any_site then
    -- Nothing configured yet — allow, but say so.
    return query select true, 'unconfigured'::text, null::double precision;
    return;
  end if;

  return query select false,
    'You must be on the academy network and on site to clock in.'::text,
    null::double precision;
end;
$$;

-- Same posture the original had: nothing implicit, only the two API roles.
revoke all on function public.evaluate_onsite(inet, double precision, double precision, boolean) from public;
grant execute on function public.evaluate_onsite(inet, double precision, double precision, boolean)
  to anon, authenticated;


-- ------------------------------------------------------------
-- 3. Is a deferred action verifiable at all?
-- ------------------------------------------------------------
-- If no active site enforces a location boundary, there is nothing that
-- can vouch for where a queued action happened. Better to refuse it than
-- to accept an unverifiable attendance record.
create or replace function public._geofence_available()
returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.worksites
    where is_active and require_location and latitude is not null
  );
$$;

revoke all on function public._geofence_available() from anon, authenticated;


-- ------------------------------------------------------------
-- 4. clock_action, now accepting an optional occurrence time
-- ------------------------------------------------------------
drop function if exists public.clock_action(uuid, text, double precision, double precision, double precision);

create or replace function public.clock_action(
  p_token       uuid,
  p_action      text,
  p_lat         double precision default null,
  p_lng         double precision default null,
  p_accuracy    double precision default null,
  p_occurred_at timestamptz default null
) returns public.attendance
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_session   record;
  v_ip        inet;
  v_check     record;
  v_row       public.attendance;
  v_now       timestamptz := now();
  v_when      timestamptz;
  v_date      date;
  v_deferred  boolean := false;
  v_ua        text;
  -- How far back a queued action may reach. Long enough to cover a shift
  -- and an overnight outage; short enough that nobody "remembers" last week.
  c_window    interval := interval '18 hours';
begin
  select * into v_session from public._require_session(p_token, false);

  if p_action not in ('in', 'out') then
    raise exception 'Invalid clock action';
  end if;

  -- Decide the effective time.
  if p_occurred_at is null then
    v_when := v_now;
  else
    v_deferred := true;
    v_when := p_occurred_at;

    -- Small forward drift is ordinary clock skew, not a claim about the future.
    if v_when > v_now + interval '2 minutes' then
      raise exception 'That clock-in is dated in the future and was not recorded';
    end if;
    if v_when > v_now then
      v_when := v_now;
    end if;
    if v_when < v_now - c_window then
      raise exception
        'That clock-in is more than % old. Ask a supervisor to enter it.', c_window;
    end if;

    -- A queued action is only as trustworthy as the position saved with it.
    if p_lat is null or p_lng is null then
      raise exception
        'This clock-in was saved while offline but without a location, so it cannot be verified. Ask a supervisor to enter it.';
    end if;
    if not public._geofence_available() then
      raise exception
        'Offline clock-in needs a site boundary configured before it can be checked. Ask a supervisor to enter it.';
    end if;
  end if;

  v_date := (v_when at time zone 'Indian/Mahe')::date;

  v_ip := public.request_client_ip();
  begin
    v_ua := (current_setting('request.headers', true)::json)->>'user-agent';
  exception when others then
    v_ua := null;
  end;

  -- Deferred actions skip the network test for the reason given at the top
  -- of this file, and lean entirely on the geofence.
  select * into v_check from public.evaluate_onsite(v_ip, p_lat, p_lng, not v_deferred);

  if not v_check.allowed then
    insert into public.clock_events (
      employee_id, action, allowed, denial_reason, ip,
      latitude, longitude, accuracy_meters, distance_meters, user_agent,
      deferred, recorded_at
    ) values (
      v_session.employee_id, p_action, false, v_check.reason, v_ip,
      p_lat, p_lng, p_accuracy, v_check.distance_meters, v_ua,
      v_deferred, case when v_deferred then v_now end
    );
    raise exception '%', v_check.reason;
  end if;

  insert into public.clock_events (
    employee_id, action, allowed, denial_reason, ip,
    latitude, longitude, accuracy_meters, distance_meters, user_agent,
    deferred, recorded_at
  ) values (
    v_session.employee_id, p_action, true, v_check.reason, v_ip,
    p_lat, p_lng, p_accuracy, v_check.distance_meters, v_ua,
    v_deferred, case when v_deferred then v_now end
  );

  -- A deferred write never overwrites a stamp that is already there: if the
  -- live action landed after all, the queued copy is a duplicate from a retry.
  insert into public.attendance (
    employee_id, date, clock_in, clock_out, updated_at,
    clock_in_ip, clock_out_ip, clock_in_lat, clock_in_lng, clock_out_lat, clock_out_lng
  ) values (
    v_session.employee_id, v_date,
    case when p_action = 'in'  then v_when end,
    case when p_action = 'out' then v_when end,
    v_now,
    case when p_action = 'in'  then v_ip end,
    case when p_action = 'out' then v_ip end,
    case when p_action = 'in'  then p_lat end,
    case when p_action = 'in'  then p_lng end,
    case when p_action = 'out' then p_lat end,
    case when p_action = 'out' then p_lng end
  )
  on conflict (employee_id, date) do update set
    clock_in = case
                 when p_action = 'in' and (public.attendance.clock_in is null or not v_deferred)
                 then v_when else public.attendance.clock_in end,
    clock_out = case
                 when p_action = 'out' and (public.attendance.clock_out is null or not v_deferred)
                 then v_when else public.attendance.clock_out end,
    clock_in_ip  = case when p_action = 'in'  and not v_deferred then v_ip else public.attendance.clock_in_ip end,
    clock_out_ip = case when p_action = 'out' and not v_deferred then v_ip else public.attendance.clock_out_ip end,
    clock_in_lat  = case when p_action = 'in'  then coalesce(p_lat, public.attendance.clock_in_lat)  else public.attendance.clock_in_lat end,
    clock_in_lng  = case when p_action = 'in'  then coalesce(p_lng, public.attendance.clock_in_lng)  else public.attendance.clock_in_lng end,
    clock_out_lat = case when p_action = 'out' then coalesce(p_lat, public.attendance.clock_out_lat) else public.attendance.clock_out_lat end,
    clock_out_lng = case when p_action = 'out' then coalesce(p_lng, public.attendance.clock_out_lng) else public.attendance.clock_out_lng end,
    updated_at = v_now
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.clock_action(uuid, text, double precision, double precision, double precision, timestamptz)
  to anon, authenticated;
