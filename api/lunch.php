<?php
/**
 * POST /api/lunch.php
 * Body: { "employee_id": 1 }
 * Toggles the employee's "on lunch" status on/off.
 */
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/functions.php';

$input = get_json_input();
$employeeId = (int)($input['employee_id'] ?? 0);

if (!$employeeId) {
    send_json(['success' => false, 'message' => 'Missing employee_id.'], 400);
}

$stmt = $pdo->prepare("SELECT is_on_lunch FROM employees WHERE id = :id AND status = 'active'");
$stmt->execute(['id' => $employeeId]);
$employee = $stmt->fetch();

if (!$employee) {
    send_json(['success' => false, 'message' => 'Employee not found.'], 404);
}

$newStatus = $employee['is_on_lunch'] ? 0 : 1;
$lunchStartedAt = $newStatus ? date('Y-m-d H:i:s') : null;

$update = $pdo->prepare("UPDATE employees SET is_on_lunch = :status, lunch_started_at = :started WHERE id = :id");
$update->execute(['status' => $newStatus, 'started' => $lunchStartedAt, 'id' => $employeeId]);

send_json([
    'success' => true,
    'is_on_lunch' => (bool)$newStatus,
    'message' => $newStatus ? 'You are now on lunch.' : 'Welcome back from lunch.'
]);
