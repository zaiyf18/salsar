<?php
declare(strict_types=1);
/**
 * سلسار V2 — api.php   [نسخة مُصلَحة — 2026-09-09]
 * =========================================================================
 * الإصلاحات في هذه النسخة:
 *  U-11  هوية الفاعل: بريد الجلسة المتحقق منها يُحقن في المستوى الأعلى للطلب،
 *        وأي actorEmail يرسله المتصفح داخل payload يُحذف صراحةً.
 *        (قبل هذا كان سجل التدقيق كله يقول «مستخدم الويب».)
 *  U-04  كاش fleet-data يُحذف بعد كل عملية كتابة ناجحة، فتظهر النتيجة فورًا
 *        بدل انتظار خمس دقائق — وهو ما كان يدفع المستخدم لإعادة الإنشاء.
 * =========================================================================
 */
$salsarBootstrap = dirname(__DIR__) . '/salsar-private/bootstrap.php';
if (!is_file($salsarBootstrap)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    exit('مجلد سلسار الخاص غير موجود خارج جذر الويب. راجع دليل النقل قبل المتابعة.');
}
require $salsarBootstrap;

$user = salsar_require_user();          // ← نحتفظ بالمستخدم بدل تجاهله

// لا نحتاج إلى إبقاء قفل جلسة PHP أثناء انتظار Apps Script؛ يسمح هذا برفع صورتين بالتوازي.
if (session_status() === PHP_SESSION_ACTIVE) session_write_close();

$config = salsar_config();
$input = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($input)) {
    salsar_json(['ok' => false, 'error' => 'طلب غير صالح'], 400);
}
$action = trim((string)($input['action'] ?? ''));
if ($action === '') {
    salsar_json(['ok' => false, 'error' => 'العملية مطلوبة'], 400);
}

// الأفعال التي لا تكتب شيئًا — لا تحتاج إبطال الكاش
const SALSAR_READ_ONLY_ACTIONS = ['health', 'bootstrap', 'vehicleHistory', 'holderHistory'];

$payload = [
    'action'     => $action,
    'apiToken'   => (string)$config['apps_script_token'],
    // U-11: المصدر الموثوق الوحيد لهوية الفاعل — جلسة PHP، لا المتصفح
    'actorEmail' => (string)($user['email'] ?? ''),
];

if (array_key_exists('payload', $input)) {
    $client = is_array($input['payload']) ? $input['payload'] : [];
    // U-11: لا نسمح للمتصفح بتحديد هوية الفاعل
    unset($client['actorEmail']);
    $payload['payload'] = $client;
}

foreach (['vehicleId', 'holderId'] as $key) {
    if (array_key_exists($key, $input)) $payload[$key] = $input[$key];
}

/**
 * U-04: يحذف كاش fleet-data حتى تعكس الصفحة التالية الكتابة فورًا.
 * ملاحظة: الحذف لا الكتابة — الطلب التالي يعيد بناء الملف من Apps Script.
 */
function salsar_invalidate_fleet_cache(): void
{
    $cacheFile = SALSAR_PRIVATE_DIR . '/fleet-cache.json';
    if (is_file($cacheFile)) {
        @unlink($cacheFile);
    }
}

try {
    $result = salsar_http_post_json((string)$config['apps_script_url'], $payload);

    if (!in_array($action, SALSAR_READ_ONLY_ACTIONS, true) && !empty($result['ok'])) {
        salsar_invalidate_fleet_cache();
    }

    salsar_json($result);
} catch (Throwable $error) {
    // عملية كتابة تعثّرت قد تكون نجحت على الخادم قبل انقطاع الاتصال —
    // نُبطل الكاش على أي حال حتى تعرض الصفحة التالية الحقيقة.
    if (!in_array($action, SALSAR_READ_ONLY_ACTIONS, true)) {
        salsar_invalidate_fleet_cache();
    }
    salsar_json(['ok' => false, 'error' => $error->getMessage()], 502);
}
