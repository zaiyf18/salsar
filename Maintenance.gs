/**
 * سلسار V2 — Maintenance.gs   [ملف جديد — 2026-09-09]
 * =========================================================================
 * وظيفتان تعملان تلقائيًا بمشغّل زمني:
 *
 *  1) salsarDailyBackup       نسخة احتياطية يومية — **لا تُنشئ نسخة إن لم
 *                             تتغيّر البيانات فعليًا**. تحتفظ بآخر 30 نسخة
 *                             وتنقل الأقدم لسلة المهملات.
 *
 *  2) salsarIntegrityCheck    فحص سلامة أسبوعي — عشر قواعد على البيانات،
 *                             ويرسل النتيجة بالبريد عند وجود خلل فقط.
 *
 * وثالثة تُشغَّل يدويًا عند الحاجة:
 *  3) salsarArchiveOldImages  تصفية صور العمليات القديمة من Drive بأمان،
 *                             مع وضع معاينة قبل أي حذف.
 *
 * التركيب: أنشئ ملفًا جديدًا في Apps Script باسم Maintenance.gs والصق هذا فيه.
 * =========================================================================
 */

// ==========================================================================
// 1) النسخة الاحتياطية اليومية الذكية
// ==========================================================================

/** الأوراق التي يعني تغيّرها أن البيانات تغيّرت فعلًا. */
function salsarWatchedSheets_() {
  return [
    SALSAR.SHEETS.vehicles,
    SALSAR.SHEETS.drivers,
    SALSAR.SHEETS.handovers,
    SALSAR.SHEETS.results,
    SALSAR.SHEETS.transfers,
    SALSAR.SHEETS.certifiedRecords,
    SALSAR.SHEETS.operationImages,
    SALSAR.SHEETS.configurations,
    SALSAR.SHEETS.documents,
    SALSAR.SHEETS.checklist
  ];
}

/**
 * بصمة محتوى البيانات. تتغيّر عند أي تعديل حقيقي — إضافة صف، حذف صف،
 * أو تعديل خلية واحدة. لا تتأثر بفتح الملف أو تغيير التنسيق أو عرض الأعمدة.
 * (سجل التدقيق مستبعد عمدًا لأنه ينمو مع كل عملية قراءة تقريبًا.)
 */
function salsarDataFingerprint_() {
  return salsarWatchedSheets_().map(function (name) {
    let text;
    try {
      const values = sheet_(name).getDataRange().getDisplayValues();
      text = values.map(function (row) { return row.join(''); }).join('');
    } catch (e) {
      text = 'ERR:' + e.message;
    }
    const digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8);
    const hex = digest.map(function (b) {
      return ('0' + (b & 0xFF).toString(16)).slice(-2);
    }).join('');
    return name + '=' + hex;
  }).join('|');
}

