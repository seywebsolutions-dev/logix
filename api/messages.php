<?php
/**
 * GET  /api/messages.php          -> list latest messages (everyone can see)
 * POST /api/messages.php          -> (admin only) post a new message
 *      Body: { "message": "..." }
 * DELETE /api/messages.php        -> (admin only) remove a message
 *      Body: { "id": 3 }
 */
if (session_status() === PHP_SESSION_NONE) {
    session_start();
}
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/functions.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $pdo->query("SELECT id, message, posted_by, created_at FROM messages ORDER BY created_at DESC LIMIT 30");
    send_json(['success' => true, 'messages' => $stmt->fetchAll()]);
}

if ($method === 'POST') {
    require_admin();
    $input = get_json_input();
    $message = trim($input['message'] ?? '');

    if ($message === '') {
        send_json(['success' => false, 'message' => 'Message cannot be empty.'], 400);
    }

    $postedBy = $_SESSION['admin_username'] ?? 'Admin';

    $stmt = $pdo->prepare("INSERT INTO messages (message, posted_by) VALUES (:msg, :by)");
    $stmt->execute(['msg' => $message, 'by' => $postedBy]);

    send_json(['success' => true, 'message' => 'Posted to the board.']);
}

if ($method === 'DELETE') {
    require_admin();
    $input = get_json_input();
    $id = (int)($input['id'] ?? 0);

    if (!$id) {
        send_json(['success' => false, 'message' => 'Missing message id.'], 400);
    }

    $stmt = $pdo->prepare("DELETE FROM messages WHERE id = :id");
    $stmt->execute(['id' => $id]);

    send_json(['success' => true, 'message' => 'Message removed.']);
}

send_json(['success' => false, 'message' => 'Method not allowed.'], 405);
