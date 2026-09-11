/**
 * سلسار V2 — Handovers.gs   [نسخة مُصلَحة — 2026-09-09]
 * =====================================
 * منطق محاضر العهدة: الإنشاء، الإلغاء مع الإرجاع، تاريخ الحائز، والتحقق من نتائج التشييك.
 *
 * نموذج العهدة المعتمد: العهدة تنتقل لحظة إنشاء المحضر (كما كان)،
 * لكن الإلغاء صار يعمل فعليًا ويُرجع الحالة كاملة إلى ما قبل المحضر.
 *
 * قاعدة الإلغاء الجديدة: يُلغى **أحدث** محضر غير ملغى فقط، ومعه إرجاع كامل.
 * (القاعدة القديمة كانت معكوسة: تمنع إلغاء الأحدث وتسمح بإلغاء الأقدم،
 *  وهو ما يكسر سلسلة العهدة ولا يصحّح شيئًا.)
 *
 * الإصلاحات في هذه النسخة:
 *  U-02  FromHolderID لم يعد يُقرأ من المتصفح — يُشتق من المركبة داخل القفل.
 *  U-07  التحقق الكامل صار قبل أي كتابة (كان append_ يسبق validateResults_).
 *  U-08  تحقق صارم من الحائز: WAREHOUSE أو DriverID موجود بنمط صحيح. أُزيل باب nameOverride.
 *  U-09  أرقام الهوية تُشتق من سجل السائق حصرًا ولا تُقبل من العميل.
 *  U-10  currentStatus يُتحقق من خيارات البند، وpreviousStatus يُشتق من الخادم.
 *  U-14  فحص clientRequestId انتقل إلى داخل القفل.
 *  U-21  تحقق خادمي من قراءة العداد (يقبل صفرًا صراحةً).
 *  U-22  CurrentVehicleID صار قائمة تُعاد حسابها من ورقة المركبات (ذاتية التصحيح).
 *  U-23  setProperty ملفوف بـtry/catch حتى لا يُفشل عملية ناجحة.
 *  U-03  لقطة بنود التشييك + رمز تحقق SHA-256 يُحسبان ويُخزَّنان على الخادم.
 *  P3-3  ترتيب المحاضر صار رقميًا لا نصيًا (لا ينكسر بعد 9,999 محضرًا).
 *  جديد  منع التسليم من الحائز إلى نفسه على الخادم.
 *
 * أعمدة جديدة مطلوبة في ورقة «محاضر العهدة»:
 *   ChecklistSnapshot | VerificationHash | PrevOdometer
 */

// ========================================
// أدوات ترتيب ولقطات
// ========================================

/** رقم تسلسلي قابل للمقارنة من H-2026-0007 → 202600007 (يصلح لأي عدد خانات). */
function handoverSeq_(id) {
  const m = String(id || '').match(/^H-(\d{4})-(\d+)$/i);
  if (!m) return -1;
  return Number(m[1]) * 1000000 + Number(m[2]);
}

function byHandoverSeq_(a, b) {
  return handoverSeq_(a.HandoverID) - handoverSeq_(b.HandoverID);
}

/** بنود التشييك النشطة المنطبقة على فئة معيّنة، مرتّبة كما تُعرض. */
function checklistForCategory_(category) {
  const cat = String(category || '');
  return rows_(SALSAR.SHEETS.checklist)
    .filter(function (item) {
      if (item['الحالة'] && item['الحالة'] !== 'نشط') return false;
      if (cat === 'أخرى') return true;
      const applicable = splitPipe_(item['ينطبق على الفئات']);
      return !applicable.length || applicable.indexOf(cat) >= 0;
    })
    .sort(function (a, b) {
      const na = Number(a['الرقم'] || 0), nb = Number(b['الرقم'] || 0);
      if (na !== nb) return na - nb;
      return String(a.CheckItemID).localeCompare(String(b.CheckItemID));
    });
}

/**
 * خيارات بند التشييك المسموحة (يدعم اسمَي العمود القديم والجديد).
 * يفصل على | أو ، أو , — نفس منطق list_() في fleet-data.php، حتى لا تُرفض
 * قيمة عرضتها الواجهة أصلًا على المستخدم.
 */
