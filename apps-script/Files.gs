/**
 * سلسار V2 — Files.gs   [نسخة مُصلَحة — 2026-09-09]
 * =====================================
 * رفع صور العمليات (Drive) والمحاضر المصادقة (PDF).
 *
 * الإصلاحات في هذه النسخة:
 *  U-21  فحص البايتات الأولى للملف فعليًا (%PDF- و FF D8 FF) بدل الثقة بنوع يرسله المتصفح.
 *  U-12أ منع رفع محضر مصادق ثانٍ فوق الأول بصمت: يلزم تأكيد صريح + سبب،
 *        وتُوسم النسخة السابقة «مستبدل» بدل بقاء نسختين «نشط» لنفس السجل.
 *  U-12ب حذف الصورة صار داخل قفل، ويحدّث الشيت **قبل** نقل الملف لسلة المهملات،
 *        ويرفض حذف صور محضر مصادق عليه (أدلة مرتبطة بتوقيع).
 *  عام   تمرير actorEmail الموثوق إلى كل سجلات التدقيق.
 */

// ========================================
// فحص محتوى الملف — لا نثق بنوع يرسله المتصفح
// ========================================

/** Utilities.base64Decode يُرجع بايتات بإشارة (-128..127)؛ نحوّلها لقيمة 0..255. */
function byteAt_(bytes, index) {
  return bytes[index] & 0xFF;
}

/** التوقيع القياسي لملف PDF: %PDF- */
function looksLikePdf_(bytes) {
  if (!bytes || bytes.length < 5) return false;
  return byteAt_(bytes, 0) === 0x25 && byteAt_(bytes, 1) === 0x50 &&
         byteAt_(bytes, 2) === 0x44 && byteAt_(bytes, 3) === 0x46 &&
         byteAt_(bytes, 4) === 0x2D;
}

/** التوقيع القياسي لصورة JPEG: FF D8 FF */
function looksLikeJpeg_(bytes) {
  if (!bytes || bytes.length < 3) return false;
  return byteAt_(bytes, 0) === 0xFF && byteAt_(bytes, 1) === 0xD8 &&
         byteAt_(bytes, 2) === 0xFF;
}

// ========================================
// رفع صورة عملية
// ========================================

