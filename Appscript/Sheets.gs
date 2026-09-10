/**
 * سلسار V2 — Sheets.gs        آخر تعديل 2026-09-10 (مع v2.5.1)
 * =========================================================================
 * طبقة الوصول للبيانات: كل قراءة وكتابة للشيت تمر من هنا.
 *
 * ما في هذا الملف:
 *  · readSheetRows_  — القراءة الخام. مصدر واحد يستعمله rows_ و refreshSheet_
 *  · cached_ / cachePut_ — كاش مجزّأ (حد CacheService 102,400 بايت للقيمة الواحدة)
 *  · refreshSheet_   — تحديث فوق الكاش بلا إبطال مسبق، فلا لحظة يكون فيها فارغًا
 *  · optionalRows_   — ورقة غير موجودة تُرجع [] بدل أن تُسقط bootstrap كله
 *  · invalidateSheet_— إبطال كل أجزاء الورقة عند أي كتابة
 *  · locked_ · update_ · append_ · nextId_ · timingSafeEqual_
 *
 * سجل التغيير:
 *  2.5.1  2026-09-10  readSheetRows_ · cachePut_ · refreshSheet_
 *  2.4    2026-09-10  optionalRows_
 *  2.1    2026-09-09  U-26 تجزئة الكاش · P2-13 صفوف الشبح · update_ بكتابة واحدة
 */

// ========================================
// وصول أساسي للشيت
// ========================================

function ss_() {
  return SpreadsheetApp.openById(SALSAR.SPREADSHEET_ID);
}

function sheet_(name) {
  const s = ss_().getSheetByName(name);
  if (!s) throw new Error('الورقة غير موجودة: ' + name);
  return s;
}

// ========================================
// نظام الكاش — مع تجزئة القيم الكبيرة (U-26)
// ========================================

// حد CacheService للقيمة الواحدة 102,400 بايت. الحروف العربية تأخذ بايتين في UTF-8
// (وبعض الرموز ثلاثة)، لذلك نجزّئ بـ30,000 حرف: أسوأ حالة ~90 كيلوبايت.
const SALSAR_CACHE_CHUNK_CHARS = 30000;

function cached_(key, ttl, fn) {
  const cache = CacheService.getScriptCache();

  // ---- قراءة ----
  try {
    const meta = cache.get(key + ':n');
    if (meta) {
      const count = Number(meta);
      if (count > 0) {
        const keys = [];
        for (let i = 0; i < count; i++) keys.push(key + ':' + i);
        const parts = cache.getAll(keys);
        let joined = '';
        let complete = true;
        for (let i = 0; i < count; i++) {
          const part = parts[key + ':' + i];
          if (part === undefined || part === null) { complete = false; break; }
          joined += part;
        }
        if (complete) return JSON.parse(joined);
      }
    }
  } catch (e) {
    // كاش تالف أو منتهٍ جزئيًا — نتجاهله ونقرأ من المصدر
  }

  const result = fn();
  cachePut_(key, ttl, result);
  return result;
}

/** كتابة قيمة في الكاش مع التجزئة — مصدر واحد يستعمله cached_ و refreshSheet_. */
function cachePut_(key, ttl, result) {
  try {
    const cache = CacheService.getScriptCache();
    const text = JSON.stringify(result);
    const count = Math.max(1, Math.ceil(text.length / SALSAR_CACHE_CHUNK_CHARS));
    const map = {};
    for (let i = 0; i < count; i++) {
      map[key + ':' + i] = text.substr(i * SALSAR_CACHE_CHUNK_CHARS, SALSAR_CACHE_CHUNK_CHARS);
    }
    map[key + ':n'] = String(count);
    cache.putAll(map, ttl);
  } catch (e) {
    console.warn('تعذّر حفظ الكاش لـ ' + key + ': ' + e.message);
  }
}

function invalidateSheet_(sheetName) {
  const cache = CacheService.getScriptCache();
  const key = 'sheet:' + sheetName;
  const keys = [key, key + ':n'];
  try {
    const meta = cache.get(key + ':n');
    const count = meta ? Number(meta) : 0;
    for (let i = 0; i < count; i++) keys.push(key + ':' + i);
  } catch (e) { /* تجاهل */ }
  // احتياط: امسح أول 12 جزءًا حتى لو ضاع مفتاح الفهرس
  for (let i = 0; i < 12; i++) {
    if (keys.indexOf(key + ':' + i) < 0) keys.push(key + ':' + i);
  }
  cache.removeAll(keys);
}

