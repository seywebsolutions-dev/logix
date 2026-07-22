# Logix — Supabase Setup

This project can run in one of two modes:
- Local PHP/MySQL under XAMPP: existing `api/*.php` backend.
- Supabase cloud Postgres + client-side JS: use the new JS files already included.

## Switch to Supabase mode

1. Create a Supabase project.
2. Go to **Project Settings -> API** and copy:
   - Project URL
   - anon public key
3. In Supabase SQL Editor, run the schema and seed in this order:
   - `database/supabase_schema.sql`
   - `database/seed.sql`
4. Copy your Supabase credentials into each HTML file, right before `helpers.js`:

```html
<script type="text/javascript">
  window.LOGIX_SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
  window.LOGIX_SUPABASE_ANON_KEY = 'public-anon-key';
</script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

## Notes

- For a quick local test with Supabase hosting but XAMPP serving files, ensure
  `.htaccess` or `api_call` is not required. The Supabase client runs from the browser.
- If you want local-only mode, keep the old API files and old JS files.