function checkItemOptions_(item) {
  const raw = String(item['خيارات الفحص'] || item['خيارات الملاحظة'] || '');
  return raw.split(/[|،,]/)
    .map(function (x) { return x.trim(); })
    .filter(String);
}

/**
 * الحالة الرسمية الحالية لبنود مركبة، مشتقّة من الخادم لا من المتصفح.
 * تستبعد نتائج المحاضر الملغاة، وتُرتّب حسب تسلسل المحضر.
 */
function authoritativeChecklistState_(vehicleId) {
  const cancelled = {};
  all_(SALSAR.SHEETS.handovers, 'VehicleID', vehicleId).forEach(function (h) {
    if (h['الحالة'] === 'ملغى') cancelled[String(h.HandoverID)] = true;
  });

  const state = {};
  all_(SALSAR.SHEETS.results, 'VehicleID', vehicleId)
    .filter(function (r) { return !cancelled[String(r.HandoverID)]; })
    .sort(function (a, b) { return handoverSeq_(a.HandoverID) - handoverSeq_(b.HandoverID); })
    .forEach(function (r) {
      state[String(r.CheckItemID)] = String(r['الحالة الحالية'] || '');
    });
  return state;
}

/** رمز تحقق ثابت يُحسب مرة واحدة على الخادم ويُخزَّن. */
function computeVerificationHash_(parts) {
  const text = parts.join('~');
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('').toUpperCase();
}

// ========================================
// التحقق من الحائز — صارم، بلا أبواب خلفية
// ========================================

/**
 * يُرجع {id, name, idNumber} لحائز صالح فقط.
 * لا يقبل معرّفًا غير موجود مهما أرسل العميل من أسماء بديلة (كان هذا باب U-08).
 */
function requireHolder_(holderId, label) {
  const id = String(holderId || '').trim();
  if (!id) throw new Error('الحقل مطلوب: ' + label);

  if (id === SALSAR.WAREHOUSE_ID) {
    return { id: id, name: SALSAR.WAREHOUSE_NAME, idNumber: '' };
  }

  if (!/^D-\d{3}$/i.test(id)) {
    throw new Error(label + ' غير صحيح: ' + id);
  }

  const driver = one_(SALSAR.SHEETS.drivers, 'DriverID', id);
  if (!driver) {
    throw new Error('الحائز غير موجود في سجل السائقين: ' + id);
  }

  return {
    id: id,
    name: String(driver['الاسم العربي'] || ''),
    idNumber: String(driver['رقم الهوية'] || '')
  };
}

/**
 * يعيد حساب CurrentVehicleID للسائق من ورقة المركبات (المصدر الوحيد للحقيقة).
 * ذاتية التصحيح: تُصلح أي تعارض قديم في الورقة تلقائيًا عند أول عملية تمسّ السائق.
 * يدعم حيازة أكثر من مركبة (قائمة مفصولة بـ|) حسب قرار العمل.
 */
function syncDriverVehicles_(driverId) {
  const id = String(driverId || '').trim();
  if (!id || id === SALSAR.WAREHOUSE_ID) return;

  const driver = one_(SALSAR.SHEETS.drivers, 'DriverID', id);
  if (!driver) return;

  const held = rows_(SALSAR.SHEETS.vehicles)
    .filter(function (v) { return String(v.CurrentHolderID || '') === id; })
    .map(function (v) { return String(v.VehicleID || ''); })
    .filter(String)
    .sort();

  const value = held.join(' | ');
  if (String(driver.CurrentVehicleID || '') !== value) {
    update_(SALSAR.SHEETS.drivers, 'DriverID', id, { CurrentVehicleID: value });
  }
}

// ========================================
// التحقق من نتائج التشييك
// ========================================

/**
 * يتحقق من نتائج التشييك ويبني الصفوف — بلا أي كتابة.
 * previousStatus يُشتق من الحالة الرسمية على الخادم، لا من المتصفح.
 * currentStatus يُتحقق من كونه ضمن خيارات البند.
 */
