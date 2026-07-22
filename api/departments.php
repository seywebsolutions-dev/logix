<?php
/**
 * Logix — Departments CRUD (admin)
 */
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/functions.php';

$method = $_SERVER['REQUEST_METHOD'];
header('Cache-Control: no-store, no-cache');

// Lazy-create departments table on first run
$pdo->exec(
    "CREATE TABLE IF NOT EXISTS departments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(20) NOT NULL UNIQUE,
        description TEXT NULL,
        head_of_department INT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (head_of_department) REFERENCES employees(id) ON DELETE SET NULL
    ) ENGINE=InnoDB"
);

if ($method === 'GET') {
    require_admin();
    $stmt = $pdo->query("SELECT d.*, e.full_name AS head_name FROM departments d LEFT JOIN employees e ON e.id = d.head_of_department ORDER BY d.name ASC");
    send_json(['success' => true, 'departments' => $stmt->fetchAll()]);
}

if ($method === 'POST') {
    require_admin();
    $input = get_json_input();
    $name = trim($input['name'] ?? '');
    $code = strtoupper(trim($input['code'] ?? ''));
    $desc = trim($input['description'] ?? '');

    if ($name === '' || $code === '') send_json(['success' => false, 'message' => 'Name and code are required.'], 400);

    $stmt = $pdo->prepare("INSERT INTO departments (name, code, description) VALUES (:n, :c, :d)");
    $stmt->execute(['n' => $name, 'c' => $code, 'd' => $desc ?: null]);
    send_json(['success' => true, 'message' => 'Department created.', 'id' => (int)$pdo->lastInsertId()]);
}

if ($method === 'PUT') {
    require_admin();
    $input = get_json_input();
    $id = (int)($input['id'] ?? 0);
    if (!$id) send_json(['success' => false, 'message' => 'Missing id.'], 400);

    $stmt = $pdo->prepare("UPDATE departments SET name = :n, code = :c, description = :d WHERE id = :i");
    $stmt->execute([
        'n' => trim($input['name'] ?? ''),
        'c' => strtoupper(trim($input['code'] ?? '')),
        'd' => trim($input['description'] ?? ''),
        'i' => $id,
    ]);
    send_json(['success' => true, 'message' => 'Department updated.']);
}

if ($method === 'DELETE') {
    require_admin();
    $input = get_json_input();
    $id = (int)($input['id'] ?? 0);
    if (!$id) send_json(['success' => false, 'message' => 'Missing id.'], 400);
    $pdo->prepare("UPDATE departments SET is_active = 0 WHERE id = :i")->execute(['i' => $id]);
    send_json(['success' => true, 'message' => 'Department deactivated.']);
}

send_json(['success' => false, 'message' => 'Method not allowed.'], 405);
