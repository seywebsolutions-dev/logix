# Logix — Database & Security Reference

Technical companion to [`README.md`](README.md). The README covers installing and running the app; this file covers how the database is put together and why, and what to know before changing it.

---

## The shape of the thing

There is no application server. The browser holds a Supabase **anon key** and talks to Postgres directly. Everything that matters therefore has to be enforced *inside the database*, because the client is fully under the user's control.

Three layers do that work:

| Layer | Enforces |
|---|---|
| **Row-level security** | Which rows a reader may see |
| **Column grants** | Which columns exist as far as the API is concerned |
| **`SECURITY DEFINER` functions** | Every write, plus who is allowed to make it |

Reads go through RLS. **Writes never do** — there are no `INSERT`/`UPDATE`/`DELETE` policies for `anon` at all. Each write is a function that re-derives the caller's identity from a session token and refuses if it doesn't like the answer.

---

## Data model

| Table | Purpose | Notes |
|---|---|---|
| `employees` | Staff records and credentials | Secret columns are ungranted, see below |
| `departments` | Administration / Teaching / Support | |
| `attendance` | One row per employee per day | Unique on `(employee_id, date)`; stores IP and coordinates of each punch |
| `leave_types` | Sick, casual, annual, … | Referenced by code (`SL`, `AL`) |
| `leave_requests` | Submissions and their review state | |
| `messages` | Announcements | |
| `audit_log` | Administrative actions | |
| `sessions` | Live sign-ins | 12-hour expiry; no client access whatsoever |
| `worksites` | Campus geofence and toggles | |
| `worksite_networks` | Registered public IP ranges (`cidr`) | |
| `clock_events` | Every clock attempt, **including refusals** | This is the fraud record |

### Columns the API cannot see

`harden_auth_and_rls.sql` revokes blanket access to `employees` and grants back a named list. Deliberately excluded:

```
password_hash   temp_otp   otp_expires_at   must_change_password
quick_pin       failed_login_attempts       locked_until
```

RLS filters *rows*; this is what hides *columns*. Without it, `select password_hash from employees` would work for anyone holding the anon key — which is printed in the page source.

**If you add a sensitive column, add it to the revoke list.** New columns are visible by default.

---

## Functions

Callable by `anon`. Each takes a session token as its first argument.

### Session

| Function | Notes |
|---|---|
| `verify_login(identifier, password, require_admin)` | The only way in. Returns a token, or nothing. |
| `whoami(token)` | Validates a stored token on page load |
| `logout(token)` | Deletes the session |

`_require_session(token, require_admin)` is the internal gate every other function calls. It expires stale rows, rejects unknown tokens, and checks role membership when asked. It is **not** granted to `anon` — only reachable from inside other functions.

### Employee actions

Identity always comes from the token, never from a client-supplied `employee_id`. This is what stops someone clocking in as a colleague.

`clock_action` · `toggle_lunch` · `submit_leave_request` · `set_employee_password` · `change_own_password` · `check_clock_eligibility`

### Administrative

All require a role of `super_admin`, `principal` or `hod`.

`admin_add_employee` · `admin_update_employee` · `admin_set_employee_status` · `admin_reset_employee_otp` · `admin_review_leave` · `admin_post_message` · `admin_delete_message` · `admin_save_worksite` · `admin_add_network` · `admin_delete_network` · `my_network_info` · `log_client_event`

---

## Passwords

**bcrypt via pgcrypto, cost 12**, unique salt per password. Roughly 250 ms per hash — slow on purpose. SHA-256, which this replaced, is built to be *fast*, which is precisely wrong for password storage: commodity hardware tests billions of SHA-256 guesses per second, and without a salt, identical passwords produce identical hashes, so cracking one cracks everyone who chose it.

`password_matches()` accepts a bcrypt hash **or** a legacy 64-character hex digest. On a successful sign-in with a legacy hash, `verify_login` re-hashes with bcrypt in place. Migration needs no cutover and no announcement.

Other properties worth not breaking:

