// =====================================================
// logistics2.js — 물류관리2 (일반창고W / 저온창고C)
// Firebase 컬렉션: lg2_inbound, lg2_outbound, lg2_audit
// =====================================================
'use strict';

// ── 전역 캐시 ──
var _lg2InboundData  = [];  // 입고 전체
var _lg2OutboundData = [];  // 출고 전체
var _lg2AuditData    = [];  // 재고실사 전체
var _lg2ProductCache = null; // 제품마스터 캐시
var _lg2ScanMode     = '';   // 'inbound' | 'outbound'
var _lg2ScanStream   = null; // 카메라 스트림
var _lg2ScanAnimId   = null; // requestAnimationFrame ID
var _lg2ScanBarcode  = '';   // 스캔된 바코드
var _lg2StocktakeBaseDate = null; // 전체 실사 기준일 (YYYY-MM-DD), null이면 미적용

// ── 초기화 ──
document.addEventListener('DOMContentLoaded', function() {
  var today = new Date().toISOString().split('T')[0];
  var setVal = function(id, v) { var el = document.getElementById(id); if (el) el.value = v; };
  setVal('lg2InDate', today);
  setVal('lg2OutDate', today);
  setVal('lg2AuditDate', today);
  lg2LoadAll();
});

// ── 전체 데이터 로드 ──
async function lg2LoadAll() {
  try {
    var results = await Promise.all([
      apiGetAll('lg2_inbound'),
      apiGetAll('lg2_outbound'),
      apiGetAll('lg2_audit'),
      apiGetAll('products'),
      apiGetAll('lg2_stocktake_config')
    ]);
    _lg2InboundData  = results[0] || [];
    _lg2OutboundData = results[1] || [];
    _lg2AuditData    = results[2] || [];
    _lg2ProductCache = results[3] || [];
    // 실사 기준일 로드 (가장 최근 config)
    var configs = results[4] || [];
    if (configs.length > 0) {
      var latest = configs.sort(function(a,b){ return (b.updated_at||0)-(a.updated_at||0); })[0];
      _lg2StocktakeBaseDate = latest.stocktake_base_date || null;
    } else {
      _lg2StocktakeBaseDate = null;
    }
    lg2UpdateStocktakeBaseBanner();
    lg2RenderAll();
  } catch(e) {
    console.error('[lg2] 데이터 로드 오류:', e);
    showToast('데이터 로드 중 오류가 발생했습니다.', 'error');
  }
}

function lg2RenderAll() {
  lg2RenderOverview();
  lg2RenderInbound();
  lg2RenderOutbound();
  lg2RenderAudit();
}

// ── 탭 전환 ──
function lg2SwitchTab(tab) {
  ['overview','inbound','outbound','audit'].forEach(function(t) {
    var btn = document.getElementById('lg2Tab_' + t);
    var con = document.getElementById('lg2Content_' + t);
    if (btn) btn.classList.toggle('active', t === tab);
    if (con) con.classList.toggle('active', t === tab);
  });
}

// ══════════════════════════════════════════════════
// 제품마스터 연동 헬퍼
// ══════════════════════════════════════════════════
function lg2GetProduct(itemName) {
  if (!_lg2ProductCache || !itemName) return null;
  var name = (itemName || '').trim().toLowerCase();
  return _lg2ProductCache.find(function(p) {
    return (p.product_name || '').trim().toLowerCase() === name;
  }) || null;
}

function lg2GetProductByBarcode(barcode) {
  if (!_lg2ProductCache || !barcode) return null;
  var bc = (barcode || '').trim();
  return _lg2ProductCache.find(function(p) {
    return (p.barcode || '').trim() === bc;
  }) || null;
}

function lg2CalcBreakdown(ea, itemName) {
  var pm = lg2GetProduct(itemName);
  var qpb = pm ? (parseInt(pm.qty_per_box) || 0) : 0;
  var bpp = pm ? (parseInt(pm.boxes_per_pallet) || 0) : 0;
  var box = qpb > 0 ? Math.floor(ea / qpb) : 0;
  var pt  = (qpb > 0 && bpp > 0) ? Math.floor(ea / (qpb * bpp)) : 0;
  return { ea: ea, box: box, pt: pt, qpb: qpb, bpp: bpp };
}

function lg2UpdateQtyPreview(itemId, qtyId, previewId) {
  var itemName = (document.getElementById(itemId) || {}).value || '';
  var qty = parseInt((document.getElementById(qtyId) || {}).value) || 0;
  var el = document.getElementById(previewId);
  if (!el) return;
  if (!qty || !itemName) { el.textContent = ''; return; }
  var bd = lg2CalcBreakdown(qty, itemName);
  if (bd.qpb > 0) {
    el.textContent = '≈ ' + bd.box + ' Box' + (bd.bpp > 0 ? ' / ' + bd.pt + ' PT' : '');
  } else {
    el.textContent = '';
  }
}

// ── 자동완성 ──
function lg2Autocomplete(inputId, listId) {
  var input = document.getElementById(inputId);
  var list  = document.getElementById(listId);
  if (!input || !list) return;
  var q = input.value.trim().toLowerCase();
  list.innerHTML = '';
  if (!q || !_lg2ProductCache) { list.style.display = 'none'; return; }
  var matches = _lg2ProductCache.filter(function(p) {
    return (p.product_name || '').toLowerCase().includes(q);
  }).slice(0, 15);
  if (!matches.length) { list.style.display = 'none'; return; }
  matches.forEach(function(p) {
    var div = document.createElement('div');
    div.textContent = p.product_name;
    div.addEventListener('mousedown', function(e) {
      e.preventDefault();
      input.value = p.product_name;
      list.style.display = 'none';
      // 수량 미리보기 갱신
      if (inputId === 'lg2InItem')    lg2UpdateQtyPreview('lg2InItem','lg2InQty','lg2InQtyPreview');
      if (inputId === 'lg2OutItem')   { lg2UpdateQtyPreview('lg2OutItem','lg2OutQty','lg2OutQtyPreview'); lg2ShowFifoPreview(); }
      if (inputId === 'lg2AuditItem') lg2UpdateAuditSystem();
    });
    list.appendChild(div);
  });
  list.style.display = 'block';
}

// 외부 클릭 시 자동완성 닫기
document.addEventListener('click', function(e) {
  ['lg2InItemList','lg2OutItemList','lg2AuditItemList'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el && !el.contains(e.target)) el.style.display = 'none';
  });
});

// ══════════════════════════════════════════════════
// FIFO 재고 계산 (선입선출)
// ══════════════════════════════════════════════════
/**
 * 특정 품목·창고의 FIFO 재고 배열 반환
 * [{expiry, inQty, outQty, stock}] 소비기한 오름차순
 */
function lg2GetFifoStock(itemName, warehouse) {
  var wh = warehouse || null;
  var baseDate = _lg2StocktakeBaseDate || null; // 실사 기준일

  // ── 실사 기준일이 설정된 경우: 기준일 실사 스냅샷 + 이후 입출고 반영 ──
  if (baseDate) {
    // 1) 기준일 실사 스냅샷 (해당 품목·창고의 가장 최근 전체실사 레코드)
    //    lg2_audit 중 date <= baseDate 인 것 (date 필드명으로 통일)
    var auditSnap = {}; // key: expiry -> actual_qty
    _lg2AuditData.forEach(function(a) {
      if ((a.item_name || '').trim() !== (itemName || '').trim()) return;
      if (wh && a.warehouse !== wh) return;
      var aDate = a.date || a.audit_date || ''; // 호환성: 이전 audit_date 필드도 지원
      if (!aDate || aDate > baseDate) return;
      // 같은 소비기한에 여러 실사 레코드가 있으면 가장 최근 것 사용
      var expKey = a.expiry || '';
      if (!auditSnap[expKey] || aDate > auditSnap[expKey].audit_date) {
        auditSnap[expKey] = { actual_qty: Number(a.actual_qty) || 0, audit_date: aDate };
      }
    });

    // 2) 기준일 이후 입고 (재고조정 포함)
    var inMapAfter = {};
    _lg2InboundData.forEach(function(r) {
      if ((r.item_name || '').trim() !== (itemName || '').trim()) return;
      if (wh && r.warehouse !== wh) return;
      if (!r.date || r.date <= baseDate) return; // 기준일 이후만
      var key = (r.expiry || '') + '||' + (r.warehouse || '');
      if (!inMapAfter[key]) inMapAfter[key] = { expiry: r.expiry || '', warehouse: r.warehouse || '', inQty: 0 };
      inMapAfter[key].inQty += Number(r.qty_ea) || 0;
    });

    // 3) 기준일 이후 출고 (재고조정 포함)
    var outListAfter = _lg2OutboundData.filter(function(r) {
      if ((r.item_name || '').trim() !== (itemName || '').trim()) return false;
      if (wh && r.warehouse !== wh) return false;
      if (!r.date || r.date <= baseDate) return false; // 기준일 이후만
      return true;
    });

    // 4) 실사 스냅샷 키 + 이후 입고 키 합집합으로 inMap 구성
    var inMap = {};
    // 실사 스냅샷 기반
    Object.keys(auditSnap).forEach(function(expKey) {
      var key = expKey + '||' + (wh || '');
      if (!inMap[key]) inMap[key] = { expiry: expKey, warehouse: wh || '', inQty: 0, outQty: 0 };
      inMap[key].inQty += auditSnap[expKey].actual_qty;
    });
    // 기준일 이후 입고 추가
    Object.keys(inMapAfter).forEach(function(key) {
      if (!inMap[key]) inMap[key] = { expiry: inMapAfter[key].expiry, warehouse: inMapAfter[key].warehouse, inQty: 0, outQty: 0 };
      inMap[key].inQty += inMapAfter[key].inQty;
    });

    // 5) 실사 스냅샷이 없으면 기준일 이전 입고도 포함 (스냅샷 없는 품목 대비)
    if (Object.keys(auditSnap).length === 0) {
      _lg2InboundData.forEach(function(r) {
        if ((r.item_name || '').trim() !== (itemName || '').trim()) return;
        if (wh && r.warehouse !== wh) return;
        if (r.date && r.date > baseDate) return; // 이후 입고는 이미 처리
        var key = (r.expiry || '') + '||' + (r.warehouse || '');
        if (!inMap[key]) inMap[key] = { expiry: r.expiry || '', warehouse: r.warehouse || '', inQty: 0, outQty: 0 };
        inMap[key].inQty += Number(r.qty_ea) || 0;
      });
      // 기준일 이전 출고도 포함
      outListAfter = _lg2OutboundData.filter(function(r) {
        if ((r.item_name || '').trim() !== (itemName || '').trim()) return false;
        if (wh && r.warehouse !== wh) return false;
        return true;
      });
    }

    // 6) FIFO 출고 차감
    var keys = Object.keys(inMap).sort(function(a, b) {
      return (inMap[a].expiry || '9999').localeCompare(inMap[b].expiry || '9999');
    });
    var remaining = outListAfter.reduce(function(sum, r) { return sum + (Number(r.qty_ea) || 0); }, 0);
    keys.forEach(function(k) {
      if (remaining <= 0) return;
      var deduct = Math.min(remaining, inMap[k].inQty);
      inMap[k].outQty += deduct;
      remaining -= deduct;
    });
    return keys.map(function(k) {
      var row = inMap[k];
      return { expiry: row.expiry, warehouse: row.warehouse, inQty: row.inQty, outQty: row.outQty, stock: row.inQty - row.outQty };
    });
  }

  // ── 실사 기준일 미설정: 기존 전체 입출고 FIFO 계산 ──
  var inMap = {};
  _lg2InboundData.forEach(function(r) {
    if ((r.item_name || '').trim() !== (itemName || '').trim()) return;
    if (wh && r.warehouse !== wh) return;
    var key = (r.expiry || '') + '||' + (r.warehouse || '');
    if (!inMap[key]) inMap[key] = { expiry: r.expiry || '', warehouse: r.warehouse || '', inQty: 0, outQty: 0 };
    inMap[key].inQty += Number(r.qty_ea) || 0;
  });
  var outList = _lg2OutboundData.filter(function(r) {
    if ((r.item_name || '').trim() !== (itemName || '').trim()) return false;
    if (wh && r.warehouse !== wh) return false;
    return true;
  });
  var keys = Object.keys(inMap).sort(function(a, b) {
    return (inMap[a].expiry || '9999').localeCompare(inMap[b].expiry || '9999');
  });
  var remaining = outList.reduce(function(sum, r) { return sum + (Number(r.qty_ea) || 0); }, 0);
  keys.forEach(function(k) {
    if (remaining <= 0) return;
    var deduct = Math.min(remaining, inMap[k].inQty);
    inMap[k].outQty += deduct;
    remaining -= deduct;
  });
  return keys.map(function(k) {
    var row = inMap[k];
    return { expiry: row.expiry, warehouse: row.warehouse, inQty: row.inQty, outQty: row.outQty, stock: row.inQty - row.outQty };
  });
}

