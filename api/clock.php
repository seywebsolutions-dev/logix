<?php
/**
 * POST /api/clock.php
 * Body: { "employee_id": 1, "action": "in" | "out" }
 * Records a clock-in or clock-out timestamp for today.
 */
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/functions.php';

$input = get_json_input();
$employeeId = (int)($input['employee_id'] ?? 0);
$action = $input['action'] ?? '';

if (!$employeeId || !in_array($action, ['in', 'out'], true)) {
    send_json(['success' => false, 'message' => 'Missing or invalid employee_id/action.'], 400);
}

$today = date('Y-m-d');
$now = date('Y-m-d H:i:s');

// Make sure the employee exists
$check = $pdo->prepare("SELECT id FROM employees WHERE id = :id AND status = 'active'");
$check->execute(['id' => $employeeId]);
if (!$check->fetch()) {
    send_json(['success' => false, 'message' => 'Employee not found.'], 404);
}

if ($action === 'in') {
    // Insert today's row if it doesn't exist yet, otherwise set clock_in
    // (this also lets someone "re-clock-in" if they made a mistake, without
    // erasing an existing clock_out for the day).
    $stmt = $pdo->prepare(
        "INSERT INTO attendance (employee_id, work_date, clock_in)
         VALUES (:id, :d, :now)
         ON DUPLICATE KEY UPDATE clock_in = VALUES(clock_in)"
    );
    $stmt->execute(['id' => $employeeId, 'd' => $today, 'now' => $now]);
    $message = 'Clocked in successfully.';
} else {
    // Clock out: only works if there's already a clock_in row for today
    $stmt = $pdo->prepare(
        "UPDATE attendance SET clock_out = :now
         WHERE employee_id = :id AND work_date = :d AND clock_in IS NOT NULL"
    );
    $stmt->execute(['id' => $employeeId, 'd' => $today, 'now' => $now]);

    if ($stmt->rowCount() === 0) {
        send_json(['success' => false, 'message' => 'You need to clock in before you can clock out.'], 400);
    }
    $message = 'Clocked out successfully.';

    // Turn off "on lunch" automatically when someone clocks out
    $pdo->prepare("UPDATE employees SET is_on_lunch = 0, lunch_started_at = NULL WHERE id = :id")
        ->execute(['id' => $employeeId]);
}

send_json(['success' => true, 'message' => $message, 'time' => $now]);