function uploadOperationImage_(payload) {
  payload = payload || {};
  const type = required_(payload.recordType, 'recordType');
  const id = required_(payload.recordId, 'recordId');
  const index = Number(payload.index || 0);
  const total = Number(payload.total || 0);
  const mime = String(payload.mimeType || '');

  if (type !== 'handover' && type !== 'transfer') {
    throw new Error('نوع السجل غير صحيح');
  }
  if (!Number.isInteger(index) || index < 1 || index > 10 ||
      !Number.isInteger(total) || total < 1 || total > 10 || index > total) {
    throw new Error('ترتيب الصورة غير صحيح');
  }
  if (mime !== 'image/jpeg') {
    throw new Error('صيغة الصورة غير مدعومة');
  }

  const encoded = String(required_(payload.base64, 'base64')).replace(/\s+/g, '');
  const expectedBytes = Number(required_(payload.byteLength, 'byteLength'));
  const bytes = Utilities.base64Decode(encoded);
  if (!bytes.length) throw new Error('وصلت الصورة فارغة');
  if (bytes.length !== expectedBytes) throw new Error('لم تصل بيانات الصورة كاملة؛ أعد المحاولة');
  if (bytes.length > 2 * 1024 * 1024) throw new Error('حجم الصورة يتجاوز 2 ميجابايت بعد الضغط');

  // U-21: فحص المحتوى الفعلي، لا النوع المُعلن
  if (!looksLikeJpeg_(bytes)) {
    throw new Error('محتوى الملف ليس صورة JPEG صالحة');
  }

  // تحقّق من وجود السجل الأب + جلب بيانات اللقطة للتسمية القابلة للقراءة
  let dateValue, plates;
  if (type === 'handover') {
    const row = one_(SALSAR.SHEETS.handovers, 'HandoverID', id);
    if (!row) throw new Error('محضر العهدة غير موجود');
    if (String(row['الحالة'] || '') === 'ملغى') {
      throw new Error('لا يمكن رفع صور لمحضر ملغى');
    }
    dateValue = row['التاريخ'] || date_();
    plates = compactPlate_(row.PlateSnapshot || 'بدون-لوحة');
  } else {
    const rows = all_(SALSAR.SHEETS.transfers, 'TransferID', id);
    if (!rows.length) throw new Error('محضر نقل الأصل غير موجود');
    if (String(rows[0]['الحالة'] || '') === 'ملغى') {
      throw new Error('لا يمكن رفع صور لمحضر ملغى');
    }
    dateValue = rows[0]['التاريخ'] || date_();
    plates = compactPlate_(rows[0]['من اللوحة'] || 'بدون-لوحة') + '_إلى_' +
             compactPlate_(rows[0]['إلى اللوحة'] || 'بدون-لوحة');
  }

  const imagesFolderId = String(SALSAR.FOLDERS.images || '').trim();
  if (!imagesFolderId) throw new Error('لم يتم إعداد مجلد صور العمليات');

  return locked_(function () {
    // منع التكرار: نفس الترتيب لنفس السجل لا يُرفع مرتين
    const recordImages = all_(SALSAR.SHEETS.operationImages, 'RecordID', id);
    const existing = recordImages.find(function (item) {
      return String(item['الحالة'] || '') !== 'محذوفة' &&
        String(item['الترتيب'] || '') === String(index);
    });
    if (existing) {
      return {
        recordId: id,
        fileName: String(existing['اسم الملف'] || ''),
        url: String(existing['رابط Drive'] || ''),
        index: index,
        total: total,
        byteLength: bytes.length,
        duplicatePrevented: true
      };
    }

    const timestampSuffix = Utilities.formatDate(new Date(), SALSAR.TIME_ZONE, 'HHmmssSSS');
    const name = safe_(id + '_' + dateValue + '_' + plates + '_' +
      String(index).padStart(2, '0') + '_' + timestampSuffix + '.jpg');

    const blob = Utilities.newBlob('').setBytes(bytes).setContentType(mime).setName(name);
    const file = DriveApp.getFolderById(imagesFolderId).createFile(blob);
    if (Number(file.getSize()) !== bytes.length) {
      file.setTrashed(true);
      throw new Error('لم يُحفظ ملف الصورة كاملاً في Drive');
    }

    append_(SALSAR.SHEETS.operationImages, {
      ImageID: Utilities.getUuid(),
      'نوع السجل': type,
      RecordID: id,
      'اسم الملف': name,
      'رابط Drive': file.getUrl(),
      DriveFileID: file.getId(),
      'حجم الملف': bytes.length,
      'الترتيب': index,
      'الحالة': 'صورة عملية',
      UploadedAt: now_()
    });

    audit_('رفع صورة عملية', type, id, name, payload.actorEmail);

    return {
      recordId: id,
      fileName: name,
      url: file.getUrl(),
      index: index,
      total: total,
      byteLength: bytes.length
    };
  });
}

function compactPlate_(value) {
  return String(value || '').trim().replace(/\s+/g, '-');
}

function handleUploadOperationImage_(r) {
  const payload = (r && r.payload) || {};
  return uploadOperationImage_(payload);
}

// ========================================
// حذف صورة عملية
// ========================================

/** حالة السجل الأب (محضر عهدة أو نقل أصل). */
function parentRecordStatus_(recordType, recordId) {
  if (recordType === 'handover') {
    const row = one_(SALSAR.SHEETS.handovers, 'HandoverID', recordId);
    return row ? String(row['الحالة'] || '') : '';
  }
  const rows = all_(SALSAR.SHEETS.transfers, 'TransferID', recordId);
  return rows.length ? String(rows[0]['الحالة'] || '') : '';
}

