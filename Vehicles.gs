/**
 * سلسار V2 — Vehicles.gs   [نسخة مُصلَحة — 2026-09-09]
 * =====================================
 * منطق المركبات: تاريخ المركبة، تغيير التجهيز/الفئة،
 * وإصلاح النقص في سجل التجهيزات الأولي (صيانة لمرة واحدة).
 *
 * الإصلاحات في هذه النسخة:
 *  U-24أ  تاريخ سريان التغيير (effectiveDate) صار يُحترم بدل استخدام تاريخ اليوم دائمًا،
 *         مع تحقق: صيغة صحيحة، ليس في المستقبل، وليس أقدم من بداية السجل الجاري إغلاقه.
 *  U-24ب  استجابة changeVehicleConfiguration صارت مسطّحة أيضًا في المستوى الأعلى،
 *         فتعمل مع الواجهة القديمة (saved.newCategory) والجديدة (saved.change.newCategory).
 */

// ========================================
// تاريخ المركبة الكامل
// ========================================

function vehicleHistory_(vehicleId) {
  required_(vehicleId, 'VehicleID');
  ref_(vehicleId, /^V-\d{3}$/i, 'VehicleID');

  const vehicle = one_(SALSAR.SHEETS.vehicles, 'VehicleID', vehicleId);
  if (!vehicle) throw new Error('المركبة غير موجودة: ' + vehicleId);

  const handovers = all_(SALSAR.SHEETS.handovers, 'VehicleID', vehicleId)
    .sort(byHandoverSeq_);

  const configurations = all_(SALSAR.SHEETS.configurations, 'VehicleID', vehicleId)
    .sort(function(a, b) {
      return String(a.ConfigurationID).localeCompare(String(b.ConfigurationID));
    });

  const documents = all_(SALSAR.SHEETS.documents, 'VehicleID', vehicleId);

  // آخر محضر غير ملغى — هو ما يحدد الحالة الحالية فعلياً
  const activeHandovers = handovers.filter(function(h) { return h['الحالة'] !== 'ملغى'; });
  const latestActiveHandover = activeHandovers.length
    ? activeHandovers[activeHandovers.length - 1]
    : null;

  return {
    vehicle: vehicle,
    latestActiveHandover: latestActiveHandover,
    handovers: handovers,
    configurations: configurations,
    documents: documents
  };
}

function handleVehicleHistory_(r) {
  const vehicleId = (r && r.vehicleId) || (r && r.payload && r.payload.vehicleId);
  return vehicleHistory_(vehicleId);
}

// ========================================
// تغيير تجهيز/فئة المركبة
// ========================================

/** يتحقق من تاريخ السريان ويعيده بصيغة yyyy-MM-dd. */
function normalizeEffectiveDate_(value, minDate) {
  const today = date_();
  const raw = String(value || '').trim();
  if (!raw) return today;

  const text = raw.split(' ')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error('تاريخ بداية الطراز غير صحيح (المطلوب صيغة YYYY-MM-DD): ' + raw);
  }
  const parsed = new Date(text + 'T00:00:00');
  if (isNaN(parsed.valueOf())) {
    throw new Error('تاريخ بداية الطراز غير صالح: ' + raw);
  }
  if (text > today) {
    throw new Error('تاريخ بداية الطراز لا يمكن أن يكون في المستقبل: ' + text);
  }
  if (minDate && text < minDate) {
    throw new Error('تاريخ بداية الطراز (' + text +
      ') لا يمكن أن يسبق بداية الطراز الحالي (' + minDate + ').');
  }
  return text;
}