/** 품목·창고의 총 현재고(ea) */
function lg2GetTotalStock(itemName, warehouse) {
  return lg2GetFifoStock(itemName, warehouse).reduce(function(s, r) { return s + r.stock; }, 0);
}

// ══════════════════════════════════════════════════
// 전체현황 렌더링
// ══════════════════════════════════════════════════
function lg2RenderOverview() {
  var wh = (document.getElementById('lg2OvWarehouse') || {}).value || '';
  var q  = ((document.getElementById('lg2OvSearch') || {}).value || '').toLowerCase();
  var showZero = (document.getElementById('lg2OvShowZero') || {}).checked || false;

  // 품목 목록 추출 (입고 기준)
  var itemSet = {};
  _lg2InboundData.forEach(function(r) {
    var name = (r.item_name || '').trim();
    var w    = r.warehouse || '';
    if (!name) return;
    var key = name + '||' + w;
    if (!itemSet[key]) itemSet[key] = { name: name, warehouse: w };
  });

  var rows = Object.values(itemSet);
  if (wh) rows = rows.filter(function(r) { return r.warehouse === wh; });
  if (q)  rows = rows.filter(function(r) { return r.name.toLowerCase().includes(q); });

  // 재고 계산
  var today = new Date();
  var result = [];
  rows.forEach(function(r) {
    var fifo = lg2GetFifoStock(r.name, r.warehouse);
    fifo.forEach(function(f) {
      var bd = lg2CalcBreakdown(f.stock, r.name);
      var status = f.stock < 0 ? 'neg' : (f.stock === 0 ? 'zero' : (f.stock <= 10 ? 'low' : 'ok'));
      var expiryWarn = false;
      if (f.expiry) {
        var diff = Math.floor((new Date(f.expiry) - today) / 86400000);
        if (diff <= 30) expiryWarn = true;
      }
      result.push({ name: r.name, warehouse: r.warehouse, expiry: f.expiry, inQty: f.inQty, outQty: f.outQty, stock: f.stock, box: bd.box, pt: bd.pt, status: status, expiryWarn: expiryWarn });
    });
  });

  if (!showZero) result = result.filter(function(r) { return r.stock > 0; });
  result.sort(function(a, b) {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return (a.expiry || '').localeCompare(b.expiry || '');
  });

  // KPI
  var allItems = Object.values(itemSet);
  var totalItems = new Set(allItems.map(function(r) { return r.name; })).size;
  var wItems = allItems.filter(function(r) { return r.warehouse === 'W'; });
  var cItems = allItems.filter(function(r) { return r.warehouse === 'C'; });
  var wCount = new Set(wItems.map(function(r) { return r.name; })).size;
  var cCount = new Set(cItems.map(function(r) { return r.name; })).size;
  var lowCount = 0, zeroCount = 0, expiryCount = 0;
  result.forEach(function(r) {
    if (r.status === 'low') lowCount++;
    if (r.status === 'zero' || r.status === 'neg') zeroCount++;
    if (r.expiryWarn && r.stock > 0) expiryCount++;
  });
  var sv = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
  sv('lg2KpiTotal', totalItems);
  sv('lg2KpiW', wCount);
  sv('lg2KpiC', cCount);
  sv('lg2KpiLow', lowCount);
  sv('lg2KpiZero', zeroCount);
  sv('lg2KpiExpiry', expiryCount);

  // 테이블
  var tbody = document.getElementById('lg2OvBody');
  if (!tbody) return;
  if (!result.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:#aaa">데이터가 없습니다.</td></tr>';
    return;
  }
  var statusLabel = { ok:'<span class="stock-ok">정상</span>', low:'<span class="stock-low">부족</span>', zero:'<span class="stock-zero">재고없음</span>', neg:'<span class="stock-neg">마이너스</span>' };
  tbody.innerHTML = result.map(function(r) {
    var wBadge = r.warehouse === 'W'
      ? '<span class="badge-W">🏭 일반(W)</span>'
      : '<span class="badge-C">❄️ 저온(C)</span>';
    var expiryStr = r.expiry || '-';
    if (r.expiryWarn && r.stock > 0) expiryStr = '<span style="color:#e74c3c;font-weight:700">' + expiryStr + ' ⚠️</span>';
    return '<tr>' +
      '<td><strong>' + lg2esc(r.name) + '</strong></td>' +
      '<td>' + wBadge + '</td>' +
      '<td>' + expiryStr + '</td>' +
      '<td style="text-align:right">' + r.inQty.toLocaleString() + '</td>' +
      '<td style="text-align:right">' + r.outQty.toLocaleString() + '</td>' +
      '<td style="text-align:right;font-weight:700">' + r.stock.toLocaleString() + '</td>' +
      '<td style="text-align:right">' + r.box.toLocaleString() + '</td>' +
      '<td style="text-align:right">' + r.pt.toLocaleString() + '</td>' +
      '<td>' + (statusLabel[r.status] || r.status) + '</td>' +
      '</tr>';
  }).join('');
}

// ══════════════════════════════════════════════════
// 입고관리 렌더링 (페이지네이션)
// ══════════════════════════════════════════════════
var _lg2InPage = 1;
var _lg2InPageSize = 20;

function lg2RenderInbound(resetPage) {
  if (resetPage) _lg2InPage = 1;
  var wh = (document.getElementById('lg2InWarehouse') || {}).value || '';
  var q  = ((document.getElementById('lg2InSearch') || {}).value || '').toLowerCase();
  var rows = _lg2InboundData.slice();
  if (wh) rows = rows.filter(function(r) { return r.warehouse === wh; });
  if (q)  rows = rows.filter(function(r) { return (r.item_name || '').toLowerCase().includes(q); });
  rows.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });

  var total = rows.length;
  var totalPages = Math.max(1, Math.ceil(total / _lg2InPageSize));
  if (_lg2InPage > totalPages) _lg2InPage = totalPages;
  var start = (_lg2InPage - 1) * _lg2InPageSize;
  var pageRows = rows.slice(start, start + _lg2InPageSize);

  var tbody = document.getElementById('lg2InBody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:#aaa">입고 내역이 없습니다.</td></tr>';
    lg2RenderPager('lg2InPageInfo','lg2InPageBtns', 0, 0, 0, 'inbound');
    return;
  }
  tbody.innerHTML = pageRows.map(function(r) {
    var bd = lg2CalcBreakdown(r.qty_ea || 0, r.item_name);
    var wBadge = r.warehouse === 'W'
      ? '<span class="badge-W">🏭 일반(W)</span>'
      : '<span class="badge-C">❄️ 저온(C)</span>';
    return '<tr>' +
      '<td>' + lg2esc(r.date || '-') + '</td>' +
      '<td><strong>' + lg2esc(r.item_name || '-') + '</strong></td>' +
      '<td>' + wBadge + '</td>' +
      '<td style="text-align:right">' + (r.qty_ea || 0).toLocaleString() + '</td>' +
      '<td style="text-align:right">' + bd.box.toLocaleString() + '</td>' +
      '<td style="text-align:right">' + bd.pt.toLocaleString() + '</td>' +
      '<td>' + lg2esc(r.expiry || '-') + '</td>' +
      '<td>' + lg2esc(r.supplier || '-') + '</td>' +
      '<td>' + lg2esc(r.manager || '-') + '</td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn-secondary btn-sm" onclick="lg2OpenInboundModal(\'' + r.id + '\')"><i class="fas fa-edit"></i></button> ' +
        '<button class="btn-danger btn-sm" onclick="lg2DeleteInbound(\'' + r.id + '\')"><i class="fas fa-trash"></i></button>' +
      '</td>' +
      '</tr>';
  }).join('');
  lg2RenderPager('lg2InPageInfo','lg2InPageBtns', total, _lg2InPage, totalPages, 'inbound');
}

// ══════════════════════════════════════════════════
// 출고관리 렌더링 (페이지네이션)
// ══════════════════════════════════════════════════
var _lg2OutPage = 1;
var _lg2OutPageSize = 20;

