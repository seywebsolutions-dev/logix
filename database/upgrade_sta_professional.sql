-- =========================================================
--  STA SEYCHELLES — LOGIX PROFESSIONAL UPGRADE
--  Run this AFTER importing logix.sql
--  Adds departments, roles, advanced leave, notifications,
--  audit logs, shift management, and richer employee records.
-- =========================================================

-- ---------------------------------------------------------
-- 1. PROFESSIONAL COMPANY SETTINGS
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_name VARCHAR(150) NOT NULL DEFAULT 'STA Seychelles',
    company_address TEXT NULL,
    company_phone VARCHAR(30) NULL,
    company_email VARCHAR(100) NULL,
    work_start_time TIME NOT NULL DEFAULT '08:00:00',
    work_end_time TIME NOT NULL DEFAULT '16:00:00',
    half_day_threshold TIME NOT NULL DEFAULT '04:00:00',
    currency VARCHAR(10) NOT NULL DEFAULT 'SCR',
    timezone VARCHAR(50) NOT NULL DEFAULT 'Indian/Mahe',
    logo_path VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO company_settings (company_name) VALUES ('STA Seychelles')
ON DUPLICATE KEY UPDATE company_name = company_name;

-- ---------------------------------------------------------
-- 2. DEPARTMENTS (e.g. Mathematics, Science, Administration)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) NOT NULL UNIQUE,
    description TEXT NULL,
    head_of_department INT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (head_of_department) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO departments (name, code, description) VALUES
('Administration', 'ADM', 'School administration and management'),
('Teaching Staff', 'TCH', 'Academic teaching staff'),
('Support Staff', 'SUP', 'Non-teaching support staff')
ON DUPLICATE KEY UPDATE code = code;

-- ---------------------------------------------------------
-- 3. UPGRADE EMPLOYEES TABLE
-- ---------------------------------------------------------
ALTER TABLE employees
    ADD COLUMN department_id INT NULL AFTER position,
    ADD COLUMN role ENUM('super_admin','principal','hod','teacher','worker') NOT NULL DEFAULT 'worker',
    ADD COLUMN email VARCHAR(100) NULL UNIQUE,
    ADD COLUMN phone VARCHAR(30) NULL,
    ADD COLUMN emergency_contact VARCHAR(100) NULL,
    ADD COLUMN emergency_phone VARCHAR(30) NULL,
    ADD COLUMN employment_type ENUM('full_time','part_time','contract') NOT NULL DEFAULT 'full_time',
    ADD COLUMN date_joined DATE NULL,
    ADD COLUMN profile_photo VARCHAR(255) NULL,
    ADD COLUMN address TEXT NULL,
    ADD COLUMN last_login_at DATETIME NULL,
    ADD COLUMN is_on_premises TINYINT(1) NOT NULL DEFAULT 0,
    ADD FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;

-- ---------------------------------------------------------
-- 4. UPGRADE ADMIN_USERS — TIE TO EMPLOYEES
-- ---------------------------------------------------------
ALTER TABLE admin_users
    ADD COLUMN employee_id INT NULL AFTER id,
    ADD COLUMN role ENUM('super_admin','admin','viewer') NOT NULL DEFAULT 'admin',
    ADD COLUMN last_login_at DATETIME NULL,
    ADD FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;

-- Link existing admin account to an employee if possible
UPDATE admin_users au
LEFT JOIN employees e ON e.worker_id = 'EMP001'
SET au.employee_id = e.id, au.role = 'super_admin'
WHERE au.username = 'admin' AND e.id IS NOT NULL;

-- ---------------------------------------------------------
-- 5. LEAVE TYPES
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    code VARCHAR(20) NOT NULL UNIQUE,
    description TEXT NULL,
    paid TINYINT(1) NOT NULL DEFAULT 1,
    max_days_per_year INT NULL,
    requires_approval TINYINT(1) NOT NULL DEFAULT 1,
    color VARCHAR(7) NOT NULL DEFAULT '#3b82f6',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO leave_types (name, code, description, paid, max_days_per_year, color) VALUES
('Sick Leave', 'SL', 'Medical certificate required after 2 days', 1, 10, '#ef4444'),
('Casual Leave', 'CL', 'Personal errands and short breaks', 1, 7, '#3b82f6'),
('Maternity Leave', 'ML', 'Maternity as per labor law', 1, 90, '#8b5cf6'),
('Paternity Leave', 'PL', 'Paternity as per labor law', 1, 5, '#06b6d4'),
('Annual Leave', 'AL', 'Planned annual vacation', 1, 21, '#10b981'),
('Study Leave', 'STL', 'Professional development and exams', 0, 5, '#f59e0b'),
('Emergency Leave', 'EL', 'Unforeseen family emergencies', 1, 3, '#f97316')
ON DUPLICATE KEY UPDATE code = code;