function validateResults_(vehicleId, category, results, serverState) {
  if (!results || !results.length) return [];

  const allowedItems = {};
  checklistForCategory_(category).forEach(function (item) {
    allowedItems[String(item.CheckItemID)] = item;
  });

  const out = [];
  results.forEach(function (r) {
    required_(r.checkItemId, 'CheckItemID');
    ref_(r.checkItemId, /^CL-\d{3}$/i, 'CheckItemID');
    const cid = String(r.checkItemId);

    const item = one_(SALSAR.SHEETS.checklist, 'CheckItemID', cid);
    if (!item) throw new Error('بند التشييك غير موجود: ' + cid);
    if (item['الحالة'] && item['الحالة'] !== 'نشط') {
      throw new Error('بند التشييك موقوف ولا يمكن استخدامه: ' + cid);
    }
    if (!allowedItems[cid]) {
      throw new Error('بند التشييك "' + item['بند التشييك'] +
        '" لا ينطبق على فئة هذه المركبة: ' + category);
    }

    const currentStatus = String(required_(r.currentStatus,
      'الحالة الحالية لبند ' + cid)).trim();

    // U-10: الحالة يجب أن تكون ضمن خيارات البند المعتمدة
    const options = checkItemOptions_(item);
    if (options.length && options.indexOf(currentStatus) < 0) {
      throw new Error('حالة غير معتمدة للبند ' + cid + ': "' + currentStatus +
        '". الخيارات المسموحة: ' + options.join('، '));
    }

    // U-10: الحالة السابقة تُشتق من الخادم وتتجاهل ما يرسله المتصفح
    const previousStatus = serverState[cid] || (options[0] || 'لا ملاحظات');

    // لا تغيير فعلي ⇒ لا صف
    if (previousStatus === currentStatus) return;

    out.push({
      ResultID: Utilities.getUuid(),
      HandoverID: '',
      VehicleID: vehicleId,
      CheckItemID: cid,
      'الحالة السابقة': previousStatus,
      'الحالة الحالية': currentStatus,
      'الملاحظة': String(r.note || ''),
      'يتطلب إجراء': r.requiresAction ? 'نعم' : 'لا'
    });
  });

  return out;
}

// ========================================
// إنشاء محضر عهدة
// ========================================