function lg2RenderOutbound(resetPage) {
  if (resetPage) _lg2OutPage = 1;
  var wh = (document.getElementById('lg2OutWarehouse') || {}).value || '';
  var q  = ((document.getElementById('lg2OutSearch') || {}).value || '').toLowerCase();
  var rows = _lg2OutboundData.slice();
  if (wh) rows = rows.filter(function(r) { return r.warehouse === wh; });
  if (q)  rows = rows.filter(function(r) { return (r.item_name || '').toLowerCase().includes(q); });
  rows.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });

  var total = rows.length;
  var totalPages = Math.max(1, Math.ceil(total / _lg2OutPageSize));
  if (_lg2OutPage > totalPages) _lg2OutPage = totalPages;
  var start = (_lg2OutPage - 1) * _lg2OutPageSize;
  var pageRows = rows.slice(start, start + _lg2OutPageSize);

  var tbody = document.getElementById('lg2OutBody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:#aaa">출고 내역이 없습니다.</td></tr>';
    lg2RenderPager('lg2OutPageInfo','lg2OutPageBtns', 0, 0, 0, 'outbound');
    return;
  }
  tbody.innerHTML = pageRows.map(function(r) {
    var bd = lg2CalcBreakdown(r.qty_ea || 0, r.item_name);
    var wBadge = r.warehouse === 'W'
      ? '<span class="badge-W">🏭 일반(W)</span>'
      : '<span class="badge-C">❄️ 저온(C)</span>';
    return '<tr>' +
      '<td>' + lg2esc(r.date || '-') + '</td>' +
      '<td><strong>' + lg2esc(r.item_name || '-') + '</strong></td>' +
      '<td>' + wBadge + '</td>' +
      '<td style="text-align:right">' + (r.qty_ea || 0).toLocaleString() + '</td>' +
      '<td style="text-align:right">' + bd.box.toLocaleString() + '</td>' +
      '<td style="text-align:right">' + bd.pt.toLocaleString() + '</td>' +
      '<td>' + lg2esc(r.destination || '-') + '</td>' +
      '<td>' + lg2esc(r.manager || '-') + '</td>' +
      '<td>' + lg2esc(r.memo || '-') + '</td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn-secondary btn-sm" onclick="lg2OpenOutboundModal(\'' + r.id + '\')"><i class="fas fa-edit"></i></button> ' +
        '<button class="btn-danger btn-sm" onclick="lg2DeleteOutbound(\'' + r.id + '\')"><i class="fas fa-trash"></i></button>' +
      '</td>' +
      '</tr>';
  }).join('');
  lg2RenderPager('lg2OutPageInfo','lg2OutPageBtns', total, _lg2OutPage, totalPages, 'outbound');
}

// ══════════════════════════════════════════════════
// 재고실사 렌더링
// ══════════════════════════════════════════════════
function lg2RenderAudit() {
  var q = ((document.getElementById('lg2AuditSearch') || {}).value || '').toLowerCase();
  var rows = _lg2AuditData.slice();
  if (q) rows = rows.filter(function(r) { return (r.item_name || '').toLowerCase().includes(q); });
  rows.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });

  var tbody = document.getElementById('lg2AuditBody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:#aaa">실사 내역이 없습니다.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function(r) {
    var diff = (r.actual_qty || 0) - (r.system_qty || 0);
    var diffStr = diff === 0
      ? '<span style="color:#27ae60">±0</span>'
      : (diff > 0 ? '<span style="color:#2980b9">+' + diff + '</span>' : '<span style="color:#e74c3c">' + diff + '</span>');
    var rowClass = diff !== 0 ? 'audit-row-diff' : 'audit-row-ok';
    var wBadge = r.warehouse === 'W'
      ? '<span class="badge-W">🏭 일반(W)</span>'
      : '<span class="badge-C">❄️ 저온(C)</span>';
    return '<tr class="' + rowClass + '">' +
      '<td>' + lg2esc(r.date || '-') + '</td>' +
      '<td><strong>' + lg2esc(r.item_name || '-') + '</strong></td>' +
      '<td>' + wBadge + '</td>' +
      '<td style="text-align:right">' + (r.system_qty || 0).toLocaleString() + '</td>' +
      '<td style="text-align:right">' + (r.actual_qty || 0).toLocaleString() + '</td>' +
      '<td style="text-align:right">' + diffStr + '</td>' +
      '<td>' + lg2esc(r.expiry || '-') + '</td>' +
      '<td>' + lg2esc(r.manager || '-') + '</td>' +
      '<td>' + lg2esc(r.memo || '-') + '</td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn-secondary btn-sm" onclick="lg2OpenAuditModal(\'' + r.id + '\')"><i class="fas fa-edit"></i></button> ' +
        '<button class="btn-danger btn-sm" onclick="lg2DeleteAudit(\'' + r.id + '\')"><i class="fas fa-trash"></i></button>' +
      '</td>' +
      '</tr>';
  }).join('');
}

// ══════════════════════════════════════════════════
// 입고 모달
// ══════════════════════════════════════════════════
function lg2OpenInboundModal(id) {
  var modal = document.getElementById('lg2InboundModal');
  if (!modal) return;
  var today = new Date().toISOString().split('T')[0];
  var setVal = function(elId, v) { var el = document.getElementById(elId); if (el) el.value = v !== undefined ? v : ''; };

  if (id) {
    var rec = _lg2InboundData.find(function(r) { return r.id === id; });
    if (!rec) return;
    document.getElementById('lg2InboundModalTitle').innerHTML = '<i class="fas fa-edit" style="color:var(--primary)"></i> 입고 수정';
    setVal('lg2InEditId', id);
    setVal('lg2InDate', rec.date || today);
    setVal('lg2InWarehouseModal', rec.warehouse || 'W');
    setVal('lg2InItem', rec.item_name || '');
    setVal('lg2InQty', rec.qty_ea || '');
    setVal('lg2InExpiry', rec.expiry || '');
    setVal('lg2InSupplier', rec.supplier || '');
    setVal('lg2InManager', rec.manager || '');
    setVal('lg2InMemo', rec.memo || '');
    lg2UpdateQtyPreview('lg2InItem','lg2InQty','lg2InQtyPreview');
  } else {
    document.getElementById('lg2InboundModalTitle').innerHTML = '<i class="fas fa-sign-in-alt" style="color:var(--primary)"></i> 입고 등록';
    setVal('lg2InEditId', '');
    setVal('lg2InDate', today);
    setVal('lg2InWarehouseModal', 'W');
    setVal('lg2InItem', '');
    setVal('lg2InQty', '');
    setVal('lg2InExpiry', '');
    setVal('lg2InSupplier', '');
    setVal('lg2InManager', '');
    setVal('lg2InMemo', '');
    var prev = document.getElementById('lg2InQtyPreview'); if (prev) prev.textContent = '';
  }
  modal.classList.add('show');
}

function lg2CloseInboundModal() {
  var modal = document.getElementById('lg2InboundModal');
  if (modal) modal.classList.remove('show');
}