/** مجلد النسخ الاحتياطية — يُنشأ تلقائيًا أول مرة ويُحفظ معرّفه. */
function salsarBackupFolder_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('SALSAR_BACKUP_FOLDER_ID');
  if (savedId) {
    try { return DriveApp.getFolderById(savedId); }
    catch (e) { /* حُذف المجلد — نُنشئ غيره */ }
  }
  const name = 'Salsar-Backups';
  const existing = DriveApp.getFoldersByName(name);
  const folder = existing.hasNext() ? existing.next() : DriveApp.createFolder(name);
  props.setProperty('SALSAR_BACKUP_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * النسخة الاحتياطية اليومية.
 * تُنشئ نسخة **فقط** إذا اختلفت بصمة البيانات عن آخر نسخة.
 * عشرون يومًا بلا تغيير = صفر ملفات جديدة، والأرشيف يبقى كما هو.
 */
function salsarDailyBackup() {
  const props = PropertiesService.getScriptProperties();
  const KEEP = Number(props.getProperty('SALSAR_BACKUP_KEEP') || 30);

  const current = salsarDataFingerprint_();
  const previous = props.getProperty('SALSAR_BACKUP_FINGERPRINT') || '';

  if (current === previous) {
    props.setProperty('SALSAR_BACKUP_LAST_CHECK', now_());
    const msg = 'لا تغيير في البيانات منذ آخر نسخة — لم تُنشأ نسخة جديدة.';
    console.log(msg);
    return { created: false, reason: msg, checkedAt: now_() };
  }

  const folder = salsarBackupFolder_();
  const stamp = Utilities.formatDate(new Date(), SALSAR.TIME_ZONE, 'yyyy-MM-dd_HHmm');
  const backupName = 'Salsar-' + stamp;

  const copy = DriveApp.getFileById(SALSAR.SPREADSHEET_ID).makeCopy(backupName, folder);

  props.setProperty('SALSAR_BACKUP_FINGERPRINT', current);
  props.setProperty('SALSAR_BACKUP_LAST_CHECK', now_());

  // ---- الاحتفاظ بآخر KEEP نسخة فقط ----
  const all = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf('Salsar-') === 0) {
      all.push({ file: f, created: f.getDateCreated().getTime() });
    }
  }
  all.sort(function (a, b) { return b.created - a.created; });

  const removed = [];
  for (let i = KEEP; i < all.length; i++) {
    try {
      removed.push(all[i].file.getName());
      all[i].file.setTrashed(true);
    } catch (e) {
      console.warn('تعذّر حذف نسخة قديمة: ' + e.message);
    }
  }

  const result = {
    created: true,
    backupName: backupName,
    url: copy.getUrl(),
    totalKept: Math.min(all.length, KEEP),
    trashedOld: removed.length,
    at: now_()
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * إعداد المشغّل اليومي — شغّلها **مرة واحدة** يدويًا.
 * تحذف أي مشغّل سابق لنفس الدالة حتى لا تتكرر.
 */
function salsarInstallBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'salsarDailyBackup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('salsarDailyBackup')
    .timeBased()
    .atHour(2)          // الساعة 2 فجرًا بتوقيت الرياض
    .everyDays(1)
    .create();
  console.log('✓ تم تفعيل النسخة الاحتياطية اليومية (2:00 فجرًا).');
  console.log('  لن تُنشأ نسخة إلا عند تغيّر البيانات فعليًا.');
  return { ok: true };
}

// ==========================================================================
// 2) فحص السلامة الأسبوعي
// ==========================================================================

/**
 * عشر قواعد على البيانات. يُرجع قائمة المخالفات، ويرسل بريدًا عند وجودها.
 */