function createHandover_(payload) {
  payload = payload || {};
  required_(payload.vehicleId, 'VehicleID');
  ref_(payload.vehicleId, /^V-\d{3}$/i, 'VehicleID');
  required_(payload.toHolderId, 'الحائز المستلم (ToHolderID)');

  const props = PropertiesService.getScriptProperties();
  const reqKey = payload.clientRequestId
    ? 'SALSAR_REQ_' + String(payload.clientRequestId).replace(/[^A-Za-z0-9_.-]/g, '')
    : null;

  return locked_(function () {

    // ---- U-14: فحص الازدواج داخل القفل، لا خارجه ----
    if (reqKey) {
      const existingId = props.getProperty(reqKey);
      if (existingId) {
        return {
          handoverId: existingId,
          duplicate: true,
          vehicleId: payload.vehicleId
        };
      }
    }

    // =========== مرحلة التحقق: لا كتابة قبل اكتمالها (U-07) ===========

    const vehicle = one_(SALSAR.SHEETS.vehicles, 'VehicleID', payload.vehicleId);
    if (!vehicle) throw new Error('المركبة غير موجودة: ' + payload.vehicleId);
    if (String(vehicle['الحالة'] || '') === 'مؤرشفة') {
      throw new Error('المركبة مؤرشفة ولا يمكن نقل عهدتها: ' + payload.vehicleId);
    }

    // ---- U-02: الحائز المُسلِّم يُشتق من المركبة، ولا يُقبل من المتصفح ----
    const actualFromId = String(vehicle.CurrentHolderID || '').trim() || SALSAR.WAREHOUSE_ID;

    // كشف تعارض اختياري: إن أرسل العميل توقّعه وكان مخالفًا للواقع، ارفض بوضوح
    const expectedFromId = String(payload.expectedFromHolderId || payload.fromHolderId || '').trim();
    if (expectedFromId && expectedFromId !== actualFromId) {
      throw new Error(
        'تغيّرت عهدة المركبة منذ فتح الصفحة. ' +
        'الحائز الحالي فعليًا هو "' + actualFromId + '" وليس "' + expectedFromId + '". ' +
        'أعد تحميل الصفحة ثم أنشئ المحضر من جديد.'
      );
    }

    const fromHolder = requireHolder_(actualFromId, 'الحائز المُسلِّم');
    const toHolder = requireHolder_(payload.toHolderId, 'الحائز المستلم (ToHolderID)');

    if (fromHolder.id === toHolder.id) {
      throw new Error('المركبة موجودة أصلًا لدى "' + toHolder.name + '" — اختر مستلمًا مختلفًا.');
    }

    // ---- U-21: تحقق خادمي من قراءة العداد، مع قبول الصفر صراحةً ----
    const currentOdometer = Number(vehicle['قراءة العداد'] || 0);
    let odometer;
    if (payload.odometerReading === undefined || payload.odometerReading === null
        || payload.odometerReading === '') {
      odometer = currentOdometer;
    } else {
      odometer = Number(payload.odometerReading);
      if (!isFinite(odometer) || odometer < 0) {
        throw new Error('قراءة العداد غير صحيحة: ' + payload.odometerReading);
      }
      if (odometer < currentOdometer) {
        throw new Error('قراءة العداد (' + odometer + ') لا يمكن أن تقل عن القراءة الحالية (' +
          currentOdometer + ').');
      }
    }

    const category = String(vehicle['الفئة'] || '');
    const serverState = authoritativeChecklistState_(payload.vehicleId);
    const validatedResults = validateResults_(
      payload.vehicleId, category, payload.results, serverState);

    // ---- U-03: لقطة بنود التشييك المنطبقة وقت الإنشاء ----
    const snapshotIds = checklistForCategory_(category)
      .map(function (item) { return String(item.CheckItemID); });

    // الحالة النهائية بعد هذا المحضر = الحالة الرسمية + النتائج الجديدة
    const finalState = {};
    Object.keys(serverState).forEach(function (k) { finalState[k] = serverState[k]; });
    validatedResults.forEach(function (r) {
      finalState[String(r.CheckItemID)] = String(r['الحالة الحالية']);
    });

    const handoverId = nextId_('H', SALSAR.SHEETS.handovers, 'HandoverID');
    const today = date_();
    const vehicleStatus = (toHolder.id === SALSAR.WAREHOUSE_ID) ? 'في المستودع' : 'مسلّمة';

    const verificationHash = computeVerificationHash_([
      handoverId, today, payload.vehicleId, fromHolder.id, toHolder.id, String(odometer),
      snapshotIds.map(function (id) {
        return id + ':' + (finalState[id] || 'لا ملاحظات');
      }).join('|')
    ]);

    const handoverRow = {
      HandoverID: handoverId,
      'التاريخ': today,
      VehicleID: payload.vehicleId,
      PlateSnapshot: vehicle['رقم اللوحة عربي'] || vehicle['رقم اللوحة إنجليزي'] || '',
      CategorySnapshot: category,
      FromHolderID: fromHolder.id,
      'المسلّم': fromHolder.name,
      'هوية المسلّم': fromHolder.idNumber,   // U-09: من سجل السائق، لا من العميل
      ToHolderID: toHolder.id,
      'المستلم': toHolder.name,
      'هوية المستلم': toHolder.idNumber,     // U-09
      'قراءة العداد': odometer,
      'الحالة': 'بانتظار التصديق',
      CertifiedFileID: '',
      'ملاحظات': String(payload.notes || ''),
      CancelledAt: '',
      CancelledBy: '',
      // ---- الأعمدة الجديدة ----
      ChecklistSnapshot: snapshotIds.join('|'),
      VerificationHash: verificationHash,
      PrevOdometer: currentOdometer          // يُستخدم عند الإلغاء لإرجاع العداد
    };

    // =========== مرحلة الكتابة: بعد اكتمال التحقق ===========

    append_(SALSAR.SHEETS.handovers, handoverRow);

    if (validatedResults.length) {
      validatedResults.forEach(function (r) { r.HandoverID = handoverId; });
      appendMany_(SALSAR.SHEETS.results, validatedResults);
    }

    update_(SALSAR.SHEETS.vehicles, 'VehicleID', payload.vehicleId, {
      CurrentHolderID: toHolder.id,
      'العهدة الحالية': toHolder.name,
      'الحالة': vehicleStatus,
      'قراءة العداد': odometer
    });

    // U-22: إعادة حساب قوائم مركبات السائقين من ورقة المركبات (ذاتية التصحيح)
    syncDriverVehicles_(fromHolder.id);
    syncDriverVehicles_(toHolder.id);

    audit_(
      'إنشاء محضر عهدة',
      'محضر عهدة',
      handoverId,
      'المركبة ' + payload.vehicleId + ': من ' + fromHolder.id + ' إلى ' + toHolder.id +
        ' | العداد ' + odometer + ' | فروقات ' + validatedResults.length +
        ' | رمز التحقق ' + verificationHash.slice(0, 8),
      payload.actorEmail
    );

    // U-23: فشل تسجيل علامة الازدواج لا يُفشل عملية نجحت بالكامل
    if (reqKey) {
      try {
        props.setProperty(reqKey, handoverId);
      } catch (e) {
        console.warn('تعذّر تسجيل علامة منع الازدواج (' + reqKey + '): ' + e.message);
      }
    }

    return {
      handoverId: handoverId,
      vehicleId: payload.vehicleId,
      fromHolderId: fromHolder.id,
      toHolderId: toHolder.id,
      status: 'بانتظار التصديق',
      odometer: odometer,
      verificationHash: verificationHash,
      resultsCount: validatedResults.length
    };
  });
}