async function lg2SaveInbound() {
  var getVal = function(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
  var date    = getVal('lg2InDate');
  var wh      = getVal('lg2InWarehouseModal');
  var item    = getVal('lg2InItem');
  var qtyStr  = getVal('lg2InQty');
  var expiry  = getVal('lg2InExpiry');
  var supplier= getVal('lg2InSupplier');
  var manager = getVal('lg2InManager');
  var memo    = getVal('lg2InMemo');
  var editId  = getVal('lg2InEditId');

  if (!date || !wh || !item || !qtyStr) {
    showToast('입고일, 창고, 품목명, 수량은 필수 입력 항목입니다.', 'error');
    return;
  }
  var qty = parseInt(qtyStr);
  if (isNaN(qty) || qty <= 0) { showToast('수량은 1 이상의 숫자를 입력하세요.', 'error'); return; }

  var bd = lg2CalcBreakdown(qty, item);
  var data = {
    date: date,
    warehouse: wh,
    item_name: item,
    qty_ea: qty,
    qty_box: bd.box,
    qty_pt: bd.pt,
    expiry: expiry,
    supplier: supplier,
    manager: manager,
    memo: memo
  };

  try {
    if (editId) {
      await apiPut('lg2_inbound', editId, data);
      showToast('입고 내역이 수정되었습니다.', 'success');
    } else {
      await apiPost('lg2_inbound', data);
      showToast('입고 등록 완료!', 'success');
    }
    lg2CloseInboundModal();
    await lg2LoadAll();
  } catch(e) {
    console.error('[lg2] 입고 저장 오류:', e);
    showToast('저장 중 오류가 발생했습니다.', 'error');
  }
}

async function lg2DeleteInbound(id) {
  if (!confirm('이 입고 내역을 삭제하시겠습니까?')) return;
  try {
    await apiDelete('lg2_inbound', id);
    showToast('삭제되었습니다.', 'success');
    await lg2LoadAll();
  } catch(e) {
    showToast('삭제 중 오류가 발생했습니다.', 'error');
  }
}

// ══════════════════════════════════════════════════
// 출고 모달
// ══════════════════════════════════════════════════
function lg2OpenOutboundModal(id) {
  var modal = document.getElementById('lg2OutboundModal');
  if (!modal) return;
  var today = new Date().toISOString().split('T')[0];
  var setVal = function(elId, v) { var el = document.getElementById(elId); if (el) el.value = v !== undefined ? v : ''; };

  if (id) {
    var rec = _lg2OutboundData.find(function(r) { return r.id === id; });
    if (!rec) return;
    document.getElementById('lg2OutboundModalTitle').innerHTML = '<i class="fas fa-edit" style="color:#e74c3c"></i> 출고 수정';
    setVal('lg2OutEditId', id);
    setVal('lg2OutDate', rec.date || today);
    setVal('lg2OutWarehouseModal', rec.warehouse || 'W');
    setVal('lg2OutItem', rec.item_name || '');
    setVal('lg2OutQty', rec.qty_ea || '');
    setVal('lg2OutDest', rec.destination || '');
    setVal('lg2OutManager', rec.manager || '');
    setVal('lg2OutMemo', rec.memo || '');
    lg2UpdateQtyPreview('lg2OutItem','lg2OutQty','lg2OutQtyPreview');
    lg2ShowFifoPreview();
  } else {
    document.getElementById('lg2OutboundModalTitle').innerHTML = '<i class="fas fa-sign-out-alt" style="color:#e74c3c"></i> 출고 등록';
    setVal('lg2OutEditId', '');
    setVal('lg2OutDate', today);
    setVal('lg2OutWarehouseModal', 'W');
    setVal('lg2OutItem', '');
    setVal('lg2OutQty', '');
    setVal('lg2OutDest', '');
    setVal('lg2OutManager', '');
    setVal('lg2OutMemo', '');
    var prev = document.getElementById('lg2OutQtyPreview'); if (prev) prev.textContent = '';
    var fp = document.getElementById('lg2OutFifoPreview'); if (fp) fp.style.display = 'none';
  }
  modal.classList.add('show');
}

function lg2CloseOutboundModal() {
  var modal = document.getElementById('lg2OutboundModal');
  if (modal) modal.classList.remove('show');
}

function lg2ShowFifoPreview() {
  var item = (document.getElementById('lg2OutItem') || {}).value || '';
  var wh   = (document.getElementById('lg2OutWarehouseModal') || {}).value || '';
  var wrap = document.getElementById('lg2OutFifoPreview');
  var body = document.getElementById('lg2OutFifoBody');
  if (!wrap || !body || !item) { if (wrap) wrap.style.display = 'none'; return; }
  var fifo = lg2GetFifoStock(item, wh);
  if (!fifo.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  body.innerHTML = fifo.map(function(f) {
    var color = f.stock <= 0 ? '#aaa' : (f.stock <= 10 ? '#e67e22' : '#27ae60');
    return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #eee">' +
      '<span>소비기한: ' + (f.expiry || '미지정') + '</span>' +
      '<span style="color:' + color + ';font-weight:700">재고 ' + f.stock.toLocaleString() + ' ea</span>' +
      '</div>';
  }).join('');
}

async function lg2SaveOutbound() {
  var getVal = function(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
  var date   = getVal('lg2OutDate');
  var wh     = getVal('lg2OutWarehouseModal');
  var item   = getVal('lg2OutItem');
  var qtyStr = getVal('lg2OutQty');
  var dest   = getVal('lg2OutDest');
  var manager= getVal('lg2OutManager');
  var memo   = getVal('lg2OutMemo');
  var editId = getVal('lg2OutEditId');

  if (!date || !wh || !item || !qtyStr) {
    showToast('출고일, 창고, 품목명, 수량은 필수 입력 항목입니다.', 'error');
    return;
  }
  var qty = parseInt(qtyStr);
  if (isNaN(qty) || qty <= 0) { showToast('수량은 1 이상의 숫자를 입력하세요.', 'error'); return; }

  // 재고 부족 경고 (신규 등록 시)
  if (!editId) {
    var currentStock = lg2GetTotalStock(item, wh);
    if (qty > currentStock) {
      if (!confirm('현재 재고(' + currentStock + ' ea)보다 출고 수량(' + qty + ' ea)이 많습니다.\n계속 진행하시겠습니까?')) return;
    }
  }

  var bd = lg2CalcBreakdown(qty, item);
  var data = {
    date: date,
    warehouse: wh,
    item_name: item,
    qty_ea: qty,
    qty_box: bd.box,
    qty_pt: bd.pt,
    destination: dest,
    manager: manager,
    memo: memo
  };

  try {
    if (editId) {
      await apiPut('lg2_outbound', editId, data);
      showToast('출고 내역이 수정되었습니다.', 'success');
    } else {
      await apiPost('lg2_outbound', data);
      showToast('출고 등록 완료!', 'success');
    }
    lg2CloseOutboundModal();
    await lg2LoadAll();
  } catch(e) {
    console.error('[lg2] 출고 저장 오류:', e);
    showToast('저장 중 오류가 발생했습니다.', 'error');
  }
}

async function lg2DeleteOutbound(id) {
  if (!confirm('이 출고 내역을 삭제하시겠습니까?')) return;
  try {
    await apiDelete('lg2_outbound', id);
    showToast('삭제되었습니다.', 'success');
    await lg2LoadAll();
  } catch(e) {
    showToast('삭제 중 오류가 발생했습니다.', 'error');
  }
}

// ══════════════════════════════════════════════════
// 재고실사 모달
// ══════════════════════════════════════════════════
function lg2UpdateAuditSystem() {
  var item = (document.getElementById('lg2AuditItem') || {}).value || '';
  var wh   = (document.getElementById('lg2AuditWarehouse') || {}).value || '';
  var sysEl = document.getElementById('lg2AuditSystem');
  if (!sysEl) return;
  var stock = item ? lg2GetTotalStock(item, wh) : 0;
  sysEl.value = stock;
  lg2UpdateAuditDiff();
}

function lg2UpdateAuditDiff() {
  var sys    = parseInt((document.getElementById('lg2AuditSystem') || {}).value) || 0;
  var actual = parseInt((document.getElementById('lg2AuditActual') || {}).value) || 0;
  var diffEl = document.getElementById('lg2AuditDiff');
  if (diffEl) diffEl.value = actual - sys;
}

function lg2OpenAuditModal(id) {
  var modal = document.getElementById('lg2AuditModal');
  if (!modal) return;
  var today = new Date().toISOString().split('T')[0];
  var setVal = function(elId, v) { var el = document.getElementById(elId); if (el) el.value = v !== undefined ? v : ''; };

  if (id) {
    var rec = _lg2AuditData.find(function(r) { return r.id === id; });
    if (!rec) return;
    setVal('lg2AuditEditId', id);
    setVal('lg2AuditDate', rec.date || today);
    setVal('lg2AuditWarehouse', rec.warehouse || 'W');
    setVal('lg2AuditItem', rec.item_name || '');
    setVal('lg2AuditSystem', rec.system_qty || 0);
    setVal('lg2AuditActual', rec.actual_qty || 0);
    setVal('lg2AuditExpiry', rec.expiry || '');
    setVal('lg2AuditManager', rec.manager || '');
    setVal('lg2AuditMemo', rec.memo || '');
    lg2UpdateAuditDiff();
  } else {
    setVal('lg2AuditEditId', '');
    setVal('lg2AuditDate', today);
    setVal('lg2AuditWarehouse', 'W');
    setVal('lg2AuditItem', '');
    setVal('lg2AuditSystem', '');
    setVal('lg2AuditActual', '');
    setVal('lg2AuditExpiry', '');
    setVal('lg2AuditManager', '');
    setVal('lg2AuditMemo', '');
    var diffEl = document.getElementById('lg2AuditDiff'); if (diffEl) diffEl.value = '';
  }
  modal.classList.add('show');
}

function lg2CloseAuditModal() {
  var modal = document.getElementById('lg2AuditModal');
  if (modal) modal.classList.remove('show');
}

async function lg2SaveAudit() {
  var getVal = function(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
  var date   = getVal('lg2AuditDate');
  var wh     = getVal('lg2AuditWarehouse');
  var item   = getVal('lg2AuditItem');
  var actual = getVal('lg2AuditActual');
  var expiry = getVal('lg2AuditExpiry');
  var manager= getVal('lg2AuditManager');
  var memo   = getVal('lg2AuditMemo');
  var editId = getVal('lg2AuditEditId');

  if (!date || !wh || !item || actual === '') {
    showToast('실사일, 창고, 품목명, 실사수량은 필수 입력 항목입니다.', 'error');
    return;
  }
  var actualQty = parseInt(actual);
  if (isNaN(actualQty) || actualQty < 0) { showToast('실사 수량은 0 이상의 숫자를 입력하세요.', 'error'); return; }
  var sysQty = lg2GetTotalStock(item, wh);

  var data = {
    date: date,
    warehouse: wh,
    item_name: item,
    system_qty: sysQty,
    actual_qty: actualQty,
    diff_qty: actualQty - sysQty,
    expiry: expiry,
    manager: manager,
    memo: memo
  };

  try {
    if (editId) {
      await apiPut('lg2_audit', editId, data);
      showToast('실사 내역이 수정되었습니다.', 'success');
    } else {
      await apiPost('lg2_audit', data);
      showToast('재고실사 등록 완료!', 'success');
    }
    lg2CloseAuditModal();
    await lg2LoadAll();
  } catch(e) {
    console.error('[lg2] 실사 저장 오류:', e);
    showToast('저장 중 오류가 발생했습니다.', 'error');
  }
}

async function lg2DeleteAudit(id) {
  if (!confirm('이 실사 내역을 삭제하시겠습니까?')) return;
  try {
    await apiDelete('lg2_audit', id);
    showToast('삭제되었습니다.', 'success');
    await lg2LoadAll();
  } catch(e) {
    showToast('삭제 중 오류가 발생했습니다.', 'error');
  }
}

// ══════════════════════════════════════════════════
// 바코드 스캔
// ══════════════════════════════════════════════════
function lg2OpenScanModal(mode) {
  _lg2ScanMode = mode;
  _lg2ScanBarcode = '';
  var modal = document.getElementById('lg2ScanModal');
  var titleEl = document.getElementById('lg2ScanModalTitle');
  var resultEl = document.getElementById('lg2ScanResult');
  var qtyWrap = document.getElementById('lg2ScanQtyWrap');
  var scanInput = document.getElementById('lg2ScanInput');
  if (!modal) return;
  if (titleEl) titleEl.innerHTML = mode === 'inbound'
    ? '<i class="fas fa-barcode"></i> 바코드 스캔 — 입고'
    : '<i class="fas fa-barcode"></i> 바코드 스캔 — 출고';
  if (resultEl) resultEl.textContent = '';
  if (qtyWrap) qtyWrap.style.display = 'none';
  if (scanInput) scanInput.value = '';
  modal.classList.add('show');
  lg2StartCamera();
}

function lg2CloseScanModal() {
  var modal = document.getElementById('lg2ScanModal');
  if (modal) modal.classList.remove('show');
  lg2StopCamera();
}

function lg2StartCamera() {
  var video = document.getElementById('lg2ScanVideo');
  var canvas = document.getElementById('lg2ScanCanvas');
  if (!video || !canvas) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(function(stream) {
      _lg2ScanStream = stream;
      video.srcObject = stream;
      video.play();
      lg2ScanFrame(video, canvas);
    })
    .catch(function(e) {
      console.warn('[lg2] 카메라 접근 불가:', e);
    });
}

function lg2StopCamera() {
  if (_lg2ScanAnimId) { cancelAnimationFrame(_lg2ScanAnimId); _lg2ScanAnimId = null; }
  if (_lg2ScanStream) {
    _lg2ScanStream.getTracks().forEach(function(t) { t.stop(); });
    _lg2ScanStream = null;
  }
}

function lg2ScanFrame(video, canvas) {
  if (!document.getElementById('lg2ScanModal') || !document.getElementById('lg2ScanModal').classList.contains('show')) {
    lg2StopCamera(); return;
  }
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (typeof jsQR !== 'undefined') {
      var code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        lg2HandleScannedBarcode(code.data);
        return;
      }
    }
  }
  _lg2ScanAnimId = requestAnimationFrame(function() { lg2ScanFrame(video, canvas); });
}

function lg2ProcessScan() {
  var input = document.getElementById('lg2ScanInput');
  if (!input || !input.value.trim()) return;
  lg2HandleScannedBarcode(input.value.trim());
}

function lg2HandleScannedBarcode(barcode) {
  lg2StopCamera();
  _lg2ScanBarcode = barcode;
  var product = lg2GetProductByBarcode(barcode);
  var resultEl = document.getElementById('lg2ScanResult');
  var qtyWrap  = document.getElementById('lg2ScanQtyWrap');
  var nameEl   = document.getElementById('lg2ScanProductName');

  if (!product) {
    if (resultEl) resultEl.innerHTML = '<span style="color:#e74c3c">바코드 [' + lg2esc(barcode) + ']에 해당하는 제품을 찾을 수 없습니다.</span>';
    return;
  }

  if (resultEl) resultEl.innerHTML = '<span style="color:#27ae60">✓ ' + lg2esc(product.product_name) + ' 인식됨</span>';

  if (_lg2ScanMode === 'inbound') {
    // 입고 모달 열기
    lg2CloseScanModal();
    lg2OpenInboundModal();
    setTimeout(function() {
      var el = document.getElementById('lg2InItem');
      if (el) { el.value = product.product_name; lg2UpdateQtyPreview('lg2InItem','lg2InQty','lg2InQtyPreview'); }
    }, 100);
  } else {
    // 출고: 수량 입력 UI 표시
    if (nameEl) nameEl.textContent = product.product_name + ' — 현재고: ' + lg2GetTotalStock(product.product_name, '') + ' ea';
    if (qtyWrap) qtyWrap.style.display = 'block';
    var qtyEl = document.getElementById('lg2ScanQty');
    if (qtyEl) { qtyEl.value = ''; qtyEl.focus(); }
  }
}

async function lg2ConfirmScanOut() {
  var product = lg2GetProductByBarcode(_lg2ScanBarcode);
  if (!product) { showToast('제품 정보를 찾을 수 없습니다.', 'error'); return; }
  var qtyEl = document.getElementById('lg2ScanQty');
  var qty = parseInt(qtyEl ? qtyEl.value : 0);
  if (!qty || qty <= 0) { showToast('출고 수량을 입력하세요.', 'error'); return; }

  var today = new Date().toISOString().split('T')[0];
  // 창고 자동 결정: 재고가 있는 창고 우선
  var stockW = lg2GetTotalStock(product.product_name, 'W');
  var stockC = lg2GetTotalStock(product.product_name, 'C');
  var wh = stockW >= qty ? 'W' : (stockC >= qty ? 'C' : (stockW > 0 ? 'W' : 'C'));

  var currentStock = lg2GetTotalStock(product.product_name, wh);
  if (qty > currentStock) {
    if (!confirm('현재 재고(' + currentStock + ' ea)보다 출고 수량(' + qty + ' ea)이 많습니다.\n계속 진행하시겠습니까?')) return;
  }

  var bd = lg2CalcBreakdown(qty, product.product_name);
  var data = {
    date: today,
    warehouse: wh,
    item_name: product.product_name,
    qty_ea: qty,
    qty_box: bd.box,
    qty_pt: bd.pt,
    destination: '',
    manager: '',
    memo: '바코드 스캔 출고'
  };

  try {
    await apiPost('lg2_outbound', data);
    showToast(product.product_name + ' ' + qty + ' ea 출고 완료!', 'success');
    lg2CloseScanModal();
    await lg2LoadAll();
  } catch(e) {
    showToast('출고 저장 중 오류가 발생했습니다.', 'error');
  }
}

// ══════════════════════════════════════════════════
// 백업 / 복구 / 전체삭제
// ══════════════════════════════════════════════════
function lg2Backup() {
  var data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    inbound: _lg2InboundData,
    outbound: _lg2OutboundData,
    audit: _lg2AuditData
  };
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href   = url;
  a.download = '물류관리2_백업_' + new Date().toISOString().split('T')[0] + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('백업 파일 다운로드 완료!', 'success');
}

function lg2Restore(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = async function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (!data.inbound && !data.outbound && !data.audit) {
        showToast('올바른 백업 파일이 아닙니다.', 'error'); return;
      }
      if (!confirm('현재 데이터를 모두 삭제하고 백업 파일로 복구하시겠습니까?\n이 작업은 되돌릴 수 없습니다.')) return;

      showToast('복구 중...', 'info');
      // 기존 데이터 삭제 후 복구
      var delAll = async function(col, arr) {
        for (var i = 0; i < arr.length; i++) {
          try { await apiDelete(col, arr[i].id); } catch(ex) {}
        }
      };
      await delAll('lg2_inbound',  _lg2InboundData);
      await delAll('lg2_outbound', _lg2OutboundData);
      await delAll('lg2_audit',    _lg2AuditData);

      // 새 데이터 저장
      var saveAll = async function(col, arr) {
        for (var i = 0; i < (arr || []).length; i++) {
          var rec = Object.assign({}, arr[i]);
          delete rec.id;
          try { await apiPost(col, rec); } catch(ex) {}
        }
      };
      await saveAll('lg2_inbound',  data.inbound);
      await saveAll('lg2_outbound', data.outbound);
      await saveAll('lg2_audit',    data.audit);

      showToast('복구 완료!', 'success');
      await lg2LoadAll();
    } catch(ex) {
      showToast('복구 중 오류가 발생했습니다: ' + ex.message, 'error');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

async function lg2DeleteAll() {
  if (!confirm('물류관리2의 모든 입고/출고/재고실사 데이터를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.')) return;
  if (!confirm('정말로 전체 삭제하시겠습니까? 마지막 확인입니다.')) return;
  showToast('삭제 중...', 'info');
  try {
    var delAll = async function(col, arr) {
      for (var i = 0; i < arr.length; i++) {
        try { await apiDelete(col, arr[i].id); } catch(ex) {}
      }
    };
    await delAll('lg2_inbound',  _lg2InboundData);
    await delAll('lg2_outbound', _lg2OutboundData);
    await delAll('lg2_audit',    _lg2AuditData);
    showToast('전체 삭제 완료!', 'success');
    await lg2LoadAll();
  } catch(e) {
    showToast('삭제 중 오류가 발생했습니다.', 'error');
  }
}

// ══════════════════════════════════════════════════
// 엑셀 다운로드
// ══════════════════════════════════════════════════
function lg2ExportExcel() {
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리가 로드되지 않았습니다.', 'error'); return; }
  var wb = XLSX.utils.book_new();
  // 전체현황 시트
  var ovRows = [['품목명','창고','소비기한','입고(ea)','출고(ea)','현재고(ea)','현재고(Box)','현재고(PT)','상태']];
  var itemSet = {};
  _lg2InboundData.forEach(function(r) {
    var key = (r.item_name || '').trim() + '||' + (r.warehouse || '');
    if (!itemSet[key]) itemSet[key] = { name: (r.item_name||'').trim(), warehouse: r.warehouse||'' };
  });
  Object.values(itemSet).forEach(function(item) {
    var fifo = lg2GetFifoStock(item.name, item.warehouse);
    fifo.forEach(function(f) {
      var bd = lg2CalcBreakdown(f.stock, item.name);
      var status = f.stock < 0 ? '마이너스' : (f.stock === 0 ? '재고없음' : (f.stock <= 10 ? '부족' : '정상'));
      ovRows.push([item.name, item.warehouse === 'W' ? '일반창고(W)' : '저온창고(C)', f.expiry||'-', f.inQty, f.outQty, f.stock, bd.box, bd.pt, status]);
    });
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ovRows), '전체현황');
  // 입고 시트
  var inRows = [['입고일','품목명','창고','수량(ea)','Box','PT','소비기한','공급업체','담당자','비고']];
  _lg2InboundData.forEach(function(r) {
    var bd = lg2CalcBreakdown(r.qty_ea||0, r.item_name);
    inRows.push([r.date||'',r.item_name||'',r.warehouse==='W'?'일반창고(W)':'저온창고(C)',r.qty_ea||0,bd.box,bd.pt,r.expiry||'',r.supplier||'',r.manager||'',r.memo||'']);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(inRows), '입고관리');
  // 출고 시트
  var outRows = [['출고일','품목명','창고','수량(ea)','Box','PT','출고처','담당자','비고']];
  _lg2OutboundData.forEach(function(r) {
    var bd = lg2CalcBreakdown(r.qty_ea||0, r.item_name);
    outRows.push([r.date||'',r.item_name||'',r.warehouse==='W'?'일반창고(W)':'저온창고(C)',r.qty_ea||0,bd.box,bd.pt,r.destination||'',r.manager||'',r.memo||'']);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(outRows), '출고관리');
  // 재고실사 시트
  var auditRows = [['실사일','품목명','창고','시스템재고(ea)','실사수량(ea)','차이(ea)','소비기한','담당자','비고']];
  _lg2AuditData.forEach(function(r) {
    auditRows.push([r.date||'',r.item_name||'',r.warehouse==='W'?'일반창고(W)':'저온창고(C)',r.system_qty||0,r.actual_qty||0,r.diff_qty||0,r.expiry||'',r.manager||'',r.memo||'']);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(auditRows), '재고실사');
  XLSX.writeFile(wb, '물류관리2_' + new Date().toISOString().split('T')[0] + '.xlsx');
  showToast('엑셀 다운로드 완료!', 'success');
}

function lg2ExportInboundExcel() {
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리가 로드되지 않았습니다.', 'error'); return; }
  var rows = [['입고일','품목명','창고','수량(ea)','Box','PT','소비기한','공급업체','담당자','비고']];
  _lg2InboundData.forEach(function(r) {
    var bd = lg2CalcBreakdown(r.qty_ea||0, r.item_name);
    rows.push([r.date||'',r.item_name||'',r.warehouse==='W'?'일반창고(W)':'저온창고(C)',r.qty_ea||0,bd.box,bd.pt,r.expiry||'',r.supplier||'',r.manager||'',r.memo||'']);
  });
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '입고관리');
  XLSX.writeFile(wb, '물류관리2_입고_' + new Date().toISOString().split('T')[0] + '.xlsx');
  showToast('입고 엑셀 다운로드 완료!', 'success');
}

function lg2ExportOutboundExcel() {
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리가 로드되지 않았습니다.', 'error'); return; }
  var rows = [['출고일','품목명','창고','수량(ea)','Box','PT','출고처','담당자','비고']];
  _lg2OutboundData.forEach(function(r) {
    var bd = lg2CalcBreakdown(r.qty_ea||0, r.item_name);
    rows.push([r.date||'',r.item_name||'',r.warehouse==='W'?'일반창고(W)':'저온창고(C)',r.qty_ea||0,bd.box,bd.pt,r.destination||'',r.manager||'',r.memo||'']);
  });
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '출고관리');
  XLSX.writeFile(wb, '물류관리2_출고_' + new Date().toISOString().split('T')[0] + '.xlsx');
  showToast('출고 엑셀 다운로드 완료!', 'success');
}

function lg2ExportAuditExcel() {
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리가 로드되지 않았습니다.', 'error'); return; }
  var rows = [['실사일','품목명','창고','시스템재고(ea)','실사수량(ea)','차이(ea)','소비기한','담당자','비고']];
  _lg2AuditData.forEach(function(r) {
    rows.push([r.date||'',r.item_name||'',r.warehouse==='W'?'일반창고(W)':'저온창고(C)',r.system_qty||0,r.actual_qty||0,r.diff_qty||0,r.expiry||'',r.manager||'',r.memo||'']);
  });
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '재고실사');
  XLSX.writeFile(wb, '물류관리2_재고실사_' + new Date().toISOString().split('T')[0] + '.xlsx');
  showToast('재고실사 엑셀 다운로드 완료!', 'success');
}

// ══════════════════════════════════════════════════
// 페이지네이션 공통 렌더러
// ══════════════════════════════════════════════════
function lg2RenderPager(infoId, btnsId, total, curPage, totalPages, mode) {
  var infoEl = document.getElementById(infoId);
  var btnsEl = document.getElementById(btnsId);
  if (!infoEl || !btnsEl) return;

  if (!total) {
    infoEl.textContent = '';
    btnsEl.innerHTML = '';
    return;
  }

  var pageSize = mode === 'inbound' ? _lg2InPageSize : _lg2OutPageSize;
  var startRow = (curPage - 1) * pageSize + 1;
  var endRow   = Math.min(curPage * pageSize, total);
  infoEl.textContent = '전체 ' + total + '건 · ' + startRow + '-' + endRow + '건 표시';

  // 페이지 버튼 생성 (윈도우 슬라이딩: 현재 페이지 기준 앞뒤 2개씩)
  var html = '';
  // 이전 버튼
  html += '<button class="lg2-page-btn" ' + (curPage <= 1 ? 'disabled' : '') + ' onclick="lg2GoPage(1,\'' + mode + '\')">&#171;</button>';
  html += '<button class="lg2-page-btn" ' + (curPage <= 1 ? 'disabled' : '') + ' onclick="lg2GoPage(' + (curPage-1) + ',\'' + mode + '\')">&#8249;</button>';

  // 페이지 번호 (curPage 기준 앞뒤 2개)
  var pStart = Math.max(1, curPage - 2);
  var pEnd   = Math.min(totalPages, curPage + 2);
  if (pStart > 1) html += '<button class="lg2-page-btn" onclick="lg2GoPage(1,\'' + mode + '\')">1</button>';
  if (pStart > 2) html += '<span style="padding:0 4px;color:#aaa">…</span>';
  for (var p = pStart; p <= pEnd; p++) {
    html += '<button class="lg2-page-btn' + (p === curPage ? ' active' : '') + '" onclick="lg2GoPage(' + p + ',\'' + mode + '\')">'+p+'</button>';
  }
  if (pEnd < totalPages - 1) html += '<span style="padding:0 4px;color:#aaa">…</span>';
  if (pEnd < totalPages) html += '<button class="lg2-page-btn" onclick="lg2GoPage(' + totalPages + ',\'' + mode + '\')">'+totalPages+'</button>';

  // 다음 버튼
  html += '<button class="lg2-page-btn" ' + (curPage >= totalPages ? 'disabled' : '') + ' onclick="lg2GoPage(' + (curPage+1) + ',\'' + mode + '\')">&#8250;</button>';
  html += '<button class="lg2-page-btn" ' + (curPage >= totalPages ? 'disabled' : '') + ' onclick="lg2GoPage(' + totalPages + ',\'' + mode + '\')">&#187;</button>';

  btnsEl.innerHTML = html;
}

function lg2GoPage(page, mode) {
  if (mode === 'inbound') {
    _lg2InPage = page;
    lg2RenderInbound();
  } else {
    _lg2OutPage = page;
    lg2RenderOutbound();
  }
}

// ── HTML 이스케이프 ──
function lg2esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════════════
// 엑셀 업로드 (드래그&클릭) — 입고/출고
// ══════════════════════════════════════════════════════

function lg2DragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.add('dragover');
}

function lg2DragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('dragover');
}

