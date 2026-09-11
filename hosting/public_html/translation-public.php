<?php
declare(strict_types=1);
/**
 * سلسار V2 — translation-public.php
 * =========================================================================
 * صفحة عامة (بلا تسجيل دخول) تُرجع بيانات الترجمة برقم الوصول.
 * متوافقة مع نمط التسمية القديم ({code}.json)
 * والجديد ({code}__{recordId}__{lang}.json).
 * =========================================================================
 */
$salsarBootstrap = dirname(__DIR__) . '/salsar-private/bootstrap.php';
if (!is_file($salsarBootstrap)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    exit('مجلد سلسار الخاص غير موجود خارج جذر الويب. راجع دليل النقل قبل المتابعة.');
}
require $salsarBootstrap;

salsar_rate_limit('translation', 8, 60);   // v2.2: 8 محاولات في الدقيقة لكل IP

$code = (string)($_GET['code'] ?? '');
if (!preg_match('/^\d{8}$/', $code)) {
    salsar_json(['ok' => false, 'error' => 'أدخل رقم ترجمة صحيحًا من 8 أرقام'], 400);
}

$folder = SALSAR_PRIVATE_DIR . '/translation-cache';
$now    = time();

// ابحث أولاً بالنمط الجديد: {code}__*.json
$candidates = glob($folder . '/' . $code . '__*.json') ?: [];

// إن لم يُجد، جرّب النمط القديم: {code}.json
if (empty($candidates)) {
    $legacy = $folder . '/' . $code . '.json';
    if (is_file($legacy)) $candidates = [$legacy];
}

if (empty($candidates)) {
    salsar_json(['ok' => false, 'error' => 'رقم الترجمة غير موجود أو انتهت صلاحيته'], 404);
}

// حالة طبيعية: ملف واحد فقط
if (count($candidates) === 1) {
    $payload = json_decode((string)file_get_contents($candidates[0]), true);
    $expires = is_array($payload) ? strtotime((string)($payload['expiresAt'] ?? '')) : false;
    if ($expires === false || $expires < $now) {
        @unlink($candidates[0]);
        salsar_json(['ok' => false, 'error' => 'انتهت صلاحية هذه الترجمة'], 410);
    }
    salsar_json(['ok' => true, 'data' => $payload]);
}

// حالة نادرة: تصادم رقم — ملفان أو أكثر بنفس الرقم
// نعيد كل المحاضر المتاحة حتى يختار القارئ
$results = [];
foreach ($candidates as $file) {
    $payload = json_decode((string)@file_get_contents($file), true);
    if (!is_array($payload)) continue;
    $expires = strtotime((string)($payload['expiresAt'] ?? ''));
    if ($expires === false || $expires < $now) { @unlink($file); continue; }
    $results[] = [
        'recordId' => $payload['record']['id']   ?? '',
        'language' => $payload['language']        ?? '',
        'date'     => $payload['record']['date']  ?? '',
        'plate'    => $payload['record']['plate'] ?? '',
    ];
}

if (empty($results)) {
    salsar_json(['ok' => false, 'error' => 'انتهت صلاحية هذه الترجمة'], 410);
}

// نعيد قائمة للـ translation-code.html ليعرضها للمستخدم
salsar_json(['ok' => true, 'collision' => true, 'records' => $results, 'code' => $code]);
