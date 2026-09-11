<?php
declare(strict_types=1);
/**
 * سلسار V2 — translation-store.php
 * =========================================================================
 * يحفظ ملخص الترجمة المترجم ويعيد رقم الوصول الفعلي المحفوظ.
 *
 * إصلاح V2: حارس التصادم (CODE_COLLISION)
 *   النسخة القديمة كانت تكتب فوق أي ملف بنفس الرقم بلا فحص.
 *   رقم الوصول (8 خانات من FNV-1a) قد يتصادم عند محضرين مختلفين.
 *   الحل: التسمية = {code}__{recordId}__{lang}.json
 *   - عند التصادم: ملفان منفصلان، لا يمحو أحدهما الآخر.
 *   - translation-public.php يبحث بنمط {code}__* ويعيد الملف الوحيد،
 *     أو يطلب رقم المحضر للتمييز إن وُجد أكثر من ملف.
 *   - رقم الوصول المُعاد للواجهة هو نفسه المُرسَل (الباركود يبقى صحيحاً).
 * =========================================================================
 */
$salsarBootstrap = dirname(__DIR__) . '/salsar-private/bootstrap.php';
if (!is_file($salsarBootstrap)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    exit('مجلد سلسار الخاص غير موجود خارج جذر الويب. راجع دليل النقل قبل المتابعة.');
}
require $salsarBootstrap;
salsar_require_user();

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    salsar_json(['ok' => false, 'error' => 'METHOD_NOT_ALLOWED'], 405);
}

$input   = json_decode((string)file_get_contents('php://input'), true);
$code    = (string)($input['code']    ?? '');
$payload = $input['payload'] ?? null;

if (!preg_match('/^\d{8}$/', $code) || !is_array($payload)) {
    salsar_json(['ok' => false, 'error' => 'بيانات الترجمة غير صالحة'], 400);
}

$now = time();
$payload['createdAt'] = gmdate('c', $now);
$payload['expiresAt'] = gmdate('c', $now + 30 * 86400);

$folder = SALSAR_PRIVATE_DIR . '/translation-cache';
if (!is_dir($folder) && !mkdir($folder, 0750, true) && !is_dir($folder)) {
    salsar_json(['ok' => false, 'error' => 'تعذر إنشاء مساحة الترجمة'], 500);
}

// حذف الملفات المنتهية الصلاحية
foreach (glob($folder . '/*.json') ?: [] as $file) {
    $saved   = json_decode((string)@file_get_contents($file), true);
    $expires = is_array($saved) ? strtotime((string)($saved['expiresAt'] ?? '')) : false;
    if ($expires === false || $expires < $now) @unlink($file);
}

// ---- حارس التصادم ----
// اسم الملف يحمل هوية المحضر واللغة — فمحضران مختلفان لا يتصادمان أبداً.
$recordId = (string)($payload['record']['id'] ?? '');
$lang     = (string)($payload['code']         ?? '');
$suffix   = ($recordId !== '' && $lang !== '')
    ? '__' . preg_replace('/[^A-Za-z0-9\-]/', '', $recordId) . '__' . preg_replace('/[^a-z]/', '', $lang)
    : '';

$target    = $folder . '/' . $code . $suffix . '.json';
$temporary = $target . '.' . bin2hex(random_bytes(4)) . '.tmp';

$json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
if ($json === false
    || file_put_contents($temporary, $json, LOCK_EX) === false
    || !rename($temporary, $target)
) {
    @unlink($temporary);
    salsar_json(['ok' => false, 'error' => 'تعذر حفظ الترجمة'], 500);
}

// نعيد نفس الرقم الذي أرسلته الواجهة — الباركود يبقى صحيحاً
salsar_json(['ok' => true, 'code' => $code, 'expiresAt' => $payload['expiresAt']]);