function lg2DropFile(e, mode) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('dragover');
  var files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  lg2ParseAndSaveExcel(files[0], mode);
}

function lg2HandleFileUpload(input, mode) {
  if (!input.files || !input.files.length) return;
  lg2ParseAndSaveExcel(input.files[0], mode);
  input.value = '';
}

async function lg2ParseAndSaveExcel(file, mode) {
  var zoneId = mode === 'inbound' ? 'lg2InDropZone' : 'lg2OutDropZone';
  var zone = document.getElementById(zoneId);
  if (zone) zone.classList.add('uploading');

  try {
    if (typeof XLSX === 'undefined') {
      showToast('엑셀 라이브러리가 로드되지 않았습니다. 잠시 후 다시 시도해주세요.', 'error');
      return;
    }
    var data = await file.arrayBuffer();
    var wb = XLSX.read(data, { type: 'array', cellDates: true });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (!rows || rows.length < 2) {
      showToast('데이터가 없거나 형식이 올바르지 않습니다.', 'warning');
      return;
    }

    var header = rows[0].map(function(h) { return String(h).trim(); });

    // 마지막 행이 합계 행인 경우 제외
    var dataRows = rows.slice(1);
    if (dataRows.length > 0) {
      var lastRow = dataRows[dataRows.length - 1];
      var firstCell = String(lastRow[0] || '').trim();
      if (!firstCell || firstCell.indexOf('합계') >= 0 || firstCell.indexOf('총계') >= 0 || firstCell === '계') {
        dataRows = dataRows.slice(0, -1);
      }
    }
    // 완전히 빈 행 제거
    dataRows = dataRows.filter(function(r) {
      return r.some(function(c) { return String(c).trim() !== ''; });
    });

    if (!dataRows.length) {
      showToast('업로드할 데이터 행이 없습니다.', 'warning');
      return;
    }

    // 헤더 인덱스 매핑
    function col(names) {
      for (var ni = 0; ni < names.length; ni++) {
        var idx = -1;
        for (var hi = 0; hi < header.length; hi++) {
          if (header[hi].indexOf(names[ni]) >= 0) { idx = hi; break; }
        }
        if (idx >= 0) return idx;
      }
      return -1;
    }

    // 날짜 변환 헬퍼
    function toDateStr(val) {
      if (!val) return '';
      if (val instanceof Date) {
        var y = val.getFullYear();
        var mo = String(val.getMonth() + 1).padStart(2, '0');
        var d = String(val.getDate()).padStart(2, '0');
        return y + '-' + mo + '-' + d;
      }
      var s = String(val).trim();
      if (/^\d{5}$/.test(s)) {
        try {
          var parsed = XLSX.SSF.parse_date_code(parseInt(s));
          if (parsed) return parsed.y + '-' + String(parsed.m).padStart(2,'0') + '-' + String(parsed.d).padStart(2,'0');
        } catch(ex) {}
      }
      var clean = s.replace(/\./g, '-').replace(/\//g, '-');
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(clean)) {
        var parts = clean.split('-');
        return parts[0] + '-' + parts[1].padStart(2,'0') + '-' + parts[2].padStart(2,'0');
      }
      return s;
    }

    var saved = 0;
    var skipped = 0;
    var todayStr = new Date().toISOString().split('T')[0];

    if (mode === 'inbound') {
      var iDate      = col(['입고일', '날짜', 'date']);
      var iWarehouse = col(['창고', 'warehouse']);
      var iItem      = col(['품목명', '품목', '제품명', '제품', 'item', 'product']);
      var iQty       = col(['수량', 'ea', 'qty', 'quantity']);
      var iExpiry    = col(['소비기한', '유통기한', 'expiry', 'expire']);
      var iSupplier  = col(['공급업체', '공급사', 'supplier', 'vendor']);
      var iManager   = col(['담당자', '작성자', 'manager']);
      var iMemo      = col(['비고', '메모', 'memo', 'note', 'remark']);

      if (iItem < 0) {
        showToast('품목명 열을 찾을 수 없습니다. 양식을 확인해주세요.', 'error');
        return;
      }

      for (var ri = 0; ri < dataRows.length; ri++) {
        var row = dataRows[ri];
        var itemName = String(row[iItem] || '').trim();
        if (!itemName) { skipped++; continue; }
        var qty = parseInt(row[iQty] || 0) || 0;
        if (qty <= 0) { skipped++; continue; }

        var warehouseRaw = String(row[iWarehouse] || '').trim().toUpperCase();
        var warehouse = (warehouseRaw.indexOf('C') >= 0 || warehouseRaw.indexOf('저온') >= 0) ? 'C' : 'W';
        var breakdown = lg2CalcBreakdown(qty, itemName);

        var rec = {
          date:      toDateStr(row[iDate]) || todayStr,
          warehouse: warehouse,
          item_name: itemName,
          qty_ea:    qty,
          qty_box:   breakdown.box,
          qty_pt:    breakdown.pt,
          expiry:    toDateStr(row[iExpiry]) || '',
          supplier:  String(row[iSupplier] || '').trim(),
          manager:   String(row[iManager] || '').trim(),
          memo:      String(row[iMemo] || '').trim(),
          createdAt: new Date().toISOString(),
          source:    'excel'
        };
        await apiPost('lg2_inbound', rec);
        saved++;
      }
    } else {
      var oDate      = col(['출고일', '날짜', 'date']);
      var oWarehouse = col(['창고', 'warehouse']);
      var oItem      = col(['품목명', '품목', '제품명', '제품', 'item', 'product']);
      var oQty       = col(['수량', 'ea', 'qty', 'quantity']);
      var oDest      = col(['출고체', '거래체', '고객사', 'destination', 'dest', 'customer']);
      var oManager   = col(['담당자', '작성자', 'manager']);
      var oMemo      = col(['비고', '메모', 'memo', 'note', 'remark']);

      if (oItem < 0) {
        showToast('품목명 열을 찾을 수 없습니다. 양식을 확인해주세요.', 'error');
        return;
      }

      for (var oi = 0; oi < dataRows.length; oi++) {
        var orow = dataRows[oi];
        var oItemName = String(orow[oItem] || '').trim();
        if (!oItemName) { skipped++; continue; }
        var oQtyVal = parseInt(orow[oQty] || 0) || 0;
        if (oQtyVal <= 0) { skipped++; continue; }

        var oWarehouseRaw = String(orow[oWarehouse] || '').trim().toUpperCase();
        var oWarehouseVal = (oWarehouseRaw.indexOf('C') >= 0 || oWarehouseRaw.indexOf('저온') >= 0) ? 'C' : 'W';
        var oBd = lg2CalcBreakdown(oQtyVal, oItemName);

        var orec = {
          date:        toDateStr(orow[oDate]) || todayStr,
          warehouse:   oWarehouseVal,
          item_name:   oItemName,
          qty_ea:      oQtyVal,
          qty_box:     oBd.box,
          qty_pt:      oBd.pt,
          destination: String(orow[oDest] || '').trim(),
          manager:     String(orow[oManager] || '').trim(),
          memo:        String(orow[oMemo] || '').trim(),
          createdAt:   new Date().toISOString(),
          source:      'excel'
        };
        await apiPost('lg2_outbound', orec);
        saved++;
      }
    }

    await lg2LoadAll();
    lg2RenderAll();

    if (saved > 0) {
      showToast(saved + '건 업로드 완료' + (skipped > 0 ? ' (건너롱 ' + skipped + '건)' : ''), 'success');
    } else {
      showToast('업로드된 데이터가 없습니다. (건너롱 ' + skipped + '건)', 'warning');
    }
  } catch(err) {
    console.error('엑셀 업로드 오류:', err);
    showToast('파일 처리 중 오류가 발생했습니다: ' + (err.message || err), 'error');
  } finally {
    if (zone) zone.classList.remove('uploading');
  }
}

