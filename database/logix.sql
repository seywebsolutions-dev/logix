-- =========================================================
--  LOGIX DATABASE SCHEMA
--  Import this file in phpMyAdmin (XAMPP) to set everything up.
--  See README.md for step-by-step instructions.
-- =========================================================

CREATE DATABASE IF NOT EXISTS logix_db;
USE logix_db;

-- ---------------------------------------------------------
-- EMPLOYEES
-- Each employee has a unique Worker ID (used to identify
-- themselves on the employee screen), a name and a position.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    worker_id         VARCHAR(20) NOT NULL UNIQUE,   -- e.g. "EMP001"
    full_name         VARCHAR(100) NOT NULL,
    position          VARCHAR(100) NOT NULL,
    is_on_lunch       TINYINT(1) NOT NULL DEFAULT 0, -- 0 = not on lunch, 1 = on lunch
    lunch_started_at  DATETIME NULL,
    status            ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- ATTENDANCE
-- One row per employee per calendar day. clock_out stays
-- NULL until the employee clocks out.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    employee_id  INT NOT NULL,
    work_date    DATE NOT NULL,
    clock_in     DATETIME NULL,
    clock_out    DATETIME NULL,
    UNIQUE KEY unique_employee_day (employee_id, work_date),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- SICK LEAVE REQUESTS
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS sick_leaves (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    employee_id   INT NOT NULL,
    leave_date    DATE NOT NULL,       -- the date the employee will be out
    reason        TEXT NULL,
    status        ENUM('pending', 'approved', 'denied') NOT NULL DEFAULT 'pending',
    requested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at   DATETIME NULL,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- MESSAGE BOARD
-- Posted by admin/supervisor, visible to all employees.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    message     TEXT NOT NULL,
    posted_by   VARCHAR(100) NOT NULL DEFAULT 'Admin',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- ADMIN USERS
-- The supervisor/admin login. Default account created below.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    username       VARCHAR(50) NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

-- Default admin login -> username: admin | password: admin123
-- IMPORTANT: change this password after your first login!
-- (This hash was generated with PHP's password_hash() function.)
INSERT INTO admin_users (username, password_hash) VALUES
('admin', '$2y$10$0mRNks3.yylDEq/SAGvvAeUd4XgCUzXhV5HmB26EToFCTwSGQ13Ye')
ON DUPLICATE KEY UPDATE username = username;

-- ---------------------------------------------------------
-- SAMPLE EMPLOYEES (optional - feel free to delete these
-- from phpMyAdmin, or use the admin panel to remove them)
-- ---------------------------------------------------------
INSERT INTO employees (worker_id, full_name, position) VALUES
('EMP001', 'Jordan Blake', 'Barista'),
('EMP002', 'Priya Anand', 'Shift Supervisor'),
('EMP003', 'Marcus Lee', 'Stock Clerk')
ON DUPLICATE KEY UPDATE worker_id = worker_id;