function changeVehicleConfiguration_(payload) {
  payload = payload || {};
  required_(payload.vehicleId, 'VehicleID');
  ref_(payload.vehicleId, /^V-\d{3}$/i, 'VehicleID');
  required_(payload.newCategory, 'الفئة الجديدة');
  required_(payload.reason, 'سبب التحويل');

  if (SALSAR_VEHICLE_CATEGORIES.indexOf(payload.newCategory) < 0) {
    throw new Error('الفئة غير معتمدة: ' + payload.newCategory);
  }

  return locked_(function() {
    const vehicle = one_(SALSAR.SHEETS.vehicles, 'VehicleID', payload.vehicleId);
    if (!vehicle) throw new Error('المركبة غير موجودة: ' + payload.vehicleId);

    const oldCategory = vehicle['الفئة'];
    if (String(oldCategory) === String(payload.newCategory)) {
      throw new Error('الفئة الجديدة مطابقة للفئة الحالية: ' + oldCategory);
    }

    const openConfig = activeConfiguration_(payload.vehicleId);

    // ---- U-24أ: احترام تاريخ السريان بعد التحقق منه ----
    const minDate = openConfig
      ? String(openConfig['تاريخ البداية'] || '').split(' ')[0]
      : '';
    const effectiveDate = normalizeEffectiveDate_(payload.effectiveDate, minDate);

    // إغلاق السجل النشط الحالي (إن وُجد)
    if (openConfig) {
      update_(SALSAR.SHEETS.configurations, 'ConfigurationID', openConfig.ConfigurationID, {
        'تاريخ النهاية': effectiveDate,
        'الحالة': 'منتهي'
      });
    }

    // فتح سجل تجهيز جديد
    const newConfigId = nextConfigurationId_();
    append_(SALSAR.SHEETS.configurations, {
      ConfigurationID: newConfigId,
      VehicleID: payload.vehicleId,
      'الفئة': payload.newCategory,
      'تاريخ البداية': effectiveDate,
      'تاريخ النهاية': '',
      'الحالة': 'نشط',
      'سبب التحويل': payload.reason,
      'التجهيزات المضافة': payload.addedEquipment || '',
      'التجهيزات المنزوعة': payload.removedEquipment || '',
      HandoverID: payload.handoverId || '',
      'رابط المستندات': payload.documentsLink || '',
      'ملاحظات': payload.notes || ''
    });

    // تحديث فئة المركبة نفسها
    update_(SALSAR.SHEETS.vehicles, 'VehicleID', payload.vehicleId, {
      'الفئة': payload.newCategory
    });

    audit_(
      'تغيير تجهيز المركبة',
      'سجل تجهيزات المركبة',
      newConfigId,
      'المركبة ' + payload.vehicleId + ': من "' + oldCategory + '" إلى "' +
        payload.newCategory + '" | تاريخ السريان ' + effectiveDate,
      payload.actorEmail
    );

    return {
      vehicleId: payload.vehicleId,
      oldCategory: oldCategory,
      newCategory: payload.newCategory,
      effectiveDate: effectiveDate,
      closedConfigurationId: openConfig ? openConfig.ConfigurationID : null,
      newConfigurationId: newConfigId,
      id: newConfigId   // اسم بديل تستخدمه الواجهة الحالية
    };
  });
}

function activeConfiguration_(vehicleId) {
  const configs = all_(SALSAR.SHEETS.configurations, 'VehicleID', vehicleId)
    .filter(function(c) { return c['الحالة'] === 'نشط' && !c['تاريخ النهاية']; });
  return configs.length ? configs[configs.length - 1] : null;
}

/**
 * U-24ب: الاستجابة تحمل الحقول في المستوى الأعلى **و** داخل change،
 * فلا تنكسر الواجهة سواء قرأت saved.newCategory أو saved.change.newCategory.
 */
function handleChangeVehicleConfiguration_(r) {
  const payload = (r && r.payload) || {};
  const result = changeVehicleConfiguration_(payload);
  const vehicle = one_(SALSAR.SHEETS.vehicles, 'VehicleID', result.vehicleId);

  return {
    vehicle: vehicle,
    change: result,
    vehicleId: result.vehicleId,
    oldCategory: result.oldCategory,
    newCategory: result.newCategory,
    effectiveDate: result.effectiveDate,
    closedConfigurationId: result.closedConfigurationId,
    newConfigurationId: result.newConfigurationId,
    id: result.newConfigurationId
  };
}

// ========================================
// إصلاح النقص في سجل التجهيزات (دالة صيانة — تُشغَّل يدوياً مرة واحدة)
// ========================================

function repairMissingOriginalVehicleConfigurationHistory() {
  return locked_(function() {
    const vehicles = rows_(SALSAR.SHEETS.vehicles);
    const repaired = [];
    const skipped = [];

    vehicles.forEach(function(vehicle) {
      const existing = all_(SALSAR.SHEETS.configurations, 'VehicleID', vehicle.VehicleID);
      if (existing.length) {
        skipped.push(vehicle.VehicleID);
        return;
      }

      const newConfigId = nextConfigurationId_();
      append_(SALSAR.SHEETS.configurations, {
        ConfigurationID: newConfigId,
        VehicleID: vehicle.VehicleID,
        'الفئة': vehicle['الفئة'] || 'أخرى',
        'تاريخ البداية': vehicle.CreatedAt ? String(vehicle.CreatedAt).split(' ')[0] : date_(),
        'تاريخ النهاية': '',
        'الحالة': 'نشط',
        'سبب التحويل': 'تسجيل أولي (ترحيل)',
        'التجهيزات المضافة': '',
        'التجهيزات المنزوعة': '',
        HandoverID: '',
        'رابط المستندات': '',
        'ملاحظات': 'تم إنشاؤه تلقائياً بواسطة repairMissingOriginalVehicleConfigurationHistory لسد نقص في السجل التاريخي'
      });

      audit_(
        'إصلاح سجل تجهيزات مفقود',
        'سجل تجهيزات المركبة',
        newConfigId,
        'إنشاء سجل تجهيز أولي تلقائي للمركبة ' + vehicle.VehicleID,
        'صيانة تلقائية'
      );

      repaired.push(vehicle.VehicleID);
    });

    const result = {
      repairedCount: repaired.length,
      repairedVehicles: repaired,
      skippedCount: skipped.length
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  });
}
