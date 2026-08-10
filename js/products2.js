'use strict';
// =====================================================
// products2.js — 제품마스터정보2
// Firebase 컬렉션: products2
// =====================================================

var _p2AllData = [];
var _p2EditingId = null;
var _p2DetailId = null;
var _p2BoxRowCount = 1;
var _p2PendingRows = []; // 엑셀 미리보기 임시 데이터

// ── 초기화 ──
document.addEventListener('DOMContentLoaded', function() {
  p2LoadAll();
});

// ── 전체 로드 ──
async function p2LoadAll() {
  try {
    var data = await apiGetAll('products2');
    _p2AllData = data || [];
    p2RenderKpi();
    p2RenderTable();
  } catch(e) {
    console.error('products2 로드 오류:', e);
    showToast('데이터 로드 실패: ' + e.message, 'error');
  }
}

// ── KPI ──
function p2RenderKpi() {
  var total = _p2AllData.length;
  var own = _p2AllData.filter(function(r) { return r.product_type === '자사'; }).length;
  var oem = _p2AllData.filter(function(r) { return r.product_type === 'OEM'; }).length;
  var imp = _p2AllData.filter(function(r) { return r.product_type === '수입'; }).length;
  var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
  set('p2TotalCount', total);
  set('p2OwnCount', own);
  set('p2OemCount', oem);
  set('p2ImpCount', imp);
}