function handleCreateHandover_(r) {
  const payload = (r && r.payload) || {};
  const result = createHandover_(payload);
  const vehicle = one_(SALSAR.SHEETS.vehicles, 'VehicleID', result.vehicleId || payload.vehicleId);
  const handover = one_(SALSAR.SHEETS.handovers, 'HandoverID', result.handoverId);

  return {
    handover: handover,
    vehicle: vehicle,
    fromHolder: holderSnapshot_(result.fromHolderId || (handover && handover.FromHolderID)),
    toHolder: holderSnapshot_(result.toHolderId || (handover && handover.ToHolderID)),
    verificationHash: result.verificationHash || (handover && handover.VerificationHash) || '',
    duplicate: !!result.duplicate
  };
}

// ========================================
// إلغاء محضر عهدة — مع إرجاع كامل للحالة
// ========================================

/**
 * يُلغى أحدث محضر غير ملغى للمركبة فقط، ومعه تُرجَع حالة المركبة والسائقين
 * إلى ما كانت عليه قبله بالضبط (من FromHolderID و PrevOdometer المخزّنين في المحضر).
 *
 * لماذا الأحدث فقط: إلغاء محضر في وسط السلسلة يجعل ToHolderID لمحضر
 * لا يساوي FromHolderID لما بعده — أي فجوة دائمة في سلسلة العهدة.
 * تصحيح خطأ قديم يكون بمحضر جديد، لا بإلغاء رجعي.
 */
