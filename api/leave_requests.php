<?php
/**
 * Logix — Leave Requests
 *
 * GET ?employee_id=1    employee view
 * GET  [admin]          list all requests
 * POST                  submit request (employee, body with employee_id)
 * PUT  [admin]          approve / deny
 */
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/functions.php';

header('Cache-Control: no-store, no-cache');
$method = $_SERVER['REQUEST_METHOD'];

$pdo->exec(
    "CREATE TABLE IF NOT EXISTS leave_types (
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
    ) ENGINE=InnoDB"
);

if ($method === 'GET') {
    $employeeId = (int)($_GET['employee_id'] ?? 0);

    if ($employeeId) {
        $stmt = $pdo->prepare(
            "SELECT lr.id, lr.leave_type_id, lr.start_date AS leave_date, lr.end_date, lr.reason,
                    lr.status, lr.requested_at, lr.is_half_day, lr.review_comment,
                    lt.name AS leave_type_name, lt.code AS leave_type_code, lt.color
             FROM leave_requests lr
             LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.employee_id = :id
             ORDER BY lr.requested_at DESC"
        );
        $stmt->execute(['id' => $employeeId]);
        $requests = $stmt->fetchAll();

        // Normalize for consumers
        $out = [];
        foreach ($requests as $r) {
            $out[] = [
                'id' => (int)$r['id'],
                'leave_type_id' => (int)$r['leave_type_id'],
                'leave_date' => $r['leave_date'],
                'end_date' => $r['end_date'],
                'reason' => $r['reason'],
                'status' => $r['status'],
                'requested_at' => $r['requested_at'],
                'is_half_day' => (bool)$r['is_half_day'],
                'review_comment' => $r['review_comment'],
                'leave_type_name' => $r['leave_type_name'],
                'leave_type_code' => $r['leave_type_code'],
                'leave_type_code' => $r['leave_type_code'],
            ];
        }
        send_json(['success' => true, 'requests' => $out]);
    }

    require_admin();
    $stmt = $pdo->query(
        "SELECT lr.id, lr.leave_type_id, lr.start_date, lr.end_date, lr.reason,
                lr.status, lr.requested_at, lr.is_half_day, lr.review_comment,
                lt.code AS leave_type_code,
                e.id AS emp_id, e.worker_id, e.full_name, e.position
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
         ORDER BY lr.requested_at DESC"
    );
    $rows = $stmt->fetchAll();
    $requests = [];
    foreach ($rows as $r) {
        $requests[] = [
            'id' => (int)$r['id'],
            'leave_type_id' => (int)$r['leave_type_id'],
            'leave_date' => $r['start_date'],
            'end_date' => $r['end_date'],
            'reason' => $r['reason'],
            'status' => $r['status'],
            'requested_at' => $r['requested_at'],
            'is_half_day' => (bool)$r['is_half_day'],
            'review_comment' => $r['review_comment'],
            'leave_type_code' => $r['leave_type_code'],
            'employee_id' => (int)$r['emp_id'],
            'worker_id' => $r['worker_id'],
            'full_name' => $r['full_name'],
            'position' => $r['position'],
        ];
    }
    send_json(['success' => true, 'requests' => $requests]);
}

if ($method === 'POST') {
    $input = get_json_input();
    $employeeId = (int)($input['employee_id'] ?? 0);
    $startDate = trim($input['start_date'] ?? $input['leave_date'] ?? '');
    $endDate = trim($input['end_date'] ?? $startDate);
    $reason = trim($input['reason'] ?? '');
    $leaveType = trim($input['leave_type'] ?? 'CL');
    $isHalfDay = !empty($input['is_half_day']) ? 1 : 0;

    if (!$employeeId || $startDate === '') {
        send_json(['success' => false, 'message' => 'Please select a date.'], 400);
    }

    // Get day names for this range
    $dates = getFullDateRange($startDate, $endDate);
    foreach ($dates as $d) {
        $stmt = $pdo->prepare(
            "INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, reason, is_half_day)
             VALUES (:eid, :lt, :s, :e, :r, :h)"
        );
        $stmt->execute([
            'eid' => $employeeId,
            'lt' => getLeaveTypeId($pdo, $leaveType),
            's' => $d,
            'e' => $d,
            'r' => $reason ?: null,
            'h' => $isHalfDay,
        ]);
    }

    // Notify admins
    $empStmt = $pdo->prepare("SELECT full_name, position FROM employees WHERE id = :id");
    $empStmt->execute(['id' => $employeeId]);
    $emp = $empStmt->fetch();
    $adminUsers = $pdo->query("SELECT id FROM admin_users")->fetchAll(PDO::FETCH_COLUMN);
    foreach ($adminUsers as $adminId) {
        notify('admin', (int)$adminId,
            'New leave request',
            ($emp['full_name'] ?? 'Unknown') . ' requested ' . $leaveType . ' starting ' . $startDate . '.',
            'admin.html#tab-leaves');
    }

    send_json(['success' => true, 'message' => count($dates) > 1 ? 'Leave submitted for ' . count($dates) . ' days.' : 'Leave request submitted.']);
}

if ($method === 'PUT') {
    require_admin();
    $input = get_json_input();
    $id = (int)($input['id'] ?? 0);
    $status = $input['status'] ?? '';
    $comment = trim($input['review_comment'] ?? '');

    if (!$id || !in_array($status, ['approved', 'denied', 'pending'], true)) {
        send_json(['success' => false, 'message' => 'Invalid request.'], 400);
    }

    $stmt = $pdo->prepare("UPDATE leave_requests SET status = :s, reviewed_at = NOW(), review_comment = :rc WHERE id = :i");
    $stmt->execute(['s' => $status, 'rc' => $comment ?: null, 'i' => $id]);

    // Notify employee
    $lrStmt = $pdo->prepare("SELECT lr.employee_id, e.full_name FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE lr.id = :i");
    $lrStmt->execute(['i' => $id]);
    $lr = $lrStmt->fetch();
    if ($lr) {
        notify('employee', (int)$lr['employee_id'], 'Leave ' . ucfirst($status), 'Your leave request has been ' . $status . '. ' . ($comment ? 'Note: ' . $comment : ''), 'index.html');
    }

    send_json(['success' => true, 'message' => 'Request updated.']);
}

send_json(['success' => false, 'message' => 'Method not allowed.'], 405);

/* Helpers */
function getLeaveTypeId(PDO $pdo, string $code): int {
    $stmt = $pdo->prepare("SELECT id FROM leave_types WHERE code = :c");
    $stmt->execute(['c' => $code]);
    $id = (int)$stmt->fetchColumn();
    if ($id) return $id;

    $colors = ['SL' => '#ef4444', 'CL' => '#3b82f6', 'ML' => '#8b5cf6', 'PL' => '#06b6d4', 'AL' => '#10b981', 'STL' => '#f59e0b', 'EL' => '#f97316'];
    $stmt = $pdo->prepare("INSERT IGNORE INTO leave_types (name, code, color) VALUES (:n, :c, :cl)");
    $stmt->execute(['n' => ucfirst(strtolower($code)), 'c' => $code, 'cl' => $colors[$code] ?? '#6b7280']);
    return (int)$pdo->lastInsertId();
}

function getFullDateRange(string $start, string $end): array {
    $d1 = new DateTime($start);
    $d2 = new DateTime($end);
    $dates = [];
    while ($d1 <= $d2) {
        $dates[] = $d1->format('Y-m-d');
        $d1->modify('+1 day');
    }
    return $dates;
}