-- Upgrade sick_leaves table to generic leaves
ALTER TABLE sick_leaves
    ADD COLUMN leave_type_id INT NOT NULL DEFAULT 1 AFTER employee_id,
    ADD COLUMN is_half_day TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN start_date DATE NOT NULL AFTER leave_date,
    ADD COLUMN end_date DATE NOT NULL,
    ADD COLUMN attachment_path VARCHAR(255) NULL,
    ADD COLUMN reviewed_by INT NULL,
    ADD COLUMN review_comment TEXT NULL,
    ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    ADD FOREIGN KEY (leave_type_id) REFERENCES leave_types(id) ON DELETE RESTRICT,
    ADD FOREIGN KEY (reviewed_by) REFERENCES employees(id) ON DELETE SET NULL;

UPDATE sick_leaves SET start_date = leave_date, end_date = leave_date WHERE start_date IS NULL;
ALTER TABLE sick_leaves MODIFY COLUMN leave_date DATE NULL COMMENT 'kept for backward compat';

-- Rename table to better name
RENAME TABLE sick_leaves TO leave_requests;

-- ---------------------------------------------------------
-- 6. SHIFTS (for variable working hours)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS shifts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    code VARCHAR(20) NOT NULL UNIQUE,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    break_duration_minutes INT NOT NULL DEFAULT 30,
    is_night_shift TINYINT(1) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO shifts (name, code, start_time, end_time) VALUES
('Morning Shift', 'MORN', '07:30:00', '15:30:00'),
('Afternoon Shift', 'AFTN', '12:00:00', '20:00:00'),
('Night Shift', 'NIGHT', '20:00:00', '04:00:00'),
('Standard Day', 'STD', '08:00:00', '16:00:00')
ON DUPLICATE KEY UPDATE code = code;

-- ---------------------------------------------------------
-- 7. NOTIFICATIONS
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_type ENUM('employee','admin') NOT NULL,
    user_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    message TEXT NOT NULL,
    link VARCHAR(255) NULL,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user (user_type, user_id, is_read)
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- 8. AUDIT LOG
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    actor_type ENUM('admin','employee') NOT NULL,
    actor_id INT NOT NULL,
    actor_name VARCHAR(100) NOT NULL,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50) NULL,
    target_id INT NULL,
    details JSON NULL,
    ip_address VARCHAR(45) NULL,
    user_agent TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_actor (actor_type, actor_id),
    INDEX idx_target (target_type, target_id),
    INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- 9. UPGRADE ATTENDANCE TABLE
-- ---------------------------------------------------------
ALTER TABLE attendance
    ADD COLUMN shift_id INT NULL AFTER work_date,
    ADD COLUMN late_minutes INT NOT NULL DEFAULT 0,
    ADD COLUMN early_leaving_minutes INT NOT NULL DEFAULT 0,
    ADD COLUMN overtime_minutes INT NOT NULL DEFAULT 0,
    ADD COLUMN is_late TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN is_early_leave TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN is_overtime TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN notes TEXT NULL,
    ADD COLUMN approved_by INT NULL,
    ADD COLUMN approved_at DATETIME NULL,
    ADD FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL,
    ADD FOREIGN KEY (approved_by) REFERENCES employees(id) ON DELETE SET NULL;

-- ---------------------------------------------------------
-- 10. REPORTS CACHE (for faster dashboard loads)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_cache (
    id INT AUTO_INCREMENT PRIMARY KEY,
    report_key VARCHAR(100) NOT NULL UNIQUE,
    report_data JSON NOT NULL,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NULL,
    INDEX idx_key (report_key, generated_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- 11. HOLIDAYS
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS holidays (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    holiday_date DATE NOT NULL,
    is_recurring TINYINT(1) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_holiday_date (holiday_date)
) ENGINE=InnoDB;

INSERT INTO holidays (name, holiday_date, is_recurring, is_active) VALUES
('New Year''s Day', '2026-01-01', 1, 1),
('Lafeter Day', '2026-01-02', 1, 1),
('Labol Day', '2026-05-01', 1, 1),
('Liberation Day', '2026-06-05', 1, 1),
('National Day', '2026-06-18', 1, 1),
('Assumption Day', '2026-08-15', 1, 1),
('All Saints Day', '2026-11-01', 1, 1),
('Constitution Day', '2026-06-18', 1, 1),
('Independence Day', '2026-06-29', 1, 1),
('Christmas Day', '2026-12-25', 1, 1)
ON DUPLICATE KEY UPDATE holiday_date = holiday_date;

-- =========================================================
-- DONE
-- Run this then restart Apache + refresh the app.
-- =========================================================
