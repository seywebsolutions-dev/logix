<?php
/**
 * GET /api/attendance.php?employee_id=1&year=2026&month=7
 *      -> that employee's attendance percentage + this month's clock records
 *
 * GET /api/attendance.php&year=2026&month=7   (admin only, no employee_id)
 *      -> attendance percentage for EVERY employee, plus who is clocked in today
 */
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/functions.php';

$year = (int)($_GET['year'] ?? date('Y'));
$month = (int)($_GET['month'] ?? date('n'));
$employeeId = (int)($_GET['employee_id'] ?? 0);

if ($employeeId) {
    // Single employee view
    $percentage = calculate_attendance_percentage($pdo, $employeeId, $year, $month);

    $stmt = $pdo->prepare(
        "SELECT work_date, clock_in, clock_out FROM attendance
         WHERE employee_id = :id AND YEAR(work_date) = :y AND MONTH(work_date) = :m
         ORDER BY work_date DESC"
    );
    $stmt->execute(['id' => $employeeId, 'y' => $year, 'm' => $month]);

    send_json([
        'success' => true,
        'percentage' => $percentage,
        'records' => $stmt->fetchAll(),
    ]);
}

// Admin: every employee's attendance percentage + today's clock status
require_admin();

$today = date('Y-m-d');
$employees = $pdo->query(
    "SELECT id, worker_id, full_name, position, is_on_lunch FROM employees WHERE status = 'active' ORDER BY full_name ASC"
)->fetchAll();

$todayStmt = $pdo->prepare("SELECT clock_in, clock_out FROM attendance WHERE employee_id = :id AND work_date = :d");

$result = [];
foreach ($employees as $emp) {
    $todayStmt->execute(['id' => $emp['id'], 'd' => $today]);
    $todayRecord = $todayStmt->fetch();

    $result[] = [
        'id' => $emp['id'],
        'worker_id' => $emp['worker_id'],
        'full_name' => $emp['full_name'],
        'position' => $emp['position'],
        'is_on_lunch' => (bool)$emp['is_on_lunch'],
        'clock_in_today' => $todayRecord['clock_in'] ?? null,
        'clock_out_today' => $todayRecord['clock_out'] ?? null,
        'attendance_percentage' => calculate_attendance_percentage($pdo, $emp['id'], $year, $month),
    ];
}

send_json(['success' => true, 'employees' => $result]);