// ========================================
// قراءة الصفوف (مع كاش تلقائي)
// ========================================

/**
 * مثل rows_ لكن يُرجع [] إذا كانت الورقة غير موجودة بدل أن يرمي.
 * السبب: ورقة اختيارية مضافة لاحقًا يجب ألّا تُسقط bootstrap كله على كل المستخدمين
 * لمجرد أن أحدهم لم ينشئها بعد.
 */
function optionalRows_(name) {
  try {
    if (!ss_().getSheetByName(name)) return [];
  } catch (e) {
    return [];
  }
  return rows_(name);
}

/** القراءة الخام من الورقة بلا أي كاش — مصدر واحد يستعمله rows_ و refreshSheet_. */
function readSheetRows_(name) {
  const a = sheet_(name).getDataRange().getDisplayValues();
  if (!a.length) return [];
  const h = a.shift();
  return a.filter(function(r) {
    // P2-13: خلية فيها مسافات فقط ليست بيانات
    return r.some(function(v) { return String(v).trim() !== ''; });
  }).map(function(r) {
    const o = {};
    h.forEach(function(x, i) { if (x) o[x] = r[i]; });
    return o;
  });
}

function rows_(name) {
  return cached_('sheet:' + name, SALSAR.CACHE_TTL_SECONDS, function() {
    return readSheetRows_(name);
  });
}

/**
 * v2.5.1 — تحديث كاش ورقة **بلا إبطال مسبق**.
 *
 * النسخة الأولى من التسخين كانت تستدعي invalidateSheet_ ثم rows_، فتفتح نافذة
 * من ثوانٍ يكون فيها الكاش فارغًا تمامًا. أي طلب مستخدم يصادف تلك النافذة يدفع
 * ثمن إعادة البناء كاملًا. هنا نقرأ من الورقة أولًا ثم نكتب فوق الكاش، فلا توجد
 * لحظة واحدة يكون فيها فارغًا.
 */
function refreshSheet_(name) {
  const fresh = readSheetRows_(name);
  cachePut_('sheet:' + name, SALSAR.CACHE_TTL_SECONDS, fresh);
  return fresh;
}

function all_(name, header, value) {
  return rows_(name).filter(function(x) {
    return String(x[header]) === String(value);
  });
}

function one_(name, header, value) {
  return all_(name, header, value)[0] || null;
}

// ========================================
// الكتابة (تُبطل الكاش تلقائياً)
// ========================================

function append_(name, obj) {
  const s = sheet_(name);
  const h = s.getRange(1, 1, 1, s.getLastColumn()).getDisplayValues()[0];
  const stamped = stampCreated_(obj);
  s.appendRow(h.map(function(x) {
    return Object.prototype.hasOwnProperty.call(stamped, x) ? stamped[x] : '';
  }));
  invalidateSheet_(name);
}

function appendMany_(name, items) {
  if (!items || !items.length) return;
  const s = sheet_(name);
  const h = s.getRange(1, 1, 1, s.getLastColumn()).getDisplayValues()[0];
  const values = items.map(function(o) {
    const stamped = stampCreated_(o);
    return h.map(function(x) {
      return Object.prototype.hasOwnProperty.call(stamped, x) ? stamped[x] : '';
    });
  });
  s.getRange(s.getLastRow() + 1, 1, values.length, h.length).setValues(values);
  invalidateSheet_(name);
}

function update_(name, idHeader, id, changes) {
  const s = sheet_(name);
  const width = s.getLastColumn();
  const h = s.getRange(1, 1, 1, width).getDisplayValues()[0];
  const c = h.indexOf(idHeader);
  if (c < 0) throw new Error('العمود غير موجود: ' + idHeader);

  const lastRow = s.getLastRow();
  if (lastRow < 2) throw new Error('السجل غير موجود: ' + id);

  const finder = s.getRange(2, c + 1, lastRow - 1, 1)
    .createTextFinder(String(id))
    .matchEntireCell(true);
  const found = finder.findNext();
  if (!found) throw new Error('السجل غير موجود: ' + id);
  const r = found.getRow();

  const stamped = stampUpdated_(changes);

  // أداء: قراءة الصف مرة واحدة وكتابته مرة واحدة بدل خلية خلية
  const range = s.getRange(r, 1, 1, width);
  const values = range.getValues()[0];
  let touched = false;
  Object.keys(stamped).forEach(function(k) {
    const col = h.indexOf(k);
    if (col >= 0) { values[col] = stamped[k]; touched = true; }
  });
  if (touched) range.setValues([values]);

  invalidateSheet_(name);
}