// ── 테이블 렌더링 ──
function p2RenderTable() {
  var q = ((document.getElementById('p2Search') || {}).value || '').toLowerCase();
  var ft = ((document.getElementById('p2FilterType') || {}).value || '');
  var tbody = document.getElementById('p2TableBody');
  if (!tbody) return;

  var rows = _p2AllData.filter(function(r) {
    if (ft && r.product_type !== ft) return false;
    if (q) {
      var name = (r.product_name || '').toLowerCase();
      var code = (r.product_code || '').toLowerCase();
      var own = (r.own_code || '').toLowerCase();
      if (!name.includes(q) && !code.includes(q) && !own.includes(q)) return false;
    }
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#aaa;padding:40px">등록된 제품이 없습니다.</td></tr>';
    var cnt = document.getElementById('p2TableCount');
    if (cnt) cnt.textContent = '0건';
    return;
  }

  tbody.innerHTML = rows.map(function(r) {
    var typeBadge = r.product_type === '자사' ? '<span style="background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:10px;font-size:11px">자사</span>'
      : r.product_type === 'OEM' ? '<span style="background:#e3f2fd;color:#1565c0;padding:2px 8px;border-radius:10px;font-size:11px">OEM</span>'
      : r.product_type === '수입' ? '<span style="background:#fff8e1;color:#f57f17;padding:2px 8px;border-radius:10px;font-size:11px">수입</span>'
      : '<span style="background:#f5f5f5;color:#666;padding:2px 8px;border-radius:10px;font-size:11px">' + (r.product_type || '-') + '</span>';
    return '<tr onclick="p2OpenDetail(\'' + r.id + '\')" data-id="' + r.id + '">'
      + '<td>' + (r.own_code || '-') + '</td>'
      + '<td style="font-family:monospace;font-size:12px">' + (r.product_code || '-') + '</td>'
      + '<td style="font-weight:600">' + (r.product_name || '-') + '</td>'
      + '<td>' + typeBadge + '</td>'
      + '<td style="text-align:right">' + (r.qty_per_box || '-') + '</td>'
      + '<td>' + (r.storage || '-') + '</td>'
      + '<td>' + (r.supplier_name || '-') + '</td>'
      + '<td style="text-align:right">' + (r.min_stock != null && r.min_stock !== '' ? r.min_stock : '-') + '</td>'
      + '<td onclick="event.stopPropagation()" style="text-align:center">'
        + '<button onclick="p2OpenModal(\'' + r.id + '\')" style="padding:3px 8px;background:#e8f5e9;color:#2e7d32;border:1px solid #c8e6c9;border-radius:4px;font-size:11px;cursor:pointer;margin-right:4px"><i class="fas fa-edit"></i></button>'
        + '<button onclick="p2DeleteProduct(\'' + r.id + '\',\'' + (r.product_name || '').replace(/'/g, "\\'") + '\')" style="padding:3px 8px;background:#ffebee;color:#c62828;border:1px solid #ef9a9a;border-radius:4px;font-size:11px;cursor:pointer"><i class="fas fa-trash"></i></button>'
      + '</td>'
      + '</tr>';
  }).join('');

  var cnt = document.getElementById('p2TableCount');
  if (cnt) cnt.textContent = rows.length + '건';
}

// ── 모달 열기 ──
function p2OpenModal(id) {
  _p2EditingId = id || null;
  _p2BoxRowCount = 1;
  var form = document.getElementById('p2Form');
  if (form) form.reset();
  // Box 행 초기화
  var boxBody = document.getElementById('p2BoxBody');
  if (boxBody) {
    boxBody.innerHTML = '<tr>'
      + '<td><input type="text" id="p2Box0Code" placeholder="Box 상품코드" /></td>'
      + '<td><input type="text" id="p2Box0Name" placeholder="Box 상품명" /></td>'
      + '<td><input type="number" id="p2Box0Qty" min="1" step="1" placeholder="예: 30" style="width:80px" /></td>'
      + '<td></td>'
      + '</tr>';
    _p2BoxRowCount = 1;
  }
  // 번들 초기화
  for (var i = 0; i < 4; i++) {
    var cEl = document.getElementById('p2Bundle' + i + 'Code');
    var nEl = document.getElementById('p2Bundle' + i + 'Name');
    var qEl = document.getElementById('p2Bundle' + i + 'Qty');
    if (cEl) cEl.value = '';
    if (nEl) nEl.value = '';
    if (qEl) qEl.value = [2, 3, 4, 5][i];
  }

  var title = document.getElementById('p2ModalTitle');
  if (id) {
    var rec = _p2AllData.find(function(r) { return r.id === id; });
    if (rec) {
      if (title) title.innerHTML = '<i class="fas fa-edit" style="color:var(--primary)"></i> 제품 수정';
      p2FillForm(rec);
    }
  } else {
    if (title) title.innerHTML = '<i class="fas fa-tag" style="color:var(--primary)"></i> 신규 제품 등록';
  }
  var modal = document.getElementById('p2Modal');
  if (modal) modal.style.display = 'flex';
}

// ── 폼 채우기 (수정 시) ──
function p2FillForm(rec) {
  var set = function(id, v) { var el = document.getElementById(id); if (el) el.value = v || ''; };
  set('p2OwnCode', rec.own_code);
  set('p2ProductCode', rec.product_code);
  set('p2ProductName', rec.product_name);
  set('p2CostPrice', rec.cost_price);
  set('p2Weight', rec.weight);
  set('p2QtyPerBox', rec.qty_per_box);
  set('p2BoxPerPallet', rec.box_per_pallet);
  set('p2VatType', rec.vat_type);
  set('p2ProductType', rec.product_type);
  set('p2ShelfLife', rec.shelf_life);
  set('p2Storage', rec.storage);
  set('p2StdUnit', rec.std_unit);
  set('p2Haccp', rec.haccp);
  set('p2MinStock', rec.min_stock);
  set('p2SupplierCode', rec.supplier_code);
  set('p2SupplierName', rec.supplier_name);
  set('p2SupplierAddr', rec.supplier_addr);
  set('p2SupplierContact', rec.supplier_contact);
  set('p2SupplierPhone', rec.supplier_phone);
  set('p2BoxW', rec.box_w);
  set('p2BoxD', rec.box_d);
  set('p2BoxH', rec.box_h);
  set('p2BoxContent', rec.box_content);
  set('p2BoxContentUnit', rec.box_content_unit);
  set('p2BoxTotalWeight', rec.box_total_weight);
  set('p2Remarks', rec.remarks);

  // 번들
  var bundles = rec.bundles || [];
  for (var i = 0; i < 4; i++) {
    var b = bundles[i] || {};
    var cEl = document.getElementById('p2Bundle' + i + 'Code');
    var nEl = document.getElementById('p2Bundle' + i + 'Name');
    var qEl = document.getElementById('p2Bundle' + i + 'Qty');
    if (cEl) cEl.value = b.code || '';
    if (nEl) nEl.value = b.name || '';
    if (qEl) qEl.value = b.qty || [2, 3, 4, 5][i];
  }

  // Box 행
  var boxes = rec.box_items || [];
  var boxBody = document.getElementById('p2BoxBody');
  if (boxBody && boxes.length > 0) {
    boxBody.innerHTML = boxes.map(function(bx, idx) {
      return '<tr>'
        + '<td><input type="text" id="p2Box' + idx + 'Code" value="' + (bx.code || '') + '" placeholder="Box 상품코드" /></td>'
        + '<td><input type="text" id="p2Box' + idx + 'Name" value="' + (bx.name || '') + '" placeholder="Box 상품명" /></td>'
        + '<td><input type="number" id="p2Box' + idx + 'Qty" value="' + (bx.qty || '') + '" min="1" step="1" placeholder="예: 30" style="width:80px" /></td>'
        + '<td><button type="button" class="del-row-btn" onclick="p2DelBoxRow(this)"><i class="fas fa-minus"></i></button></td>'
        + '</tr>';
    }).join('');
    _p2BoxRowCount = boxes.length;
  }
}

// ── 모달 닫기 ──
function p2CloseModal() {
  var modal = document.getElementById('p2Modal');
  if (modal) modal.style.display = 'none';
  _p2EditingId = null;
}

// ── Box 행 추가 ──
function p2AddBoxRow() {
  var boxBody = document.getElementById('p2BoxBody');
  if (!boxBody) return;
  var idx = _p2BoxRowCount;
  var tr = document.createElement('tr');
  tr.innerHTML = '<td><input type="text" id="p2Box' + idx + 'Code" placeholder="Box 상품코드" /></td>'
    + '<td><input type="text" id="p2Box' + idx + 'Name" placeholder="Box 상품명" /></td>'
    + '<td><input type="number" id="p2Box' + idx + 'Qty" min="1" step="1" placeholder="예: 30" style="width:80px" /></td>'
    + '<td><button type="button" class="del-row-btn" onclick="p2DelBoxRow(this)"><i class="fas fa-minus"></i></button></td>';
  boxBody.appendChild(tr);
  _p2BoxRowCount++;
}

// ── Box 행 삭제 ──
function p2DelBoxRow(btn) {
  var tr = btn.closest('tr');
  if (tr) tr.remove();
}

// ── 폼 데이터 수집 ──
function p2GetFormData() {
  var get = function(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
  var getNum = function(id) { var v = get(id); return v === '' ? null : Number(v); };

  // 번들
  var bundles = [];
  for (var i = 0; i < 4; i++) {
    var code = get('p2Bundle' + i + 'Code');
    var name = get('p2Bundle' + i + 'Name');
    var qty = getNum('p2Bundle' + i + 'Qty');
    if (code || name) bundles.push({ code: code, name: name, qty: qty || [2,3,4,5][i] });
  }

  // Box 상품
  var boxItems = [];
  var boxBody = document.getElementById('p2BoxBody');
  if (boxBody) {
    var rows = boxBody.querySelectorAll('tr');
    rows.forEach(function(tr, idx) {
      var codeEl = tr.querySelector('input[id^="p2Box"][id$="Code"]');
      var nameEl = tr.querySelector('input[id^="p2Box"][id$="Name"]');
      var qtyEl  = tr.querySelector('input[id^="p2Box"][id$="Qty"]');
      var c = codeEl ? codeEl.value.trim() : '';
      var n = nameEl ? nameEl.value.trim() : '';
      var q = qtyEl  ? Number(qtyEl.value) : null;
      if (c || n) boxItems.push({ code: c, name: n, qty: q });
    });
  }

  return {
    own_code:         get('p2OwnCode'),
    product_code:     get('p2ProductCode'),
    product_name:     get('p2ProductName'),
    cost_price:       getNum('p2CostPrice'),
    weight:           getNum('p2Weight'),
    qty_per_box:      getNum('p2QtyPerBox'),
    box_per_pallet:   getNum('p2BoxPerPallet'),
    vat_type:         get('p2VatType'),
    product_type:     get('p2ProductType'),
    shelf_life:       get('p2ShelfLife'),
    storage:          get('p2Storage'),
    std_unit:         get('p2StdUnit'),
    haccp:            get('p2Haccp'),
    min_stock:        getNum('p2MinStock'),
    supplier_code:    get('p2SupplierCode'),
    supplier_name:    get('p2SupplierName'),
    supplier_addr:    get('p2SupplierAddr'),
    supplier_contact: get('p2SupplierContact'),
    supplier_phone:   get('p2SupplierPhone'),
    box_w:            getNum('p2BoxW'),
    box_d:            getNum('p2BoxD'),
    box_h:            getNum('p2BoxH'),
    box_content:      getNum('p2BoxContent'),
    box_content_unit: get('p2BoxContentUnit'),
    box_total_weight: getNum('p2BoxTotalWeight'),
    bundles:          bundles,
    box_items:        boxItems,
    remarks:          get('p2Remarks')
  };
}

// ── 저장 ──
async function p2HandleSubmit(e) {
  e.preventDefault();
  var data = p2GetFormData();
  if (!data.own_code) { showToast('당사 분류코드를 입력하세요.', 'error'); return; }
  if (!data.product_name) { showToast('상품명을 입력하세요.', 'error'); return; }

  try {
    var prevName = null;
    if (_p2EditingId) {
      var prev = _p2AllData.find(function(r) { return r.id === _p2EditingId; });
      if (prev) prevName = prev.product_name;
      await apiPut('products2', _p2EditingId, data);
      showToast('수정되었습니다.', 'success');
      // 이름 변경 시 물류관리2 연동 갱신
      if (prevName && prevName !== data.product_name) {
        p2SyncLinkedCollections(prevName, data.product_name);
      }
    } else {
      data.created_at = new Date().toISOString();
      await apiPost('products2', data);
      showToast('등록되었습니다.', 'success');
    }
    p2CloseModal();
    await p2LoadAll();
  } catch(err) {
    showToast('저장 실패: ' + err.message, 'error');
  }
}

// ── 물류관리2 연동 갱신 (상품명 변경 시) ──
async function p2SyncLinkedCollections(oldName, newName) {
  var collections = ['lg2_inbound', 'lg2_outbound', 'lg2_audit'];
  for (var ci = 0; ci < collections.length; ci++) {
    try {
      var col = collections[ci];
      var recs = await apiGetAll(col);
      for (var ri = 0; ri < recs.length; ri++) {
        var r = recs[ri];
        if ((r.item_name || '').trim() === oldName.trim() && r.id) {
          await apiPut(col, r.id, { item_name: newName });
        }
      }
    } catch(e) {
      console.warn('연동 갱신 실패(' + collections[ci] + '):', e.message);
    }
  }
}

// ── 삭제 ──
async function p2DeleteProduct(id, name) {
  if (!confirm('"' + name + '"을(를) 삭제하시겠습니까?\n관련 물류관리2 데이터도 함께 삭제됩니다.')) return;
  try {
    await apiDelete('products2', id);
    // 물류관리2 연동 삭제
    var collections = ['lg2_inbound', 'lg2_outbound', 'lg2_audit'];
    for (var ci = 0; ci < collections.length; ci++) {
      try {
        var recs = await apiGetAll(collections[ci]);
        for (var ri = 0; ri < recs.length; ri++) {
          if ((recs[ri].item_name || '').trim() === name.trim() && recs[ri].id) {
            await apiDelete(collections[ci], recs[ri].id);
          }
        }
      } catch(e) { console.warn('연동 삭제 실패:', e.message); }
    }
    showToast('삭제되었습니다.', 'success');
    await p2LoadAll();
  } catch(err) {
    showToast('삭제 실패: ' + err.message, 'error');
  }
}

// ══════════════════════════════════════════════════
// 상세보기 패널
// ══════════════════════════════════════════════════
function p2OpenDetail(id) {
  var rec = _p2AllData.find(function(r) { return r.id === id; });
  if (!rec) return;
  _p2DetailId = id;

  var setEl = function(elId, v) { var el = document.getElementById(elId); if (el) el.textContent = v || '-'; };
  setEl('p2DetailCode', (rec.own_code || '') + (rec.product_code ? '  |  ' + rec.product_code : ''));
  setEl('p2DetailName', rec.product_name || '-');

  var body = document.getElementById('p2DetailBody');
  if (!body) return;

  var row = function(label, value) {
    return '<div class="p2-detail-item"><label>' + label + '</label><span>' + (value || '-') + '</span></div>';
  };

  var bundleHtml = '';
  if (rec.bundles && rec.bundles.length > 0) {
    bundleHtml = '<table class="p2-bundle-table"><thead><tr><th>구분</th><th>상품코드</th><th>상품명</th><th>번들기준</th></tr></thead><tbody>'
      + rec.bundles.map(function(b, i) {
          return '<tr><td>자코드 ' + (i+1) + '</td><td>' + (b.code||'-') + '</td><td>' + (b.name||'-') + '</td><td>' + (b.qty||'-') + '개</td></tr>';
        }).join('')
      + '</tbody></table>';
  } else {
    bundleHtml = '<span style="color:#aaa;font-size:12px">등록된 번들 없음</span>';
  }

  var boxHtml = '';
  if (rec.box_items && rec.box_items.length > 0) {
    boxHtml = '<table class="p2-box-table"><thead><tr><th>Box 상품코드</th><th>Box 상품명</th><th>박스 입수</th></tr></thead><tbody>'
      + rec.box_items.map(function(b) {
          return '<tr><td>' + (b.code||'-') + '</td><td>' + (b.name||'-') + '</td><td>' + (b.qty||'-') + ' EA</td></tr>';
        }).join('')
      + '</tbody></table>';
  } else {
    boxHtml = '<span style="color:#aaa;font-size:12px">등록된 Box 상품 없음</span>';
  }

  body.innerHTML = ''
    + '<div class="p2-detail-section"><h4>📋 기본정보</h4>'
    + '<div class="p2-detail-grid">'
    + row('GS리테일 분류코드', rec.gs_code)
    + row('당사 분류코드', rec.own_code)
    + row('상품코드', rec.product_code)
    + row('상품구분', rec.product_type)
    + row('원가', rec.cost_price != null ? rec.cost_price.toLocaleString() + '원' : null)
    + row('중량', rec.weight != null ? rec.weight + 'g' : null)
    + row('박스입수', rec.qty_per_box != null ? rec.qty_per_box + ' EA' : null)
    + row('파렛트입수', rec.box_per_pallet != null ? rec.box_per_pallet + ' 박스' : null)
    + row('부가세구분', rec.vat_type)
    + row('소비기한', rec.shelf_life)
    + row('보관조건', rec.storage)
    + row('표준단위', rec.std_unit)
    + row('HACCP', rec.haccp)
    + row('적정재고량', rec.min_stock != null ? rec.min_stock + ' EA' : null)
    + '</div></div>'
    + '<div class="p2-detail-section"><h4>📐 박스규격</h4>'
    + '<div class="p2-detail-grid">'
    + row('가로', rec.box_w != null ? rec.box_w + ' cm' : null)
    + row('세로', rec.box_d != null ? rec.box_d + ' cm' : null)
    + row('높이', rec.box_h != null ? rec.box_h + ' cm' : null)
    + row('내용량', rec.box_content != null ? rec.box_content + ' ' + (rec.box_content_unit || '') : null)
    + row('총중량', rec.box_total_weight != null ? rec.box_total_weight + ' g' : null)
    + '</div></div>'
    + '<div class="p2-detail-section"><h4>🏢 협력사 정보</h4>'
    + '<div class="p2-detail-grid">'
    + row('협력사코드', rec.supplier_code)
    + row('협력사명', rec.supplier_name)
    + row('주소', rec.supplier_addr)
    + row('담당자', rec.supplier_contact)
    + row('연락처', rec.supplier_phone)
    + '</div></div>'
    + '<div class="p2-detail-section"><h4>🔗 자코드 (번들 상품)</h4>' + bundleHtml + '</div>'
    + '<div class="p2-detail-section"><h4>📦 Box 상품코드</h4>' + boxHtml + '</div>'
    + (rec.remarks ? '<div class="p2-detail-section"><h4>📝 비고</h4><span style="font-size:13px;color:#333">' + rec.remarks + '</span></div>' : '');

  var panel = document.getElementById('p2DetailPanel');
  var overlay = document.getElementById('p2DetailOverlay');
  if (panel) panel.classList.add('open');
  if (overlay) overlay.style.display = 'block';

  // 선택 행 강조
  document.querySelectorAll('#p2TableBody tr').forEach(function(tr) {
    tr.classList.toggle('selected', tr.dataset.id === id);
  });
}

function p2CloseDetail() {
  var panel = document.getElementById('p2DetailPanel');
  var overlay = document.getElementById('p2DetailOverlay');
  if (panel) panel.classList.remove('open');
  if (overlay) overlay.style.display = 'none';
  document.querySelectorAll('#p2TableBody tr').forEach(function(tr) { tr.classList.remove('selected'); });
  _p2DetailId = null;
}

function p2EditFromDetail() {
  if (_p2DetailId) {
    p2CloseDetail();
    p2OpenModal(_p2DetailId);
  }
}

// ══════════════════════════════════════════════════
// 엑셀 업로드 (드래그&드롭)
// ══════════════════════════════════════════════════
function p2DragOver(e) {
  e.preventDefault();
  var zone = document.getElementById('p2DropZone');
  if (zone) zone.classList.add('drag-over');
}
function p2DragLeave(e) {
  var zone = document.getElementById('p2DropZone');
  if (zone) zone.classList.remove('drag-over');
}
function p2Drop(e) {
  e.preventDefault();
  var zone = document.getElementById('p2DropZone');
  if (zone) zone.classList.remove('drag-over');
  var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) p2HandleFile(file);
}
function p2HandleFile(file) {
  if (!file) return;
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리 로드 중입니다. 잠시 후 다시 시도하세요.', 'error'); return; }
  var reader = new FileReader();
  reader.onload = function(ev) {
    try {
      var wb = XLSX.read(ev.target.result, { type: 'array', cellDates: true });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // 헤더 행 찾기 (상품명 포함 행)
      var headerRowIdx = -1;
      for (var i = 0; i < Math.min(raw.length, 10); i++) {
        var rowStr = raw[i].join('|').toLowerCase();
        if (rowStr.includes('상품명') || rowStr.includes('product')) { headerRowIdx = i; break; }
      }
      if (headerRowIdx < 0) { showToast('헤더 행을 찾을 수 없습니다. 양식을 확인하세요.', 'error'); return; }

      var header = raw[headerRowIdx].map(function(h) { return String(h).trim(); });
      var dataRows = raw.slice(headerRowIdx + 1).filter(function(r) {
        return r.some(function(c) { return String(c).trim() !== ''; });
      });

      // 합계 행 제거
      dataRows = dataRows.filter(function(r) {
        var first = String(r[0] || '').trim();
        return !first.includes('합계') && !first.includes('total') && !first.includes('소계');
      });

      if (!dataRows.length) { showToast('데이터 행이 없습니다.', 'error'); return; }

      var col = function(names) {
        for (var ni = 0; ni < names.length; ni++) {
          for (var hi = 0; hi < header.length; hi++) {
            if (header[hi].includes(names[ni])) return hi;
          }
        }
        return -1;
      };

      var iOwnCode    = col(['당사 분류', '당사분류', 'own_code']);
      var iGsCode     = col(['GS', 'gs_code', '상품분류코드']);
      var iCode       = col(['상품코드', 'product_code']);
      var iName       = col(['상품명', 'product_name', 'name']);
      var iCost       = col(['원가', 'cost']);
      var iWeight     = col(['중량', 'weight']);
      var iQtyBox     = col(['박스입수', 'qty_per_box', '박스 입수']);
      var iBoxPallet  = col(['파렛트입수', 'box_per_pallet', '파렛트 입수']);
      var iVat        = col(['부가세', 'vat']);
      var iType       = col(['상품구분', 'product_type', '구분']);
      var iShelf      = col(['소비기한', 'shelf']);
      var iStorage    = col(['보관', 'storage']);
      var iUnit       = col(['표준단위', 'std_unit', '단위']);
      var iHaccp      = col(['HACCP', 'haccp']);
      var iSupCode    = col(['협력사코드', 'supplier_code']);
      var iSupName    = col(['협력사명', 'supplier_name', '협력사']);
      var iSupAddr    = col(['주소', 'addr']);
      var iSupContact = col(['담당자', 'contact']);
      var iSupPhone   = col(['연락처', 'phone']);
      var iMin        = col(['적정재고', 'min_stock']);
      var iRemarks    = col(['비고', 'remarks']);

      if (iName < 0) { showToast('상품명 컬럼을 찾을 수 없습니다.', 'error'); return; }

      _p2PendingRows = dataRows.map(function(r) {
        return {
          gs_code:          iGsCode >= 0 ? String(r[iGsCode] || '').trim() : '',
          own_code:         iOwnCode >= 0 ? String(r[iOwnCode] || '').trim() : '',
          product_code:     iCode >= 0 ? String(r[iCode] || '').trim() : '',
          product_name:     iName >= 0 ? String(r[iName] || '').trim() : '',
          cost_price:       iCost >= 0 ? (Number(r[iCost]) || null) : null,
          weight:           iWeight >= 0 ? (Number(r[iWeight]) || null) : null,
          qty_per_box:      iQtyBox >= 0 ? (Number(r[iQtyBox]) || null) : null,
          box_per_pallet:   iBoxPallet >= 0 ? (Number(r[iBoxPallet]) || null) : null,
          vat_type:         iVat >= 0 ? String(r[iVat] || '').trim() : '',
          product_type:     iType >= 0 ? String(r[iType] || '').trim() : '',
          shelf_life:       iShelf >= 0 ? String(r[iShelf] || '').trim() : '',
          storage:          iStorage >= 0 ? String(r[iStorage] || '').trim() : '',
          std_unit:         iUnit >= 0 ? String(r[iUnit] || '').trim() : '',
          haccp:            iHaccp >= 0 ? String(r[iHaccp] || '').trim() : '',
          min_stock:        iMin >= 0 ? (Number(r[iMin]) || null) : null,
          supplier_code:    iSupCode >= 0 ? String(r[iSupCode] || '').trim() : '',
          supplier_name:    iSupName >= 0 ? String(r[iSupName] || '').trim() : '',
          supplier_addr:    iSupAddr >= 0 ? String(r[iSupAddr] || '').trim() : '',
          supplier_contact: iSupContact >= 0 ? String(r[iSupContact] || '').trim() : '',
          supplier_phone:   iSupPhone >= 0 ? String(r[iSupPhone] || '').trim() : '',
          remarks:          iRemarks >= 0 ? String(r[iRemarks] || '').trim() : '',
          bundles: [],
          box_items: []
        };
      }).filter(function(r) { return r.product_name; });

      p2RenderUploadPreview();
    } catch(err) {
      showToast('엑셀 파싱 오류: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function p2RenderUploadPreview() {
  var preview = document.getElementById('p2UploadPreview');
  var title   = document.getElementById('p2PreviewTitle');
  var thead   = document.getElementById('p2PreviewHead');
  var tbody   = document.getElementById('p2PreviewBody');
  if (!preview || !thead || !tbody) return;

  if (title) title.textContent = '미리보기 — ' + _p2PendingRows.length + '건 (저장 버튼을 눌러 확정)';

  thead.innerHTML = '<tr>'
    + '<th>당사분류코드</th><th>상품코드</th><th>상품명</th><th>상품구분</th>'
    + '<th>원가</th><th>박스입수</th><th>보관</th><th>협력사명</th>'
    + '</tr>';

  tbody.innerHTML = _p2PendingRows.map(function(r, idx) {
    return '<tr>'
      + '<td>' + (r.own_code || '') + '</td>'
      + '<td>' + (r.product_code || '') + '</td>'
      + '<td style="font-weight:600">' + r.product_name + '</td>'
      + '<td>' + (r.product_type || '') + '</td>'
      + '<td style="text-align:right">' + (r.cost_price != null ? r.cost_price.toLocaleString() : '') + '</td>'
      + '<td style="text-align:right">' + (r.qty_per_box != null ? r.qty_per_box : '') + '</td>'
      + '<td>' + (r.storage || '') + '</td>'
      + '<td>' + (r.supplier_name || '') + '</td>'
      + '</tr>';
  }).join('');

  preview.style.display = 'block';
}

async function p2ConfirmUpload() {
  if (!_p2PendingRows.length) return;
  var saved = 0;
  try {
    for (var i = 0; i < _p2PendingRows.length; i++) {
      var rec = _p2PendingRows[i];
      rec.created_at = new Date().toISOString();
      await apiPost('products2', rec);
      saved++;
    }
    showToast(saved + '건 등록되었습니다.', 'success');
    p2CancelUpload();
    await p2LoadAll();
  } catch(e) {
    showToast('업로드 실패: ' + e.message, 'error');
  }
}

function p2CancelUpload() {
  _p2PendingRows = [];
  var preview = document.getElementById('p2UploadPreview');
  if (preview) preview.style.display = 'none';
  var fileInput = document.getElementById('p2FileInput');
  if (fileInput) fileInput.value = '';
}

// ══════════════════════════════════════════════════
// 엑셀 내보내기
// ══════════════════════════════════════════════════
function p2ExportExcel() {
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리 로드 중입니다.', 'error'); return; }
  var headers = ['당사분류코드','상품코드','상품명','원가','중량(g)','박스입수(EA)','파렛트입수(박스)','부가세구분','상품구분','소비기한','보관','표준단위','HACCP','적정재고','협력사코드','협력사명','주소','담당자','연락처','가로(cm)','세로(cm)','높이(cm)','내용량','내용량단위','총중량(g)','비고'];
  var rows = _p2AllData.map(function(r) {
    return [r.own_code||'', r.product_code||'', r.product_name||'',
      r.cost_price||'', r.weight||'', r.qty_per_box||'', r.box_per_pallet||'',
      r.vat_type||'', r.product_type||'', r.shelf_life||'', r.storage||'',
      r.std_unit||'', r.haccp||'', r.min_stock||'',
      r.supplier_code||'', r.supplier_name||'', r.supplier_addr||'', r.supplier_contact||'', r.supplier_phone||'',
      r.box_w||'', r.box_d||'', r.box_h||'', r.box_content||'', r.box_content_unit||'', r.box_total_weight||'',
      r.remarks||''];
  });
  var ws = XLSX.utils.aoa_to_sheet([headers].concat(rows));
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '제품마스터정보2');
  XLSX.writeFile(wb, '제품마스터정보2_' + new Date().toISOString().slice(0,10) + '.xlsx');
}

// ══════════════════════════════════════════════════
// 양식 다운로드
// ══════════════════════════════════════════════════
function p2DownloadTemplate() {
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리 로드 중입니다.', 'error'); return; }
  var headers = ['당사 분류코드','상품코드','상품명','원가','중량(g)','박스입수(EA)','파렛트입수(박스)','부가세구분','상품구분(자사/OEM/수입)','소비기한','보관(냉장/냉동/상온/실온)','표준단위(EA/BOX)','HACCP 유무(있음/없음)','적정재고량(EA)','협력사코드','협력사명','주소','담당자','연락처','가로(cm)','세로(cm)','높이(cm)','내용량','내용량단위','총중량(g)','비고'];
  var sample = ['LC-001','P001','예시 상품명','5000','200','24','40','과세','자사','제조일로부터 12월','상온','EA','있음','100','S001','(주)예시협력사','서울시 강남구','홍길동','010-0000-0000','30','20','25','200','ml','500','비고 입력'];
  var ws = XLSX.utils.aoa_to_sheet([headers, sample]);
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '양식');
  XLSX.writeFile(wb, '제품마스터정보2_양식.xlsx');
}
