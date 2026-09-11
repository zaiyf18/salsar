<?php
declare(strict_types=1);
/**
 * سلسار V2 — fleet-data.php
 * =========================================================================
 * طبقة التحويل بين bootstrap (Apps Script V2) وشكل window.FLEET_DATA
 * الذي تستهلكه app-template.html.
 *
 * تغييرات V2 الجوهرية عن النسخة القديمة:
 *  1) مفتاح files انقسم إلى certifiedRecords + operationImages.
 *  2) معرّفات الحائز تُقرأ من FromHolderID/ToHolderID/CurrentHolderID مباشرة،
 *     ولم يعد يُستنتج المعرّف من الاسم (أهش نقطة في النظام القديم).
 *  3) عمود «التاريخ (YYYY-MM-DD)» صار «التاريخ».
 *  4) «اللوحة» صارت PlateSnapshot، و«رابط المحضر» صار CertifiedFileID.
 *  5) نتائج المحاضر الملغاة تُستبعد من حساب الحالة الحالية (إصلاح خلل V1).
 *  6) ترجمات بنود التشييك تُقرأ من ورقة منفصلة إن أُرسلت، وإلا تتراجع للثابتة.
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
$config = salsar_config();
header('Content-Type: application/javascript; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

// ---------------------------------------------------------------- أدوات

/** أول قيمة غير فارغة من قائمة أسماء أعمدة محتملة. */
function pick_(array $row, array $keys, mixed $fallback = null): mixed {
    foreach ($keys as $key) {
        if (array_key_exists($key, $row) && $row[$key] !== '' && $row[$key] !== null) return $row[$key];
    }
    return $fallback;
}

/** يحوّل نصاً مفصولاً بـ | أو ، أو , إلى مصفوفة. */
function list_(mixed $value, array $fallback = []): array {
    if (is_array($value)) $items = $value;
    else $items = preg_split('/\s*[|،,]\s*/u', trim((string)$value)) ?: [];
    $items = array_values(array_filter(array_map(fn($x) => trim((string)$x), $items), fn($x) => $x !== ''));
    return $items ?: $fallback;
}

function index_(array $rows, string $key): array {
    $out = [];
    foreach ($rows as $row) {
        if (is_array($row) && trim((string)($row[$key] ?? '')) !== '') $out[trim((string)$row[$key])] = $row;
    }
    return $out;
}

/** V2 يخزّن «يتطلب إجراء» كـ نعم/لا. النسخة القديمة كانت true/false. ندعم الاثنين. */
function bool_(mixed $value): bool {
    $text = trim((string)$value);
    if ($text === 'نعم') return true;
    if ($text === 'لا')  return false;
    return filter_var($value, FILTER_VALIDATE_BOOLEAN);
}

/** ينتزع جزء التاريخ فقط من قيمة قد تكون «2026-09-05 14:30». */
function dateOnly_(mixed $value): string {
    $text = trim((string)$value);
    if ($text === '') return '';
    return explode(' ', $text)[0];
}

// ------------------------------------------- البيانات الثابتة الاحتياطية

// ---- كاش PHP محلي (5 دقائق) لتجنب استدعاء Apps Script في كل تحميل ----
// U-04: المدة نُزّلت من 300 إلى 60 ثانية، و api.php صار يحذف هذا الملف بعد كل كتابة.
// الطبقتان معًا: الكتابة تظهر فورًا، والقراءات المتتالية تبقى سريعة.
$cacheFile = SALSAR_PRIVATE_DIR . '/fleet-cache.json';
// v2.5: 60 → 600. api.php يحذف هذا الملف بعد كل كتابة، فالمهلة القصيرة
// لا تشتري طزاجة إضافية وتكلّف إعادة بناء كاملة كل دقيقة.
$cacheTtl  = 600;
if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < $cacheTtl) {
    $cached = file_get_contents($cacheFile);
    if ($cached !== false && $cached !== '') {
        echo $cached;
        exit;
    }
}