- **Lockout** — 5 failures locks for 15 minutes and writes to `audit_log`. Cost factor protects a stolen dump; lockout protects the login form. They solve different problems.
- **Timing** — an unknown Worker ID still pays for a bcrypt hash, so response time doesn't reveal whether an ID exists.
- **Rules live in `validate_password()`** — the JavaScript check is a convenience and can be bypassed by calling the API directly.
- **One-time codes are hashed and expire** (48 h resets, 7 days new staff). The plaintext exists only in the admin's browser at the instant it is generated.
- **Changing a password deletes every other session** for that employee.

---

## On-site enforcement

### Client IP — the part that is easy to get wrong

`request_client_ip()` prefers Cloudflare's `cf-connecting-ip`, which the edge sets and a client cannot forge. Falling back to `x-forwarded-for`, it reads the **rightmost** entry.

That is not a stylistic choice. A client *can* send its own `X-Forwarded-For`, and Supabase does not overwrite it — it **appends** the real address. A forged value therefore lands on the left and the trustworthy one is last:

```
X-Forwarded-For: 41.20.30.40, 102.164.9.11
                 ^ attacker-supplied      ^ actual client
```

Most published examples use `split_part(header, ',', 1)` — the leftmost, spoofable entry. Copying that pattern makes the whole feature decorative.

### Evaluation

`evaluate_onsite(ip, lat, lng)` walks active worksites and allows the punch if any one is satisfied. Per site, `require_network` and `require_location` are independent.

**With no active worksite, everything is allowed.** That is intentional — a migration that instantly locked out the entire academy would be worse than the problem. The admin dashboard shows an amber warning until a site is saved, and `check_clock_eligibility` returns `enforced: false` so the employee portal can say so plainly.

Distance uses `haversine_meters()`. Every attempt, allowed or refused, lands in `clock_events` with IP, coordinates, GPS accuracy and distance.

---

## Operations

**Promote an administrator** — role must be `super_admin`, `principal` or `hod`:

```sql
update public.employees set role = 'hod' where worker_id = 'STA009';
```

**Issue a first or emergency code** — the plaintext is never stored, so choose it, run this, and hand it over:

```sql
update public.employees
set temp_otp = public.hash_password('SOMETHING-ONLY-YOU-KNOW'),
    otp_expires_at = now() + interval '48 hours',
    must_change_password = true,
    locked_until = null, failed_login_attempts = 0
where worker_id = 'STA001';
```

**Sign everybody out** — after a suspected compromise:

```sql
delete from public.sessions;
```

**Review refused clock-ins:**

```sql
select c.created_at, e.full_name, c.action, c.ip, c.denial_reason
from public.clock_events c
left join public.employees e on e.id = c.employee_id
where not c.allowed
order by c.created_at desc
limit 50;
```

**Rotating the anon key** (Project Settings → API) invalidates the copies in `index.html` and `admin.html`. Update both and redeploy, or the app goes dark.

---

## Extending it safely

Adding a privileged operation? Follow the existing shape:

1. Write it as `SECURITY DEFINER` with `set search_path = public` — without the search path, a hostile schema can hijack unqualified names.
2. Call `_require_session(p_token, true)` first. Pass `true` for anything administrative.
3. Derive identity from the session. **Never trust an `employee_id` from the client.**
4. `revoke all ... from public`, then `grant execute ... to anon, authenticated`.
5. If it touches staff records, write to `audit_log`.

Do **not** solve a problem by adding an `INSERT`/`UPDATE` policy for `anon`. That reopens exactly what `harden_auth_and_rls.sql` closed.

---

## Things that will trip you up

**A new column on `employees` is readable by default.** Revoke it if it is sensitive.

**`create table if not exists` silently does nothing** if the table already exists in a different shape. `audit_log` is defined two incompatible ways across the old files; `harden_auth_and_rls.sql` reconciles it with `add column if not exists`. Expect this class of bug when mixing old scripts.

**The `service_role` key must never reach the browser.** It bypasses RLS entirely. It is for server-side use only, and this project has no server.

**Geolocation requires a secure context.** `https://` or `localhost`. Anywhere else the browser refuses and the geofence silently degrades to "no position supplied".

**Announcements need Realtime to appear without a refresh.** Both portals subscribe to `postgres_changes` on `messages`. There is no polling fallback — an earlier version re-fetched every 3 seconds from every open tab, which is a lot of load for a noticeboard. If Realtime is disabled for the project nothing breaks, but staff will only see a new announcement when they next load the page. Enable it under **Database → Replication** for the `messages` table.
