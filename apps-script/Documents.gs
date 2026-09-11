/**
 * سلسار V2 — Documents.gs   [ملف جديد — 2026-09-09]
 * =========================================================================
 * استيراد وثائق المركبات من قالب Excel إلى ورقة «وثائق المركبات».
 *
 * لماذا هذا الملف: النسخة السابقة من الاستيراد كانت تكتب في localStorage
 * داخل متصفح واحد فقط — لا تصل قاعدة البيانات، ولا يراها جهاز آخر، وتضيع
 * مع أول مسح للكاش. أي أن الميزة كانت **تبدو ناجحة وهي لا تحفظ شيئًا**.
 *
 * هذه النسخة تكتب في الشيت داخل قفل، بعد تحقق كامل، بكتابة واحدة مجمّعة
 * (قراءة واحدة + كتابة واحدة) بدل 42 عملية منفصلة تتجاوز مهلة الاتصال.
 *
 * عمود جديد مطلوب في ورقة «وثائق المركبات»: UpdatedAt
 * =========================================================================
 */

/** يقبل تاريخًا بأي صيغة معقولة ويُرجع yyyy-MM-dd أو '' إن كان فارغًا. */
function normalizeDocumentDate_(value, label) {
  if (value === undefined || value === null) return '';
  const raw = String(value).trim();
  if (!raw) return '';                       // فراغ مقصود = «لا تنطبق»

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];

  const parsed = new Date(raw);
  if (isNaN(parsed.valueOf())) {
    throw new Error(label + ': تاريخ غير صالح «' + raw + '»');
  }
  return Utilities.formatDate(parsed, SALSAR.TIME_ZONE, SALSAR.DATE_FORMAT);
}

/**
 * يحدّث وثائق المركبات دفعة واحدة.
 * payload: { documents: [{ vehicleId, plate, registrationExpiry, insuranceExpiry,
 *                          inspectionExpiry, operationLicenseExpiry, notes }] }
 */
function updateVehicleDocuments_(payload) {
  payload = payload || {};
  const incoming = payload.documents;
  if (!Array.isArray(incoming) || !incoming.length) {
    throw new Error('لم تصل أي بيانات وثائق');
  }
  if (incoming.length > 500) {
    throw new Error('عدد الصفوف يتجاوز الحد المسموح (500)');
  }

  return locked_(function () {

    // ---------- مرحلة التحقق: لا كتابة قبل اكتمالها ----------
    const vehicleById = {};
    rows_(SALSAR.SHEETS.vehicles).forEach(function (v) {
      vehicleById[String(v.VehicleID || '').trim()] = v;
    });

    const seen = {};
    const prepared = incoming.map(function (d, i) {
      const label = 'الصف ' + (i + 1);
      const id = String((d && d.vehicleId) || '').trim().toUpperCase();

      if (!id) throw new Error(label + ': VehicleID فارغ');
      if (!/^V-\d{3}$/.test(id)) throw new Error(label + ': VehicleID غير صحيح «' + id + '»');
      if (!vehicleById[id]) throw new Error(label + ': المركبة غير موجودة في النظام «' + id + '»');
      if (seen[id]) throw new Error('المركبة مكررة في الملف: ' + id);
      seen[id] = true;

      return {
        VehicleID: id,
        'رقم اللوحة': String((d.plate || vehicleById[id]['رقم اللوحة عربي'] || '')).trim(),
        'انتهاء استمارة رخصة السير': normalizeDocumentDate_(d.registrationExpiry, label + ' — الاستمارة'),
        'انتهاء وثيقة التأمين':      normalizeDocumentDate_(d.insuranceExpiry,    label + ' — التأمين'),
        'انتهاء الفحص الدوري':       normalizeDocumentDate_(d.inspectionExpiry,   label + ' — الفحص الدوري'),
        'انتهاء رخصة التشغيل':       normalizeDocumentDate_(d.operationLicenseExpiry, label + ' — رخصة التشغيل'),
        'ملاحظات': String(d.notes || '').slice(0, 500),
        UpdatedAt: now_()
      };
    });

    // ---------- مرحلة الكتابة: قراءة واحدة + كتابة واحدة ----------
    const sheet = sheet_(SALSAR.SHEETS.documents);
    const range = sheet.getDataRange();
    const data = range.getValues();
    if (!data.length) throw new Error('ورقة وثائق المركبات فارغة تمامًا (لا يوجد صف عناوين)');

    const headers = data[0].map(function (h) { return String(h).trim(); });
    const idCol = headers.indexOf('VehicleID');
    if (idCol < 0) throw new Error('عمود VehicleID غير موجود في ورقة وثائق المركبات');

    const missingCols = [];
    if (headers.indexOf('UpdatedAt') < 0) missingCols.push('UpdatedAt');
    if (missingCols.length) {
      throw new Error('أعمدة ناقصة في ورقة «وثائق المركبات»: ' + missingCols.join('، ') +
        ' — أضفها في صف العناوين ثم أعد المحاولة.');
    }

    const rowIndexById = {};
    for (let r = 1; r < data.length; r++) {
      const key = String(data[r][idCol] || '').trim();
      if (key) rowIndexById[key] = r;
    }

    let updated = 0, added = 0;
    prepared.forEach(function (row) {
      let r = rowIndexById[row.VehicleID];
      if (r === undefined) {
        data.push(new Array(headers.length).fill(''));
        r = data.length - 1;
        rowIndexById[row.VehicleID] = r;
        added++;
      } else {
        updated++;
      }
      Object.keys(row).forEach(function (k) {
        const c = headers.indexOf(k);
        if (c >= 0) data[r][c] = row[k];
      });
    });

    sheet.getRange(1, 1, data.length, headers.length).setValues(data);
    invalidateSheet_(SALSAR.SHEETS.documents);

    audit_(
      'تحديث وثائق المركبات',
      'وثائق المركبات',
      'DOCS-' + date_(),
      'حُدّثت ' + updated + ' مركبة وأُضيفت ' + added + ' من ملف بـ' + prepared.length + ' صفًا',
      payload.actorEmail
    );

    return {
      total: prepared.length,
      updated: updated,
      added: added,
      at: now_()
    };
  });
}

function handleUpdateVehicleDocuments_(r) {
  const payload = (r && r.payload) || {};
  return updateVehicleDocuments_(payload);
}

/**
 * فحص جاهزية الورقة — شغّلها بعد إضافة عمود UpdatedAt للتأكد.
 */
function testDocumentsSheet() {
  const sheet = sheet_(SALSAR.SHEETS.documents);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getDisplayValues()[0].map(function (h) { return String(h).trim(); });

  const required = ['VehicleID', 'رقم اللوحة', 'انتهاء استمارة رخصة السير',
                    'انتهاء وثيقة التأمين', 'انتهاء الفحص الدوري',
                    'انتهاء رخصة التشغيل', 'ملاحظات', 'UpdatedAt'];
  const missing = required.filter(function (c) { return headers.indexOf(c) < 0; });

  const result = {
    headers: headers.filter(String),
    rows: Math.max(0, sheet.getLastRow() - 1),
    missing: missing,
    ok: missing.length === 0
  };
  console.log(JSON.stringify(result, null, 2));
  console.log(result.ok
    ? '✓ ورقة وثائق المركبات جاهزة للاستيراد'
    : '❌ أضف الأعمدة الناقصة في صف العناوين: ' + missing.join('، '));
  return result;
}
