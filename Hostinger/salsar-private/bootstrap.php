<?php
declare(strict_types=1);

/**
 * مسار مجلد سلسار الخاص — يُشتق من موقع هذا الملف نفسه.
 * بعد النقل خارج جذر الويب صار __DIR__ هو المجلد الجديد تلقائيًا،
 * فكل ما يعتمد عليه (config.php ومجلد rate-limit) ينتقل بلا أي تعديل.
 */
if (!defined('SALSAR_PRIVATE_DIR')) {
    define('SALSAR_PRIVATE_DIR', __DIR__);
}

function salsar_config(): array
{
    $path = __DIR__ . '/config.php';
    if (!is_file($path)) {
        throw new RuntimeException('ملف إعدادات سلسار غير موجود');
    }
    $config = require $path;
    if (!is_array($config)) {
        throw new RuntimeException('ملف إعدادات سلسار غير صالح');
    }
    return $config;
}

function salsar_session_start(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_name('SALSAR_SESSION');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function salsar_json(array $data, int $status = 200): void
{
    // Some shared-hosting error handlers replace JSON bodies for 4xx/5xx
    // responses. Keep the transport successful and carry the intended status
    // in the JSON envelope so the browser always receives a useful message.
    http_response_code(200);
    if ($status !== 200) {
        $data['_httpStatus'] = $status;
    }
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function salsar_require_user(): array
{
    salsar_session_start();
    $user = $_SESSION['salsar_user'] ?? null;
    if (!is_array($user) || empty($user['email'])) {
        salsar_json(['ok' => false, 'error' => 'AUTH_REQUIRED'], 401);
    }
    return $user;
}

/**
 * محدّد معدّل بسيط لكل IP — للنقاط العامة بلا مصادقة.
 * v2.2: كانت translation-public.php و auth.php مفتوحتين بلا أي حد،
 * فيمكن تعداد أرقام الترجمة (8 خانات) أو تخمين الدخول بلا مقاومة.
 */
function salsar_rate_limit(string $bucket, int $maxAttempts, int $windowSeconds): void
{
    $ip  = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $dir = __DIR__ . '/rate-limit';
    if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
        return; // تعذّر إنشاء المجلد: لا نمنع الخدمة بسببه
    }

    // تنظيف عشوائي خفيف للملفات المنتهية (مرة كل ~50 طلبًا)
    if (random_int(1, 50) === 1) {
        foreach (glob($dir . '/*.json') ?: [] as $old) {
            if (filemtime($old) < time() - 86400) @unlink($old);
        }
    }

    $file = $dir . '/' . preg_replace('/[^a-z0-9_-]/i', '', $bucket) . '-' . sha1($ip) . '.json';
    $now  = time();

    $hits = [];
    if (is_file($file)) {
        $decoded = json_decode((string)@file_get_contents($file), true);
        if (is_array($decoded)) $hits = $decoded;
    }
    $hits = array_values(array_filter($hits, static fn($t) => ((int)$t) > $now - $windowSeconds));

    if (count($hits) >= $maxAttempts) {
        salsar_json([
            'ok'    => false,
            'error' => 'محاولات كثيرة خلال وقت قصير. انتظر دقيقة ثم أعد المحاولة.',
        ], 429);
    }

    $hits[] = $now;
    @file_put_contents($file, json_encode($hits), LOCK_EX);
}

/**
 * أخطاء المصادقة التي يُعاد الطلب بعدها بأمان.
 * Apps Script ينفّذ authorize_ **قبل** dispatch_، فالطلب المرفوض بهذه الرموز
 * لم يصل مرحلة الكتابة إطلاقًا — لا سجل، ولا ملف، ولا تكرار. لذلك إعادته
 * آمنة حتى لأفعال الإنشاء والرفع، بخلاف أي فشل آخر.
 * AUTH_TOKEN_MISMATCH غير مدرج عمدًا: خطأ إعداد حقيقي، وإعادته بلا فائدة.
 */
const SALSAR_RETRYABLE_AUTH_CODES = ['AUTH_TOKEN_UNREADABLE', 'AUTH_TOKEN_MISSING'];

function salsar_http_post_json(string $url, array $payload): array
{
    $lastError = 'تعذر الاتصال بخدمة البيانات';
    // إعادة القراءة آمنة، لكن إعادة طلب إنشاء/رفع قد تكرر السجل أو الملف.
    $action = trim((string)($payload['action'] ?? ''));
    $readOnlyActions = ['health', 'bootstrap', 'vehicleHistory', 'holderHistory'];
    $maxAttempts = in_array($action, $readOnlyActions, true) ? 2 : 1;

    // فشل مبكر وواضح بدل رسالة «الحساب غير مصرح له» المضلِّلة من الطرف الآخر.
    if (array_key_exists('apiToken', $payload)
        && trim((string)$payload['apiToken']) === '') {
        throw new RuntimeException('رمز API غير مضبوط في config.php — لم يُرسل الطلب.');
    }

    $authRetryUsed = false;
    for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT => 60,
            CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Accept: application/json',
                'Cache-Control: no-cache',
            ],
            CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ]);
        $body = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $error = curl_error($curl);
        curl_close($curl);
        if ($body !== false && $error === '') {
            $decoded = json_decode($body, true);
            if (is_array($decoded)) {
                if ($status >= 400) {
                    throw new RuntimeException((string) ($decoded['error'] ?? 'فشل طلب البيانات'));
                }

                // إخفاق مصادقة عابر: مضمون أنه سبق أي كتابة، فإعادته لا تكرّر شيئًا.
                if (!$authRetryUsed
                    && empty($decoded['ok'])
                    && in_array((string)($decoded['code'] ?? ''), SALSAR_RETRYABLE_AUTH_CODES, true)) {
                    $authRetryUsed = true;
                    $maxAttempts = $attempt + 1;   // محاولة إضافية واحدة، لا أكثر
                    error_log('سلسار: إعادة محاولة بعد ' . (string)$decoded['code'] . ' للفعل ' . $action);
                    usleep(400000);
                    continue;
                }

                return $decoded;
            }
            $lastError = 'استجابة خدمة البيانات غير صالحة';
        } else {
            $lastError = 'تعذر الاتصال بخدمة البيانات';
        }
        if ($attempt < $maxAttempts) usleep(250000);
    }
    throw new RuntimeException($lastError);
}
