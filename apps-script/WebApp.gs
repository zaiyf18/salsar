/**
 * سلسار V2 — WebApp.gs        الإصدار 2.5.1 — آخر تعديل 2026-09-10
 * =========================================================================
 * نقطة الدخول: يستقبل طلبات GET/POST من الوسيط على الاستضافة، يتحقق من المصادقة، ويوجّه.
 *
 * ما في هذا الملف:
 *  · SALSAR_BOOTSTRAP_SHEETS — مصدر واحد لأوراق bootstrap يستعمله التوجيه والتسخين
 *  · salsarWarmCache + salsarInstallWarmTrigger — تسخين الكاش كل 15 دقيقة
 *  · authorize_ — أربعة رموز أخطاء مميّزة + كاش الرمز + ثلاث محاولات قراءة
 *  · parse_ — يحقن actorEmail من جلسة PHP ويحذف ما يرسله المتصفح (U-11)
 *  · دوال محرر: salsarVersion · testConnection · testCachePerformance · testBootstrap
 *
 * سجل التغيير:
 *  2.5.1  2026-09-10  حذف «الإعدادات» من bootstrap · التسخين بلا إبطال مسبق
 *  2.5.0  2026-09-10  تسخين الكاش · حذف مشغّل doGet الزمني · TTL من 60 إلى 1800
 *  2.4.0  2026-09-10  ورقة «ترجمات الأصول» في bootstrap عبر optionalRows_
 *  2.3.3  2026-09-09  فصل رموز أخطاء المصادقة + إعادة محاولة آمنة من PHP
 *  2.3.0  2026-09-09  توجيه updateVehicleDocuments
 */

/** إصدار هذا الملف — يظهر في health وفي salsarVersion(). */
const SALSAR_WEBAPP_VERSION = '2.5.1';

/**
 * الأوراق التي تُرسَل في bootstrap — مصدر واحد يستعمله التوجيه ودالة التسخين معًا.
 * وجود قائمتين منفصلتين كان سيسمح بأن نُسخّن ورقة ونقرأ أخرى، فيبقى البطء بلا تفسير.
 */
const SALSAR_BOOTSTRAP_SHEETS = Object.freeze({
  vehicles:              { sheet: 'vehicles' },
  drivers:               { sheet: 'drivers' },
  checklist:             { sheet: 'checklist' },
  checklistTranslations: { sheet: 'checklistTranslations' },
  assetTranslations:     { sheet: 'assetTranslations', optional: true },
  documents:             { sheet: 'documents' },
  // «الإعدادات» حُذفت من bootstrap في v2.5.1: تُجلب ولا يقرؤها PHP ولا الواجهة
  handovers:             { sheet: 'handovers' },
  results:               { sheet: 'results' },
  transfers:             { sheet: 'transfers' },
  certifiedRecords:      { sheet: 'certifiedRecords' },
  operationImages:       { sheet: 'operationImages' },
  configurations:        { sheet: 'configurations' }
});

/**
 * شغّلها من المحرر للتأكد أن اللصق تمّ فعلًا.
 * إن طبعت 2.5.1 فالكود الجديد في المشروع.
 * (ما زال يلزم النشر: Deploy ← Manage deployments ← ✏️ ← New version.)
 */
function salsarVersion() {
  console.log('نسخة WebApp.gs في المشروع: ' + SALSAR_WEBAPP_VERSION);
  return SALSAR_WEBAPP_VERSION;
}

// =====================================================================
// v2.5 — تسخين الكاش
// ---------------------------------------------------------------------
// قياس فعلي: bootstrap يكلّف 10.4 ثانية بلا كاش و1.5 ثانية معه (7× أسرع).
// هذه الدالة تدفع تكلفة البناء البارد نيابةً عن المستخدم قبل أن يصل،
// فلا يرى إلا المسار الساخن. تُشغَّل بمشغّل زمني كل 15 دقيقة.
// =====================================================================
function salsarWarmCache() {
  const started = Date.now();
  const failed = [];
  let ok = 0;

  Object.keys(SALSAR_BOOTSTRAP_SHEETS).forEach(function (key) {
    const spec = SALSAR_BOOTSTRAP_SHEETS[key];
    const name = SALSAR.SHEETS[spec.sheet];
    try {
      // v2.5.1: تحديث فوق الكاش بلا إبطال مسبق — لا لحظة يكون فيها فارغًا
      if (spec.optional && !ss_().getSheetByName(name)) { ok++; return; }
      refreshSheet_(name);
      ok++;
    } catch (err) {
      failed.push(name + ': ' + err.message);
    }
  });

  const ms = Date.now() - started;
  const summary = { sheets: ok, ms: ms, failed: failed };
  console.log('تسخين الكاش: ' + ok + ' ورقة في ' + ms + ' مللي ثانية'
    + (failed.length ? ' | فشل: ' + failed.join(' · ') : ''));
  return summary;
}

