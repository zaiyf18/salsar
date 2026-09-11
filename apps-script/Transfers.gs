/**
 * سلسار V2 — Transfers.gs
 * =====================================
 * منطق نقل الأصول بين المركبات — دالة إنشاء واحدة فقط (createAssetTransfer_)،
 * مطابقة لمنطق النظام القديم (createTransfer_ في Code.gs)، بدون إلغاء أو تاريخ عرض،
 * مع ربط FromHolderID/ToHolderID بالمعرّف بدل الاسم فقط.
 */

function createAssetTransfer_(payload) {
  payload = payload || {};

  const props = PropertiesService.getScriptProperties();
  const reqKey = payload.clientRequestId ? 'SALSAR_REQ_' + payload.clientRequestId : null;
  if (reqKey) {
    const existingId = props.getProperty(reqKey);
    if (existingId) {
      const existingRows = all_(SALSAR.SHEETS.transfers, 'TransferID', existingId);
      return {
        transferId: existingId,
        duplicate: true,
        assetCount: existingRows.length,
        status: existingRows[0] ? existingRows[0]['الحالة'] : ''
      };
    }
  }

  ref_(payload.fromVehicleId, /^V-\d{3}$/i, 'المركبة المصدر');
  ref_(payload.toVehicleId, /^V-\d{3}$/i, 'المركبة الوجهة');
  if (payload.fromVehicleId === payload.toVehicleId) {
    throw new Error('يجب اختيار مركبتين مختلفتين');
  }

  return locked_(function() {
    const from = one_(SALSAR.SHEETS.vehicles, 'VehicleID', payload.fromVehicleId);
    const to = one_(SALSAR.SHEETS.vehicles, 'VehicleID', payload.toVehicleId);
    if (!from || !to) throw new Error('إحدى المركبتين غير موجودة');

    const transferId = nextId_('AT', SALSAR.SHEETS.transfers, 'TransferID');

    const assets = (Array.isArray(payload.assets) && payload.assets.length)
      ? payload.assets
      : [{ assetType: payload.assetType, assetStatus: payload.assetStatus }];

    if (assets.length > 20) {
      throw new Error('الحد الأعلى 20 أصلًا في المحضر الواحد');
    }

    const rows = assets.map(function(asset) {
      return {
        TransferID: transferId,
        'التاريخ': date_(),
        'نوع الأصل': required_(asset.assetType, 'نوع الأصل'),
        'حالة الأصل': required_(asset.assetStatus, 'حالة الأصل'),
        FromVehicleID: payload.fromVehicleId,
        'من اللوحة': from['رقم اللوحة عربي'] || from['رقم اللوحة إنجليزي'] || '',
        FromHolderID: from.CurrentHolderID || '',
        'المسلّم': from['العهدة الحالية'] || '',
        ToVehicleID: payload.toVehicleId,
        'إلى اللوحة': to['رقم اللوحة عربي'] || to['رقم اللوحة إنجليزي'] || '',
        ToHolderID: to.CurrentHolderID || '',
        'المستلم': to['العهدة الحالية'] || '',
        'سبب النقل وملاحظات': payload.notes || '',
        'الحالة': 'بانتظار التصديق',
        CertifiedFileID: ''
      };
    });

    appendMany_(SALSAR.SHEETS.transfers, rows);

    audit_(
      'نقل أصول',
      'نقل أصل',
      transferId,
      payload.fromVehicleId + ' ← ' + payload.toVehicleId + ' (' + assets.length + ')',
      payload.actorEmail
    );

    if (reqKey) props.setProperty(reqKey, transferId);

    return {
      transferId: transferId,
      assetCount: assets.length,
      status: 'بانتظار التصديق'
    };
  });
}

/**
 * معالج (handler) الفعل createAssetTransfer — يُستدعى من dispatch_.
 */
function handleCreateAssetTransfer_(r) {
  const payload = (r && r.payload) || {};
  const result = createAssetTransfer_(payload);
  const transfers = all_(SALSAR.SHEETS.transfers, 'TransferID', result.transferId);

  return {
    transferId: result.transferId,
    transfers: transfers,
    assetCount: result.assetCount,
    status: result.status,
    duplicate: !!result.duplicate
  };
}