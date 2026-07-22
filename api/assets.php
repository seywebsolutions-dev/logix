<?php
/**
 * Logix — Equipment / Assets / Inventory
 * New CRUD endpoint for workplace resource tracking.
 */
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/functions.php';

$method = $_SERVER['REQUEST_METHOD'];

// Ensure table exists
$pdo->exec(
    "CREATE TABLE IF NOT EXISTS assets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        category VARCHAR(80) NOT NULL,
        serial_number VARCHAR(120) NULL,
        assigned_to INT NULL,
        status ENUM('available','in_use','maintenance','retired') NOT NULL DEFAULT 'available',
        condition_notes TEXT NULL,
        acquired_at DATE NULL,
        created_by VARCHAR(50) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_category (category),
        INDEX idx_status (status),
        FOREIGN KEY (assigned_to) REFERENCES employees(id) ON DELETE SET NULL
    ) ENGINE=InnoDB"
);

header('Cache-Control: no-store, no-cache');

if ($method === 'GET') {
    require_admin();
    $stmt = $pdo->query(
        "SELECT a.*, e.full_name AS assigned_to_name, e.worker_id AS assigned_worker_id
         FROM assets a
         LEFT JOIN employees e ON e.id = a.assigned_to
         ORDER BY a.created_at DESC"
    );
    send_json(['success' => true, 'assets' => $stmt->fetchAll()]);
}

if ($method === 'POST') {
    require_admin();
    $input = get_json_input();
    $name = trim($input['name'] ?? '');
    $category = trim($input['category'] ?? '');
    $serial = trim($input['serial_number'] ?? '');
    $assignedTo = isset($input['assigned_to']) ? (int) $input['assigned_to'] : null;
    $status = in_array(trim($input['status'] ?? ''), ['available','in_use','maintenance','retired'], true) ? trim($input['status']) : 'available';
    $conditionNotes = trim($input['condition_notes'] ?? '');
    $acquiredAt = trim($input['acquired_at'] ?? '');

    if ($name === '' || $category === '') {
        send_json(['success' => false, 'message' => 'Name and category are required.'], 400);
    }

    $stmt = $pdo->prepare(
        "INSERT INTO assets (name, category, serial_number, assigned_to, status, condition_notes, acquired_at, created_by)
         VALUES (:n, :c, :s, :ai, :st, :cn, :a, :cb)"
    );
    $stmt->execute([
        'n' => $name,
        'c' => $category,
        's' => $serial ?: null,
        'ai' => $assignedTo,
        'st' => $status,
        'cn' => $conditionNotes ?: null,
        'a' => $acquiredAt ?: null,
        'cb' => $_SESSION['admin_username'] ?? 'Admin',
    ]);
    log_action($pdo, 'admin', $_SESSION['admin_id'] ?? 0, $_SESSION['admin_username'] ?? 'Admin',
        'asset_created', 'asset', (int)$pdo->lastInsertId(), ['name' => $name, 'category' => $category]);
    send_json(['success' => true, 'message' => 'Asset recorded.', 'id' => (int)$pdo->lastInsertId()]);
}

if ($method === 'PUT') {
    require_admin();
    $input = get_json_input();
    $id = (int)($input['id'] ?? 0);
    if (!$id) send_json(['success' => false, 'message' => 'Invalid asset.'], 400);

    $fields = [];
    $params = ['id' => $id];
    $allowed = ['name', 'category', 'serial_number', 'assigned_to', 'status', 'condition_notes', 'acquired_at'];
    foreach ($allowed as $col) {
        if (isset($input[$col])) {
            $fields[] = "`$col` = :$col";
            $params[$col] = $input[$col] !== '' ? $input[$col] : null;
        }
    }
    if (!$fields) send_json(['success' => false, 'message' => 'Nothing to update.'], 400);

    $stmt = $pdo->prepare("UPDATE assets SET " . implode(',', $fields) . " WHERE id = :id");
    $stmt->execute($params);
    send_json(['success' => true, 'message' => 'Asset updated.']);
}

if ($method === 'DELETE') {
    require_admin();
    $input = get_json_input();
    $id = (int)($input['id'] ?? 0);
    if (!$id) send_json(['success' => false, 'message' => 'Invalid asset.'], 400);
    $pdo->prepare("DELETE FROM assets WHERE id = :id")->execute(['id' => $id]);
    send_json(['success' => true, 'message' => 'Asset removed.']);
}

send_json(['success' => false, 'message' => 'Method not allowed.'], 405);