// ══════════════════════════════════════════════════════
// 양식 다운로드 (입고 / 출고)
// ══════════════════════════════════════════════════════

function lg2DownloadInboundTemplate() {
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리가 로드되지 않았습니다.', 'error'); return; }
  var header = ['입고일', '창고(W=일반/C=저온)', '품목명', '수량(ea)', '소비기한', '공급업체', '담당자', '비고'];
  var example = [
    new Date().toISOString().split('T')[0],
    'W',
    '예시제품A',
    100,
    '2026-12-31',
    '(주)공급업체',
    '홍길동',
    '메모'
  ];
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet([header, example]);
  ws['!cols'] = [
    { wch: 12 }, { wch: 18 }, { wch: 24 }, { wch: 10 },
    { wch: 12 }, { wch: 20 }, { wch: 10 }, { wch: 20 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, '입고양식');
  XLSX.writeFile(wb, '물류관리2_입고_양식.xlsx');
  showToast('입고 양식이 다운로드되었습니다.', 'success');
}

function lg2DownloadOutboundTemplate() {
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리가 로드되지 않았습니다.', 'error'); return; }
  var header = ['출고일', '창고(W=일반/C=저온)', '품목명', '수량(ea)', '출고체', '담당자', '비고'];
  var example = [
    new Date().toISOString().split('T')[0],
    'W',
    '예시제품A',
    50,
    '(주)거래체',
    '홍길동',
    '메모'
  ];
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet([header, example]);
  ws['!cols'] = [
    { wch: 12 }, { wch: 18 }, { wch: 24 }, { wch: 10 },
    { wch: 20 }, { wch: 10 }, { wch: 20 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, '출고양식');
  XLSX.writeFile(wb, '물류관리2_출고_양식.xlsx');
  showToast('출고 양식이 다운로드되었습니다.', 'success');
}


// ══════════════════════════════════════════════════════════════════
// 전체 실사 모드 (Full Audit Mode)
// ══════════════════════════════════════════════════════════════════
var _lg2FullAuditUnlocked  = false;
var _lg2FullAuditWarehouse = 'W'; // 현재 선택 창고 ('W' or 'C')
var _lg2FullAuditPending   = {};  // 재렌더링 중 입력값 임시 보존 { safeId: value }

// ── 관리자 허가 요청 ──────────────────────────────────────────────
function lg2RequestFullAuditApproval() {
  var user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
  if (user && user.role === 'admin') {
    lg2GrantFullAudit();
    return;
  }
  var modalId = 'lg2FullApproveModal';
  var existing = document.getElementById(modalId);
  if (existing) existing.remove();
  var m = document.createElement('div');
  m.id = modalId;
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center';
  m.innerHTML =
    '<div style="background:#fff;border-radius:14px;padding:0;width:360px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.2);overflow:hidden">' +
      '<div style="background:linear-gradient(135deg,#8e44ad,#6c3483);padding:16px 20px;display:flex;align-items:center;justify-content:space-between">' +
        '<div style="color:#fff;font-weight:700;font-size:14px"><i class="fas fa-key"></i> 관리자 허가</div>' +
        '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;opacity:0.7">&times;</button>' +
      '</div>' +
      '<div style="padding:20px">' +
        '<div style="font-size:13px;color:#555;margin-bottom:16px">전체 실사 모드를 활성화하려면<br>관리자 비밀번호를 입력하세요.</div>' +
        '<div style="margin-bottom:12px">' +
          '<label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:5px">관리자 이메일</label>' +
          '<input type="email" id="lg2ApproveEmail" placeholder="admin@lifeculture.co.kr" value="admin@lifeculture.co.kr" style="width:100%;padding:9px 12px;border:1.5px solid #ddd;border-radius:8px;font-size:13px;box-sizing:border-box" />' +
        '</div>' +
        '<div style="margin-bottom:16px">' +
          '<label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:5px">관리자 비밀번호 <span style="color:#e74c3c">*</span></label>' +
          '<input type="password" id="lg2ApprovePassword" placeholder="비밀번호 입력" style="width:100%;padding:9px 12px;border:1.5px solid #ddd;border-radius:8px;font-size:13px;box-sizing:border-box" onkeydown="if(event.key===\'Enter\')lg2VerifyAdminApproval()" autofocus />' +
        '</div>' +
        '<div id="lg2ApproveError" style="display:none;color:#e74c3c;font-size:12px;margin-bottom:10px;padding:8px;background:#fdedec;border-radius:6px"></div>' +
        '<div style="display:flex;gap:8px">' +
          '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="flex:1;padding:10px;background:#f8f9fa;color:#555;border:1px solid #ddd;border-radius:8px;cursor:pointer;font-size:13px">취소</button>' +
          '<button onclick="lg2VerifyAdminApproval()" style="flex:1;padding:10px;background:#8e44ad;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700"><i class="fas fa-unlock"></i> 허가</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(m);
  setTimeout(function() {
    var pw = document.getElementById('lg2ApprovePassword');
    if (pw) pw.focus();
  }, 100);
}

function lg2VerifyAdminApproval() {
  var emailEl = document.getElementById('lg2ApproveEmail');
  var pwEl    = document.getElementById('lg2ApprovePassword');
  var errEl   = document.getElementById('lg2ApproveError');
  if (!pwEl) return;
  var email    = (emailEl ? emailEl.value : 'admin@lifeculture.co.kr').trim();
  var password = pwEl.value;
  var USERS_KEY = 'lc_users';
  var users = [];
  try { users = JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); } catch(e) {}
  if (users.length === 0 && typeof DEFAULT_USERS !== 'undefined') users = DEFAULT_USERS;
  var adminUser = users.find(function(u) {
    return u.email.toLowerCase() === email.toLowerCase() && u.password === password && u.role === 'admin' && u.active;
  });
  if (!adminUser) {
    if (errEl) { errEl.textContent = '관리자 이메일 또는 비밀번호가 올바르지 않습니다.'; errEl.style.display = 'block'; }
    if (pwEl)  { pwEl.value = ''; pwEl.focus(); }
    return;
  }
  var modal = document.getElementById('lg2FullApproveModal');
  if (modal) modal.remove();
  lg2GrantFullAudit();
}

async function lg2GrantFullAudit() {
  _lg2FullAuditUnlocked = true;
  var statusEl    = document.getElementById('lg2FullAuditStatus');
  var approveBtn  = document.getElementById('lg2FullAuditApproveBtn');
  var saveBtn     = document.getElementById('lg2FullAuditSaveBtn');
  var lockBtn     = document.getElementById('lg2FullAuditLockBtn');
  var overlay     = document.getElementById('lg2FullAuditLockOverlay');
  var grid        = document.getElementById('lg2FullAuditGrid');
  var dateEl      = document.getElementById('lg2FullAuditDate');
  if (statusEl)   statusEl.innerHTML = '<i class="fas fa-unlock" style="color:#2ecc71"></i> <span style="color:#2ecc71">허가됨 — 실사 모드 활성</span>';
  if (approveBtn) approveBtn.style.display = 'none';
  if (saveBtn)    saveBtn.style.display = '';
  if (lockBtn)    lockBtn.style.display = '';
  if (overlay)    overlay.style.display = 'none';
  if (grid)       grid.style.display = '';
  if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().split('T')[0];
  showToast('실사 모드 데이터 로딩 중...', 'info');
  // 최신 데이터 재로드
  try {
    var results = await Promise.all([
      apiGetAll('lg2_inbound'),
      apiGetAll('lg2_outbound'),
      apiGetAll('lg2_audit')
    ]);
    _lg2InboundData  = results[0] || [];
    _lg2OutboundData = results[1] || [];
    _lg2AuditData    = results[2] || [];
  } catch(e) { console.warn('lg2 데이터 재로드 실패:', e); }
  lg2RenderFullAuditGrid();
  showToast('전체 실사 모드가 활성화되었습니다.', 'success');
}

function lg2LockFullAudit() {
  if (!confirm('실사 모드를 잠금하시겠습니까?\n저장하지 않은 수정 내용은 사라집니다.')) return;
  _lg2FullAuditUnlocked = false;
  _lg2FullAuditPending  = {};
  var statusEl   = document.getElementById('lg2FullAuditStatus');
  var approveBtn = document.getElementById('lg2FullAuditApproveBtn');
  var saveBtn    = document.getElementById('lg2FullAuditSaveBtn');
  var lockBtn    = document.getElementById('lg2FullAuditLockBtn');
  var overlay    = document.getElementById('lg2FullAuditLockOverlay');
  var grid       = document.getElementById('lg2FullAuditGrid');
  if (statusEl)   statusEl.innerHTML = '<i class="fas fa-lock"></i> 관리자 허가 필요';
  if (approveBtn) approveBtn.style.display = '';
  if (saveBtn)    saveBtn.style.display = 'none';
  if (lockBtn)    lockBtn.style.display = 'none';
  if (overlay)    overlay.style.display = '';
  if (grid)       grid.style.display = 'none';
  showToast('실사 모드가 잠금되었습니다.', 'info');
}

// ── 창고 전환 ────────────────────────────────────────────────────
function lg2FullAuditSetWarehouse(wh) {
  _lg2FullAuditWarehouse = wh;
  var btnW = document.getElementById('lg2FullWh_W');
  var btnC = document.getElementById('lg2FullWh_C');
  if (btnW) {
    if (wh === 'W') {
      btnW.style.background = '#8e44ad'; btnW.style.color = '#fff'; btnW.style.borderColor = '#8e44ad';
    } else {
      btnW.style.background = '#fff'; btnW.style.color = '#555'; btnW.style.borderColor = '#ddd';
    }
  }
  if (btnC) {
    if (wh === 'C') {
      btnC.style.background = '#8e44ad'; btnC.style.color = '#fff'; btnC.style.borderColor = '#8e44ad';
    } else {
      btnC.style.background = '#fff'; btnC.style.color = '#555'; btnC.style.borderColor = '#ddd';
    }
  }
  if (_lg2FullAuditUnlocked) lg2RenderFullAuditGrid();
}

// ── 그리드 렌더링 ─────────────────────────────────────────────────
function lg2RenderFullAuditGrid() {
  var inner   = document.getElementById('lg2FullAuditGridInner');
  var emptyEl = document.getElementById('lg2FullAuditEmpty');
  if (!inner) return;

  // 재렌더링 전 입력값 보존
  inner.querySelectorAll('input[type="number"][data-item]').forEach(function(inp) {
    if (inp.value !== '') _lg2FullAuditPending[inp.id] = inp.value;
  });

  // 현재 창고의 품목 목록 (입고 기준)
  var wh = _lg2FullAuditWarehouse;
  var itemMap = {};
  _lg2InboundData.forEach(function(r) {
    if (r.warehouse !== wh) return;
    var name = (r.item_name || '').trim();
    if (!name) return;
    if (!itemMap[name]) itemMap[name] = { name: name, fifo: [] };
  });

  // FIFO 재고 계산
  Object.keys(itemMap).forEach(function(name) {
    itemMap[name].fifo = lg2GetFifoStock(name, wh);
  });

  var items = Object.values(itemMap).sort(function(a, b) { return a.name.localeCompare(b.name); });

  if (!items.length) {
    inner.innerHTML = '';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  inner.innerHTML = '';
  items.forEach(function(item) {
    var card = lg2CreateFullAuditCard(item.name, item.fifo, wh);
    inner.appendChild(card);
  });

  // 보존된 입력값 복원
  Object.keys(_lg2FullAuditPending).forEach(function(inputId) {
    var el = document.getElementById(inputId);
    if (el && el.value === '') {
      el.value = _lg2FullAuditPending[inputId];
      lg2FullAuditCalcDiff(el);
    }
  });

  lg2FilterFullAuditGrid();
}

// ── 품목 카드 생성 ────────────────────────────────────────────────
function lg2CreateFullAuditCard(itemName, fifoRows, wh) {
  var safeId = itemName.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  var totalStock = fifoRows.reduce(function(s, r) { return s + r.stock; }, 0);
  var hasStock = totalStock > 0;
  var whLabel = wh === 'W' ? '🏭 일반창고' : '❄️ 저온창고';
  var borderColor = hasStock ? '#8e44ad' : '#ddd';
  var bgColor     = hasStock ? '#fdf5ff' : '#f8f9fa';

  var card = document.createElement('div');
  card.className = 'lg2-full-audit-card';
  card.dataset.itemName = itemName;
  card.dataset.hasStock = hasStock ? '1' : '0';
  card.style.cssText = 'border:1.5px solid ' + borderColor + ';border-radius:10px;padding:12px 14px;background:' + bgColor + ';transition:all 0.15s';

  // 헤더
  var headerHtml =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
      '<div>' +
        '<div style="font-size:13px;font-weight:700;color:' + (hasStock ? '#6c3483' : '#aaa') + '">' + lg2esc(itemName) + '</div>' +
        '<div style="font-size:11px;color:#888;margin-top:2px">' + whLabel + ' · 전산재고 <strong>' + totalStock.toLocaleString() + '</strong> ea</div>' +
      '</div>' +
    '</div>';

  // 소비기한별 행
  var rowsHtml = '';
  if (fifoRows.length === 0) {
    rowsHtml = '<div style="font-size:12px;color:#aaa;text-align:center;padding:8px">입고 내역 없음</div>';
  } else {
    fifoRows.forEach(function(f, idx) {
      var rowSafeId = safeId + '_' + idx;
      var expLabel = f.expiry ? f.expiry : '소비기한 미지정';
      var stockColor = f.stock < 0 ? '#e74c3c' : (f.stock === 0 ? '#aaa' : '#27ae60');
      rowsHtml +=
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px;background:#fff;border-radius:8px;border:1px solid #eee;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:120px">' +
            '<div style="font-size:11px;color:#888">소비기한</div>' +
            '<div style="font-size:12px;font-weight:700;color:#555">' + lg2esc(expLabel) + '</div>' +
          '</div>' +
          '<div style="text-align:right;min-width:70px">' +
            '<div style="font-size:11px;color:#888">전산재고</div>' +
            '<div style="font-size:13px;font-weight:700;color:' + stockColor + '">' + f.stock.toLocaleString() + '</div>' +
          '</div>' +
          '<div style="min-width:90px">' +
            '<div style="font-size:11px;color:#888;margin-bottom:3px">실사수량(ea)</div>' +
            '<input type="number" id="lg2fa_' + rowSafeId + '" min="0" placeholder="입력" ' +
              'data-item="' + lg2esc(itemName) + '" ' +
              'data-expiry="' + lg2esc(f.expiry || '') + '" ' +
              'data-wh="' + wh + '" ' +
              'data-sys="' + f.stock + '" ' +
              'oninput="lg2FullAuditCalcDiff(this)" ' +
              'style="width:80px;padding:5px 8px;border:1.5px solid #ddd;border-radius:6px;font-size:13px;text-align:right" />' +
          '</div>' +
          '<div style="min-width:70px;text-align:right">' +
            '<div style="font-size:11px;color:#888;margin-bottom:3px">차이</div>' +
            '<div id="lg2fa_diff_' + rowSafeId + '" style="font-size:13px;font-weight:700;color:#aaa">-</div>' +
          '</div>' +
        '</div>';
    });
  }

  card.innerHTML = headerHtml + rowsHtml;
  return card;
}

// ── 차이 계산 표시 ────────────────────────────────────────────────
function lg2FullAuditCalcDiff(input) {
  var sys    = Number(input.dataset.sys) || 0;
  var actual = input.value !== '' ? Number(input.value) : null;
  var diffId = input.id.replace('lg2fa_', 'lg2fa_diff_');
  var diffEl = document.getElementById(diffId);
  if (!diffEl) return;
  if (actual === null) { diffEl.textContent = '-'; diffEl.style.color = '#aaa'; return; }
  var diff = actual - sys;
  diffEl.textContent = (diff >= 0 ? '+' : '') + diff.toLocaleString();
  diffEl.style.color = diff > 0 ? '#27ae60' : (diff < 0 ? '#e74c3c' : '#aaa');
  // 카드 테두리 강조
  var card = input.closest('.lg2-full-audit-card');
  if (card && diff !== 0) { card.style.borderColor = '#e67e22'; card.style.background = '#fffbf0'; }
}

// ── 필터링 ────────────────────────────────────────────────────────
function lg2FilterFullAuditGrid() {
  var inner      = document.getElementById('lg2FullAuditGridInner');
  var emptyEl    = document.getElementById('lg2FullAuditEmpty');
  if (!inner) return;
  var q          = ((document.getElementById('lg2FullAuditSearch') || {}).value || '').trim().toLowerCase();
  var diffOnly   = (document.getElementById('lg2FullShowDiffOnly') || {}).checked || false;
  var cards      = inner.querySelectorAll('.lg2-full-audit-card');
  var visible    = 0;
  cards.forEach(function(card) {
    var name = (card.dataset.itemName || '').toLowerCase();
    var show = true;
    if (q && !name.includes(q)) show = false;
    if (diffOnly && show) {
      var hasDiff = false;
      card.querySelectorAll('input[type="number"]').forEach(function(inp) {
        if (inp.value !== '') {
          var sys = Number(inp.dataset.sys) || 0;
          if (Number(inp.value) !== sys) hasDiff = true;
        }
      });
      if (!hasDiff) show = false;
    }
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  if (emptyEl) emptyEl.style.display = visible === 0 ? '' : 'none';
}

// ── 실사 저장 ─────────────────────────────────────────────────────
async function lg2SaveFullAudit() {
  if (!_lg2FullAuditUnlocked) { showToast('관리자 허가가 필요합니다.', 'warning'); return; }
  var dateEl = document.getElementById('lg2FullAuditDate');
  var date   = dateEl ? dateEl.value : new Date().toISOString().split('T')[0];
  if (!date) { showToast('실사일자를 입력해주세요.', 'warning'); return; }

  // 입력된 실재고 수집
  var inputs  = document.querySelectorAll('#lg2FullAuditGridInner input[type="number"][data-item]');
  var records = [];
  inputs.forEach(function(inp) {
    if (inp.value === '') return;
    records.push({
      item_name:  inp.dataset.item,
      warehouse:  inp.dataset.wh,
      expiry:     inp.dataset.expiry || '',
      sys_qty:    Number(inp.dataset.sys) || 0,
      actual_qty: Number(inp.value) || 0,
      diff:       (Number(inp.value) || 0) - (Number(inp.dataset.sys) || 0),
      audit_date: date
    });
  });

  if (!records.length) { showToast('입력된 실사 수량이 없습니다.', 'warning'); return; }
  if (!confirm(records.length + '건의 실사 결과를 저장하시겠습니까?\n차이가 있는 항목은 재고가 자동 조정됩니다.')) return;

  showToast('실사 저장 중...', 'info');
  try {
    var adjCreated = 0;
    var user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    var userName = user ? (user.name || user.email) : '관리자';

    for (var i = 0; i < records.length; i++) {
      var rec  = records[i];
      var diff = rec.diff;

      // 실사 이력 저장 (일반 실사 모달과 동일한 필드명 사용)
      await apiPost('lg2_audit', {
        date:        rec.audit_date,
        warehouse:   rec.warehouse,
        item_name:   rec.item_name,
        expiry:      rec.expiry,
        system_qty:  rec.sys_qty,
        actual_qty:  rec.actual_qty,
        diff_qty:    diff,
        manager:     userName,
        memo:        '전체 실사 모드',
        created_at:  Date.now()
      });

      // 차이가 있으면 입고/출고로 재고 조정
      if (diff !== 0) {
        var adjLot  = 'ADJ-' + date.replace(/-/g, '') + '-' + String(i + 1).padStart(3, '0');
        var adjDate = date;
        if (diff > 0) {
          await apiPost('lg2_inbound', {
            date:        adjDate,
            warehouse:   rec.warehouse,
            item_name:   rec.item_name,
            qty_ea:      diff,
            expiry:      rec.expiry,
            supplier:    '재고조정',
            manager:     userName,
            memo:        '전체실사 플러스 조정 (실사:' + rec.actual_qty + ' / 시스템:' + rec.sys_qty + ')',
            created_at:  Date.now()
          });
        } else {
          await apiPost('lg2_outbound', {
            date:        adjDate,
            warehouse:   rec.warehouse,
            item_name:   rec.item_name,
            qty_ea:      Math.abs(diff),
            destination: '재고조정',
            manager:     userName,
            memo:        '전체실사 마이너스 조정 (실사:' + rec.actual_qty + ' / 시스템:' + rec.sys_qty + ')',
            created_at:  Date.now()
          });
        }
        adjCreated++;
      }
    }

    var msg = '전체 실사 저장 완료 (' + records.length + '건)';
    if (adjCreated > 0) msg += ' — 재고 자동 조정 ' + adjCreated + '건 반영';
    showToast(msg, 'success');

    // ★ 실사 기준일을 lg2_stocktake_config에 저장
    try {
      var existingConfigs = await apiGetAll('lg2_stocktake_config');
      var prevConfig = (existingConfigs || []).sort(function(a,b){ return (b.updated_at||0)-(a.updated_at||0); })[0];
      var configPayload = {
        stocktake_base_date: date,
        stocktake_records_count: records.length,
        adj_created: adjCreated,
        updated_at: Date.now(),
        updated_by: userName
      };
      if (prevConfig && prevConfig.id) {
        var prevId = prevConfig.id;
        delete configPayload.id;
        await apiPut('lg2_stocktake_config', prevId, configPayload);
      } else {
        await apiPost('lg2_stocktake_config', configPayload);
      }
      _lg2StocktakeBaseDate = date;
      lg2UpdateStocktakeBaseBanner();
    } catch(cfgErr) {
      console.warn('lg2 실사 기준일 저장 실패:', cfgErr);
    }

    // 데이터 재로드 및 UI 갱신
    _lg2FullAuditPending = {};
    var results = await Promise.all([
      apiGetAll('lg2_inbound'),
      apiGetAll('lg2_outbound'),
      apiGetAll('lg2_audit')
    ]);
    _lg2InboundData  = results[0] || [];
    _lg2OutboundData = results[1] || [];
    _lg2AuditData    = results[2] || [];

    lg2RenderOverview();
    lg2RenderInbound();
    lg2RenderOutbound();
    lg2RenderAudit();
    lg2RenderFullAuditGrid();

  } catch(e) {
    showToast('저장 실패: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════
// 실사 기준일 배너 UI 헬퍼
// ══════════════════════════════════════════════════════════════════
function lg2UpdateStocktakeBaseBanner() {
  var banner  = document.getElementById('lg2StocktakeBaseBanner');
  var label   = document.getElementById('lg2StocktakeBaseDateLabel');
  if (!banner) return;
  if (_lg2StocktakeBaseDate) {
    banner.style.display = 'flex';
    if (label) label.textContent = _lg2StocktakeBaseDate + ' 기준';
  } else {
    banner.style.display = 'none';
    if (label) label.textContent = '';
  }
}

async function lg2ClearStocktakeBase() {
  if (!confirm('실사 기준일을 해제하시겠습니까?\n해제하면 전체 입출고 내역 기준으로 재고가 계산됩니다.')) return;
  try {
    var configs = await apiGetAll('lg2_stocktake_config');
    for (var i = 0; i < configs.length; i++) {
      if (configs[i].id) await apiDelete('lg2_stocktake_config', configs[i].id);
    }
    _lg2StocktakeBaseDate = null;
    lg2UpdateStocktakeBaseBanner();
    lg2RenderOverview();
    showToast('실사 기준일이 해제되었습니다.', 'info');
  } catch(e) {
    showToast('기준일 해제 실패: ' + e.message, 'error');
  }
}