function salsarIntegrityCheck() {
  const issues = [];
  const add = function (rule, detail) { issues.push({ rule: rule, detail: detail }); };

  const vehicles = rows_(SALSAR.SHEETS.vehicles);
  const drivers = rows_(SALSAR.SHEETS.drivers);
  const handovers = rows_(SALSAR.SHEETS.handovers)
    .filter(function (h) { return /^H-\d{4}-\d+$/i.test(String(h.HandoverID || '')); });
  const results = rows_(SALSAR.SHEETS.results);
  const images = rows_(SALSAR.SHEETS.operationImages);
  const certified = rows_(SALSAR.SHEETS.certifiedRecords);
  const configs = rows_(SALSAR.SHEETS.configurations);

  const driverIds = {};
  drivers.forEach(function (d) { driverIds[String(d.DriverID || '')] = d; });
  const vehicleIds = {};
  vehicles.forEach(function (v) { vehicleIds[String(v.VehicleID || '')] = v; });

  const active = handovers.filter(function (h) { return h['الحالة'] !== 'ملغى'; });
  const byVehicle = {};
  active.forEach(function (h) {
    (byVehicle[String(h.VehicleID || '')] = byVehicle[String(h.VehicleID || '')] || []).push(h);
  });
  Object.keys(byVehicle).forEach(function (v) { byVehicle[v].sort(byHandoverSeq_); });

  // (1) عهدة كل مركبة تطابق آخر محضر غير ملغى
  vehicles.forEach(function (v) {
    const id = String(v.VehicleID || '');
    const chain = byVehicle[id] || [];
    if (!chain.length) return;
    const last = chain[chain.length - 1];
    const expected = String(last.ToHolderID || '');
    const actual = String(v.CurrentHolderID || '');
    if (expected !== actual) {
      add('العهدة لا تطابق آخر محضر',
        id + ': الورقة تقول "' + actual + '" وآخر محضر (' + last.HandoverID + ') يقول "' + expected + '"');
    }
  });

  // (2) سلسلة العهدة متصلة: ToHolderID لمحضر = FromHolderID لما يليه
  Object.keys(byVehicle).forEach(function (v) {
    const chain = byVehicle[v];
    for (let i = 1; i < chain.length; i++) {
      if (String(chain[i].FromHolderID || '') !== String(chain[i - 1].ToHolderID || '')) {
        add('انقطاع في سلسلة العهدة',
          v + ': ' + chain[i - 1].HandoverID + ' سلّم إلى "' + chain[i - 1].ToHolderID +
          '" لكن ' + chain[i].HandoverID + ' يقول إن المُسلِّم "' + chain[i].FromHolderID + '"');
      }
    }
  });

  // (3) الحائز الحالي لكل مركبة موجود فعلًا
  vehicles.forEach(function (v) {
    const h = String(v.CurrentHolderID || '');
    if (!h) { add('مركبة بلا حائز', String(v.VehicleID || '')); return; }
    if (h !== SALSAR.WAREHOUSE_ID && !driverIds[h]) {
      add('حائز غير موجود في سجل السائقين', String(v.VehicleID || '') + ' → ' + h);
    }
  });

  // (4) تطابق ورقتي المركبات والسائقين
  drivers.forEach(function (d) {
    const id = String(d.DriverID || '');
    const listed = splitPipe_(d.CurrentVehicleID);
    const actual = vehicles
      .filter(function (v) { return String(v.CurrentHolderID || '') === id; })
      .map(function (v) { return String(v.VehicleID || ''); }).sort();
    if (listed.slice().sort().join(',') !== actual.join(',')) {
      add('تعارض بين ورقتي المركبات والسائقين',
        id + ': الورقة تقول [' + listed.join(', ') + '] والواقع [' + actual.join(', ') + ']');
    }
  });

  // (5) أرقام محاضر مكررة
  const seen = {};
  handovers.forEach(function (h) {
    const id = String(h.HandoverID || '');
    if (seen[id]) add('رقم محضر مكرر', id);
    seen[id] = true;
  });

  // (6) نتائج تشييك يتيمة
  results.forEach(function (r) {
    const hid = String(r.HandoverID || '');
    if (hid && !seen[hid]) add('نتيجة تشييك بلا محضر', 'ResultID ' + r.ResultID + ' → ' + hid);
  });

  // (7) صور يتيمة
  images.forEach(function (im) {
    const rid = String(im.RecordID || '');
    if (!rid) { add('صورة بلا سجل مرتبط', String(im.ImageID || '')); return; }
    if (/^H-/i.test(rid) && !seen[rid]) add('صورة مرتبطة بمحضر غير موجود', rid);
  });

  // (8) محضر مصادق عليه بلا ملف نشط
  const certByRecord = {};
  certified.forEach(function (c) {
    if (String(c['الحالة'] || '') === 'نشط') certByRecord[String(c.RecordID || '')] = c;
  });
  handovers.forEach(function (h) {
    if (String(h['الحالة'] || '') === 'مصادق عليه' && !certByRecord[String(h.HandoverID || '')]) {
      add('محضر مصادق عليه بلا ملف موقّع نشط', String(h.HandoverID || ''));
    }
  });

  // (9) أكثر من ملف مصادق «نشط» لنفس السجل
  const activeCount = {};
  certified.forEach(function (c) {
    if (String(c['الحالة'] || '') !== 'نشط') return;
    const rid = String(c.RecordID || '');
    activeCount[rid] = (activeCount[rid] || 0) + 1;
  });
  Object.keys(activeCount).forEach(function (rid) {
    if (activeCount[rid] > 1) {
      add('أكثر من نسخة موقّعة نشطة لنفس السجل', rid + ' (' + activeCount[rid] + ' نسخ)');
    }
  });

  // (10) أكثر من سجل تجهيز نشط لمركبة واحدة
  const cfgActive = {};
  configs.forEach(function (c) {
    if (String(c['الحالة'] || '') !== 'نشط') return;
    const v = String(c.VehicleID || '');
    cfgActive[v] = (cfgActive[v] || 0) + 1;
  });
  Object.keys(cfgActive).forEach(function (v) {
    if (cfgActive[v] > 1) {
      add('أكثر من سجل تجهيز نشط', v + ' (' + cfgActive[v] + ' سجلات)');
    }
  });

  const report = {
    checkedAt: now_(),
    vehicles: vehicles.length,
    drivers: drivers.length,
    handovers: handovers.length,
    issueCount: issues.length,
    issues: issues
  };
  console.log(JSON.stringify(report, null, 2));

  if (issues.length) {
    salsarSendIntegrityEmail_(report);
  }
  return report;
}

