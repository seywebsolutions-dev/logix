<?php
/**
 * GET /api/employee_lookup.php?worker_id=EMP001
 * Looks up an employee by their Worker ID so the employee-facing
 * screen can confirm "you are logged in as [name] - [position]".
 */
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/functions.php';

$workerId = trim($_GET['worker_id'] ?? '');

if ($workerId === '') {
    send_json(['success' => false, 'message' => 'Please enter your Worker ID.'], 400);
}

$stmt = $pdo->prepare("SELECT id, worker_id, full_name, position, is_on_lunch FROM employees WHERE worker_id = :wid AND status = 'active'");
$stmt->execute(['wid' => $workerId]);
$employee = $stmt->fetch();

if (!$employee) {
    send_json(['success' => false, 'message' => 'Worker ID not found. Check with your supervisor.'], 404);
}

// Cast explicitly so JSON encodes a real boolean (true/false), not a
// string "0"/"1" that JavaScript would treat as truthy either way.
$employee['is_on_lunch'] = (bool)$employee['is_on_lunch'];

// Also tell the front-end whether they're already clocked in today
// (so the button can show "Clock Out" instead of "Clock In").
$today = date('Y-m-d');
$attStmt = $pdo->prepare("SELECT clock_in, clock_out FROM attendance WHERE employee_id = :id AND work_date = :d");
$attStmt->execute(['id' => $employee['id'], 'd' => $today]);
$todayRecord = $attStmt->fetch();

send_json([
    'success' => true,
    'employee' => $employee,
    'today' => [
        'clock_in'  => $todayRecord['clock_in'] ?? null,
        'clock_out' => $todayRecord['clock_out'] ?? null,
    ]
]);
