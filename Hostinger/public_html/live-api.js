/**
 * سلسار V2 — live-api.js      آخر تعديل 2026-09-10 (مع v2.5.5)
 *
 * سجل التغيير:
 *  2.5.5  2026-09-10  شريط التقدّم صار يعني ما يقوله: كان يعرض «0 من 1 (100%)»
 *                     لأن النسبة تقيس بايتات أُرسلت والعدّاد يقيس صورًا أكّد
 *                     الخادم حفظها. الآن الإرسال 90% والتأكيد آخر 10%،
 *                     ويظهر «بانتظار تأكيد الخادم» في الفجوة بينهما.
 *                     يشمل رفع الصور ورفع المحضر المصادق عليه.
 *  2.5.2  2026-09-10  نص التأكيد عند إنشاء المحضر صار يعلن ما سيُطبع فعلًا:
 *                     عدد التغييرات، وعدد البنود التي ستظهر في المحضر، وكم
 *                     منها ملاحظة موروثة لم تُمَس. كان يقول «جميع البنود باقية
 *                     لا ملاحظات» حتى مع وجود ملاحظات قائمة — وهو غير صحيح.
 *  2.5.1  2026-09-10  إعادة محاولة واحدة عند فشل وصول الرد فقط، ومشروطة
 *                     بأمان الإعادة (فعل قراءة أو كتابة تحمل clientRequestId)
 *  2.3    2026-09-09  رفع الصور بـXMLHttpRequest مع شريط تقدّم حقيقي
 *
 * =========================================================================
 * طبقة الاتصال بين app-template.html و Apps Script V2 (عبر api.php).
 *
 * تغييرات V2 عن النسخة القديمة:
 *   createHandover : odometer → odometerReading
 *                    fromIdentity/toIdentity → fromHolderIdNumber/toHolderIdNumber
 *                    fromName/toName → fromHolderNameOverride/toHolderNameOverride
 *                    results[].status → results[].currentStatus
 *                    الإرجاع: saved.handover.HandoverID (لا يوجد saved.id)
 *   createAssetTransfer : الإرجاع saved.transferId (لا يوجد saved.id)
 *   uploadOperationImage / uploadCertifiedRecord : بلا تغيير (مطابقة أصلاً)
 * =========================================================================
 */