function deleteOperationImage_(payload) {
  payload = payload || {};
  const imageId = required_(payload.imageId, 'imageId');
  const recordId = required_(payload.recordId, 'recordId');

  return locked_(function () {
    const row = one_(SALSAR.SHEETS.operationImages, 'ImageID', imageId);
    if (!row || String(row.RecordID || '') !== String(recordId)) {
      throw new Error('الصورة غير مرتبطة بهذا السجل');
    }
    if (String(row['الحالة'] || '') === 'محذوفة') {
      return { recordId: recordId, imageId: imageId, status: 'محذوفة' };
    }

    // U-12ب: أدلة محضر مصادق عليه لا تُحذف — النسخة الورقية موقّعة عليها
    const recordType = String(row['نوع السجل'] || 'handover');
    const parentStatus = parentRecordStatus_(recordType, recordId);
    if (parentStatus === 'مصادق عليه') {
      throw new Error(
        'لا يمكن حذف صور محضر مصادق عليه — الصور جزء من الأدلة المرتبطة بالنسخة الموقّعة.'
      );
    }

    // U-12ب: حدّث الشيت أولًا. إن فشل النقل لسلة المهملات بعدها،
    // يبقى الصف موسومًا «محذوفة» والملف موجودًا — وهو أخف ضررًا من
    // ملف محذوف وصف يقول إنه موجود برابط ميت.
    update_(SALSAR.SHEETS.operationImages, 'ImageID', imageId, {
      'الحالة': 'محذوفة'
    });

    const driveFileId = String(row.DriveFileID || '');
    let trashed = false;
    if (driveFileId) {
      try {
        DriveApp.getFileById(driveFileId).setTrashed(true);
        trashed = true;
      } catch (e) {
        console.warn('تعذّر نقل ملف الصورة لسلة المهملات (' + driveFileId + '): ' + e.message);
      }
    }

    audit_(
      'حذف صورة عملية',
      recordType,
      recordId,
      String(row['اسم الملف'] || imageId) + (trashed ? '' : ' | لم يُنقل الملف لسلة المهملات'),
      payload.actorEmail
    );

    return {
      recordId: recordId,
      imageId: imageId,
      fileName: String(row['اسم الملف'] || ''),
      driveTrashed: trashed,
      status: 'محذوفة'
    };
  });
}

function handleDeleteOperationImage_(r) {
  const payload = (r && r.payload) || {};
  return deleteOperationImage_(payload);
}

// ========================================
// رفع محضر مصادق عليه (PDF)
// ========================================

