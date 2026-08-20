# Logix — Seychelles Tourism Academy

Staff attendance, leave and announcements for STA Seychelles.

Two pages, no build step, no server of our own:

- **`index.html`** — employee portal: clock in/out, lunch, leave requests, announcements
- **`admin.html`** — administration: attendance, leave approval, staff records, site security, audit trail

The front end is plain HTML/CSS/JavaScript talking straight to **Supabase** (hosted Postgres) from the browser. There is no PHP and no backend to run.

> **If you have used an older copy of Logix:** it ran on XAMPP with PHP files in `/api` and a MySQL database. That version is gone. There is no `config/db.php`, no Apache, and the old `admin` / `admin123` login no longer exists. Follow this file, not any older instructions.

---

## How security works

Worth reading before changing anything, because a lot of it is deliberate.

**The browser is never trusted.** Sign-in, clocking in, approving leave, editing staff — all of it runs inside Postgres functions that re-check who you are. The JavaScript only asks; the database decides. Editing the page in devtools gets you nothing.

**The anon key in the HTML is meant to be public.** That is how Supabase works. It is safe *only* because row-level security and column grants are correct — which is what `harden_auth_and_rls.sql` sets up. Never put the **service_role** key in these files; it bypasses every protection and would hand your database to anyone who views source.

**Passwords are bcrypt, cost 12, uniquely salted.** They cannot be read back by anyone, including administrators. Five wrong attempts locks an account for 15 minutes.

**Clock-ins are checked against the campus.** Staff must be on a registered academy network *and/or* inside a GPS boundary. Both are verified server-side. See [On-site clock-in](#on-site-clock-in) below.

---

## Setup

### 1. Create a Supabase project

At [supabase.com](https://supabase.com) → **New Project**. Save the database password somewhere safe; you will not need it for day-to-day use.

From **Project Settings → API**, copy the **Project URL** and the **anon public** key.

### 2. Point the app at your project

Both `index.html` and `admin.html` carry the same block near the bottom. Update both:

```html
<script type="text/javascript">
  window.LOGIX_SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
  window.LOGIX_SUPABASE_ANON_KEY = 'your-anon-public-key';
</script>
```

### 3. Run the migrations, in this order

Open **SQL Editor** in the Supabase dashboard and run each file top to bottom. Order matters — later files replace functions defined earlier.

| # | File | What it does |
|---|------|--------------|
| 1 | `database/supabase_schema.sql` | Tables: employees, attendance, leave, messages, departments |
| 2 | `database/supabase_employees.sql` | 15 sample STA staff (STA001–STA015) |
| 3 | `database/upgrade_passwords_and_photos.sql` | Password/photo columns, photo storage bucket |
| 4 | `database/harden_auth_and_rls.sql` | **Real security.** Removes the open policies, locks down columns, moves every write behind session-checked functions |
| 5 | `database/geofence_and_network.sql` | On-site clock-in enforcement |
| 6 | `database/password_security.sql` | bcrypt hashing, lockout, hashed one-time codes |

**Not used** — ignore these, they are from the old MySQL version or superseded:
`logix.sql`, `upgrade_sta_professional.sql`, `seed.sql`, `security_rls_policies.sql`

### 4. Create your first administrator

Step 6 invalidates the seed data's plaintext code, so **no account can sign in until you do this**. At the bottom of `password_security.sql` there is a commented block. Change the code to something only you know, then run it:

```sql
update public.employees
set temp_otp = public.hash_password('CHANGE-THIS-FIRST'),
    otp_expires_at = now() + interval '48 hours',
    must_change_password = true
where worker_id = 'STA001';
```

Then open the **employee portal**, sign in as `STA001` with that code, and set a real password when prompted. STA001 (Adeline Hoareau) is seeded as `principal`, so that password now also gets you into `admin.html`.

### 5. Turn on on-site enforcement

Until you do this, staff can clock in from anywhere — including home. The admin dashboard says so in amber until it is configured. See below.

---

## On-site clock-in

The point is to stop someone clocking in from their sofa.

**Browsers cannot read the WiFi network name.** There is no web API for it, on any browser, by design. Only a native mobile app can. So "must be on the STA WiFi" is enforced by the two things a browser *can* prove:

1. **Network** — the device's public IP must fall inside a range you register. Everyone on the campus WiFi shares the academy's public address; someone at home does not. This is the practical equivalent.
2. **Location** — GPS must be within a radius you set.

Both are evaluated inside Postgres. Each requirement is an independent toggle.

### Configuring it

In **Admin → Site security**, while physically on the STA WiFi:

1. The panel shows the address you are connecting from. Click **use this address** to register it.
2. Click **Use my current location**, set a radius (200 m suits a campus), and **Save site**.

Enforcement starts immediately.

### Limits, stated plainly

- If the academy's ISP hands out a **dynamic** public IP, it will change eventually and staff will be blocked until you re-register it. Ask the ISP for a static address, or rely on the geofence instead.
- Staff on **mobile data** standing in the car park fail the network check but pass the geofence. Decide which you want — the toggles are independent.
- **GPS can be faked** on a rooted or developer-mode device. The IP check is considerably harder to defeat. Together they are a strong deterrent, not an unbreakable lock.
- Every blocked attempt is recorded under **Site security → Blocked clock-in attempts**, with time, employee, address and reason.

---

## Running it

**Locally** — any static file server. It must be served over HTTP, not opened as a `file://` path, or the browser blocks the API calls:

```bash
python -m http.server 5500
```

Then visit `http://localhost:5500`.

**Deployed** — `vercel.json` is set up for static hosting. Note that **GPS requires HTTPS**, so geofencing will not work over plain `http://` except on `localhost`. Any real deployment must be HTTPS; Vercel gives you that automatically.

---

## Day-to-day

**Adding staff** — Admin → Staff. A one-time code appears once, valid 7 days. Write it down before closing the dialog; it is stored hashed and cannot be shown again.

**Forgotten passwords** — nobody can recover one, including you. Admin → Staff → **Reset code** issues a replacement valid 48 hours. Signing in with it forces a new password and signs the account out everywhere else.

**Locked out** — five wrong attempts means a 15-minute wait. Waiting is the fix; retrying restarts nothing.

**Removing someone** — Admin → Staff → Remove marks them inactive. Their attendance history is kept.

---

## Structure

```
index.html                   Employee portal
admin.html                   Admin dashboard
vercel.json                  Static hosting config
css/style.css                Design system — tokens, light/dark, mobile-first
js/theme.js                  Applies saved theme before first paint
js/helpers.js                Supabase client, session, RPC wrapper, toasts, geolocation
js/employee.js               Employee portal logic
js/admin.js                  Admin dashboard logic
database/                    SQL migrations (see the table above)
```

The `.jpg` files in `css/` are unused leftovers from an earlier design — about 5.2 MB, referenced nowhere. They are listed in `.gitignore` and `.vercelignore`, so they stay on disk but are never committed or deployed. Delete them whenever you like.

---

## Troubleshooting

**Every sign-in fails, including a fresh code.** The migrations have not been run, or step 6 ran without step 4. Check that `verify_login` exists under Database → Functions.

**"You must be on the academy network and on site to clock in."** Working as designed. Either the device is genuinely off-campus, or the registered IP is stale — check **Site security** against the address currently shown.

**Clock-in fails only on mobile.** Almost always location permission, or the page being served over `http://`. GPS needs HTTPS.

**Nothing loads and the console shows permission errors.** RLS is on but the grants did not apply — re-run `harden_auth_and_rls.sql`.

**The tables are empty but sign-in works.** `supabase_employees.sql` was skipped, or everyone is marked inactive.