/**
 * يثبّت مشغّل التسخين كل 15 دقيقة، ويحذف أي مشغّل زمني على doGet.
 *
 * لماذا يُحذف doGet: هو بوابة دخول تطبيق الويب، ولا معنى لتشغيله بمؤقّت.
 * كان يعمل كل 5 دقائق (288 تنفيذًا يوميًا) ويُرجع health ولا يُسخّن شيئًا،
 * أي استهلاك حصة بلا مقابل. حذفه لا يمسّ عمل تطبيق الويب إطلاقًا —
 * النشر يخدم doGet سواء وُجد مشغّل أم لا.
 */
function salsarInstallWarmTrigger() {
  const removed = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'salsarWarmCache' || fn === 'doGet' || fn === 'doPost') {
      ScriptApp.deleteTrigger(t);
      removed.push(fn);
    }
  });

  ScriptApp.newTrigger('salsarWarmCache').timeBased().everyMinutes(15).create();

  console.log('✓ ثُبّت مشغّل تسخين الكاش كل 15 دقيقة'
    + (removed.length ? ' | حُذفت مشغّلات: ' + removed.join('، ') : ''));
  console.log('تشغيل أول للتسخين الآن...');
  return salsarWarmCache();
}

function doGet(e) {
  return route_('GET', e);
}

function doPost(e) {
  return route_('POST', e);
}

function route_(method, e) {
  try {
    const r = parse_(method, e);
    authorize_(r);
    const action = r.action || 'health';
    return json_({
      ok: true,
      action: action,
      data: dispatch_(action, r),
      timestamp: now_()
    });
  } catch (err) {
    console.error(err.stack || err);
    return json_({
      ok: false,
      error: String(err.message || err),
      code: String(err.salsarCode || ''),
      timestamp: now_()
    });
  }
}

function parse_(method, e) {
  const r = Object.assign({}, (e && e.parameter) || {});
  if (method === 'POST' && e && e.postData && e.postData.contents
      && String(e.postData.type || '').toLowerCase().indexOf('application/json') >= 0) {
    Object.assign(r, JSON.parse(e.postData.contents));
  }
  if (typeof r.payload === 'string') {
    r.payload = JSON.parse(r.payload);
  }

  // ---- U-11: توحيد هوية الفاعل من مصدر موثوق واحد ----
  // actorEmail في المستوى الأعلى يأتي مع apiToken من api.php (جلسة PHP متحقق منها).
  // أي قيمة داخل payload مصدرها المتصفح مباشرة — تُحذف.
  const trustedActor = String(r.actorEmail || '').trim();
  if (!r.payload || typeof r.payload !== 'object' || Array.isArray(r.payload)) {
    r.payload = (r.payload && typeof r.payload === 'object') ? r.payload : {};
  }
  delete r.payload.actorEmail;
  if (trustedActor) {
    r.payload.actorEmail = trustedActor;
  }

  return r;
}

/**
 * خطأ مصادقة يحمل رمزًا ثابتًا يستطيع api.php التصرف بناءً عليه.
 * كل هذه الأخطاء تُرمى **قبل** dispatch_ — أي قبل أي كتابة على الإطلاق.
 */
function salsarAuthError_(message, code) {
  const err = new Error(message);
  err.salsarCode = code;
  return err;
}

/**
 * v2.3.2 — يقرأ SALSAR_API_TOKEN من إعدادات السكربت بثلاث محاولات.
 * السبب: PropertiesService خدمة شبكية، وقد تفشل أو تُرجع فراغًا لحظيًا تحت
 * التنفيذ المتوازي (رفع الصور يعمل بعاملَين متوازيين). النسخة السابقة كانت
 * تعامل الفراغ اللحظي كأنه «رمز غير مضبوط» وتنزلق بصمت لمسار البريد.
 */
function readApiTokenFromProperties_() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const token = String(PropertiesService.getScriptProperties()
        .getProperty('SALSAR_API_TOKEN') || '').trim();
      if (token) return token;
    } catch (err) {
      lastErr = err;
      console.error('AUTH: فشل قراءة SALSAR_API_TOKEN (محاولة ' + attempt + '): ' + err);
    }
    if (attempt < 3) Utilities.sleep(200 * attempt);
  }
  if (lastErr) console.error('AUTH: فشلت كل محاولات قراءة SALSAR_API_TOKEN.');
  return '';
}

