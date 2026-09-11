<?php
declare(strict_types=1);
$salsarBootstrap = dirname(__DIR__) . '/salsar-private/bootstrap.php';
if (!is_file($salsarBootstrap)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    exit('مجلد سلسار الخاص غير موجود خارج جذر الويب. راجع دليل النقل قبل المتابعة.');
}
require $salsarBootstrap;
salsar_session_start();
$config = salsar_config();
salsar_rate_limit('auth', 10, 300);   // v2.2: 10 محاولات كل 5 دقائق لكل IP
$input = json_decode(file_get_contents('php://input') ?: '', true);
$credential = is_array($input) ? trim((string)($input['credential'] ?? '')) : '';
if ($credential === '') {
    salsar_json(['ok' => false, 'error' => 'بيانات تسجيل الدخول غير مكتملة'], 400);
}
$url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' . rawurlencode($credential);
$curl = curl_init($url);
curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 15]);
$body = curl_exec($curl);
$status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
curl_close($curl);
$claims = json_decode(is_string($body) ? $body : '', true);
if ($status !== 200 || !is_array($claims)) {
    salsar_json(['ok' => false, 'error' => 'تعذر التحقق من حساب Google'], 401);
}
$email = strtolower(trim((string)($claims['email'] ?? '')));
$audience = (string)($claims['aud'] ?? '');
$domain = strtolower(trim((string)($claims['hd'] ?? '')));
$verified = filter_var($claims['email_verified'] ?? false, FILTER_VALIDATE_BOOLEAN);
$allowed = array_map(static fn($value) => strtolower(trim((string)$value)), (array)($config['allowed_emails'] ?? []));
if ($audience !== (string)$config['google_client_id'] || !$verified || $domain !== strtolower((string)$config['allowed_domain']) || !in_array($email, $allowed, true)) {
    salsar_json(['ok' => false, 'error' => 'هذا الحساب غير مصرح له باستخدام سلسار'], 403);
}
session_regenerate_id(true);
$_SESSION['salsar_user'] = ['email' => $email, 'name' => (string)($claims['name'] ?? 'مسؤول المركبات'), 'picture' => (string)($claims['picture'] ?? ''), 'signedInAt' => time()];
salsar_json(['ok' => true, 'user' => $_SESSION['salsar_user']]);
