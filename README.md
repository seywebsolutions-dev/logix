# Logix — Setup Guide (XAMPP)

Logix is a small PHP + MySQL app: plain HTML/CSS/JS on the front end, PHP files in `/api` talking to a MySQL database on the back end. Follow these steps in order and it will be fully working.

## What you need
- XAMPP installed (Apache + MySQL + phpMyAdmin), started with **Apache** and **MySQL** both running (green in the XAMPP Control Panel).

## Step 1 — Copy the project into htdocs
1. Find your XAMPP install folder (Windows: `C:\xampp`, Mac: `/Applications/XAMPP`).
2. Open the `htdocs` folder inside it.
3. Copy the whole `logix` folder into `htdocs`, so you end up with:
   `.../htdocs/logix/index.html`, `.../htdocs/logix/api/`, etc.

## Step 2 — Create the database
1. Open your browser and go to **http://localhost/phpmyadmin**.
2. Click the **Import** tab at the top.
3. Click **Choose File** and select `database/logix.sql` from the `logix` folder.
4. Click **Go** at the bottom.

That's it — this one file creates the `logix_db` database, all 5 tables, a default admin login, and 3 sample employees you can delete later from the admin panel.

## Step 3 — Check the database connection settings
Open `config/db.php` in a text editor. The defaults match a stock XAMPP install:

```php
define('DB_HOST', 'localhost');
define('DB_NAME', 'logix_db');
define('DB_USER', 'root');
define('DB_PASS', '');
```

If you ever changed your XAMPP MySQL username/password, update `DB_USER` / `DB_PASS` here to match. Otherwise, leave it as is.

## Step 4 — Open the app
- **Employee portal:** http://localhost/logix/index.html
- **Admin dashboard:** http://localhost/logix/admin.html

### Default admin login
```
Username: admin
Password: admin123
```
Change this from phpMyAdmin once you're comfortable (Step 6 below), since anyone who finds the login page can otherwise try this password.

### Try it out
The sample employees you can log in as on the employee portal:
```
EMP001  — Jordan Blake
EMP002  — Priya Anand
EMP003  — Marcus Lee
```

## Step 5 — Everyday use
- No need to redo Steps 1–3 again — once the database is imported and the folder is in `htdocs`, just make sure Apache + MySQL are running in XAMPP and open the two links above.
- Add real employees from **Admin → Employees** tab. Removing an employee there doesn't delete their history — it just stops them from clocking in again.

## Step 6 (optional) — Change the admin password
1. Go to **http://localhost/phpmyadmin**, open `logix_db` → `admin_users` table.
2. You'll generate a new password hash rather than typing a plain password directly (MySQL doesn't hash it for you). The easiest way: create a tiny throwaway PHP file anywhere in `htdocs`, e.g. `htdocs/makehash.php`, containing:
   ```php
   <?php echo password_hash('yourNewPassword', PASSWORD_DEFAULT);
   ```
3. Visit `http://localhost/makehash.php` in your browser — it prints a long hash string starting with `$2y$`.
4. Copy that whole string, go back to phpMyAdmin → `admin_users` table → **Edit** the `admin` row → paste it into the `password_hash` field → **Go**.
5. Delete `makehash.php` from `htdocs` when you're done (don't leave it sitting there).

## Troubleshooting
- **"Database connection failed" message:** Make sure MySQL is running in the XAMPP Control Panel, and that you completed Step 2 (imported `logix.sql`).
- **Blank page or PHP errors:** Make sure the `logix` folder is directly inside `htdocs` (not nested one level deeper), and that you're browsing to `localhost/logix/...` — not opening the HTML files directly by double-clicking them.
- **Login/clock buttons don't seem to do anything:** Open your browser's dev console (F12) and check for red errors — usually this means the `api/` calls can't reach the database (see the first bullet above).

## Project structure
```
logix/
├── index.html          Employee portal (clock in/out, lunch, sick leave, message board)
├── admin.html           Admin dashboard (password protected)
├── css/style.css        Neumorphic styling + dark mode
├── js/                  Front-end logic (theme.js, helpers.js, employee.js, admin.js)
├── api/                 PHP endpoints the front end talks to
├── config/db.php        Database connection settings (edit here if needed)
├── includes/functions.php   Shared PHP helper functions
└── database/logix.sql   Full database schema + sample data (import this in phpMyAdmin)
```