/** يقرأ الرمز من الكاش أولًا؛ forceRefresh يتجاوز الكاش (لحالة تدوير الرمز). */
function expectedApiToken_(forceRefresh) {
  const KEY = 'SALSAR_API_TOKEN_V1';
  let cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }

  if (cache && !forceRefresh) {
    try {
      const cached = cache.get(KEY);
      if (cached) return cached;
    } catch (e) { /* الكاش مساعد فقط — فشله لا يوقف التحقق */ }
  }

  const token = readApiTokenFromProperties_();
  if (cache && token) {
    try { cache.put(KEY, token, 300); } catch (e) { /* تجاهل */ }
  }
  return token;
}

function authorize_(request) {
  const suppliedToken = String((request && request.apiToken) || '').trim();

  // ---- المسار الطبيعي: طلب قادم من الوسيط على الاستضافة يحمل رمز API ----
  if (suppliedToken) {
    const cached = expectedApiToken_(false);
    if (cached && timingSafeEqual_(suppliedToken, cached)) return;

    // عدم التطابق قد يعني أن الرمز دُوّر للتو والكاش ما زال يحمل القديم.
    // أعد القراءة من المصدر قبل الرفض، حتى يسري التدوير فورًا.
    const fresh = expectedApiToken_(true);
    if (fresh && timingSafeEqual_(suppliedToken, fresh)) return;

    if (!fresh) {
      throw salsarAuthError_(
        'تعذّر قراءة رمز API من إعدادات السكربت — لم تُنفَّذ العملية ولم يُكتب شيء.',
        'AUTH_TOKEN_UNREADABLE');
    }
    console.error('AUTH: رمز API المرسل لا يطابق المخزّن.');
    throw salsarAuthError_(
      'رمز API غير مطابق — راجع SALSAR_API_TOKEN في إعدادات السكربت وconfig.php.',
      'AUTH_TOKEN_MISMATCH');
  }

  // ---- بلا رمز: إمّا تنفيذ مباشر من محرر Apps Script، أو ضاع الرمز في الطريق ----
  const allowedEmail = String(getAuthorizedEmail_() || '').trim().toLowerCase();
  const activeEmail  = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();

  if (!allowedEmail) {
    throw salsarAuthError_('لم يتم تحديد حساب سلسار المصرح له', 'AUTH_NO_ALLOWLIST');
  }
  if (activeEmail && activeEmail === allowedEmail) return;

  if (!activeEmail) {
    // النشر ANYONE_ANONYMOUS: البريد فارغ دائمًا هنا. المشكلة الحقيقية أن الرمز
    // لم يصل — لا أن الحساب ممنوع. الرسالة القديمة كانت تُضلّل التشخيص.
    console.error('AUTH: وصل الطلب بلا رمز API وبلا هوية مستخدم — الرمز فُقد في النقل.');
    throw salsarAuthError_(
      'لم يصل رمز API مع الطلب — لم تُنفَّذ العملية ولم يُكتب شيء. أعد المحاولة.',
      'AUTH_TOKEN_MISSING');
  }
  throw salsarAuthError_('هذا الحساب غير مصرح له باستخدام سلسار', 'AUTH_ACCOUNT');
}

