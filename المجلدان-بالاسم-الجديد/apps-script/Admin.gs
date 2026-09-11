/**
 * سلسار V2 — Admin.gs
 * =========================================================================
 * الإصدار: 2.6.0   |   آخر تعديل: 2026-09-10 (بتوقيت الرياض)
 *
 * نسخة احتياطية مجدولة للجدول، بلا أي دالة تمسح بيانات.
 *
 * ملاحظة مقصودة: النسخة الداخلية من هذا الملف كانت تحوي منظومة تصفير
 * كاملة (معاينة، رمز تأكيد، مسح كل صفوف المحاضر والنتائج والتصديقات).
 * حُذفت من هذه النسخة عمدًا: أداةٌ تمسح كل شيء بضغطة لا تُنشر مع كود
 * يركّبه غيرك. من احتاجها فليكتبها بنفسه وهو يعرف ما يفعل.
 * =========================================================================
 */

/** عدد النسخ المحفوظة قبل حذف الأقدم. */
const SALSAR_BACKUP_KEEP = 8;

/** اسم مجلد Drive الذي تُحفظ فيه النسخ (يُنشأ تلقائيًا عند أول تشغيل). */
const SALSAR_BACKUP_FOLDER = 'سلسار — النسخ الاحتياطية';

/**
 * ينسخ الجدول كاملًا إلى مجلد النسخ، ويحذف ما زاد عن SALSAR_BACKUP_KEEP.
 * يُرجع رابط النسخة الجديدة.
 *
 * ما لا يفعله — وهذا مهم أن تعرفه: لا ينسخ ملفات Drive (المحاضر المصادقة
 * والصور). الجدول يحمل معرّفاتها لا محتواها، فاسترجاع الجدول وحده يعيد
 * سجلًا يشير إلى ملفات قد لا تكون موجودة. احمِ المجلدات الثلاثة بنسخ Drive.
 */
function salsarBackupSpreadsheet() {
  const folders = DriveApp.getFoldersByName(SALSAR_BACKUP_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(SALSAR_BACKUP_FOLDER);

  const stamp = Utilities.formatDate(new Date(), SALSAR.TIME_ZONE, 'yyyy-MM-dd_HHmm');
  const copy = DriveApp.getFileById(SALSAR.SPREADSHEET_ID).makeCopy('سلسار-' + stamp, folder);

  // احذف الأقدم فوق الحد — الترتيب بتاريخ الإنشاء لا بالاسم
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); files.push({ file: f, at: f.getDateCreated().getTime() }); }
  files.sort(function (a, b) { return b.at - a.at; });
  files.slice(SALSAR_BACKUP_KEEP).forEach(function (x) { x.file.setTrashed(true); });

  const url = copy.getUrl();
  console.log('نسخة احتياطية: ' + url + ' | المحفوظ: ' +
    Math.min(files.length, SALSAR_BACKUP_KEEP) + ' نسخة');
  try {
    audit_('نسخة احتياطية مجدولة', 'تهيئة النظام', 'BACKUP-' + stamp, url, '');
  } catch (err) {
    console.warn('تعذّر تسجيل النسخة في سجل التدقيق: ' + err.message);
  }
  return url;
}

/**
 * يثبّت مشغّلًا أسبوعيًا (الجمعة 2 فجرًا) يشغّل salsarBackupSpreadsheet.
 * شغّله مرة واحدة من المحرّر. تكراره لا يضاعف المشغّلات — يحذف القديم أولًا.
 */
function salsarInstallBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'salsarBackupSpreadsheet') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('salsarBackupSpreadsheet')
    .timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(2).create();
  console.log('ثُبّت مشغّل النسخ الأسبوعي: الجمعة ~2 فجرًا بتوقيت ' + SALSAR.TIME_ZONE);
}

/**
 * فحص سريع للتحقق من سلامة التركيب: يقرأ الأوراق ويعدّ صفوفها.
 * لا يكتب شيئًا — آمن التشغيل في أي وقت.
 */
function salsarHealthCheck() {
  const report = [];
  Object.keys(SALSAR.SHEETS).forEach(function (key) {
    const name = SALSAR.SHEETS[key];
    try {
      const sheet = ss_().getSheetByName(name);
      report.push(name + ': ' + (sheet ? (sheet.getLastRow() - 1) + ' صفًا' : 'غير موجودة'));
    } catch (err) {
      report.push(name + ': خطأ — ' + err.message);
    }
  });
  console.log(report.join('\n'));
  return report;
}
