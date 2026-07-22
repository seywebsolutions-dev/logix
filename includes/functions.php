<?php
/**
 * Logix — Shared backend helpers.
 */

function send_json($data, $statusCode = 200)
{
    http_response_code($statusCode);
    header('Content-Type: application/json');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    header('Pragma: no-cache');
    echo json_encode($data);
    exit;
}

function get_json_input()
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function require_admin()
{
    if (session_status() === PHP_SESSION_NONE) {
        session_start();
    }
    if (empty($_SESSION['is_admin'])) {
        send_json(['success' => false, 'message' => 'Not authorized. Please log in as admin.'], 401);
    }
}

function log_action(PDO $pdo, string $actorType, int $actorId, string $actorName, string $action, ?string $targetType = null, ?int $targetId = null, ?array $details = null, ?string $ip = null, ?string $ua = null)
{
    $stmt = $pdo->prepare(
        'INSERT INTO audit_log (actor_type, actor_id, actor_name, action, target_type, target_id, details, ip_address, user_agent)
         VALUES (:a, :id, :n, :ac, :t, :ti, :d, :i, :u)'
    );
    $stmt->execute([
        'a' => $actorType,
        'id' => $actorId,
        'n' => $actorName,
        'ac' => $action,
        't' => $targetType,
        'ti' => $targetId,
        'd' => $details ? json_encode($details) : null,
        'i' => $ip ?? ($_SERVER['REMOTE_ADDR'] ?? ''),
        'u' => $ua ?? ($_SERVER['HTTP_USER_AGENT'] ?? ''),
    ]);
}

function count_working_days($year, $month)
{
    $today = new DateTime();
    $isCurrentMonth = ($today->format('Y') == $year && $today->format('n') == $month);
    $lastDay = (int)($isCurrentMonth ? $today->format('j') : date('t', mktime(0, 0, 0, $month, 1, $year)));

    $count = 0;
    for ($d = 1; $d <= $lastDay; $d++) {
        $dow = (int)date('N', mktime(0, 0, 0, $month, $d, $year)); // 1=Mon..5=Fri
        if ($dow < 6) $count++;
    }
    return max($count, 1);
}

function calculate_attendance_percentage(PDO $pdo, int $employeeId, int $year, int $month): float
{
    $stmt = $pdo->prepare(
        "SELECT COUNT(DISTINCT work_date) FROM attendance
         WHERE employee_id = :id AND clock_in IS NOT NULL
           AND YEAR(work_date) = :y AND MONTH(work_date) = :m"
    );
    $stmt->execute(['id' => $employeeId, 'y' => $year, 'm' => $month]);
    $present = (int)$stmt->fetchColumn();
    $pct = ($present / count_working_days($year, $month)) * 100;
    return round(min($pct, 100), 1);
}

function notify(string $userType, int $userId, string $title, string $message, ?string $link = null)
{
    global $pdo;
    try {
        $stmt = $pdo->prepare(
            "INSERT INTO notifications (user_type, user_id, title, message, link)
             VALUES (:ut, :ui, :t, :m, :l)"
        );
        $stmt->execute(['ut' => $userType, 'ui' => $userId, 't' => $title, 'm' => $message, 'l' => $link]);
    } catch (Throwable $e) {
        /* notifications must never break the main flow */
    }
}