function salsarSendIntegrityEmail_(report) {
  const to = PropertiesService.getScriptProperties().getProperty('SALSAR_ALERT_EMAIL')
    || getAuthorizedEmail_();
  if (!to) return;

  const grouped = {};
  report.issues.forEach(function (i) {
    (grouped[i.rule] = grouped[i.rule] || []).push(i.detail);
  });

  let body = 'فحص سلامة بيانات سلسار — ' + report.checkedAt + '\n\n';
  body += 'عدد المخالفات: ' + report.issueCount + '\n';
  body += '(' + report.vehicles + ' مركبة، ' + report.drivers + ' سائق، '
       + report.handovers + ' محضر)\n\n';
  body += '════════════════════════════════════\n\n';
  Object.keys(grouped).forEach(function (rule) {
    body += '● ' + rule + ' (' + grouped[rule].length + ')\n';
    grouped[rule].forEach(function (d) { body += '   - ' + d + '\n'; });
    body += '\n';
  });
  body += '════════════════════════════════════\n';
  body += 'شغّل repairDriverVehicleLists() لإصلاح تعارض المركبات/السائقين تلقائيًا.\n';

  try {
    MailApp.sendEmail(to, 'سلسار — ' + report.issueCount + ' مخالفة في فحص السلامة', body);
    console.log('أُرسل التقرير إلى ' + to);
  } catch (e) {
    console.error('تعذّر إرسال البريد: ' + e.message);
  }
}

/** إعداد المشغّل الأسبوعي — شغّلها مرة واحدة. */
function salsarInstallIntegrityTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'salsarIntegrityCheck') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('salsarIntegrityCheck')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(6)
    .create();
  console.log('✓ تم تفعيل فحص السلامة الأسبوعي (الأحد 6 صباحًا).');
  console.log('  لن يصلك بريد إلا عند وجود مخالفة.');
  return { ok: true };
}

// ==========================================================================
// 3) تصفية صور العمليات القديمة من Drive
// ==========================================================================

/**
 * معاينة: يعرض ما **سيُحذف** بلا حذف فعلي. شغّلها أولًا دائمًا.
 * @param {number} monthsOld عمر المحضر بالأشهر (افتراضي 12)
 */
function salsarPreviewOldImages(monthsOld) {
  return salsarArchiveOldImages_(monthsOld || 12, false);
}