function cancelHandover_(payload) {
  payload = payload || {};
  required_(payload.handoverId, 'HandoverID');
  ref_(payload.handoverId, /^H-\d{4}-\d+$/i, 'HandoverID');
  const reason = String(required_(payload.reason, 'سبب الإلغاء')).trim();
  if (reason.length < 3) throw new Error('اكتب سبب إلغاء واضحًا (3 أحرف على الأقل).');

  return locked_(function () {
    const handover = one_(SALSAR.SHEETS.handovers, 'HandoverID', payload.handoverId);
    if (!handover) throw new Error('المحضر غير موجود: ' + payload.handoverId);
    if (handover['الحالة'] === 'ملغى') {
      throw new Error('المحضر ملغى مسبقاً: ' + payload.handoverId);
    }
    if (handover['الحالة'] === 'مصادق عليه') {
      throw new Error('لا يمكن إلغاء محضر مصادق عليه — له نسخة ورقية موقّعة مرفوعة. ' +
        'أنشئ محضرًا جديدًا لتصحيح الوضع.');
    }

    const vehicleId = String(handover.VehicleID || '');
    const chain = all_(SALSAR.SHEETS.handovers, 'VehicleID', vehicleId)
      .filter(function (h) { return h['الحالة'] !== 'ملغى'; })
      .sort(byHandoverSeq_);

    const latest = chain.length ? chain[chain.length - 1] : null;
    if (!latest || String(latest.HandoverID) !== String(payload.handoverId)) {
      throw new Error(
        'يمكن إلغاء أحدث محضر للمركبة فقط (' +
        (latest ? latest.HandoverID : 'لا يوجد') + '). ' +
        'لتصحيح محضر أقدم أنشئ محضر عهدة جديدًا يوثّق الوضع الصحيح.'
      );
    }

    const vehicle = one_(SALSAR.SHEETS.vehicles, 'VehicleID', vehicleId);
    if (!vehicle) throw new Error('المركبة غير موجودة: ' + vehicleId);

    const actor = payload.actorEmail || Session.getActiveUser().getEmail() || 'مستخدم الويب';
    const restoreHolderId = String(handover.FromHolderID || '').trim() || SALSAR.WAREHOUSE_ID;
    const restoreHolderName = String(handover['المسلّم'] || SALSAR.WAREHOUSE_NAME);
    const restoreStatus = (restoreHolderId === SALSAR.WAREHOUSE_ID) ? 'في المستودع' : 'مسلّمة';

    const prevOdometerRaw = handover.PrevOdometer;
    const restoreOdometer = (prevOdometerRaw === undefined || prevOdometerRaw === null
      || prevOdometerRaw === '') ? vehicle['قراءة العداد'] : Number(prevOdometerRaw);

    // 1) وسم المحضر ملغى
    update_(SALSAR.SHEETS.handovers, 'HandoverID', payload.handoverId, {
      'الحالة': 'ملغى',
      'ملاحظات': String(handover['ملاحظات'] || '') + ' | سبب الإلغاء: ' + reason,
      CancelledAt: now_(),
      CancelledBy: actor
    });

    // 2) إرجاع حالة المركبة إلى ما قبل المحضر بالضبط
    update_(SALSAR.SHEETS.vehicles, 'VehicleID', vehicleId, {
      CurrentHolderID: restoreHolderId,
      'العهدة الحالية': restoreHolderName,
      'الحالة': restoreStatus,
      'قراءة العداد': restoreOdometer
    });

    // 3) إعادة حساب قوائم مركبات السائقين المتأثرين
    syncDriverVehicles_(handover.ToHolderID);
    syncDriverVehicles_(restoreHolderId);

    // ملاحظة: صفوف «نتائج التشييك» تبقى كما هي بوصفها سجلًا تاريخيًا،
    // لكن authoritativeChecklistState_ يستبعد نتائج المحاضر الملغاة تلقائيًا.

    audit_(
      'إلغاء محضر عهدة مع إرجاع الحالة',
      'محضر عهدة',
      payload.handoverId,
      'السبب: ' + reason +
        ' | أُرجعت المركبة ' + vehicleId + ' إلى ' + restoreHolderId +
        ' | العداد ' + restoreOdometer,
      payload.actorEmail
    );

    return {
      handoverId: payload.handoverId,
      status: 'ملغى',
      restored: {
        vehicleId: vehicleId,
        holderId: restoreHolderId,
        holderName: restoreHolderName,
        vehicleStatus: restoreStatus,
        odometer: restoreOdometer
      }
    };
  });
}

function handleCancelHandover_(r) {
  const payload = (r && r.payload) || {};
  const result = cancelHandover_(payload);
  const handover = one_(SALSAR.SHEETS.handovers, 'HandoverID', result.handoverId);
  const vehicle = one_(SALSAR.SHEETS.vehicles, 'VehicleID', result.restored.vehicleId);

  return {
    handover: handover,
    vehicle: vehicle,
    status: result.status,
    restored: result.restored
  };
}

// ========================================
// تاريخ الحائز (سائق أو مستودع)
// ========================================

function holderHistory_(holderId) {
  required_(holderId, 'HolderID');

  const isWarehouse = (holderId === SALSAR.WAREHOUSE_ID);
  if (!isWarehouse) {
    ref_(holderId, /^D-\d{3}$/i, 'HolderID');
  }

  const holder = isWarehouse
    ? { DriverID: SALSAR.WAREHOUSE_ID, 'الاسم العربي': SALSAR.WAREHOUSE_NAME }
    : one_(SALSAR.SHEETS.drivers, 'DriverID', holderId);

  if (!holder) throw new Error('الحائز غير موجود: ' + holderId);

  const relatedHandovers = rows_(SALSAR.SHEETS.handovers)
    .filter(function (h) { return h.FromHolderID === holderId || h.ToHolderID === holderId; })
    .sort(byHandoverSeq_);

  return {
    holder: holder,
    handovers: relatedHandovers
  };
}