function uploadCertifiedRecord_(payload) {
  payload = payload || {};
  const type = required_(payload.recordType, 'recordType');
  const id = required_(payload.recordId, 'recordId');
  const mime = payload.mimeType || 'application/pdf';

  if (type !== 'handover' && type !== 'transfer') {
    throw new Error('نوع السجل غير صحيح');
  }
  if (mime !== 'application/pdf') {
    throw new Error('المسموح ملفات PDF فقط');
  }

  const encoded = String(required_(payload.base64, 'base64'))
    .replace(/^data:application\/pdf;base64,/, '')
    .replace(/\s+/g, '');
  const bytes = Utilities.base64Decode(encoded);
  if (!bytes.length) throw new Error('وصل الملف فارغًا');
  if (bytes.length > 10 * 1024 * 1024) {
    throw new Error('حجم الملف يتجاوز 10 ميجابايت');
  }

  // U-21: فحص المحتوى الفعلي — ملف .txt مُعاد التسمية لن يمر
  if (!looksLikePdf_(bytes)) {
    throw new Error('محتوى الملف ليس PDF صالحًا (لم يبدأ بتوقيع %PDF-)');
  }

  return locked_(function () {
    const sheetName = (type === 'handover') ? SALSAR.SHEETS.handovers : SALSAR.SHEETS.transfers;
    const idHeader = (type === 'handover') ? 'HandoverID' : 'TransferID';
    const folderId = (type === 'handover') ? SALSAR.FOLDERS.handovers : SALSAR.FOLDERS.transfers;

    const existingRows = all_(sheetName, idHeader, id);
    if (!existingRows.length) throw new Error('السجل غير موجود: ' + id);
    if (existingRows[0]['الحالة'] === 'ملغى') {
      throw new Error('لا يمكن رفع محضر مصادق لسجل ملغى');
    }

    // ---- U-12أ: حارس الاستبدال ----
    const activePrevious = all_(SALSAR.SHEETS.certifiedRecords, 'RecordID', id)
      .filter(function (f) { return String(f['الحالة'] || '') === 'نشط'; });

    const replaceReason = String(payload.replaceReason || '').trim();
    if (activePrevious.length) {
      if (!payload.confirmReplace) {
        throw new Error(
          'يوجد محضر مصادق عليه مرفوع مسبقًا لهذا السجل (' +
          String(activePrevious[0]['اسم الملف'] || '') + '). ' +
          'لاستبداله أعد الرفع مع تأكيد الاستبدال وذكر السبب.'
        );
      }
      if (replaceReason.length < 3) {
        throw new Error('اذكر سبب استبدال المحضر المصادق عليه.');
      }
    }

    const name = safe_(id + '-' + date_() + '-' +
      Utilities.formatDate(new Date(), SALSAR.TIME_ZONE, 'HHmmss') + '.pdf');
    const file = DriveApp.getFolderById(folderId).createFile(
      Utilities.newBlob(bytes, mime, name)
    );
    if (Number(file.getSize()) !== bytes.length) {
      file.setTrashed(true);
      throw new Error('لم يُحفظ الملف كاملاً في Drive؛ أعد المحاولة');
    }

    // وسم النسخ السابقة «مستبدل» — لا تبقى نسختان «نشط» لنفس السجل
    activePrevious.forEach(function (old) {
      update_(SALSAR.SHEETS.certifiedRecords, 'FileID', old.FileID, {
        'الحالة': 'مستبدل',
        'ملاحظات': String(old['ملاحظات'] || '') +
          ' | استُبدل في ' + now_() + ' بالملف ' + name + ' — السبب: ' + replaceReason
      });
    });

    const fileId = Utilities.getUuid();
    append_(SALSAR.SHEETS.certifiedRecords, {
      FileID: fileId,
      'نوع السجل': type,
      RecordID: id,
      'اسم الملف': name,
      'رابط Drive': file.getUrl(),
      DriveFileID: file.getId(),
      'حجم الملف': bytes.length,
      'الحالة': 'نشط',
      UploadedAt: now_(),
      UploadedBy: payload.actorEmail || Session.getActiveUser().getEmail() || 'مستخدم الويب',
      'ملاحظات': String(payload.notes || '') +
        (activePrevious.length ? ' | نسخة بديلة. السبب: ' + replaceReason : '')
    });

    updateAll_(sheetName, idHeader, id, {
      'الحالة': 'مصادق عليه',
      CertifiedFileID: fileId
    });

    audit_(
      activePrevious.length ? 'استبدال محضر مصادق عليه' : 'رفع محضر مصادق عليه',
      type,
      id,
      name + ' | ' + file.getUrl() +
        (activePrevious.length
          ? ' | استُبدل: ' + activePrevious.map(function (o) { return o['اسم الملف']; }).join('، ') +
            ' | السبب: ' + replaceReason
          : ''),
      payload.actorEmail
    );

    return {
      recordId: id,
      fileId: fileId,
      fileName: name,
      url: file.getUrl(),
      replaced: activePrevious.length > 0,
      status: 'مصادق عليه'
    };
  });
}

function handleUploadCertifiedRecord_(r) {
  const payload = (r && r.payload) || {};
  return uploadCertifiedRecord_(payload);
}
