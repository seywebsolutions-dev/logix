-- ============================================================
--  LOGIX FOR STA SEYCHELLES — ADVANCED SECURITY & HR UPGRADE
-- ============================================================

-- 1. Add new columns to employees table
alter table public.employees
  add column if not exists date_of_birth date,
  add column if not exists photo_url text,
  add column if not exists password_hash text,
  add column if not exists must_change_password boolean not null default true,
  add column if not exists temp_otp text,
  add column if not exists otp_expires_at timestamp with time zone;

-- 2. Set default initial passwords for existing demo employees
-- Default password: "STA-Password123" hashed with SHA-256 ("4b5952d7e487569b7bf268153c3066d03d157a9ae639a039755f1f3131758c0c")
-- or plain initial temp OTP "STA-1234" with must_change_password = true
update public.employees
set 
  must_change_password = true,
  temp_otp = 'STA-1234'
where temp_otp is null;

-- 3. Create Storage bucket for employee profile photos (if storage schema exists)
insert into storage.buckets (id, name, public)
values ('employee-photos', 'employee-photos', true)
on conflict (id) do nothing;

-- 4. Storage Policies for employee photos
create policy "Public Read Employee Photos"
  on storage.objects for select
  using (bucket_id = 'employee-photos');

create policy "Admin Upload Employee Photos"
  on storage.objects for insert
  with check (bucket_id = 'employee-photos');

create policy "Admin Update Employee Photos"
  on storage.objects for update
  using (bucket_id = 'employee-photos');

create policy "Admin Delete Employee Photos"
  on storage.objects for delete
  using (bucket_id = 'employee-photos');