function handleHolderHistory_(r) {
  const holderId = (r && r.holderId) || (r && r.payload && r.payload.holderId);
  return holderHistory_(holderId);
}

// ========================================
// دوال داخلية مساعدة
// ========================================

function holderSnapshot_(holderId) {
  if (!holderId) return { id: '', name: null };
  if (holderId === SALSAR.WAREHOUSE_ID) {
    return { id: SALSAR.WAREHOUSE_ID, name: SALSAR.WAREHOUSE_NAME };
  }
  const driver = one_(SALSAR.SHEETS.drivers, 'DriverID', holderId);
  return driver
    ? { id: holderId, name: driver['الاسم العربي'], currentVehicleId: driver.CurrentVehicleID }
    : { id: holderId, name: null };
}

// ========================================
// صيانة: إصلاح تعارض قوائم مركبات السائقين القائم في الورقة
// تُشغَّل يدويًا مرة واحدة من محرر Apps Script بعد رفع هذه النسخة.
// ========================================

function repairDriverVehicleLists() {
  return locked_(function () {
    const drivers = rows_(SALSAR.SHEETS.drivers);
    const vehicles = rows_(SALSAR.SHEETS.vehicles);
    const byHolder = {};
    vehicles.forEach(function (v) {
      const h = String(v.CurrentHolderID || '').trim();
      if (!h || h === SALSAR.WAREHOUSE_ID) return;
      (byHolder[h] = byHolder[h] || []).push(String(v.VehicleID || ''));
    });

    const changed = [];
    drivers.forEach(function (d) {
      const id = String(d.DriverID || '').trim();
      if (!id) return;
      const expected = (byHolder[id] || []).sort().join(' | ');
      const actual = String(d.CurrentVehicleID || '');
      if (expected !== actual) {
        update_(SALSAR.SHEETS.drivers, 'DriverID', id, { CurrentVehicleID: expected });
        changed.push({ driverId: id, was: actual, now: expected });
      }
    });

    const result = { fixedCount: changed.length, changes: changed };
    console.log(JSON.stringify(result, null, 2));
    return result;
  });
}

// ========================================
// صيانة: ملء لقطة التشييك ورمز التحقق للمحاضر القديمة
// تُشغَّل يدويًا مرة واحدة بعد إضافة الأعمدة الجديدة.
// ========================================

function backfillHandoverSnapshots() {
  return locked_(function () {
    const handovers = rows_(SALSAR.SHEETS.handovers)
      .filter(function (h) { return /^H-\d{4}-\d+$/i.test(String(h.HandoverID || '')); })
      .sort(byHandoverSeq_);

    const filled = [];
    handovers.forEach(function (h) {
      if (String(h.ChecklistSnapshot || '').trim() &&
          String(h.VerificationHash || '').trim()) return;

      const category = String(h.CategorySnapshot || '');
      const snapshotIds = checklistForCategory_(category)
        .map(function (item) { return String(item.CheckItemID); });

      const state = {};
      all_(SALSAR.SHEETS.results, 'HandoverID', h.HandoverID).forEach(function (r) {
        state[String(r.CheckItemID)] = String(r['الحالة الحالية'] || '');
      });

      const hash = computeVerificationHash_([
        String(h.HandoverID), String(h['التاريخ'] || ''), String(h.VehicleID || ''),
        String(h.FromHolderID || ''), String(h.ToHolderID || ''),
        String(h['قراءة العداد'] || ''),
        snapshotIds.map(function (id) {
          return id + ':' + (state[id] || 'لا ملاحظات');
        }).join('|')
      ]);

      update_(SALSAR.SHEETS.handovers, 'HandoverID', h.HandoverID, {
        ChecklistSnapshot: snapshotIds.join('|'),
        VerificationHash: hash
      });
      filled.push(String(h.HandoverID));
    });

    const result = { filledCount: filled.length, handovers: filled };
    console.log(JSON.stringify(result, null, 2));
    return result;
  });
}
