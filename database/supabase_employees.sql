-- ============================================================
--  LOGIX — EMPLOYEE SEED DATA FOR STA SEYCHELLES
-- ============================================================
-- Usage:
--   1. Create a Supabase project at https://supabase.com
--   2. Go to SQL Editor in Supabase dashboard
--   3. Run supabase_schema.sql first
--   4. Run this file second
--   5. Copy your Project URL and anon/public key into the app config
-- ============================================================

insert into public.departments (name, code, description)
values
  ('Administration', 'ADM', 'School administration and management'),
  ('Teaching Staff', 'TCH', 'Academic teaching staff'),
  ('Support Staff', 'SUP', 'Operational support staff')
on conflict (code) do nothing;

-- Passwords are placeholder strings; secure auth should use Supabase Auth or hashing
insert into public.employees (worker_id, full_name, position, role, department_id, employment_type, date_joined, email, phone, emergency_contact, emergency_phone, address)
values
-- Administration
('STA001', 'Adeline Hoareau', 'Principal', 'principal', (select id from public.departments where code = 'ADM'), 'full_time', '2015-08-10', 'adeline.hoareau@sta.sc', '+248 420 1101', 'Robert Hoareau', '+248 420 1102', 'Victoria, Mahe'),
('STA002', 'David Bristol', 'Vice Principal', 'hod', (select id from public.departments where code = 'ADM'), 'full_time', '2016-01-15', 'david.bristol@sta.sc', '+248 420 1201', 'Mary Bristol', '+248 420 1202', 'Bel Ombre, Mahe'),

-- Teaching Staff
('STA003', 'Priya Anand', 'Senior Teacher - Mathematics', 'teacher', (select id from public.departments where code = 'TCH'), 'full_time', '2018-09-03', 'priya.anand@sta.sc', '+248 420 1301', 'Raj Anand', '+248 420 1302', 'Anse Royale, Mahe'),
('STA004', 'Marcus Lee', 'Teacher - English', 'teacher', (select id from public.departments where code = 'TCH'), 'full_time', '2019-01-20', 'marcus.lee@sta.sc', '+248 420 1401', 'Sarah Lee', '+248 420 1402', 'Cascade, Mahe'),
('STA005', 'Chantal Bastien', 'Teacher - Science', 'teacher', (select id from public.departments where code = 'TCH'), 'full_time', '2017-05-11', 'chantal.bastien@sta.sc', '+248 420 1501', 'Jean Bastien', '+248 420 1502', 'Beau Vallon, Mahe'),
('STA006', 'Kevin Durup', 'Teacher - History', 'teacher', (select id from public.departments where code = 'TCH'), 'full_time', '2020-02-01', 'kevin.durup@sta.sc', '+248 420 1601', 'Lisa Durup', '+248 420 1602', 'Port Glaud, Mahe'),
('STA007', 'Nadia Rose', 'Teacher - French', 'teacher', (select id from public.departments where code = 'TCH'), 'full_time', '2021-08-15', 'nadia.rose@sta.sc', '+248 420 1701', 'Paul Rose', '+248 420 1702', 'Anse Etoile, Mahe'),

-- Support Staff
('STA008', 'Amelie Camille', 'Office Administrator', 'worker', (select id from public.departments where code = 'SUP'), 'full_time', '2016-07-22', 'amelie.camille@sta.sc', '+248 420 1801', 'Marc Camille', '+248 420 1802', 'Mont Fleuri, Mahe'),
('STA009', 'James Mousbe', 'IT Support', 'hod', (select id from public.departments where code = 'SUP'), 'contract', '2019-11-05', 'james.mousbe@sta.sc', '+248 420 1901', 'Anna Mousbe', '+248 420 1902', 'Les Mamelles, Mahe'),
('STA010', 'Rita Hoareau', 'HR Assistant', 'worker', (select id from public.departments where code = 'SUP'), 'full_time', '2020-06-10', 'rita.hoareau@sta.sc', '+248 420 2001', 'Adeline Hoareau', '+248 420 2002', 'La Retraite, Mahe'),
('STA011', 'Selvin Tirant', 'Maintenance Worker', 'worker', (select id from public.departments where code = 'SUP'), 'full_time', '2018-03-18', 'selvin.tirant@sta.sc', '+248 420 2101', 'Marie Tirant', '+248 420 2102', 'Takamaka, Mahe'),
('STA012', 'Lucy Michel', 'Finance Officer', 'hod', (select id from public.departments where code = 'ADM'), 'full_time', '2017-09-01', 'lucy.michel@sta.sc', '+248 420 2201', 'George Michel', '+248 420 2202', 'Anse Boileau, Mahe'),
('STA013', 'Danny Valmont', 'Security Officer', 'worker', (select id from public.departments where code = 'SUP'), 'part_time', '2022-01-10', 'danny.valmont@sta.sc', '+248 420 2301', 'Elena Valmont', '+248 420 2302', 'Roche Caiman, Mahe'),
('STA014', 'Fatima Zohra', 'Nurse', 'worker', (select id from public.departments where code = 'SUP'), 'full_time', '2019-06-15', 'fatima.zohra@sta.sc', '+248 420 2401', 'Hassan Zohra', '+248 420 2402', 'Liberte, Mahe'),
('STA015', 'Michael Payet', 'Driver', 'worker', (select id from public.departments where code = 'SUP'), 'full_time', '2021-03-22', 'michael.payet@sta.sc', '+248 420 2501', 'Claire Payet', '+248 420 2502', 'Copia, Mahe')
on conflict (worker_id) do nothing;