function dispatch_(action, r) {
  // ---- فحص صحة النظام ----
  if (action === 'health') {
    return {
      service: 'سلسار | SalSar V2',
      database: ss_().getName(),
      status: 'ready',
      cacheEnabled: true,
      actor: String((r && r.payload && r.payload.actorEmail) || ''),
      version: SALSAR_WEBAPP_VERSION
    };
  }

  // ---- تحميل البيانات الكاملة ----
  if (action === 'bootstrap') {
    const out = {};
    Object.keys(SALSAR_BOOTSTRAP_SHEETS).forEach(function (key) {
      const spec = SALSAR_BOOTSTRAP_SHEETS[key];
      const name = SALSAR.SHEETS[spec.sheet];
      out[key] = spec.optional ? optionalRows_(name) : rows_(name);
    });
    return out;
  }

  // ---- إبطال الكاش يدوياً (للطوارئ أو الاختبار) ----
  if (action === 'flushCache') {
    Object.values(SALSAR.SHEETS).forEach(function(name) {
      invalidateSheet_(name);
    });
    return { flushed: true, timestamp: now_() };
  }

  // ---- أفعال المركبات والعهد ----
  if (action === 'vehicleHistory') {
    return handleVehicleHistory_(r);
  }
  if (action === 'holderHistory') {
    return handleHolderHistory_(r);
  }
  if (action === 'createHandover') {
    return handleCreateHandover_(r);
  }
  if (action === 'cancelHandover') {
    return handleCancelHandover_(r);
  }
  if (action === 'changeVehicleConfiguration') {
    return handleChangeVehicleConfiguration_(r);
  }

  // ---- نقل الأصول والملفات ----
  if (action === 'createAssetTransfer') {
    return handleCreateAssetTransfer_(r);
  }
  if (action === 'uploadOperationImage') {
    return handleUploadOperationImage_(r);
  }
  if (action === 'deleteOperationImage') {
    return handleDeleteOperationImage_(r);
  }
  if (action === 'uploadCertifiedRecord') {
    return handleUploadCertifiedRecord_(r);
  }

  // ---- وثائق المركبات (v2.3) ----
  if (action === 'updateVehicleDocuments') {
    return handleUpdateVehicleDocuments_(r);
  }

  throw new Error('عملية غير مدعومة: ' + action);
}

// =====================================================
// دوال اختبار (تُشغَّل من محرر Apps Script للتحقق)
// =====================================================

function testConnection() {
  console.log('اختبار الاتصال بالشيت...');
  const result = {
    service: 'سلسار | SalSar V2',
    database: ss_().getName(),
    sheetsFound: {},
    status: 'ready'
  };
  Object.keys(SALSAR.SHEETS).forEach(function(key) {
    const name = SALSAR.SHEETS[key];
    try {
      const count = Math.max(0, sheet_(name).getLastRow() - 1);
      result.sheetsFound[name] = count + ' صف';
    } catch (e) {
      result.sheetsFound[name] = 'خطأ: ' + e.message;
    }
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * يتحقق من وجود الأعمدة الجديدة المطلوبة بعد ترقية 2026-09-09.
 * شغّلها بعد إضافة الأعمدة يدويًا للتأكد من الأسماء والتهجئة.
 */
function testRequiredColumns() {
  const required = {};
  required[SALSAR.SHEETS.handovers] =
    ['ChecklistSnapshot', 'VerificationHash', 'PrevOdometer'];

  const report = {};
  let allOk = true;
  Object.keys(required).forEach(function (sheetName) {
    const s = sheet_(sheetName);
    const headers = s.getRange(1, 1, 1, s.getLastColumn()).getDisplayValues()[0];
    const missing = required[sheetName].filter(function (c) {
      return headers.indexOf(c) < 0;
    });
    report[sheetName] = missing.length
      ? ('❌ أعمدة ناقصة: ' + missing.join('، '))
      : '✓ كل الأعمدة المطلوبة موجودة';
    if (missing.length) allOk = false;
  });

  console.log(JSON.stringify(report, null, 2));
  if (!allOk) {
    console.error('أضف الأعمدة الناقصة في صف العناوين قبل استخدام النسخة الجديدة.');
  }
  return { ok: allOk, report: report };
}

function testApiTokenAuthorization() {
  const token = PropertiesService.getScriptProperties()
    .getProperty('SALSAR_API_TOKEN');
  if (!token) {
    console.error('❌ لم يتم إعداد SALSAR_API_TOKEN بعد.');
    console.error('اذهب لـ: Project Settings → Script Properties → Add script property');
    return { ok: false };
  }
  authorize_({ apiToken: token });
  console.log('✓ رمز API يعمل بشكل صحيح');
  return { ok: true };
}

function testBootstrap() {
  const data = dispatch_('bootstrap', { payload: {} });
  const summary = {};
  Object.keys(data).forEach(function(k) {
    summary[k] = data[k].length + ' سجل';
  });
  console.log('نتيجة bootstrap:');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function testCachePerformance() {
  Object.values(SALSAR.SHEETS).forEach(function(name) {
    invalidateSheet_(name);
  });

  const t1 = Date.now();
  dispatch_('bootstrap', { payload: {} });
  const withoutCache = Date.now() - t1;

  const t2 = Date.now();
  dispatch_('bootstrap', { payload: {} });
  const withCache = Date.now() - t2;

  const result = {
    withoutCache: withoutCache + ' ms',
    withCache: withCache + ' ms',
    speedup: Math.round((withoutCache / Math.max(withCache, 1)) * 10) / 10 + 'x أسرع'
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
