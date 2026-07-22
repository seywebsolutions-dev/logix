<?php
/**
 * ===========================================================
 *  DATABASE CONNECTION (XAMPP / MySQL)
 * ===========================================================
 * These are the default XAMPP settings. If you changed your
 * MySQL username/password in XAMPP, update the values below.
 * See README.md for the full setup walkthrough.
 * ===========================================================
 */

define('DB_HOST', 'localhost');
define('DB_NAME', 'logix_db');
define('DB_USER', 'root');   // default XAMPP MySQL user
define('DB_PASS', '');       // default XAMPP MySQL password (blank)

try {
    $pdo = new PDO(
        "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=utf8mb4",
        DB_USER,
        DB_PASS,
        [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]
    );
} catch (PDOException $e) {
    http_response_code(500);
    die(json_encode([
        'success' => false,
        'message' => 'Database connection failed. Make sure XAMPP MySQL is running and logix_db has been imported. (' . $e->getMessage() . ')'
    ]));
}
