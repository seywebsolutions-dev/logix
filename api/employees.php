<?php
/**
 * GET    /api/employees.php            -> (admin only) list all employees
 * POST   /api/employees.php            -> (admin only) add a new employee
 *        Body: { "worker_id": "EMP004", "full_name": "...", "position": "..." }
 * DELETE /api/employees.php            -> (admin only) remove an employee
 *        Body: { "id": 4 }
 */
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/functions.php';

require_admin(); // every action on this file requires an admin session

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $pdo->query(
        "SELECT id, worker_id, full_name, position, is_on_lunch, status, created_at
         FROM employees WHERE status = 'active' ORDER BY full_name ASC"
    );
    $employees = $stmt->fetchAll();
    foreach ($employees as &$emp) {
        $emp['is_on_lunch'] = (bool)$emp['is_on_lunch'];
    }
    send_json(['success' => true, 'employees' => $employees]);
}

if ($method === 'POST') {
    $input = get_json_input();
    $workerId = trim($input['worker_id'] ?? '');
    $fullName = trim($input['full_name'] ?? '');
    $position = trim($input['position'] ?? '');

    if ($workerId === '' || $fullName === '' || $position === '') {
        send_json(['success' => false, 'message' => 'Worker ID, name, and position are all required.'], 400);
    }

    // Check for a duplicate Worker ID first, for a friendlier error message
    $dupe = $pdo->prepare("SELECT id FROM employees WHERE worker_id = :wid");
    $dupe->execute(['wid' => $workerId]);
    if ($dupe->fetch()) {
        send_json(['success' => false, 'message' => 'That Worker ID is already in use.'], 409);
    }

    $stmt = $pdo->prepare(
        "INSERT INTO employees (worker_id, full_name, position) VALUES (:wid, :name, :pos)"
    );
    $stmt->execute(['wid' => $workerId, 'name' => $fullName, 'pos' => $position]);

    send_json(['success' => true, 'message' => 'Employee added.', 'id' => $pdo->lastInsertId()]);
}

if ($method === 'DELETE') {
    $input = get_json_input();
    $id = (int)($input['id'] ?? 0);

    if (!$id) {
        send_json(['success' => false, 'message' => 'Missing employee id.'], 400);
    }

    // Soft delete keeps their historical attendance/sick-leave records intact
    $stmt = $pdo->prepare("UPDATE employees SET status = 'inactive' WHERE id = :id");
    $stmt->execute(['id' => $id]);

    send_json(['success' => true, 'message' => 'Employee removed.']);
}

send_json(['success' => false, 'message' => 'Method not allowed.'], 405);