(function () {
  if (!window.SALSAR_LIVE) return;

  // v2.3 — الرفع عبر XMLHttpRequest لا fetch، لأن fetch لا يوفّر حدث تقدّم للرفع.
  // هذا ما يحوّل «الزر متجمّد بلا تفسير» إلى نسبة مئوية تتحرك.
  const apiUpload = (action, payload, onProgress) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'api.php', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.withCredentials = true;
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.upload && onProgress) onProgress(1);
      let data;
      try { data = JSON.parse(xhr.responseText); }
      catch (_) { reject(new Error('انقطع الرد قبل وصوله، وقد تكون العملية نجحت على الخادم. '
        + 'حدّث الصفحة وتحقق قبل إعادة الرفع.')); return; }
      if (!data.ok) { reject(new Error(data.error || 'تعذر تنفيذ العملية')); return; }
      resolve(data.data);
    };
    xhr.onerror = () => reject(new Error('انقطع الاتصال أثناء الرفع؛ تحقق من الشبكة'));
    xhr.ontimeout = () => reject(new Error('انتهت مهلة الرفع؛ أعد المحاولة'));
    xhr.timeout = 180000;
    xhr.send(JSON.stringify({ action, payload }));
  });

  // ─── شريط تقدّم مرئي ───
  const progressBar = (() => {
    let box, fill, label;
    const build = () => {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:9998;background:#0b1739;color:#fff;padding:11px 18px;font:700 14px Calibri,Arial;display:none;box-shadow:0 -3px 14px rgba(0,0,0,.25)';
      box.innerHTML = '<div style="max-width:720px;margin:0 auto"><div id="salsarProgressLabel" style="margin-bottom:7px"></div><div style="height:8px;background:rgba(255,255,255,.22);border-radius:2px;overflow:hidden"><i id="salsarProgressFill" style="display:block;height:100%;width:0;background:#5fd0a6;transition:width .18s"></i></div></div>';
      document.body.appendChild(box);
      fill = box.querySelector('#salsarProgressFill');
      label = box.querySelector('#salsarProgressLabel');
    };
    return {
      show(text) { if (!box) build(); label.textContent = text; fill.style.width = '0%'; box.style.display = 'block'; },
      set(ratio, text) {
        if (!box) build();
        fill.style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
        if (text) label.textContent = text;
      },
      hide() { if (box) box.style.display = 'none'; }
    };
  })();

  // v2.5.1 — أفعال القراءة: إعادتها لا تكتب شيئًا فهي آمنة دائمًا
  const READ_ONLY_ACTIONS = ['health', 'bootstrap', 'vehicleHistory', 'holderHistory', 'flushCache'];

  const apiOnce = async (action, payload) => {
    const response = await fetch('api.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action, payload })
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) {
      // ردّ ليس JSON: صفحة خطأ من الاستضافة، أو ردّ مقطوع.
      // نميّزه عن خطأ الأعمال لأن الأول قد يُعاد والثاني لا.
      const err = new Error('استجابة الخادم غير مكتملة');
      err.incompleteResponse = true;
      throw err;
    }
    if (!data.ok) throw new Error(data.error || 'تعذر تنفيذ العملية');
    return data.data;
  };

  /**
   * v2.5.1 — إعادة محاولة واحدة، بشرطين معًا:
   *
   *  (أ) أن يكون الفشل في **وصول الرد** لا في العملية نفسها — انقطاع شبكة أو ردّ
   *      ليس JSON. أخطاء الأعمال (مثل «المركبة في عهدة سائق آخر») لا تُعاد أبدًا.
   *  (ب) أن تكون الإعادة **مضمونة ألّا تُنشئ سجلًا ثانيًا**: إمّا فعل قراءة، أو
   *      كتابة تحمل clientRequestId — و Apps Script يتعرّف عليه داخل القفل
   *      ويُرجع السجل الأول بدل إنشاء غيره (منع الازدواج U-14).
   *
   * وإن لم يتحقق الشرطان، لا نُعيد ولا ندّعي الفشل: نقول إن العملية **قد تكون
   * نجحت** ونطلب التحقق قبل إعادة المحاولة يدويًا. هذا ما حدث فعلًا في 2026-09-10:
   * نجح رفع محضر مصادق عليه على الخادم بينما أُخبر المستخدم بالفشل.
   */
  const api = async (action, payload) => {
    try {
      return await apiOnce(action, payload);
    } catch (error) {
      const deliveryFailure = Boolean(error.incompleteResponse) || error.name === 'TypeError';
      const retrySafe = READ_ONLY_ACTIONS.indexOf(action) >= 0
                     || Boolean(payload && payload.clientRequestId);

      if (deliveryFailure && retrySafe) {
        await new Promise(resolve => setTimeout(resolve, 800));
        return await apiOnce(action, payload);
      }
      if (deliveryFailure) {
        throw new Error('انقطع الرد قبل وصوله، وقد تكون العملية نجحت على الخادم. '
          + 'حدّث الصفحة وتحقق من النتيجة قبل إعادة المحاولة.');
      }
      throw error;
    }
  };
  window.salsarApi = api;

  // معرّف طلب فريد لمنع الازدواج عند إعادة المحاولة (يقابل clientRequestId في V2)
  const requestId = prefix => prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

  // بعد أي عملية كتابة، نُبطل كاش Apps Script قبل إعادة التحميل
  // حتى تظهر النتيجة فورًا بدل انتظار انتهاء صلاحية الكاش.
  const reloadWith = async hash => {
    try { await api('flushCache'); } catch (_) { /* الفشل هنا لا يمنع إعادة التحميل */ }
    location.replace('./?refresh=' + Date.now() + '#' + hash);
  };

  const selectedImages = input => {
    const files = [...(input?.files || [])];
    if (files.length > 10) throw new Error('الحد الأعلى 10 صور لكل محضر');
    return files;
  };

  const showSavedMessage = (form, button, message) => {
    button.disabled = true; button.hidden = true;
    form.querySelectorAll('button[type="reset"]').forEach(item => item.disabled = true);
    let notice = form.querySelector('.operation-saved-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'operation-saved-notice';
      notice.style.cssText = 'margin-top:16px;padding:14px 16px;border:1px solid #9bc9bd;border-radius:12px;background:#e8f6f1;color:#145b4d;font-weight:800;line-height:1.7';
      form.appendChild(notice);
    }
    notice.textContent = message + ' — جاري فتح المحضر…';
    notice.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // ---------------------------------------------------------- تجهيز الصور
  const imageBase64 = async file => {
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) throw new Error('المسموح صور JPG أو PNG أو WebP فقط');
    const bitmap = await createImageBitmap(file), max = 1024,   // v2.3: كان 1280
      scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height)),
      canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .70));
    if (!blob || blob.size < 1) throw new Error('تعذر تجهيز الصورة');
    if (blob.size > 2 * 1024 * 1024) throw new Error('تعذر ضغط إحدى الصور إلى أقل من 2 ميجابايت');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { mimeType: 'image/jpeg', byteLength: bytes.length, base64: btoa(binary) };
  };

  // رفع بمسارين متوازيين — V2 يمنع ازدواج نفس «الترتيب» لنفس السجل داخلياً
  const uploadImages = async (recordType, recordId, files, button) => {
    if (!files.length) return 0;
    let next = 0, done = 0;
    const fraction = new Array(files.length).fill(0);   // نسبة رفع كل ملف

    // v2.5.5 — «0 من 1 (100%)» كان صحيحًا حرفيًا ومضلّلًا عمليًا:
    // النسبة تقيس بايتات أُرسلت من المتصفح، والعدّاد يقيس صورًا أكّد الخادم حفظها.
    // بين انتهاء الإرسال ووصول رد Apps Script (ثوانٍ) كان الشريط يبلغ 100%
    // بينما لم يُحفظ شيء بعد. الآن: الإرسال 90% من الشريط، وتأكيد الخادم آخر 10%،
    // فلا يبلغ 100% إلا بعد تأكيد حفظ كل صورة.
    const paint = () => {
      const sent = fraction.reduce((a, b) => a + b, 0) / files.length;
      const total = sent * 0.9 + (done / files.length) * 0.1;
      const awaiting = fraction.filter(f => f >= 1).length > done;
      progressBar.set(total,
        'جاري رفع الصور — ' + done + ' من ' + files.length +
        (awaiting ? ' · بانتظار تأكيد الخادم…' : ' (' + Math.round(total * 100) + '%)'));
      button.textContent = 'جاري رفع الصور… ' + done + ' من ' + files.length;
    };

    progressBar.show('جاري تجهيز الصور…');
    const worker = async () => {
      while (next < files.length) {
        const i = next++;
        const image = await imageBase64(files[i]);
        await apiUpload('uploadOperationImage', {
          recordType, recordId, index: i + 1, total: files.length,
          mimeType: image.mimeType, byteLength: image.byteLength, base64: image.base64
        }, r => { fraction[i] = r; paint(); });
        fraction[i] = 1; done++; paint();
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(2, files.length) }, worker));
      progressBar.set(1, 'اكتمل رفع ' + files.length + ' صورة');
      setTimeout(() => progressBar.hide(), 900);
    } catch (error) {
      progressBar.hide();
      throw error;
    }
    return files.length;
  };

  // ------------------------------------------- رفع المحضر المصادق (PDF)
  const pdfBase64 = async file => {
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name || '')) throw new Error('ارفع المحضر بصيغة PDF');
    if (file.size < 1) throw new Error('ملف PDF فارغ');
    if (file.size > 10 * 1024 * 1024) throw new Error('حجم ملف PDF يتجاوز 10 ميجابايت');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  };

  const bindCertifiedUpload = (inputId, buttonId, recordType, getRecordId, hashName) => {
    const input = document.querySelector(inputId), button = document.querySelector(buttonId);
    if (!input || !button) return;
    input.onchange = async event => {
      const file = event.target.files?.[0], recordId = getRecordId();
      if (!file || !recordId) return;
      const original = button.textContent;
      button.disabled = true;
      button.textContent = 'جاري رفع المحضر المصادق عليه…';
      try {
        const base64 = await pdfBase64(file);
        progressBar.show('جاري رفع المحضر المصادق عليه…');
        const saved = await apiUpload('uploadCertifiedRecord',
          { recordType, recordId, mimeType: 'application/pdf', base64 },
          // v2.5.5 — نفس علّة عدّاد الصور: 100% كانت تعني «أُرسلت البايتات»
          // لا «حُفظ الملف». الإرسال 90% والتأكيد آخر 10%.
          r => progressBar.set(r * 0.9, r >= 1
            ? 'اكتمل الإرسال — بانتظار تأكيد الخادم…'
            : 'جاري رفع المحضر المصادق عليه — ' + Math.round(r * 90) + '%'));
        progressBar.set(1, 'اكتمل الرفع وتأكيد الحفظ');
        setTimeout(() => progressBar.hide(), 900);
        const records = recordType === 'handover' ? handoverLog : assetLog;
        const record = records.find(item => item.id === recordId);
        if (record) {
          record.status = saved.status || 'مصادق عليه';
          record.certifiedUrl = saved.url || '';
          record.certifiedFileName = saved.fileName || file.name;
        }
        toast('تم رفع المحضر المصادق عليه وحفظ حالته في Google Sheets');
        setTimeout(() => reloadWith(hashName + '=' + encodeURIComponent(recordId)), 700);
      } catch (error) {
        progressBar.hide();
        toast(error.message || 'تعذر رفع المحضر المصادق عليه');
        button.disabled = false;
        button.textContent = original;
        input.value = '';
      }
    };
  };
  bindCertifiedUpload('#certifiedFileInput', '#uploadCertified', 'handover', () => activeReceiptId, 'handover-record');
  bindCertifiedUpload('#assetCertifiedFileInput', '#uploadAssetCertified', 'transfer', () => activeAssetReceiptId, 'asset-record');

  if (window.FLEET_DATA?.checklistState) {
    localStorage.setItem('vehicleChecklistState', JSON.stringify(window.FLEET_DATA.checklistState));
  }

  // =========================================================== محضر العهدة
  const handover = document.querySelector('#handoverForm');
  handover.onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button.primary');
    if (form.dataset.saving === '1') return;

    const d = new FormData(form), v = vehicleById(d.get('vehicle')), to = holderById(d.get('toId'));
    let images;
    try { images = selectedImages(document.querySelector('#handoverImages')); }
    catch (error) { toast(error.message); return; }
    if (!v || !to) return;
    if (v.status === 'مؤرشفة') { toast('المركبة مؤرشفة ولا يمكن نقل عهدتها'); return; }
    if (d.get('fromId') === to.id) { toast('المركبة موجودة أصلًا لدى المستلم المختار'); return; }

    const currentOdometer = Number(v.km || 0), enteredOdometer = Number(d.get('odometer'));
    if (!Number.isFinite(enteredOdometer) || enteredOdometer < 0) { toast('أدخل قراءة عداد صحيحة'); return; }
    if (enteredOdometer < currentOdometer) {
      toast('قراءة العداد لا يمكن أن تقل عن القراءة الحالية: ' + currentOdometer.toLocaleString('en-US') + ' كم');
      return;
    }

    // V2 يتطلب currentStatus (وليس status) في كل نتيجة تشييك
    const allResults = [...form.querySelectorAll('#checklist .check')].map(row => {
      const select = row.querySelector('select');
      const currentStatus = select.value || 'لا ملاحظات';
      const previousStatus = row.dataset.previous || 'لا ملاحظات';
      const neutralStatus = (select.options[0] && select.options[0].value) || 'لا ملاحظات';
      return {
        checkItemId: row.dataset.ref,
        previousStatus,
        currentStatus,
        neutralStatus,
        note: '',
        requiresAction: currentStatus !== 'لا ملاحظات'
      };
    });
    const changed = allResults.filter(item => item.currentStatus !== item.previousStatus);
    // ورقة «نتائج التشييك» سجلّ فروقات: لا يُرسل إلا ما تغيّر فعلًا (يفرضه الخادم أيضًا)
    const results = changed.map(item => ({
      checkItemId: item.checkItemId, previousStatus: item.previousStatus,
      currentStatus: item.currentStatus, note: item.note, requiresAction: item.requiresAction
    }));

    // v2.5.2 — ما سيظهر فعلًا في المحضر المطبوع: نفس قاعدة receiptExceptions حرفيًا،
    // أي بند حالته تخالف الحالة المحايدة (ولو كانت ملاحظة موروثة لم تُمَس)، أو تغيّر اليوم.
    const printedItems = allResults.filter(item =>
      item.currentStatus !== item.neutralStatus || item.currentStatus !== item.previousStatus);
    const carriedNotes = printedItems.filter(item =>
      item.currentStatus === item.previousStatus).length;

    const confirmation = results.length
      ? `سيُسجَّل ${results.length} تغييرًا في هذا المحضر، وسيظهر في المحضر المطبوع ${printedItems.length} بندًا` +
        (carriedNotes ? ` (منها ${carriedNotes} ملاحظة قائمة من محضر سابق لم تتغيّر)` : '') +
        '. هل تريد الاعتماد؟'
      : printedItems.length
        ? `لم تتغيّر أي حالة في هذا المحضر، ويبقى ${printedItems.length} بندًا عليه ملاحظة قائمة من محضر سابق — وستظهر في المحضر المطبوع. هل تريد الاعتماد؟`
        : 'لم تتغيّر أي حالة، وجميع البنود بلا ملاحظات. هل تريد اعتماد المحضر؟';
    if (!window.confirm(confirmation)) return;

    form.dataset.saving = '1';
    button.disabled = true;
    button.textContent = 'جاري إنشاء المحضر…';

    try {
      const from = holderById(d.get('fromId'));
      form.dataset.requestId = form.dataset.requestId || requestId('HO');

      const saved = await api('createHandover', {
        clientRequestId: form.dataset.requestId,
        vehicleId: v.id,
        fromHolderId: d.get('fromId'),
        fromHolderNameOverride: v.rep,
        fromHolderIdNumber: from?.identity || '',
        toHolderId: to.id,
        toHolderNameOverride: to.name,
        toHolderIdNumber: to.identity || '',
        odometerReading: enteredOdometer,
        notes: d.get('notes') || '',
        results
      });

      // V2 يُرجع {handover, vehicle, fromHolder, toHolder, duplicate}
      const handoverId = saved?.handover?.HandoverID;
      if (!handoverId) throw new Error('تعذر قراءة رقم المحضر من استجابة الخادم');
      form.dataset.createdRecordId = handoverId;

      const uploaded = await uploadImages('handover', handoverId, images, button);
      const handoverCount = handoverLog.filter(item => item.vehicleId === v.id).length + 1;
      let message = 'تم إنشاء محضر التسليم والاستلام ' + handoverId + ' وحفظه في Google Sheets'
        + (uploaded ? ' ورفع ' + uploaded + ' صورة' : '');
      if (handoverCount % 3 === 0) {
        message += '\n\nتذكير: بلغت المركبة ' + handoverCount + ' عمليات تسليم؛ راجع صورها القديمة في مجلد Drive.';
      }
      showSavedMessage(form, button, message);
      setTimeout(() => reloadWith('handover-record=' + encodeURIComponent(handoverId)), 1200);

    } catch (error) {
      const createdId = form.dataset.createdRecordId;
      if (createdId) {
        showSavedMessage(form, button, 'تم حفظ المحضر ' + createdId + ' بنجاح، وتعذر تأكيد رفع جميع الصور. لا تعد إنشاء المحضر');
        toast(error.message || 'تعذر تأكيد رفع الصور');
        setTimeout(() => reloadWith('handover-record=' + encodeURIComponent(createdId)), 1600);
        return;
      }
      toast(error.message || 'تعذر حفظ المحضر');
      form.dataset.saving = '0';
      button.hidden = false;
      button.disabled = false;
      button.textContent = 'اعتماد محضر التسليم والاستلام';
    }
  };

  // ========================================================== نقل الأصول
  const asset = document.querySelector('#assetForm');
  const assetRows = document.querySelector('#assetRows'),
    assetTemplate = document.querySelector('#assetRowTemplate'),
    assetOptions = ['بطارية1', 'بطارية2', 'كفر', 'جنط', 'كفر سبير', 'جنط سبير', 'طفاية', 'حقيبة السلامة', 'عفريتة', 'عدة', 'مضخة بنزين', 'مضخة كهرباء', 'سلم', 'كاميرا1', 'كاميرا2', 'جهاز تتبع', 'واير سحب', 'كيبل اشتراك', 'أخرى'];

  const updateAssetCount = () => {
    const count = assetRows.querySelectorAll('.asset-transfer-row').length;
    document.querySelector('#assetCountBadge').textContent = count === 1 ? 'أصل واحد' : count + ' أصول';
  };

  const addAssetRow = (type = '', condition = 'جيد') => {
    const row = assetTemplate.content.firstElementChild.cloneNode(true),
      kind = row.querySelector('.asset-kind'),
      other = row.querySelector('.other-asset');
    kind.innerHTML = '<option value="">اختر الأصل</option>' + assetOptions.map(value => `<option>${value}</option>`).join('');
    kind.value = type;
    row.querySelector('.asset-condition').value = condition;
    kind.onchange = () => {
      other.hidden = kind.value !== 'أخرى';
      other.required = kind.value === 'أخرى';
      if (other.hidden) other.value = '';
    };
    row.querySelector('.remove-asset').onclick = () => {
      if (assetRows.children.length === 1) { toast('يجب إبقاء أصل واحد على الأقل'); return; }
      row.remove();
      updateAssetCount();
    };
    assetRows.appendChild(row);
    updateAssetCount();
    return row;
  };
  document.querySelector('#addAssetRow').onclick = () => addAssetRow();
  if (!assetRows.querySelector('.asset-transfer-row')) addAssetRow();

  asset.onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button.primary');
    if (form.dataset.saving === '1') return;

    const d = new FormData(form);
    let images;
    try { images = selectedImages(document.querySelector('#assetImages')); }
    catch (error) { toast(error.message); return; }
    if (d.get('source') === d.get('target')) { toast('اختر مركبتين مختلفتين لإتمام النقل'); return; }

    const assets = [...form.querySelectorAll('.asset-transfer-row')].map(row => {
      const selected = row.querySelector('.asset-kind').value;
      return {
        assetType: selected === 'أخرى' ? row.querySelector('.other-asset').value.trim() : selected,
        assetStatus: row.querySelector('.asset-condition').value
      };
    });
    if (!assets.length || assets.some(item => !item.assetType)) { toast('أكمل بيانات جميع الأصول'); return; }
    if (assets.length > 20) { toast('الحد الأعلى 20 أصلًا في المحضر الواحد'); return; }

    form.dataset.saving = '1';
    button.disabled = true;
    button.textContent = 'جاري إنشاء المحضر…';

    try {
      form.dataset.requestId = form.dataset.requestId || requestId('AT');
      const saved = await api('createAssetTransfer', {
        clientRequestId: form.dataset.requestId,
        fromVehicleId: d.get('source'),
        toVehicleId: d.get('target'),
        assets,
        notes: d.get('notes') || ''
      });

      // V2 يُرجع {transferId, transfers, assetCount, status, duplicate}
      const transferId = saved?.transferId;
      if (!transferId) throw new Error('تعذر قراءة رقم المحضر من استجابة الخادم');
      form.dataset.createdRecordId = transferId;

      const uploaded = await uploadImages('transfer', transferId, images, button);
      const message = 'تم إنشاء محضر نقل الأصول ' + transferId + ' وحفظ '
        + (saved.assetCount || assets.length) + ' أصل/أصول في Google Sheets'
        + (uploaded ? ' ورفع ' + uploaded + ' صورة' : '');
      showSavedMessage(form, button, message);
      setTimeout(() => reloadWith('asset-record=' + encodeURIComponent(transferId)), 1200);

    } catch (error) {
      const createdId = form.dataset.createdRecordId;
      if (createdId) {
        showSavedMessage(form, button, 'تم حفظ محضر نقل الأصول ' + createdId + ' بنجاح، وتعذر تأكيد رفع جميع الصور. لا تعد إنشاء المحضر');
        toast(error.message || 'تعذر تأكيد رفع الصور');
        setTimeout(() => reloadWith('asset-record=' + encodeURIComponent(createdId)), 1600);
        return;
      }
      toast(error.message || 'تعذر حفظ نقل الأصول');
      form.dataset.saving = '0';
      button.hidden = false;
      button.disabled = false;
      button.textContent = 'إنشاء محضر نقل الأصول';
    }
  };
})();
