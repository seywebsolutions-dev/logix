<?php
/**
 * POST /api/admin_login.php
 * Body: { "username": "admin", "password": "admin123" }
 *
 * POST /api/admin_login.php?logout=1   -> logs the admin out
 */
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/functions.php';

if (isset($_GET['logout'])) {
    $_SESSION = [];
    session_destroy();
    send_json(['success' => true, 'message' => 'Logged out.']);
}

$input = get_json_input();
$username = trim($input['username'] ?? '');
$password = $input['password'] ?? '';

if ($username === '' || $password === '') {
    send_json(['success' => false, 'message' => 'Please enter a username and password.'], 400);
}

$stmt = $pdo->prepare("SELECT id, username, password_hash FROM admin_users WHERE username = :u");
$stmt->execute(['u' => $username]);
$admin = $stmt->fetch();

if (!$admin || !password_verify($password, $admin['password_hash'])) {
    send_json(['success' => false, 'message' => 'Incorrect username or password.'], 401);
}

$_SESSION['is_admin'] = true;
$_SESSION['admin_username'] = $admin['username'];

send_json(['success' => true, 'message' => 'Welcome back, ' . $admin['username'] . '.']);