/**
 * التنفيذ الفعلي: ينقل صور المحاضر القديمة **المصادق عليها** إلى سلة مهملات
 * Drive، ويُبقي اسم الصورة وبياناتها في الشيت موسومة «مؤرشفة».
 *
 * شرط الأمان: لا تُحذف صور محضر غير مصادق عليه — لأن الصور قد تكون الدليل
 * الوحيد عليه ما دامت النسخة الورقية الموقّعة لم تُرفع بعد.
 *
 * @param {number} monthsOld عمر المحضر بالأشهر (افتراضي 12)
 */
function salsarArchiveOldImages(monthsOld) {
  return salsarArchiveOldImages_(monthsOld || 12, true);
}

function salsarArchiveOldImages_(monthsOld, execute) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - Number(monthsOld));
  const cutoffText = Utilities.formatDate(cutoff, SALSAR.TIME_ZONE, SALSAR.DATE_FORMAT);

  const handoverById = {};
  rows_(SALSAR.SHEETS.handovers).forEach(function (h) {
    handoverById[String(h.HandoverID || '')] = h;
  });
  const transferById = {};
  rows_(SALSAR.SHEETS.transfers).forEach(function (t) {
    if (!transferById[String(t.TransferID || '')]) transferById[String(t.TransferID || '')] = t;
  });

  const candidates = [];
  const skipped = { notOld: 0, notCertified: 0, alreadyGone: 0, noParent: 0 };

  rows_(SALSAR.SHEETS.operationImages).forEach(function (im) {
    const status = String(im['الحالة'] || '');
    if (status === 'محذوفة' || status === 'مؤرشفة') { skipped.alreadyGone++; return; }

    const rid = String(im.RecordID || '');
    const parent = handoverById[rid] || transferById[rid];
    if (!parent) { skipped.noParent++; return; }

    const parentDate = String(parent['التاريخ'] || '').split(' ')[0];
    if (!parentDate || parentDate >= cutoffText) { skipped.notOld++; return; }

    if (String(parent['الحالة'] || '') !== 'مصادق عليه') { skipped.notCertified++; return; }

    candidates.push({
      imageId: String(im.ImageID || ''),
      recordId: rid,
      date: parentDate,
      fileName: String(im['اسم الملف'] || ''),
      driveFileId: String(im.DriveFileID || ''),
      sizeBytes: Number(im['حجم الملف'] || 0)
    });
  });

  const totalBytes = candidates.reduce(function (a, c) { return a + c.sizeBytes; }, 0);
  const summary = {
    mode: execute ? '⚠️ تنفيذ فعلي' : '👁 معاينة فقط — لم يُحذف شيء',
    cutoffDate: cutoffText,
    monthsOld: Number(monthsOld),
    willArchive: candidates.length,
    spaceFreedMB: Math.round(totalBytes / 1048576 * 10) / 10,
    skipped: skipped,
    sample: candidates.slice(0, 10).map(function (c) {
      return c.date + ' · ' + c.recordId + ' · ' + c.fileName;
    })
  };

  if (!execute) {
    console.log(JSON.stringify(summary, null, 2));
    console.log('\nلا شيء حُذف. للتنفيذ الفعلي شغّل: salsarArchiveOldImages(' + monthsOld + ')');
    return summary;
  }

  let archived = 0, failed = 0;
  candidates.forEach(function (c) {
    try {
      if (c.driveFileId) {
        DriveApp.getFileById(c.driveFileId).setTrashed(true);
      }
      update_(SALSAR.SHEETS.operationImages, 'ImageID', c.imageId, {
        'الحالة': 'مؤرشفة',
        'رابط Drive': ''
      });
      archived++;
    } catch (e) {
      failed++;
      console.warn('تعذّرت أرشفة ' + c.fileName + ': ' + e.message);
    }
  });

  audit_('أرشفة صور قديمة', 'صيانة', 'ARCHIVE-' + cutoffText,
    'أُرشفت ' + archived + ' صورة لمحاضر مصادقة أقدم من ' + cutoffText +
    ' (' + summary.spaceFreedMB + ' ميجابايت)', 'صيانة تلقائية');

  summary.archived = archived;
  summary.failed = failed;
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}