// P2-6: الملف الاحتياطي القديم قد لا يكون موجودًا. بدون is_file() يُصدر PHP تحذيرًا
// يُطبع داخل استجابة application/javascript فيكسر window.FLEET_DATA بالكامل.
$data = [];
$legacySource = SALSAR_PRIVATE_DIR . '/fleet-data.js';
if (is_file($legacySource)) {
    $source = (string)@file_get_contents($legacySource);
    if ($source !== '' && preg_match('/window\.FLEET_DATA\s*=\s*(\{.*\})\s*;?\s*$/su', $source, $match)) {
        $decoded = json_decode($match[1] ?? '{}', true);
        if (is_array($decoded)) $data = $decoded;
    }
}

// دالة لحفظ الناتج في الكاش وطباعته
function outputAndCache(string $cacheFile, string $output): void {
    $tmp = $cacheFile . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (file_put_contents($tmp, $output, LOCK_EX) !== false) {
        rename($tmp, $cacheFile);
    }
    echo $output;
}

try {
    $response = salsar_http_post_json((string)$config['apps_script_url'], [
        'action'   => 'bootstrap',
        'apiToken' => (string)$config['apps_script_token'],
    ]);
    if (empty($response['ok']) || !is_array($response['data'] ?? null)) {
        throw new RuntimeException((string)($response['error'] ?? 'تعذر قراءة البيانات'));
    }
    $live = $response['data'];

    // ============================================================ المركبات
    // V2: CurrentHolderID هو المصدر الوحيد لمعرّف الحائز. «ملاحظات» محذوف.
    $base = index_((array)($data['vehicles'] ?? []), 'id');
    $vehicles = [];
    foreach ((array)($live['vehicles'] ?? []) as $r) {
        if (!is_array($r)) continue;
        $id = trim((string)pick_($r, ['VehicleID']));
        if ($id === '') continue;
        $b = $base[$id] ?? ['id' => $id];
        $vehicles[] = array_merge($b, [
            'id'         => $id,
            'plateAr'    => (string)pick_($r, ['رقم اللوحة عربي', 'رقم اللوحة', 'اللوحة'], $b['plateAr'] ?? ''),
            'plateEn'    => (string)pick_($r, ['رقم اللوحة إنجليزي', 'رقم اللوحة انجليزي'], $b['plateEn'] ?? ''),
            'category'   => (string)pick_($r, ['الفئة'], $b['category'] ?? 'أخرى'),
            'model'      => pick_($r, ['الموديل', 'سنة الصنع'], $b['model'] ?? ''),
            'serial'     => (string)pick_($r, ['الرقم التسلسلي', 'رقم السيارة للحسابات'], $b['serial'] ?? ''),
            'vin'        => (string)pick_($r, ['رقم الهيكل', 'VIN'], $b['vin'] ?? ''),
            'status'     => (string)pick_($r, ['الحالة'], $b['status'] ?? 'في المستودع'),
            'holderId'   => (string)pick_($r, ['CurrentHolderID'], $b['holderId'] ?? ''),
            'holderName' => (string)pick_($r, ['العهدة الحالية'], $b['holderName'] ?? 'أمين المستودع'),
            'odometer'   => (float)pick_($r, ['قراءة العداد'], $b['odometer'] ?? 0),
            'notes'      => '', // محذوف من مخطط V2 — يبقى المفتاح حتى لا تنكسر الواجهة
        ]);
    }

    // ============================================================ السائقون
    // V2: CurrentVehicleID هو الفيصل الوحيد لارتباط السائق بمركبة. لا عمود «الحالة».
    $base = index_((array)($data['drivers'] ?? []), 'id');
    $drivers = [];
    foreach ((array)($live['drivers'] ?? []) as $r) {
        if (!is_array($r)) continue;
        $id = trim((string)pick_($r, ['DriverID']));
        if ($id === '') continue;
        $b = $base[$id] ?? ['id' => $id];
        $drivers[] = array_merge($b, [
            'id'        => $id,
            'name'      => (string)pick_($r, ['الاسم العربي'], $b['name'] ?? ''),
            'identity'  => (string)pick_($r, ['رقم الهوية'], $b['identity'] ?? ''),
            'phone'     => (string)pick_($r, ['الجوال', 'رقم الجوال'], $b['phone'] ?? 'غير مسجل'),
            'vehicleId' => (string)pick_($r, ['CurrentVehicleID'], $b['vehicleId'] ?? ''),
            'notes'     => '', // محذوف من مخطط V2
        ]);
    }

    // المستودع كحائز افتراضي لأي مركبة بلا حائز مسجّل
    foreach ($vehicles as &$v) {
        if (($v['holderId'] ?? '') === '' && ($v['status'] ?? '') === 'في المستودع') $v['holderId'] = 'WAREHOUSE';
    }
    unset($v);

    // ================================================= ترجمات بنود التشييك
    // V2 نقلها لورقة مستقلة. إن لم تُرسل في bootstrap نتراجع للترجمات الثابتة.
    $languageHeaders = [
        'en' => ['English', 'الإنجليزية', 'الانجليزية'],
        'ur' => ['Urdu', 'الأردية', 'الاردية'],
        'hi' => ['Hindi', 'الهندية'],
        'bn' => ['Bengali', 'البنغالية'],
        'ne' => ['Nepali', 'النيبالية'],
    ];
    $translationsByItem = [];
    foreach ((array)($live['checklistTranslations'] ?? []) as $r) {
        if (!is_array($r)) continue;
        $itemId = trim((string)pick_($r, ['CheckItemID']));
        if ($itemId === '') continue;

        // المخطط الجديد: كل صف = بند واحد + لغة واحدة
        // الأعمدة: TranslationID | CheckItemID | اللغة | الترجمة | ...
        $langCode = trim((string)pick_($r, ['اللغة', 'Language', 'lang'], ''));
        $langText = trim((string)pick_($r, ['الترجمة', 'Translation', 'text'], ''));
        if ($langCode !== '' && $langText !== '') {
            $translationsByItem[$itemId][$langCode] = $langText;
            continue;
        }

        // المخطط القديم (احتياطي): أعمدة متعددة في صف واحد
        foreach ($languageHeaders as $code => $headers) {
            $text = trim((string)pick_($r, $headers, ''));
            if ($text !== '') $translationsByItem[$itemId][$code] = $text;
        }
    }

    // ================================================= ترجمات الأصول (v2.4)
    // ورقة «ترجمات الأصول»: TranslationID | AssetTerm | النوع | اللغة | الترجمة
    // المفتاح هو المصطلح العربي نفسه، لأن الأصول بلا معرّفات في نموذج البيانات.
    // عمود «اللغة» يقبل الرمز (hi) أو الاسم العربي (الهندية): الاسم العربي في ورقة
    // التشييك يُنتج ترجمة فارغة بصمت، ولا نريد تكرار ذلك الفخ في ورقة جديدة.
    $languageAliases = [];
    foreach ($languageHeaders as $code => $names) {
        $languageAliases[$code] = $code;
        foreach ($names as $n) $languageAliases[mb_strtolower(trim($n))] = $code;
    }
    $assetTranslations = [];
    foreach ((array)($live['assetTranslations'] ?? []) as $r) {
        if (!is_array($r)) continue;
        $term = trim((string)pick_($r, ['AssetTerm', 'المصطلح', 'الأصل', 'Term']));
        $rawLang = mb_strtolower(trim((string)pick_($r, ['اللغة', 'Language', 'lang'], '')));
        $text = trim((string)pick_($r, ['الترجمة', 'Translation', 'text'], ''));
        if ($term === '' || $rawLang === '' || $text === '') continue;
        $code = $languageAliases[$rawLang] ?? '';
        if ($code === '') continue;               // لغة غير معروفة: تُتجاهل ولا تكسر شيئًا
        $assetTranslations[$term][$code] = $text;
    }
    $data['assetTranslations'] = $assetTranslations;

    // ======================================================= بنود التشييك
    $base = index_((array)($data['checklist'] ?? []), 'id');
    $checks = [];
    foreach ((array)($live['checklist'] ?? []) as $r) {
        if (!is_array($r)) continue;
        $id = trim((string)pick_($r, ['CheckItemID']));
        if ($id === '') continue;
        if (trim((string)pick_($r, ['الحالة'], 'نشط')) === 'موقوف') continue; // بند موقوف لا يُعرض
        $b = $base[$id] ?? ['id' => $id, 'categories' => [], 'options' => ['لا ملاحظات']];

        // أولوية الترجمة: الورقة المستقلة ← أعمدة داخل البند ← الثابتة
        $translations = (array)($b['translations'] ?? []);
        foreach ($languageHeaders as $code => $headers) {
            $inline = trim((string)pick_($r, $headers, ''));
            if ($inline !== '') $translations[$code] = $inline;
        }
        if (!empty($translationsByItem[$id])) $translations = array_merge($translations, $translationsByItem[$id]);

        $checks[] = array_merge($b, [
            'id'           => $id,
            'no'           => (int)pick_($r, ['الرقم', 'ترتيب العرض', 'م'], $b['no'] ?? 0),
            'item'         => (string)pick_($r, ['بند التشييك'], $b['item'] ?? $id),
            'categories'   => list_(pick_($r, ['ينطبق على الفئات'], ''), (array)($b['categories'] ?? [])),
            'options'      => list_(pick_($r, ['خيارات الملاحظة', 'خيارات الفحص'], ''), (array)($b['options'] ?? ['لا ملاحظات'])),
            'translations' => $translations,
        ]);
    }

    // ==================================================== وثائق المركبات
    $base = index_((array)($data['documents'] ?? []), 'vehicleId');
    $documents = [];
    foreach ((array)($live['documents'] ?? []) as $r) {
        if (!is_array($r)) continue;
        $id = trim((string)pick_($r, ['VehicleID']));
        if ($id === '') continue;
        $b = $base[$id] ?? ['vehicleId' => $id];
        $documents[] = array_merge($b, [
            'vehicleId'              => $id,
            'plate'                  => (string)pick_($r, ['رقم اللوحة', 'رقم اللوحة عربي'], $b['plate'] ?? ''),
            'registrationNo'         => (string)pick_($r, ['رقم استمارة رخصة السير'], $b['registrationNo'] ?? ''),
            'registrationExpiry'     => pick_($r, ['انتهاء استمارة رخصة السير'], $b['registrationExpiry'] ?? null),
            'insuranceNo'            => (string)pick_($r, ['رقم وثيقة التأمين'], $b['insuranceNo'] ?? ''),
            'insuranceExpiry'        => pick_($r, ['انتهاء وثيقة التأمين'], $b['insuranceExpiry'] ?? null),
            'inspectionExpiry'       => pick_($r, ['انتهاء الفحص الدوري'], $b['inspectionExpiry'] ?? null),
            'operationLicenseNo'     => (string)pick_($r, ['رقم رخصة التشغيل'], $b['operationLicenseNo'] ?? ''),
            'operationLicenseExpiry' => pick_($r, ['انتهاء رخصة التشغيل'], $b['operationLicenseExpiry'] ?? null),
            'updatedAt'              => pick_($r, ['UpdatedAt', 'تاريخ التحديث'], $b['updatedAt'] ?? null),
            'notes'                  => (string)pick_($r, ['ملاحظات'], $b['notes'] ?? ''),
        ]);
    }

    // ======================================= الملفات: مصادقة + صور عمليات
    // V2 قسّم ورقة files القديمة إلى ورقتين مستقلتين.
    $certifiedByFileId = [];
    $certifiedByRecord = [];
    foreach ((array)($live['certifiedRecords'] ?? []) as $r) {
        if (!is_array($r)) continue;
        if (trim((string)pick_($r, ['الحالة'], 'نشط')) !== 'نشط') continue;
        $url = trim((string)pick_($r, ['رابط Drive'], ''));
        if ($url === '') continue;
        $entry = [
            'name' => trim((string)pick_($r, ['اسم الملف'], '')) ?: 'محضر مصادق عليه.pdf',
            'url'  => $url,
        ];
        $fileId   = trim((string)pick_($r, ['FileID'], ''));
        $recordId = trim((string)pick_($r, ['RecordID'], ''));
        if ($fileId !== '')   $certifiedByFileId[$fileId] = $entry;
        if ($recordId !== '') $certifiedByRecord[$recordId] = $entry;
    }

    $imagesByRecord = [];
    foreach ((array)($live['operationImages'] ?? []) as $r) {
        if (!is_array($r)) continue;
        if (trim((string)pick_($r, ['الحالة'], '')) === 'محذوفة') continue;
        $recordId = trim((string)pick_($r, ['RecordID'], ''));
        $url      = trim((string)pick_($r, ['رابط Drive'], ''));
        $name     = trim((string)pick_($r, ['اسم الملف'], ''));
        if ($recordId === '' || $url === '' || $name === '') continue;
        $imageId = (string)pick_($r, ['ImageID'], '');
        $imagesByRecord[$recordId][] = [
            'fileId'     => $imageId, // اسم قديم تعتمد عليه الواجهة
            'imageId'    => $imageId, // الاسم الذي يتطلبه deleteOperationImage في V2
            'name'       => $name,
            'url'        => $url,
            'order'      => (int)pick_($r, ['الترتيب'], 0),
            'status'     => (string)pick_($r, ['الحالة'], 'صورة عملية'),
            'uploadedAt' => (string)pick_($r, ['UploadedAt'], ''),
        ];
    }
    foreach ($imagesByRecord as &$group) {
        usort($group, fn($a, $b) => ($a['order'] <=> $b['order']));
    }
    unset($group);

    /** يعثر على المحضر المصادق سواء عبر CertifiedFileID أو عبر RecordID. */
    $certifiedFor = function (string $recordId, string $certifiedFileId) use ($certifiedByFileId, $certifiedByRecord): array {
        if ($certifiedFileId !== '' && isset($certifiedByFileId[$certifiedFileId])) return $certifiedByFileId[$certifiedFileId];
        return $certifiedByRecord[$recordId] ?? ['name' => '', 'url' => ''];
    };

    // ====================================================== محاضر العهدة
    $checkById = [];
    foreach ($checks as $c) $checkById[$c['id']] = $c;

    // المحاضر الملغاة: نتائجها يجب ألا تؤثر على الحالة الحالية (إصلاح خلل V1)
    $cancelledHandovers = [];
    foreach ((array)($live['handovers'] ?? []) as $r) {
        if (!is_array($r)) continue;
        if (trim((string)pick_($r, ['الحالة'], '')) === 'ملغى') {
            $cancelledHandovers[trim((string)pick_($r, ['HandoverID'], ''))] = true;
        }
    }

    // خط الأساس: كل مركبة تبدأ بـ«لا ملاحظات» في كل بند ينطبق على فئتها
    $latestState = [];
    foreach ($vehicles as $vehicle) {
        $vid = (string)($vehicle['id'] ?? '');
        $category = (string)($vehicle['category'] ?? 'أخرى');
        if ($vid === '') continue;
        foreach ($checks as $check) {
            if (in_array($category, (array)($check['categories'] ?? []), true)) {
                $latestState[$vid][(string)$check['id']] = 'لا ملاحظات';
            }
        }
    }

    $resultsByHandover = [];
    foreach ((array)($live['results'] ?? []) as $r) {
        if (!is_array($r)) continue;
        $hid = trim((string)pick_($r, ['HandoverID'], ''));
        $cid = trim((string)pick_($r, ['CheckItemID'], ''));
        if ($hid === '' || $cid === '') continue;
        $entry = [
            'id'             => $cid,
            'item'           => $checkById[$cid]['item'] ?? $cid,
            'previous'       => (string)pick_($r, ['الحالة السابقة'], ''),
            'current'        => (string)pick_($r, ['الحالة الحالية'], 'لا ملاحظات'),
            'note'           => (string)pick_($r, ['الملاحظة'], ''),
            'requiresAction' => bool_(pick_($r, ['يتطلب إجراء'], false)),
        ];
        $resultsByHandover[$hid][] = $entry;

        if (isset($cancelledHandovers[$hid])) continue; // ← لا يؤثر على الحالة الحالية
        $vid = trim((string)pick_($r, ['VehicleID'], ''));
        if ($vid !== '') $latestState[$vid][$cid] = $entry['current'];
    }

    $handovers = [];
    foreach ((array)($live['handovers'] ?? []) as $r) {
        if (!is_array($r)) continue;
        $id = trim((string)pick_($r, ['HandoverID'], ''));
        if ($id === '' || isset($cancelledHandovers[$id])) continue;

        $snapshot = $resultsByHandover[$id] ?? [];
        $changes = array_values(array_filter(
            $snapshot,
            fn($x) => trim((string)($x['previous'] ?? '')) !== '' && (string)($x['previous'] ?? '') !== (string)($x['current'] ?? '')
        ));
        $certified = $certifiedFor($id, (string)pick_($r, ['CertifiedFileID'], ''));

        $handovers[] = [
            'id'                => $id,
            'date'              => dateOnly_(pick_($r, ['التاريخ'], '')),
            'vehicleId'         => (string)pick_($r, ['VehicleID'], ''),
            'vehiclePlate'      => (string)pick_($r, ['PlateSnapshot'], ''),
            'vehicleCategory'   => (string)pick_($r, ['CategorySnapshot'], ''),
            'fromHolderId'      => (string)pick_($r, ['FromHolderID'], ''),
            'fromHolderName'    => (string)pick_($r, ['المسلّم'], ''),
            'fromIdentity'      => (string)pick_($r, ['هوية المسلّم'], ''),
            'toHolderId'        => (string)pick_($r, ['ToHolderID'], ''),
            'toHolderName'      => (string)pick_($r, ['المستلم'], ''),
            'toIdentity'        => (string)pick_($r, ['هوية المستلم'], ''),
            'odometer'          => (float)pick_($r, ['قراءة العداد'], 0),
            'status'            => (string)pick_($r, ['الحالة'], 'بانتظار التصديق'),
            'notes'             => (string)pick_($r, ['ملاحظات'], ''),
            // U-03: لقطة بنود التشييك ورمز التحقق المحفوظان وقت الإنشاء.
            // الطباعة تعتمد عليهما بدل الفئة الحالية للمركبة، فلا تتغير إعادة
            // الطباعة بعد تغيير طراز المركبة.
            'checklistIds'      => list_(pick_($r, ['ChecklistSnapshot'], ''), []),
            'verification'      => (string)pick_($r, ['VerificationHash'], ''),
            'prevOdometer'      => (string)pick_($r, ['PrevOdometer'], ''),
            'certifiedUrl'      => $certified['url'],
            'certifiedFileName' => $certified['name'] ?: ($certified['url'] !== '' ? 'محضر مصادق عليه.pdf' : ''),
            'checklistSnapshot' => $snapshot,
            'changes'           => $changes,
            'images'            => $imagesByRecord[$id] ?? [],
        ];
    }

    // ======================================================== نقل الأصول
    $transferGroups = [];
    foreach ((array)($live['transfers'] ?? []) as $r) {
        if (!is_array($r)) continue;
        $id = trim((string)pick_($r, ['TransferID'], ''));
        if ($id === '') continue;

        if (!isset($transferGroups[$id])) {
            $certified = $certifiedFor($id, (string)pick_($r, ['CertifiedFileID'], ''));
            $transferGroups[$id] = [
                'id'                => $id,
                'date'              => dateOnly_(pick_($r, ['التاريخ'], '')),
                'type'              => '',
                'sourceVehicleId'   => (string)pick_($r, ['FromVehicleID'], ''),
                'sourcePlate'       => (string)pick_($r, ['من اللوحة'], ''),
                'targetVehicleId'   => (string)pick_($r, ['ToVehicleID'], ''),
                'targetPlate'       => (string)pick_($r, ['إلى اللوحة'], ''),
                'giverDriverId'     => (string)pick_($r, ['FromHolderID'], ''),
                'giverName'         => (string)pick_($r, ['المسلّم'], ''),
                'receiverDriverId'  => (string)pick_($r, ['ToHolderID'], ''),
                'receiverName'      => (string)pick_($r, ['المستلم'], ''),
                'condition'         => '',
                'status'            => (string)pick_($r, ['الحالة'], 'بانتظار التصديق'),
                'notes'             => (string)pick_($r, ['سبب النقل وملاحظات'], ''),
                'certifiedUrl'      => $certified['url'],
                'certifiedFileName' => $certified['name'] ?: ($certified['url'] !== '' ? 'محضر مصادق عليه.pdf' : ''),
                'assets'            => [],
                'images'            => $imagesByRecord[$id] ?? [],
            ];
        }
        $transferGroups[$id]['assets'][] = [
            'type'      => (string)pick_($r, ['نوع الأصل'], ''),
            'condition' => (string)pick_($r, ['حالة الأصل'], 'جيد'),
        ];
    }
    $transfers = array_values($transferGroups);
    foreach ($transfers as &$transfer) {
        $transfer['type']      = $transfer['assets'][0]['type'] ?? '';
        $transfer['condition'] = $transfer['assets'][0]['condition'] ?? '';
    }
    unset($transfer);

    // ================================================ سجل تجهيزات المركبة
    $configurations = [];
    foreach ((array)($live['configurations'] ?? []) as $r) {
        if (!is_array($r)) continue;
        $id        = trim((string)pick_($r, ['ConfigurationID'], ''));
        $vehicleId = trim((string)pick_($r, ['VehicleID'], ''));
        if ($id === '' || $vehicleId === '') continue;
        $configurations[] = [
            'id'           => $id,
            'vehicleId'    => $vehicleId,
            'category'     => (string)pick_($r, ['الفئة'], ''),
            'start'        => dateOnly_(pick_($r, ['تاريخ البداية'], '')),
            'end'          => dateOnly_(pick_($r, ['تاريخ النهاية'], '')),
            'status'       => (string)pick_($r, ['الحالة'], ''),
            'reason'       => (string)pick_($r, ['سبب التحويل'], ''),
            'added'        => (string)pick_($r, ['التجهيزات المضافة'], ''),
            'removed'      => (string)pick_($r, ['التجهيزات المنزوعة'], ''),
            'handoverId'   => (string)pick_($r, ['HandoverID'], ''),
            'receiptNo'    => (string)pick_($r, ['HandoverID'], ''), // اسم قديم تعتمد عليه الواجهة
            'documentsUrl' => (string)pick_($r, ['رابط المستندات'], ''),
            'notes'        => (string)pick_($r, ['ملاحظات'], ''),
        ];
    }

    // ================================================================ الإخراج
    $data['generatedAt']    = (string)($response['timestamp'] ?? gmdate('c'));
    $data['vehicles']       = $vehicles ?: ($data['vehicles'] ?? []);
    $data['drivers']        = $drivers ?: ($data['drivers'] ?? []);
    $data['checklist']      = $checks ?: ($data['checklist'] ?? []);
    $data['documents']      = $documents ?: ($data['documents'] ?? []);
    $data['handovers']      = $handovers;
    $data['assetTransfers'] = $transfers;
    $data['assets']         = [];
    $data['configurations'] = $configurations;
    $data['checklistState'] = $latestState;
    $data['liveSource']     = true;
    $data['schemaVersion']  = '2.0.0';

    $out = 'window.FLEET_DATA=' . json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ';window.SALSAR_LIVE=true;';
    outputAndCache($cacheFile, $out);

} catch (Throwable $e) {
    $safe = [
        'generatedAt' => gmdate('c'), 'vehicles' => [], 'drivers' => [], 'checklist' => [],
        'documents' => [], 'handovers' => [], 'assetTransfers' => [], 'assets' => [],
        'configurations' => [], 'checklistState' => [], 'liveSource' => false, 'schemaVersion' => '2.0.0',
    ];
    echo 'window.FLEET_DATA=' . json_encode($safe, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
       . ';window.SALSAR_LIVE=false;window.SALSAR_DATA_ERROR='
       . json_encode($e->getMessage(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ';';
}
