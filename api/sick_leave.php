<?php
/**
 * GET  /api/sick_leave.php?employee_id=1     -> list requests for one employee
 * GET  /api/sick_leave.php                    -> (admin only) list ALL requests
 * POST /api/sick_leave.php                    -> submit a new request
 *      Body: { "employee_id": 1, "leave_date": "2026-07-20", "reason": "..." }
 * PUT  /api/sick_leave.php                    -> (admin only) approve/deny
 *      Body: { "id": 5, "status": "approved" | "denied" }
 */
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/functions.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $employeeId = (int)($_GET['employee_id'] ?? 0);

    if ($employeeId) {
        // An employee checking their own requests
        $stmt = $pdo->prepare(
            "SELECT id, leave_date, reason, status, requested_at
             FROM sick_leaves WHERE employee_id = :id ORDER BY requested_at DESC"
        );
        $stmt->execute(['id' => $employeeId]);
    } else {
        // Admin viewing every request
        require_admin();
        $stmt = $pdo->query(
            "SELECT sl.id, sl.leave_date, sl.reason, sl.status, sl.requested_at,
                    e.full_name, e.position, e.worker_id
             FROM sick_leaves sl
             JOIN employees e ON e.id = sl.employee_id
             ORDER BY sl.requested_at DESC"
        );
    }

    send_json(['success' => true, 'requests' => $stmt->fetchAll()]);
}

if ($method === 'POST') {
    $input = get_json_input();
    $employeeId = (int)($input['employee_id'] ?? 0);
    $leaveDate = trim($input['leave_date'] ?? '');
    $reason = trim($input['reason'] ?? '');

    if (!$employeeId || $leaveDate === '') {
        send_json(['success' => false, 'message' => 'Please select a date for your sick leave.'], 400);
    }

    $stmt = $pdo->prepare(
        "INSERT INTO sick_leaves (employee_id, leave_date, reason) VALUES (:id, :d, :r)"
    );
    $stmt->execute(['id' => $employeeId, 'd' => $leaveDate, 'r' => $reason]);

    send_json(['success' => true, 'message' => 'Sick leave request submitted.']);
}

if ($method === 'PUT') {
    require_admin();
    $input = get_json_input();
    $id = (int)($input['id'] ?? 0);
    $status = $input['status'] ?? '';

    if (!$id || !in_array($status, ['approved', 'denied', 'pending'], true)) {
        send_json(['success' => false, 'message' => 'Invalid request.'], 400);
    }

    $stmt = $pdo->prepare("UPDATE sick_leaves SET status = :status, reviewed_at = NOW() WHERE id = :id");
    $stmt->execute(['status' => $status, 'id' => $id]);

    send_json(['success' => true, 'message' => 'Request updated.']);
}

send_json(['success' => false, 'message' => 'Method not allowed.'], 405);