function updateAll_(name, idHeader, id, changes) {
  const s = sheet_(name);
  const a = s.getDataRange().getValues();
  if (!a.length) throw new Error('السجل غير موجود: ' + id);
  const h = a[0].map(String);
  const c = h.indexOf(idHeader);
  if (c < 0) throw new Error('العمود غير موجود: ' + idHeader);

  const stamped = stampUpdated_(changes);
  let found = 0;
  for (let i = 1; i < a.length; i++) {
    if (String(a[i][c]) === String(id)) {
      found++;
      Object.keys(stamped).forEach(function(k) {
        const col = h.indexOf(k);
        if (col >= 0) a[i][col] = stamped[k];
      });
    }
  }
  if (!found) throw new Error('السجل غير موجود: ' + id);

  s.getRange(2, 1, a.length - 1, h.length).setValues(a.slice(1));
  invalidateSheet_(name);
}

// ========================================
// توليد المعرّفات
// ========================================

function nextId_(prefix, name, header) {
  const year = Utilities.formatDate(new Date(), SALSAR.TIME_ZONE, 'yyyy');
  const re = new RegExp('^' + prefix + '-' + year + '-(\\d+)$', 'i');
  let max = 0;
  rows_(name).forEach(function(x) {
    const m = String(x[header] || '').match(re);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + '-' + year + '-' + String(max + 1).padStart(4, '0');
}

function nextConfigurationId_() {
  return nextId_('CFG', SALSAR.SHEETS.configurations, 'ConfigurationID');
}

// ========================================
// الطوابع الزمنية التلقائية
// ========================================

function stampCreated_(obj) {
  const now = now_();
  const out = {};
  Object.keys(obj).forEach(function(k) { out[k] = obj[k]; });
  if (!out.CreatedAt) out.CreatedAt = now;
  if (!out.UpdatedAt) out.UpdatedAt = now;
  return out;
}

function stampUpdated_(changes) {
  const out = {};
  Object.keys(changes).forEach(function(k) { out[k] = changes[k]; });
  out.UpdatedAt = now_();
  return out;
}

// ========================================
// التدقيق (Audit Log)
// ========================================

/**
 * يسجّل عملية في سجل التدقيق.
 * actorEmail يأتي من جلسة PHP عبر api.php (WebApp.parse_ يحقنه في الحمولة).
 */
function audit_(op, type, id, details, actorEmail) {
  const email = String(actorEmail || '').trim()
    || Session.getActiveUser().getEmail()
    || 'مستخدم الويب';
  append_(SALSAR.SHEETS.audit, {
    AuditID: Utilities.getUuid(),
    'التاريخ والوقت': now_(),
    'ActorEmail': email,
    'العملية': op,
    'نوع السجل': type,
    'RecordID': id,
    'التفاصيل': details || ''
  });
}

// ========================================
// الأقفال (لمنع التزامن الخاطئ)
// ========================================

function locked_(fn) {
  const l = LockService.getScriptLock();
  if (!l.tryLock(20000)) {
    throw new Error('النظام مشغول بعملية أخرى الآن؛ أعد المحاولة بعد لحظات.');
  }
  try {
    return fn();
  } finally {
    l.releaseLock();
  }
}

// ========================================
// دوال مساعدة عامة
// ========================================

function required_(v, n) {
  if (v === undefined || v === null || v === '') {
    throw new Error('الحقل مطلوب: ' + n);
  }
  return v;
}

function ref_(v, p, n) {
  if (!p.test(String(v || ''))) {
    throw new Error(n + ' غير صحيح: ' + v);
  }
}

function date_() {
  return Utilities.formatDate(new Date(), SALSAR.TIME_ZONE, SALSAR.DATE_FORMAT);
}

function now_() {
  return Utilities.formatDate(new Date(), SALSAR.TIME_ZONE, SALSAR.DATETIME_FORMAT);
}

function safe_(n) {
  return String(n).replace(/[\\/:*?"<>|]/g, '-');
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

function splitPipe_(value) {
  return String(value || '').split('|')
    .map(function(x) { return x.trim(); })
    .filter(String);
}

function timingSafeEqual_(a, b) {
  const first = String(a);
  const second = String(b);
  if (first.length !== second.length) return false;
  let diff = 0;
  for (let i = 0; i < first.length; i++) {
    diff |= first.charCodeAt(i) ^ second.charCodeAt(i);
  }
  return diff === 0;
}
