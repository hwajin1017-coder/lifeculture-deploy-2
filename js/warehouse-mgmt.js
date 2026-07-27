// =====================================================
// 창고 재고 관리 시스템 (warehouse-mgmt.js)
// 저온창고(C) / 일반창고(W)
// 위치 코드: C-[구역번호]-[단]-[파렛트] / W-[구역번호]-[단]-[파렛트]
// v2.0 성능 최적화: whCalcStock 중복 호출 제거, new Date() 단일화, HTML 캐싱
// =====================================================

// ── 전역 상태 ──────────────────────────────────────
var whInboundData = [];
var whOutboundData = [];
var whStocktakeData = [];
var whCurrentMap = 'cold';

// ── 배치도 HTML 캐시 ──────────────────────────────
// 재고 데이터가 변경되지 않으면 이전 렌더링 결과를 재사용
let _whMapCache = { cold: null, warm: null, stockHash: null };
function whInvalidateMapCache() { _whMapCache.stockHash = null; }

// ── 저온창고(냉장창고) 위치 정의 ─────────────────────────────
// A구역: A1~A4, B구역: B1~B5, C구역: C1~C4, D구역: D1~D4, E구역: E1~E4
// 구역당 파렛트 2개 (예외: A1, B5 → 1개), 3단 적재 → 총 120PT
const COLD_ZONE_COUNTS = { A:4, B:5, C:4, D:4, E:4 };
const COLD_SINGLE_PALLET = ['A1','B5'];
const COLD_LOCATIONS = (function() {
  const locs = [];
  Object.entries(COLD_ZONE_COUNTS).forEach(function(entry) {
    var zone = entry[0], count = entry[1];
    for (var n = 1; n <= count; n++) {
      var zoneKey = zone + n;
      var pallets = COLD_SINGLE_PALLET.indexOf(zoneKey) >= 0 ? 1 : 2;
      for (var d = 1; d <= 3; d++) {
        for (var p = 1; p <= pallets; p++) {
          locs.push({
            code: 'C-' + zoneKey + '-' + d + '-' + p,
            zone: zone, zoneNo: n, zoneKey: zoneKey,
            level: d, slot: p, type: 'cold', capacity: 1
          });
        }
      }
    }
  });
  return locs;
})();

// ── 일반창고 위치 정의 ─────────────────────────────
// A구역: A1~A12, B구역: B1~B6, C구역: C1~C7, D구역: D1~D7, E구역: E1~E4
// 구역당 파렛트 2개, 예외(1개): A12, C4, D4, E4, 3단 적재 → 총 204PT
const WARM_ZONE_COUNTS = { A:12, B:6, C:7, D:7, E:4 };
const WARM_SINGLE_PALLET = ['A12','C4','D4','E4'];
const WARM_LOCATIONS = (function() {
  const locs = [];
  Object.entries(WARM_ZONE_COUNTS).forEach(function(entry) {
    var zone = entry[0], count = entry[1];
    for (var n = 1; n <= count; n++) {
      var zoneKey = zone + n;
      var pallets = WARM_SINGLE_PALLET.indexOf(zoneKey) >= 0 ? 1 : 2;
      for (var d = 1; d <= 3; d++) {
        for (var p = 1; p <= pallets; p++) {
          locs.push({
            code: 'W-' + zoneKey + '-' + d + '-' + p,
            zone: zone, zoneNo: n, zoneKey: zoneKey,
            level: d, slot: p, type: 'warm', capacity: 1
          });
        }
      }
    }
  });
  return locs;
})();

// ── 초기화 ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async function() {
  var today = new Date().toISOString().split('T')[0];
  ['whin_date','whout_date','whst_date'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = today;
  });
  // 최초 로드: 창고 데이터 로드
  // (loadLogisticsData는 logistics.js의 DOMContentLoaded에서 직접 호출하므로 여기서는 호출 안 함)
  await whLoadAll();
  whInitLotNos();
});

// 입출고 등록/수정/삭제 후 수동 호출 시 사용
async function whReloadAll() {
  whLoadAll._calledByUser = true;
  await whLoadAll();
  whLoadAll._calledByUser = false;
}

async function whLoadAll() {
  try {
    var results = await Promise.all([
      apiGetAll('wh_inbound'),
      apiGetAll('wh_outbound'),
      apiGetAll('wh_stocktake'),
      apiGetAll('products')
    ]);
    whInboundData = results[0] || [];
    whOutboundData = results[1] || [];
    whStocktakeData = results[2] || [];
    // 제품마스터 캐시 선로딩 (환산 표시용)
    _whProductMasterCache = results[3] || [];
    // InventoryStore 공유 스토어에 창고 데이터 저장
    if (window.InventoryStore) {
      window.InventoryStore.setAll({
        wh_inbound: whInboundData,
        wh_outbound: whOutboundData,
        wh_stocktake: whStocktakeData
      });
    }

    // ── 최적화: stockMap을 1회만 계산하여 모든 함수에 전달 ──
    whInvalidateMapCache(); // 데이터 변경 시 캐시 무효화
    var stockMap = whCalcStock();
    whUpdateMapKpi(stockMap);
    whUpdateDashKpi(stockMap);
    whRenderInTable();
    whRenderOutTable();
    whRenderLedger(stockMap);
    whRenderStocktakeTable();

    var mapTab = document.getElementById('tabContent_wh_map');
    if (mapTab && mapTab.classList.contains('active')) {
      whShowMap(whCurrentMap, stockMap);
    }
    // 재고현황 탭(logistics.js) 동기화 - 창고 입출고 반영
    // whLoadAll이 수동 호출(입출고 등록/수정/삭제)된 경우에만 재로드
    if (typeof loadLogisticsData === 'function' && whLoadAll._calledByUser) {
      await loadLogisticsData();
    }
    // InventoryStore 이벤트 발행 - 입출고 후 자동 갱신 알림
    if (window.InventoryStore && whLoadAll._calledByUser) {
      window.InventoryStore.emit('warehouse:updated', {
        wh_inbound: whInboundData,
        wh_outbound: whOutboundData,
        wh_stocktake: whStocktakeData
      });
    }
  } catch(e) {
    console.error('[warehouse-mgmt] 데이터 로드 실패:', e);
  }
}

// ── Lot No 생성 ───────────────────────────────────
async function whInitLotNos() {
  var today = new Date().toISOString().split('T')[0].replace(/-/g,'').slice(2);
  var inPrefix = 'WH-IN-' + today;
  var outPrefix = 'WH-OUT-' + today;
  var inSeq = String((whInboundData.filter(function(r){ return r.lot_no && r.lot_no.startsWith(inPrefix); }).length) + 1).padStart(3,'0');
  var outSeq = String((whOutboundData.filter(function(r){ return r.lot_no && r.lot_no.startsWith(outPrefix); }).length) + 1).padStart(3,'0');
  var inEl = document.getElementById('whInLotDisplay');
  var outEl = document.getElementById('whOutLotDisplay');
  if (inEl) { inEl.textContent = inPrefix + '-' + inSeq; inEl.dataset.lot = inPrefix + '-' + inSeq; }
  if (outEl) { outEl.textContent = outPrefix + '-' + outSeq; outEl.dataset.lot = outPrefix + '-' + outSeq; }
}

async function whRefreshInLot() {
  var today = new Date().toISOString().split('T')[0].replace(/-/g,'').slice(2);
  var prefix = 'WH-IN-' + today;
  // 성능 개선: Firestore 재조회 대신 메모리 캐시 사용
  var data = (whInboundData && whInboundData.length > 0) ? whInboundData : await apiGetAll('wh_inbound');
  var seq = String((data.filter(function(r){ return r.lot_no && r.lot_no.startsWith(prefix); }).length) + 1).padStart(3,'0');
  var lot = prefix + '-' + seq;
  var el = document.getElementById('whInLotDisplay');
  if (el) { el.textContent = lot; el.dataset.lot = lot; }
}

async function whRefreshOutLot() {
  var today = new Date().toISOString().split('T')[0].replace(/-/g,'').slice(2);
  var prefix = 'WH-OUT-' + today;
  // 성능 개선: Firestore 재조회 대신 메모리 캐시 사용
  var data = (whOutboundData && whOutboundData.length > 0) ? whOutboundData : await apiGetAll('wh_outbound');
  var seq = String((data.filter(function(r){ return r.lot_no && r.lot_no.startsWith(prefix); }).length) + 1).padStart(3,'0');
  var lot = prefix + '-' + seq;
  var el = document.getElementById('whOutLotDisplay');
  if (el) { el.textContent = lot; el.dataset.lot = lot; }
}

// ── 위치 선택 드롭다운 빌드 ───────────────────────
function whBuildLocationSelect(prefix) {
  var whEl = document.getElementById(prefix + '_warehouse');
  var locEl = document.getElementById(prefix + '_location');
  if (!whEl || !locEl) return;
  var wh = whEl.value;
  locEl.innerHTML = '<option value="">위치 선택</option>';
  if (!wh) return;
  // 위치이동 모달은 빈 위치만 표시 (현재 이동 대상 위치 제외)
  if (prefix === 'whMove') {
    var fromLoc = (document.getElementById('whMoveFromLoc') || {}).value || '';
    var stockMap = whCalcStock();
    var usedLocs = {};
    Object.keys(stockMap).forEach(function(loc) {
      if (loc === fromLoc) return; // 이동 출발지는 제외 (이미 비워질 예정)
      var hasStock = Object.values(stockMap[loc]).some(function(v) { return (Number(v.qty) || 0) > 0; });
      if (hasStock) usedLocs[loc] = true;
    });
    var locs2 = wh === 'C' ? COLD_LOCATIONS : WARM_LOCATIONS;
    var zoneKeys2 = [];
    locs2.forEach(function(l) { if (zoneKeys2.indexOf(l.zoneKey) < 0) zoneKeys2.push(l.zoneKey); });
    var totalEmpty = 0;
    zoneKeys2.forEach(function(zk) {
      var filtered = locs2.filter(function(l) { return l.zoneKey === zk && !usedLocs[l.code]; });
      if (filtered.length === 0) return;
      totalEmpty += filtered.length;
      var group = document.createElement('optgroup');
      group.label = (wh === 'C' ? '저온' : '일반') + ' ' + zk + '구역 (빈 위치 ' + filtered.length + '개)';
      filtered.forEach(function(l) {
        var opt = document.createElement('option');
        opt.value = l.code;
        opt.textContent = l.code + '  (' + l.level + '단 ' + l.slot + '번파렛트)';
        group.appendChild(opt);
      });
      locEl.appendChild(group);
    });
    if (totalEmpty === 0) {
      locEl.innerHTML = '<option value="">빈 위치 없음</option>';
    }
    return;
  }
  var locs = wh === 'C' ? COLD_LOCATIONS : WARM_LOCATIONS;
  var zoneKeys = [];
  locs.forEach(function(l) { if (zoneKeys.indexOf(l.zoneKey) < 0) zoneKeys.push(l.zoneKey); });

  // 입고 위치 선택: 같은 제품이 있는 위치 우선 표시
  if (prefix === 'whin') {
    var stockMapIn = whCalcStock();
    var itemNameIn = (document.getElementById('whin_item_name') || {}).value || '';
    itemNameIn = itemNameIn.trim();
    var sameItemLocs = [];
    var otherStockedLocs = [];
    var emptyInLocs = [];
    locs.forEach(function(l) {
      var items = stockMapIn[l.code] || {};
      var hasSameItem = itemNameIn && items[itemNameIn] && (Number(items[itemNameIn].qty) || 0) > 0;
      var totalQty = Object.values(items).reduce(function(s, v) { return s + (Number(v.qty) || 0); }, 0);
      if (hasSameItem) {
        sameItemLocs.push({ loc: l, qty: items[itemNameIn].qty, unit: items[itemNameIn].unit || '' });
      } else if (totalQty > 0) {
        var itemSummary = Object.entries(items)
          .filter(function(e2) { return (Number(e2[1].qty) || 0) > 0; })
          .map(function(e2) { return e2[0] + ' ' + e2[1].qty; })
          .join(', ');
        otherStockedLocs.push({ loc: l, summary: itemSummary });
      } else {
        emptyInLocs.push(l);
      }
    });
    // 같은 제품 있는 위치 그룹
    if (sameItemLocs.length > 0) {
      var grpSame = document.createElement('optgroup');
      grpSame.label = '⭐ 같은 제품 있는 위치 (' + sameItemLocs.length + '개) — 합산 추천';
      sameItemLocs.forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s.loc.code;
        opt.textContent = s.loc.code + '  ▶ 현재고 ' + s.qty + ' ' + s.unit + ' (합산 가능)';
        opt.dataset.hasSameItem = '1';
        grpSame.appendChild(opt);
      });
      locEl.appendChild(grpSame);
    }
    // 다른 제품 있는 위치 그룹
    if (otherStockedLocs.length > 0) {
      var grpOther = document.createElement('optgroup');
      grpOther.label = '📦 다른 제품 있는 위치 (' + otherStockedLocs.length + '개)';
      otherStockedLocs.forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s.loc.code;
        opt.textContent = s.loc.code + '  ▶ ' + (s.summary.length > 35 ? s.summary.substring(0, 35) + '...' : s.summary);
        grpOther.appendChild(opt);
      });
      locEl.appendChild(grpOther);
    }
    // 빈 위치 그룹
    if (emptyInLocs.length > 0) {
      var grpEmptyIn = document.createElement('optgroup');
      grpEmptyIn.label = '□ 빈 위치 (' + emptyInLocs.length + '개)';
      emptyInLocs.forEach(function(l) {
        var opt = document.createElement('option');
        opt.value = l.code;
        opt.textContent = l.code + '  (' + l.level + '단 ' + l.slot + '번파레트)';
        grpEmptyIn.appendChild(opt);
      });
      locEl.appendChild(grpEmptyIn);
    }
    return;
  }

  // 출고 위치 선택: 재고 있는 위치 우선 표시
  if (prefix === 'whout') {
    var stockMapOut = whCalcStock();
    var stockedLocs = [];
    var emptyOutLocs = [];
    locs.forEach(function(l) {
      var items = stockMapOut[l.code] || {};
      var totalQty = Object.values(items).reduce(function(s, v) { return s + (Number(v.qty) || 0); }, 0);
      if (totalQty > 0) {
        stockedLocs.push({ loc: l, qty: totalQty, items: items });
      } else {
        emptyOutLocs.push(l);
      }
    });
    if (stockedLocs.length > 0) {
      var grpStock = document.createElement('optgroup');
      grpStock.label = '✅ 재고 있는 위치 (' + stockedLocs.length + '개)';
      stockedLocs.forEach(function(s) {
        var itemSummary = Object.entries(s.items)
          .filter(function(e2) { return (Number(e2[1].qty) || 0) > 0; })
          .map(function(e2) { return e2[0] + ' ' + e2[1].qty + (e2[1].unit || ''); })
          .join(', ');
        var opt = document.createElement('option');
        opt.value = s.loc.code;
        opt.textContent = s.loc.code + '  ▶ ' + (itemSummary.length > 40 ? itemSummary.substring(0, 40) + '...' : itemSummary);
        opt.dataset.hasStock = '1';
        grpStock.appendChild(opt);
      });
      locEl.appendChild(grpStock);
    }
    if (emptyOutLocs.length > 0) {
      var grpEmptyOut = document.createElement('optgroup');
      grpEmptyOut.label = '□ 빈 위치 (' + emptyOutLocs.length + '개)';
      emptyOutLocs.forEach(function(l) {
        var opt = document.createElement('option');
        opt.value = l.code;
        opt.textContent = l.code + '  (' + l.level + '단 ' + l.slot + '번파레트)';
        grpEmptyOut.appendChild(opt);
      });
      locEl.appendChild(grpEmptyOut);
    }
    return;
  }

  zoneKeys.forEach(function(zk) {
    var group = document.createElement('optgroup');
    group.label = (wh === 'C' ? '저온' : '일반') + ' ' + zk + '구역';
    locs.filter(function(l){ return l.zoneKey === zk; }).forEach(function(l) {
      var opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.code + '  (' + l.level + '단 ' + l.slot + '번파레트)';
      group.appendChild(opt);
    });
    locEl.appendChild(group);
  });
}

// ── 재고 계산 ─────────────────────────────────────
function whCalcStock() {
  var stockMap = {};
  whInboundData.forEach(function(r) {
    if (!r.location) return;
    if (!stockMap[r.location]) stockMap[r.location] = {};
    var key = r.item_name || '미상';
    if (!stockMap[r.location][key]) {
      stockMap[r.location][key] = { qty: 0, unit: r.unit || '', expiry: r.expiry_date || '', lot: r.lot_no || '', inDate: r.inbound_date || '' };
    }
    stockMap[r.location][key].qty += Number(r.qty) || 0;
    if ((r.inbound_date || '') > stockMap[r.location][key].inDate) {
      stockMap[r.location][key].expiry = r.expiry_date || '';
      stockMap[r.location][key].lot = r.lot_no || '';
      stockMap[r.location][key].inDate = r.inbound_date || '';
    }
  });
  whOutboundData.forEach(function(r) {
    var outQty = Number(r.qty) || 0;
    var outItem = r.item_name || '미상';
    // 1순위: 정확한 위치+품목명 매칭
    if (r.location && stockMap[r.location] && stockMap[r.location][outItem]) {
      stockMap[r.location][outItem].qty -= outQty;
      return;
    }
    // 2순위: 위치가 없거나 매칭 안되면 품목명 기준으로 소비기한 짧은 순으로 차감
    var bestLoc = null;
    var bestExpiry = '9999-99-99';
    Object.keys(stockMap).forEach(function(loc) {
      if (stockMap[loc][outItem] && stockMap[loc][outItem].qty > 0) {
        var exp = stockMap[loc][outItem].expiry || '9999-99-99';
        if (!bestLoc || exp < bestExpiry) {
          bestLoc = loc;
          bestExpiry = exp;
        }
      }
    });
    if (bestLoc) {
      stockMap[bestLoc][outItem].qty -= outQty;
    }
  });
  return stockMap;
}

// ── 대시보드 KPI (전체현황 탭) ──────────────────────
// 최적화: stockMap을 인수로 받아 중복 계산 방지 (없으면 자체 계산)
function whUpdateDashKpi(stockMap) {
  stockMap = stockMap || whCalcStock();
  var today = new Date();
  var soon30 = new Date(today); soon30.setDate(today.getDate() + 30);
  var coldUsed = Object.keys(stockMap).filter(function(k) {
    return k.startsWith('C-') && Object.values(stockMap[k]).some(function(v){ return v.qty > 0; });
  }).length;
  var warmUsed = Object.keys(stockMap).filter(function(k) {
    return k.startsWith('W-') && Object.values(stockMap[k]).some(function(v){ return v.qty > 0; });
  }).length;
  var coldExpiry = 0, warmExpiry = 0;
  whInboundData.forEach(function(r) {
    if (!r.expiry_date) return;
    var exp = new Date(r.expiry_date);
    if (exp <= soon30 && exp >= today) {
      if ((r.warehouse || r.location || '').startsWith('C')) coldExpiry++;
      else warmExpiry++;
    }
  });
  function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
  set('dashColdUsed', coldUsed);
  set('dashColdTotal', COLD_LOCATIONS.length);
  set('dashColdExpiry', coldExpiry);
  set('dashWarmUsed', warmUsed);
  set('dashWarmTotal', WARM_LOCATIONS.length);
  set('dashWarmExpiry', warmExpiry);
}

// ── KPI 업데이트 (창고현황 탭) ──────────────────────
// 최적화: stockMap을 인수로 받아 중복 계산 방지 (없으면 자체 계산)
function whUpdateMapKpi(stockMap) {
  stockMap = stockMap || whCalcStock();
  var today = new Date();
  var soon30 = new Date(today); soon30.setDate(today.getDate() + 30);
  var coldUsed = Object.keys(stockMap).filter(function(k) {
    return k.startsWith('C-') && Object.values(stockMap[k]).some(function(v){ return v.qty > 0; });
  }).length;
  var warmUsed = Object.keys(stockMap).filter(function(k) {
    return k.startsWith('W-') && Object.values(stockMap[k]).some(function(v){ return v.qty > 0; });
  }).length;
  var expirySoon = 0;
  var allItems = {};
  whInboundData.forEach(function(r) {
    if (r.item_name) allItems[r.item_name] = 1;
    if (r.expiry_date) {
      var exp = new Date(r.expiry_date);
      if (exp <= soon30 && exp >= today) expirySoon++;
    }
  });
  function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
  set('whKpiColdUsed', coldUsed + ' / ' + COLD_LOCATIONS.length);
  set('whKpiWarmUsed', warmUsed + ' / ' + WARM_LOCATIONS.length);
  set('whKpiExpirySoon', expirySoon);
  set('whKpiTotalItems', Object.keys(allItems).length);
  var alertEl = document.getElementById('whExpiryAlert');
  var alertList = document.getElementById('whExpiryAlertList');
  if (alertEl && alertList) {
    var expItems = whInboundData.filter(function(r) {
      if (!r.expiry_date) return false;
      var exp = new Date(r.expiry_date);
      var diff = Math.ceil((exp - today) / (1000*60*60*24));
      return diff >= 0 && diff <= 30;
    }).sort(function(a,b){ return (a.expiry_date||'').localeCompare(b.expiry_date||''); });
    if (expItems.length > 0) {
      alertEl.style.display = '';
      alertList.innerHTML = expItems.slice(0,5).map(function(r) {
        var diff = Math.ceil((new Date(r.expiry_date) - today) / (1000*60*60*24));
        return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,193,7,0.3);font-size:13px">' +
          '<span><strong>' + (r.item_name||'-') + '</strong> (' + (r.location||'-') + ')</span>' +
          '<span style="color:#e74c3c;font-weight:700">D-' + diff + ' (' + r.expiry_date + ')</span>' +
          '</div>';
      }).join('');
    } else {
      alertEl.style.display = 'none';
    }
  }
}

// ── 창고 배치도 시각화 ────────────────────────────
// 최적화: stockMap 인수 전달 + HTML 캐싱 + 로딩 스켈레톤
function whShowMap(type, stockMap) {
  whCurrentMap = type;
  var container = document.getElementById('whMapContainer');
  if (!container) return;

  // 버튼 스타일 업데이트
  var coldBtn = document.getElementById('btnColdMap');
  var warmBtn = document.getElementById('btnWarmMap');
  if (coldBtn && warmBtn) {
    if (type === 'cold') {
      coldBtn.style.cssText = 'background:#e8f4fd;color:#2980b9;border:2px solid #2980b9;font-weight:700;padding:8px 16px;border-radius:8px;cursor:pointer';
      warmBtn.style.cssText = 'background:#f8f9fa;color:#555;border:2px solid #ddd;font-weight:700;padding:8px 16px;border-radius:8px;cursor:pointer';
    } else {
      warmBtn.style.cssText = 'background:#eafaf1;color:#27ae60;border:2px solid #27ae60;font-weight:700;padding:8px 16px;border-radius:8px;cursor:pointer';
      coldBtn.style.cssText = 'background:#f8f9fa;color:#555;border:2px solid #ddd;font-weight:700;padding:8px 16px;border-radius:8px;cursor:pointer';
    }
  }

  // ── 최적화 1: 로딩 스켈레톤 즉시 표시 ──
  container.innerHTML =
    '<div style="text-align:center;padding:40px 20px;color:#aaa">' +
    '<i class="fas fa-spinner fa-spin" style="font-size:24px;color:#2980b9"></i>' +
    '<div style="margin-top:10px;font-size:13px">배치도 렌더링 중...</div>' +
    '</div>';

  // ── 최적화 2: stockMap을 외부에서 받아 중복 계산 방지 ──
  stockMap = stockMap || whCalcStock();

  // ── 최적화 3: 재고 변경이 없으면 캐시된 HTML 재사용 ──
  var hash = JSON.stringify(stockMap);
  if (_whMapCache.stockHash !== hash) {
    // 데이터가 변경된 경우에만 HTML 재생성
    _whMapCache.cold = whBuildColdMap(stockMap);
    _whMapCache.warm = whBuildWarmMap(stockMap);
    _whMapCache.stockHash = hash;
  }

  // requestAnimationFrame으로 렌더링을 브라우저 페인트 사이클에 맞춤
  requestAnimationFrame(function() {
    container.innerHTML = type === 'cold' ? _whMapCache.cold : _whMapCache.warm;
    whUpdateMapKpi(stockMap);
  });
}

function whGetSlotColor(stockMap, code) {
  var items = stockMap[code] || {};
  var hasStock = Object.values(items).some(function(v){ return (v.qty||0) > 0; });
  if (!hasStock) return { bg: '#e0e0e0', text: '#999', label: '공실' };
  var today = new Date();
  var hasExpiring = Object.values(items).some(function(v) {
    if (!v.expiry) return false;
    var diff = Math.ceil((new Date(v.expiry) - today) / (1000*60*60*24));
    return diff >= 0 && diff <= 30;
  });
  if (hasExpiring) return { bg: '#fff3cd', text: '#856404', label: '임박' };
  return { bg: '#d4edda', text: '#155724', label: '적재' };
}

function whBuildColdMap(stockMap) {
  // ── 최적화: new Date()를 함수 상단에서 1회만 생성 ──
  var today = new Date();

  function zoneBlock(zone, count) {
    var html = '';
    for (var n = 1; n <= count; n++) {
      var zk = zone + n;
      var pallets = COLD_SINGLE_PALLET.indexOf(zk) >= 0 ? 1 : 2;
      var totalSlots = pallets * 4;
      var used = 0;
      var hasExpiry = false;
      for (var d = 1; d <= 4; d++) {
        for (var p = 1; p <= pallets; p++) {
          var code = 'C-' + zk + '-' + d + '-' + p;
          var locItems = stockMap[code] || {};
          if (Object.values(locItems).some(function(v){ return (v.qty||0) > 0; })) used++;
          if (Object.values(locItems).some(function(v) {
            if (!v.expiry) return false;
            return Math.ceil((new Date(v.expiry) - today) / 86400000) <= 30;
          })) hasExpiry = true;
        }
      }
      var ratio = totalSlots > 0 ? used / totalSlots : 0;
      var bg = ratio === 0 ? '#e0e0e0' : ratio < 0.5 ? '#27ae60' : ratio < 1 ? '#f39c12' : '#e74c3c';
      var textColor = ratio === 0 ? '#999' : '#fff';
      var expiryDot = hasExpiry ? '<span style="position:absolute;top:-3px;right:-3px;width:8px;height:8px;background:#e74c3c;border-radius:50%;display:block"></span>' : '';
      html += '<div onclick="whShowLocDetail(\'C-' + zk + '-1-1\')" title="' + zk + ': ' + used + '/' + totalSlots + '"' +
        ' style="position:relative;cursor:pointer;background:' + bg + ';border-radius:6px;padding:5px 7px;min-width:52px;text-align:center;border:2px solid transparent;transition:all 0.2s;margin:2px"' +
        ' onmouseover="this.style.boxShadow=\'0 2px 8px rgba(0,0,0,0.2)\'" onmouseout="this.style.boxShadow=\'none\'">' +
        expiryDot +
        '<div style="font-size:11px;font-weight:700;color:' + textColor + '">' + zk + '</div>' +
        '<div style="font-size:9px;color:' + (ratio===0?'#bbb':'rgba(255,255,255,0.85)') + '">' + used + '/' + totalSlots + '</div>' +
        '</div>';
    }
    return html;
  }

  var totalSlots = COLD_LOCATIONS.length;
  var usedSlots = COLD_LOCATIONS.filter(function(l) {
    var items = stockMap[l.code] || {};
    return Object.values(items).some(function(v){ return (v.qty||0) > 0; });
  }).length;

  return '<div style="background:#fff;border-radius:12px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">' +
    '<div style="font-size:14px;font-weight:700;color:#2980b9;margin-bottom:12px;display:flex;align-items:center;gap:8px">' +
    '<i class="fas fa-snowflake"></i> 저온창고(냉장창고) (C) — 3단 적재 · 총 ' + totalSlots + '슬롯 · 사용 ' + usedSlots + '슬롯</div>' +
    '<div style="background:#f0f7ff;border:2px solid #2980b9;border-radius:10px;padding:14px;position:relative">' +
    '<div style="margin-bottom:12px;background:#e3f2fd;border-radius:8px;padding:10px">' +
    '<div style="font-size:11px;font-weight:700;color:#1565c0;margin-bottom:6px">A구역 (1~4)</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + zoneBlock('A', 4) + '</div></div>' +
    '<div style="margin-bottom:12px;background:#e8f4fd;border-radius:8px;padding:10px">' +
    '<div style="font-size:11px;font-weight:700;color:#2980b9;margin-bottom:6px">B구역 (1~5)</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + zoneBlock('B', 5) + '</div></div>' +
    '<div style="margin-bottom:12px;background:#e0f0ff;border-radius:8px;padding:10px">' +
    '<div style="font-size:11px;font-weight:700;color:#0e6da8;margin-bottom:6px">C구역 (1~4)</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + zoneBlock('C', 4) + '</div></div>' +
    '<div style="margin-bottom:12px;background:#d6eaf8;border-radius:8px;padding:10px">' +
    '<div style="font-size:11px;font-weight:700;color:#1a5276;margin-bottom:6px">D구역 (1~4)</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + zoneBlock('D', 4) + '</div></div>' +
    '<div style="margin-bottom:4px;background:#cce5f6;border-radius:8px;padding:10px">' +
    '<div style="font-size:11px;font-weight:700;color:#154360;margin-bottom:6px">E구역 (1~4)</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + zoneBlock('E', 4) + '</div></div>' +
    '<div style="position:absolute;bottom:-13px;left:50%;transform:translateX(-50%);background:#2C5F2E;color:#fff;font-size:11px;font-weight:700;padding:2px 14px;border-radius:20px">🚪 입구</div>' +
    '</div>' +
    '<div style="display:flex;gap:14px;margin-top:18px;flex-wrap:wrap;font-size:12px">' +
    '<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;background:#e0e0e0;border-radius:3px;display:inline-block"></span>공실</span>' +
    '<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;background:#27ae60;border-radius:3px;display:inline-block"></span>적재(50%미만)</span>' +
    '<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;background:#f39c12;border-radius:3px;display:inline-block"></span>여유(50~99%)</span>' +
    '<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;background:#e74c3c;border-radius:3px;display:inline-block"></span>만재</span>' +
    '<span style="display:flex;align-items:center;gap:4px"><span style="width:8px;height:8px;background:#e74c3c;border-radius:50%;display:inline-block"></span>소비기한임박</span>' +
    '</div>' +
    '<div style="margin-top:6px;font-size:11px;color:#888">※ 각 구역 클릭 시 단별 상세 재고 확인 가능</div>' +
    '</div>';
}

function whBuildWarmMap(stockMap) {
  // ── 최적화: new Date()를 함수 상단에서 1회만 생성 ──
  var today = new Date();

  function zoneBlock(zone, count) {
    var html = '';
    for (var n = 1; n <= count; n++) {
      var zk = zone + n;
      var pallets = WARM_SINGLE_PALLET.indexOf(zk) >= 0 ? 1 : 2;
      var totalSlots = pallets * 3;
      var used = 0;
      var hasExpiry = false;
      for (var d = 1; d <= 3; d++) {
        for (var p = 1; p <= pallets; p++) {
          var code = 'W-' + zk + '-' + d + '-' + p;
          var locItems = stockMap[code] || {};
          if (Object.values(locItems).some(function(v){ return (v.qty||0) > 0; })) used++;
          if (Object.values(locItems).some(function(v) {
            if (!v.expiry) return false;
            return Math.ceil((new Date(v.expiry) - today) / 86400000) <= 30;
          })) hasExpiry = true;
        }
      }
      var ratio = totalSlots > 0 ? used / totalSlots : 0;
      var bg = ratio === 0 ? '#e0e0e0' : ratio < 0.5 ? '#27ae60' : ratio < 1 ? '#f39c12' : '#e74c3c';
      var textColor = ratio === 0 ? '#999' : '#fff';
      var expiryDot = hasExpiry ? '<span style="position:absolute;top:-3px;right:-3px;width:8px;height:8px;background:#e74c3c;border-radius:50%;display:block"></span>' : '';
      html += '<div onclick="whShowLocDetail(\'W-' + zk + '-1-1\')" title="' + zk + ': ' + used + '/' + totalSlots + '"' +
        ' style="position:relative;cursor:pointer;background:' + bg + ';border-radius:6px;padding:5px 7px;min-width:52px;text-align:center;border:2px solid transparent;transition:all 0.2s;margin:2px"' +
        ' onmouseover="this.style.boxShadow=\'0 2px 8px rgba(0,0,0,0.2)\'" onmouseout="this.style.boxShadow=\'none\'">' +
        expiryDot +
        '<div style="font-size:11px;font-weight:700;color:' + textColor + '">' + zk + '</div>' +
        '<div style="font-size:9px;color:' + (ratio===0?'#bbb':'rgba(255,255,255,0.85)') + '">' + used + '/' + totalSlots + '</div>' +
        '</div>';
    }
    return html;
  }

  var totalSlots = WARM_LOCATIONS.length;
  var usedSlots = WARM_LOCATIONS.filter(function(l) {
    var items = stockMap[l.code] || {};
    return Object.values(items).some(function(v){ return (v.qty||0) > 0; });
  }).length;

  return '<div style="background:#fff;border-radius:12px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">' +
    '<div style="font-size:14px;font-weight:700;color:#27ae60;margin-bottom:12px;display:flex;align-items:center;gap:8px">' +
    '<i class="fas fa-warehouse"></i> 일반창고 (W) — 3단 적재 · 총 ' + totalSlots + '슬롯 · 사용 ' + usedSlots + '슬롯</div>' +
    '<div style="background:#f0fff4;border:2px solid #27ae60;border-radius:10px;padding:14px;position:relative">' +
    '<div style="margin-bottom:12px;background:#e8f5e9;border-radius:8px;padding:10px">' +
    '<div style="font-size:11px;font-weight:700;color:#1b5e20;margin-bottom:6px">A구역 (1~12)</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + zoneBlock('A', 12) + '</div></div>' +
    '<div style="margin-bottom:12px;background:#e3f2fd;border-radius:8px;padding:10px">' +
    '<div style="font-size:11px;font-weight:700;color:#0d47a1;margin-bottom:6px">B구역 (1~6)</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + zoneBlock('B', 6) + '</div></div>' +
    '<div style="margin-bottom:12px;background:#fff3e0;border-radius:8px;padding:10px">' +
    '<div style="font-size:11px;font-weight:700;color:#e65100;margin-bottom:6px">C구역 (1~7)</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + zoneBlock('C', 7) + '</div></div>' +
    '<div style="margin-bottom:12px;background:#f3e5f5;border-radius:8px;padding:10px">' +
    '<div style="font-size:11px;font-weight:700;color:#4a148c;margin-bottom:6px">D구역 (1~7)</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + zoneBlock('D', 7) + '</div></div>' +
    '<div style="margin-bottom:4px;background:#e0f7fa;border-radius:8px;padding:10px">' +
    '<div style="font-size:11px;font-weight:700;color:#006064;margin-bottom:6px">E구역 (1~4)</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + zoneBlock('E', 4) + '</div></div>' +
    '<div style="position:absolute;bottom:-13px;left:50%;transform:translateX(-50%);background:#2C5F2E;color:#fff;font-size:11px;font-weight:700;padding:2px 14px;border-radius:20px">🚪 입구</div>' +
    '</div>' +
    '<div style="display:flex;gap:14px;margin-top:18px;flex-wrap:wrap;font-size:12px">' +
    '<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;background:#e0e0e0;border-radius:3px;display:inline-block"></span>공실</span>' +
    '<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;background:#27ae60;border-radius:3px;display:inline-block"></span>적재(50%미만)</span>' +
    '<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;background:#f39c12;border-radius:3px;display:inline-block"></span>여유(50~99%)</span>' +
    '<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;background:#e74c3c;border-radius:3px;display:inline-block"></span>만재</span>' +
    '</div>' +
    '<div style="margin-top:6px;font-size:11px;color:#888">※ 각 구역 클릭 시 단별 상세 재고 확인 가능</div>' +
    '</div>';
}

// ── 위치 상세 팝업 ────────────────────────────────
function whShowLocDetail(locCode) {
  // 최적화: stockMap 1회 계산
  var stockMap = whCalcStock();
  var parts = locCode.split('-');
  var wh = parts[0];
  var zoneKey = parts[1];
  var allLocs = wh === 'C' ? COLD_LOCATIONS : WARM_LOCATIONS;
  var zoneLocs = allLocs.filter(function(l){ return l.zoneKey === zoneKey; });
  var modal = document.getElementById('whLocDetailModal');
  var title = document.getElementById('whLocDetailTitle');
  var body = document.getElementById('whLocDetailBody');
  if (!modal || !title || !body) return;
  var whName = wh === 'C' ? '저온창고' : '일반창고';
  title.innerHTML = '<i class="fas fa-map-marker-alt"></i> ' + whName + ' ' + zoneKey + '구역 상세';
  var levels = 3; // 저온창고/일반창고 모두 3단 적재
  // 최적화: today를 루프 밖에서 1회 생성
  var today = new Date();
  var bodyHtml = '<div style="font-size:12px;color:#555;margin-bottom:12px"><b>' + whName + '</b> · <b>' + zoneKey + '구역</b> · ' + '3단' + ' 적재</div>';
  for (var d = 1; d <= levels; d++) {
    var lvLocs = zoneLocs.filter(function(l){ return l.level === d; });
    bodyHtml += '<div style="background:#f8f9fa;border-radius:8px;padding:10px;margin-bottom:8px">';
    bodyHtml += '<div style="font-weight:700;font-size:12px;color:#555;margin-bottom:6px">' + d + '단</div>';
    bodyHtml += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
    lvLocs.forEach(function(l) {
      var items = stockMap[l.code] || {};
      var hasStock = Object.values(items).some(function(v){ return (v.qty||0) > 0; });
      var bg = hasStock ? '#d4edda' : '#f8f9fa';
      var border = hasStock ? '#27ae60' : '#dee2e6';
      var itemList = Object.entries(items).filter(function(e){ return (e[1].qty||0) > 0; }).map(function(e) {
        var diff = e[1].expiry ? Math.ceil((new Date(e[1].expiry) - today) / 86400000) : null;
        var expiryColor = diff !== null && diff <= 30 ? '#e74c3c' : '#555';
        return '<div style="font-size:11px"><b>' + e[0] + '</b> ' + e[1].qty + (e[1].unit||'') +
          (e[1].expiry ? ' <span style="color:' + expiryColor + '">(' + e[1].expiry + ')</span>' : '') +
          (e[1].lot ? ' <span style="color:#888">Lot:' + e[1].lot + '</span>' : '') + '</div>';
      }).join('');
      bodyHtml += '<div style="flex:1;min-width:120px;background:' + bg + ';border:1px solid ' + border + ';border-radius:6px;padding:8px">' +
        '<div style="font-size:10px;font-weight:700;color:#555;margin-bottom:4px">' + l.code + '</div>' +
        (itemList || '<div style="font-size:11px;color:#aaa">공실</div>') +
        '</div>';
    });
    bodyHtml += '</div></div>';
  }
  body.innerHTML = bodyHtml;
  modal.classList.add('show');
}

// ── 입고 등록 ─────────────────────────────────────
async function whSubmitInbound() {
  var fields = ['whin_warehouse','whin_location','whin_item_name','whin_qty','whin_unit','whin_date'];
  var data = {};
  var valid = true;
  fields.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el || !el.value.trim()) { valid = false; return; }
    data[id.replace('whin_','')] = el.value.trim();
  });
  if (!valid) { showToast('필수 항목을 모두 입력해주세요.', 'warning'); return; }
  var lotEl = document.getElementById('whInLotDisplay');
  data.lot_no = lotEl ? lotEl.dataset.lot || lotEl.textContent : '';
  data.inbound_date = data.date;
  data.expiry_date = (document.getElementById('whin_expiry') || {}).value || '';
  data.lot_no_product = (document.getElementById('whin_lot_no') || {}).value || '';
  data.supplier = (document.getElementById('whin_supplier') || {}).value || '';
  data.memo = (document.getElementById('whin_memo') || {}).value || '';
  try {
    await apiPost('wh_inbound', data);
    showToast('입고 등록 완료: ' + data.lot_no, 'success');
    whInvalidateMapCache(); // 캐시 무효화
    await whReloadAll();
    whRefreshInLot();
    var form = document.getElementById('whInboundForm');
    if (form) form.reset();
    var today = new Date().toISOString().split('T')[0];
    var dateEl = document.getElementById('whin_date');
    if (dateEl) dateEl.value = today;
  } catch(e) {
    showToast('입고 등록 실패: ' + e.message, 'error');
  }
}

// ── 입고 테이블 렌더 ──────────────────────────────
function whRenderInTable() {
  var tbody = document.getElementById('whInTableBody');
  if (!tbody) return;
  // 제품마스터 캐시 없으면 로딩 후 재렌더링
  if (!_whProductMasterCache) {
    whLoadProductMaster().then(function() { whRenderInTable(); });
    return;
  }
  var _inSearchQ = (document.getElementById('whInSearch') ? document.getElementById('whInSearch').value.trim().toLowerCase() : '');
  var _inTypeQ = (document.getElementById('whInTypeFilter') ? document.getElementById('whInTypeFilter').value : '');
  var data = whInboundData.slice().sort(function(a,b){ return (b.inbound_date||'').localeCompare(a.inbound_date||''); });
  if (_inSearchQ) {
    data = data.filter(function(r) {
      return (r.item_name||'').toLowerCase().includes(_inSearchQ) ||
             (r.lot_no||'').toLowerCase().includes(_inSearchQ) ||
             (r.location||'').toLowerCase().includes(_inSearchQ) ||
             (r.supplier||'').toLowerCase().includes(_inSearchQ);
    });
  }
  if (_inTypeQ) {
    data = data.filter(function(r) { return (r.inbound_type||'') === _inTypeQ; });
  }
  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;color:#aaa;padding:30px"><i class="fas fa-inbox" style="font-size:24px;display:block;margin-bottom:8px"></i>' + (_inSearchQ ? '검색 결과가 없습니다.' : '등록된 입고 내역이 없습니다.') + '</td></tr>';
    return;
  }
  tbody.innerHTML = data.map(function(r) {
    var rid = (r.id||'').replace(/'/g,"\\'");
    var rlot = (r.lot_no||'').replace(/'/g,"\\'");
    return '<tr data-id="' + (r.id||'') + '">' +
      '<td style="text-align:center"><input type="checkbox" class="whInRowCheck" data-id="' + (r.id||'') + '" onchange="whInCheckChange()" /></td>' +
      '<td>' + (r.lot_no||'-') + '</td>' +
      '<td><span style="background:#e8f4fd;color:#2980b9;padding:2px 8px;border-radius:12px;font-size:11px">' + (r.warehouse==='C'?'저온':'일반') + '</span></td>' +
      '<td><code style="font-size:11px">' + (r.location||'-') + '</code></td>' +
      '<td>' + (r.inbound_date||'-') + '</td>' +
      '<td><b>' + (r.item_name||'-') + '</b></td>' +
      '<td>' + (function(t){
        var map = {'수입제품':'#2980b9','OEM제품':'#d68910','자체생산':'#1e8449','회수입고':'#8e44ad','기타':'#888'};
        var bgMap = {'수입제품':'#e8f4fd','OEM제품':'#fef9e7','자체생산':'#eafaf1','회수입고':'#f3e8fd','기타':'#f0f0f0'};
        var c = map[t]||'#888', b = bgMap[t]||'#f0f0f0';
        return '<span style="background:'+b+';color:'+c+';padding:2px 8px;border-radius:12px;font-size:11px">'+(t||'-')+'</span>';
      })(r.inbound_type||'') + '</td>' +
      '<td style="text-align:right">' + _whFmtQtyBreakdown(r.qty, r.unit, r.item_name, r.qty_ea, r.qty_box, r.qty_pt) + '</td>' +
      '<td>' + (r.unit||'-') + '</td>' +
      '<td>' + (r.expiry_date||'-') + '</td>' +
      '<td>' + (r.supplier||'-') + '</td>' +
      '<td>' + (r.manager||'-') + '</td>' +
      '<td>' +
        '<button class="btn btn-sm" onclick="whOpenInEditModal(\'' + rid + '\')" style="background:#eafaf1;color:#27ae60;border:1px solid #27ae60;padding:3px 8px;font-size:11px"><i class="fas fa-edit"></i></button>' +
        '<button class="btn btn-sm" onclick="whPrintLabel(\'' + rlot + '\')" style="background:#f8f9fa;color:#555;border:1px solid #ddd;padding:3px 8px;font-size:11px;margin-left:4px"><i class="fas fa-print"></i></button>' +
        '<button class="btn btn-sm" onclick="whDeleteInbound(\'' + rid + '\')" style="background:#fdedec;color:#e74c3c;border:1px solid #e74c3c;padding:3px 8px;font-size:11px;margin-left:4px"><i class="fas fa-trash"></i></button>' +
      '</td>' +
      '</tr>';
  }).join('');
}

async function whDeleteInbound(id) {
  if (!confirm('이 입고 기록을 삭제하시겠습니까?\n(물류현황 입고 기록도 함께 삭제됩니다)')) return;
  try {
    // 삭제 전 lot_no 확보
    var inRecord = whInboundData.find(function(r){ return r.id === id; });
    var lotNo = inRecord ? (inRecord.lot_no || '') : '';
    await apiDelete('wh_inbound', id);
    // logistics 콜렉션에서 동일 lot_no 입고 기록 삭제
    if (lotNo) {
      try {
        // 성능 개선: Firestore 재조회 대신 메모리 캐시 사용
        var lgAll = (typeof allLogisticsData !== 'undefined' && allLogisticsData.length > 0) ? allLogisticsData : await apiGetAll('logistics');
        var lgMatch = lgAll.filter(function(r) {
          return (r.wh_lot_no === lotNo || r.lot_no === lotNo) && r.transaction_type === '입고';
        });
        for (var i = 0; i < lgMatch.length; i++) {
          if (lgMatch[i].id) await apiDelete('logistics', lgMatch[i].id);
        }
      } catch(le) {
        console.warn('logistics 연동 삭제 실패:', le);
      }
    }
    showToast('삭제 완료', 'success');
    whInvalidateMapCache();
    await whReloadAll();
    whRenderInTable();
    // logistics 탭도 갱신
    if (typeof loadLogisticsData === 'function') loadLogisticsData();
  } catch(e) {
    showToast('삭제 실패: ' + e.message, 'error');
  }
}

// ── 체크박스 선택 삭제 관련 함수 ──────────────────────
// 체크박스 변경 시 선택된 건수 업데이트
function whInCheckChange() {
  var checked = document.querySelectorAll('.whInRowCheck:checked');
  var total = document.querySelectorAll('.whInRowCheck');
  var count = checked.length;
  var countEl = document.getElementById('whInSelectedCount');
  var btn = document.getElementById('whInDeleteSelectedBtn');
  var allChk = document.getElementById('whInCheckAll');
  if (countEl) countEl.textContent = count;
  if (btn) btn.style.display = count > 0 ? '' : 'none';
  if (allChk) {
    allChk.checked = count > 0 && count === total.length;
    allChk.indeterminate = count > 0 && count < total.length;
  }
}
// 헤더 체크박스 변경 시 전체 선택/해제
function whInCheckAllChange(el) {
  var boxes = document.querySelectorAll('.whInRowCheck');
  boxes.forEach(function(b){ b.checked = el.checked; });
  whInCheckChange();
}
// 전체선택 토글 버튼
function whInToggleSelectAll() {
  var boxes = document.querySelectorAll('.whInRowCheck');
  var allChecked = Array.from(boxes).every(function(b){ return b.checked; });
  boxes.forEach(function(b){ b.checked = !allChecked; });
  var allChk = document.getElementById('whInCheckAll');
  if (allChk) allChk.checked = !allChecked;
  whInCheckChange();
}
// 선택 삭제
async function whInDeleteSelected() {
  var checked = document.querySelectorAll('.whInRowCheck:checked');
  if (checked.length === 0) { showToast('삭제할 항목을 선택해주세요.', 'warning'); return; }
  if (!confirm(checked.length + '건을 삭제하시겠습니까?\n(물류현황 입고 기록도 함께 삭제됩니다)\n이 작업은 되돌릴 수 없습니다.')) return;
  var ids = Array.from(checked).map(function(b){ return b.dataset.id; });
  // 삭제 대상 lot_no 목록 수집
  var lotNos = ids.map(function(id) {
    var r = whInboundData.find(function(x){ return x.id === id; });
    return r ? (r.lot_no || '') : '';
  }).filter(function(l){ return !!l; });
  var successCount = 0;
  var failCount = 0;
  for (var i = 0; i < ids.length; i++) {
    try {
      await apiDelete('wh_inbound', ids[i]);
      successCount++;
    } catch(e) {
      failCount++;
    }
  }
  // logistics 콜렉션에서 연동 입고 기록 삭제
  if (lotNos.length > 0) {
    try {
      // 성능 개선: Firestore 재조회 대신 메모리 캐시 사용
      var lgAll = (typeof allLogisticsData !== 'undefined' && allLogisticsData.length > 0) ? allLogisticsData : await apiGetAll('logistics');
      var lgMatch = lgAll.filter(function(r) {
        return lotNos.indexOf(r.wh_lot_no || r.lot_no) !== -1 && r.transaction_type === '입고';
      });
      for (var j = 0; j < lgMatch.length; j++) {
        if (lgMatch[j].id) await apiDelete('logistics', lgMatch[j].id);
      }
    } catch(le) {
      console.warn('logistics 연동 삭제 실패:', le);
    }
  }
  showToast(successCount + '건 삭제 완료' + (failCount > 0 ? ' (' + failCount + '건 실패)' : ''), 'success');
  whInvalidateMapCache();
  await whReloadAll();
  whRenderInTable();
  if (typeof loadLogisticsData === 'function') loadLogisticsData();
}
// 전체 삭제
async function whInDeleteAll() {
  if (whInboundData.length === 0) { showToast('삭제할 입고 이력이 없습니다.', 'warning'); return; }
  if (!confirm('입고 이력 전체 ' + whInboundData.length + '건을 삭제하시겠습니까?\n(물류현황 입고 기록도 함께 삭제됩니다)\n이 작업은 되돌릴 수 없습니다.')) return;
  var ids = whInboundData.map(function(r){ return r.id; });
  var lotNos = whInboundData.map(function(r){ return r.lot_no || ''; }).filter(function(l){ return !!l; });
  var successCount = 0;
  var failCount = 0;
  for (var i = 0; i < ids.length; i++) {
    try {
      await apiDelete('wh_inbound', ids[i]);
      successCount++;
    } catch(e) {
      failCount++;
    }
  }
  // logistics 콜렉션에서 연동 입고 기록 삭제
  if (lotNos.length > 0) {
    try {
      // 성능 개선: Firestore 재조회 대신 메모리 캐시 사용
      var lgAll = (typeof allLogisticsData !== 'undefined' && allLogisticsData.length > 0) ? allLogisticsData : await apiGetAll('logistics');
      var lgMatch = lgAll.filter(function(r) {
        return lotNos.indexOf(r.wh_lot_no || r.lot_no) !== -1 && r.transaction_type === '입고';
      });
      for (var j = 0; j < lgMatch.length; j++) {
        if (lgMatch[j].id) await apiDelete('logistics', lgMatch[j].id);
      }
    } catch(le) {
      console.warn('logistics 연동 삭제 실패:', le);
    }
  }
  showToast(successCount + '건 전체 삭제 완료' + (failCount > 0 ? ' (' + failCount + '건 실패)' : ''), 'success');
  whInvalidateMapCache();
  await whReloadAll();
  whRenderInTable();
  if (typeof loadLogisticsData === 'function') loadLogisticsData();
}

// 입고 수정 모달 열기
function whOpenInEditModal(id) {
  var record = whInboundData.find(function(r){ return r.id === id; });
  if (!record) { showToast('해당 입고 기록을 찾을 수 없습니다.', 'warning'); return; }

  var sv = function(eid, v) {
    var el = document.getElementById(eid);
    if (el) el.value = v !== undefined && v !== null ? v : '';
  };

  sv('whInEditId', record.id);
  sv('whInEdit_date', record.inbound_date || '');
  sv('whInEdit_item_name', record.item_name || '');
  sv('whInEdit_qty', record.qty || '');
  sv('whInEdit_mfg_date', record.mfg_date || '');
  sv('whInEdit_expiry_date', record.expiry_date || '');
  sv('whInEdit_ref_lot', record.lot_no_product || '');
  sv('whInEdit_supplier', record.supplier || '');
  sv('whInEdit_temp', record.temp || '');
  sv('whInEdit_manager', record.manager || '');
  sv('whInEdit_memo', record.memo || '');

  // 창고구분 설정
  var whEl = document.getElementById('whInEdit_warehouse');
  if (whEl) {
    whEl.value = record.warehouse || 'C';
    whBuildLocationSelect('whInEdit');
  }
  // 위치 선택 (setTimeout으로 드롭다운 렌더링 후 설정)
  setTimeout(function() {
    sv('whInEdit_location', record.location || '');
  }, 150);

  // 입고유형 설정
  var typeEl = document.getElementById('whInEdit_type');
  if (typeEl) {
    var tv = record.inbound_type || record.type || '';
    for (var i = 0; i < typeEl.options.length; i++) {
      if (typeEl.options[i].value === tv) { typeEl.selectedIndex = i; break; }
    }
  }

  // 단위 설정
  var unitEl = document.getElementById('whInEdit_unit');
  if (unitEl) {
    for (var j = 0; j < unitEl.options.length; j++) {
      if (unitEl.options[j].value === (record.unit||'pallet')) { unitEl.selectedIndex = j; break; }
    }
  }

  var modal = document.getElementById('whInEditModal');
  if (modal) modal.classList.add('show');
}

function whCloseInEditModal() {
  var modal = document.getElementById('whInEditModal');
  if (modal) modal.classList.remove('show');
}

async function whSaveInEdit() {
  var id = (document.getElementById('whInEditId') || {}).value;
  if (!id) { showToast('수정할 기록을 찾을 수 없습니다.', 'warning'); return; }
  // 기존 lot_no 보존 (apiPut은 전체 덮어쓰기이므로 반드시 포함해야 함)
  var existingRecord = whInboundData.find(function(r){ return r.id === id; });
  var existingLotNo = existingRecord ? (existingRecord.lot_no || '') : '';

  var required = [
    { id: 'whInEdit_warehouse', label: '창고구분' },
    { id: 'whInEdit_location', label: '보관위치' },
    { id: 'whInEdit_item_name', label: '품목명' },
    { id: 'whInEdit_qty', label: '수량' },
    { id: 'whInEdit_date', label: '입고일자' },
    { id: 'whInEdit_expiry_date', label: '소비기한' },
    { id: 'whInEdit_manager', label: '담당자' }
  ];
  for (var i = 0; i < required.length; i++) {
    var el = document.getElementById(required[i].id);
    if (!el || !el.value.trim()) {
      showToast(required[i].label + '을(를) 입력해주세요.', 'warning');
      if (el) el.focus();
      return;
    }
  }

  var data = {
    lot_no: existingLotNo,
    warehouse: document.getElementById('whInEdit_warehouse').value,
    location: document.getElementById('whInEdit_location').value,
    inbound_date: document.getElementById('whInEdit_date').value,
    inbound_type: document.getElementById('whInEdit_type').value,
    item_name: document.getElementById('whInEdit_item_name').value.trim(),
    qty: Number(document.getElementById('whInEdit_qty').value),
    unit: document.getElementById('whInEdit_unit').value,
    mfg_date: (document.getElementById('whInEdit_mfg_date') || {}).value || '',
    expiry_date: document.getElementById('whInEdit_expiry_date').value,
    lot_no_product: (document.getElementById('whInEdit_ref_lot') || {}).value || '',
    supplier: (document.getElementById('whInEdit_supplier') || {}).value || '',
    temp: (document.getElementById('whInEdit_temp') || {}).value || '',
    manager: document.getElementById('whInEdit_manager').value.trim(),
    memo: (document.getElementById('whInEdit_memo') || {}).value || '',
    updated_at: Date.now()
  };

  // qty_ea/qty_box/qty_pt 환산 계산
  var _editProducts = _whProductMasterCache || [];
  var _editMatchP = _editProducts.find(function(p) { return (p.product_name||'').trim() === data.item_name; });
  var _editQpb = _editMatchP ? (parseInt(_editMatchP.qty_per_box) || 0) : 0;
  var _editBpp = _editMatchP ? (parseInt(_editMatchP.boxes_per_pallet) || 0) : 0;
  var _editBreakdown = _whCalcBreakdown(data.qty, data.unit, _editQpb, _editBpp);
  data.qty_ea = _editBreakdown.qty_ea;
  data.qty_box = _editBreakdown.qty_box;
  data.qty_pt = _editBreakdown.qty_pt;

  var saveBtn = document.querySelector('#whInEditModal .btn-primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...'; }
  try {
    await apiPut('wh_inbound', id, data);

    // ── logistics 컬렉션 동기화: lot_no로 기존 logistics 레코드 찾아 업데이트 ──
    if (existingLotNo) {
      try {
        var lgAll = await apiGetAll('logistics');
        var lgMatch = lgAll.find(function(r) { return r.lot_no === existingLotNo && r.transaction_type === '입고'; });
        if (lgMatch && lgMatch.id) {
          var lgUpdated = _whBuildLogisticsRecord(data);
          await apiPut('logistics', lgMatch.id, lgUpdated);
        }
      } catch(lgErr) { /* logistics 동기화 실패는 무시 */ }
    }

    showToast('입고 정보가 수정되었습니다.', 'success');
    whCloseInEditModal();
    whInvalidateMapCache();
    await whReloadAll();
    whRenderInTable();
    // ── 연동 갱신: 물류현황/재고현황 즉시 반영 (await로 순서 보장) ──
    if (typeof loadLogisticsData === 'function') await loadLogisticsData();
  } catch(err) {
    showToast('수정 실패: ' + err.message, 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> 저장'; }
  }
}

// ── 출고 등록 ─────────────────────────────────────
async function whSubmitOutbound() {
  var fields = ['whout_warehouse','whout_location','whout_item_name','whout_qty','whout_unit','whout_date'];
  var data = {};
  var valid = true;
  fields.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el || !el.value.trim()) { valid = false; return; }
    data[id.replace('whout_','')] = el.value.trim();
  });
  if (!valid) { showToast('필수 항목을 모두 입력해주세요.', 'warning'); return; }
  var lotEl = document.getElementById('whOutLotDisplay');
  data.lot_no = lotEl ? lotEl.dataset.lot || lotEl.textContent : '';
  data.outbound_date = data.date;
  data.ref_lot = (document.getElementById('whout_ref_lot') || {}).value || '';
  data.destination = (document.getElementById('whout_destination') || {}).value || '';
  data.memo = (document.getElementById('whout_memo') || {}).value || '';
  // FIFO 재고 검증
  var stockMap = whCalcStock();
  var locStock = stockMap[data.location] || {};
  var itemStock = locStock[data.item_name] || { qty: 0 };
  if (itemStock.qty < Number(data.qty)) {
    showToast('재고 부족! 현재 재고: ' + itemStock.qty + (data.unit||''), 'warning');
    return;
  }
  try {
    await apiPost('wh_outbound', data);
    // logistics 콜렉션 동기화
    await apiPost('logistics', _whBuildLogisticsOutRecord(data));
    showToast('출고 등록 완료: ' + data.lot_no, 'success');
    whInvalidateMapCache(); // 캐시 무효화
    await whReloadAll();
    whRefreshOutLot();
    var form = document.getElementById('whOutboundForm');
    if (form) form.reset();
    var today = new Date().toISOString().split('T')[0];
    var dateEl = document.getElementById('whout_date');
    if (dateEl) dateEl.value = today;
  } catch(e) {
    showToast('출고 등록 실패: ' + e.message, 'error');
  }
}

// ── FIFO 가이드 ───────────────────────────────────
function whFifoGuide() {
  var itemName = (document.getElementById('whout_item_name') || {}).value || '';
  var resultEl = document.getElementById('whFifoResult');
  if (!resultEl) return;
  if (!itemName.trim()) { resultEl.style.display = 'none'; return; }
  var stockMap = whCalcStock();
  var candidates = [];
  Object.entries(stockMap).forEach(function(entry) {
    var locCode = entry[0], items = entry[1];
    if (items[itemName] && (items[itemName].qty||0) > 0) {
      candidates.push({ code: locCode, qty: items[itemName].qty, unit: items[itemName].unit, expiry: items[itemName].expiry, lot: items[itemName].lot });
    }
  });
  if (candidates.length === 0) {
    resultEl.style.display = '';
    resultEl.innerHTML = '<div style="color:#e74c3c">⚠️ "' + itemName + '" 재고가 없습니다.</div>';
    return;
  }
  candidates.sort(function(a,b){ return (a.expiry||'9999').localeCompare(b.expiry||'9999'); });
  var today = new Date();
  var html = '<div style="font-weight:700;color:#27ae60;margin-bottom:8px"><i class="fas fa-sort-amount-up"></i> FIFO 출고 권장 순서</div>';
  candidates.forEach(function(c, i) {
    var diff = c.expiry ? Math.ceil((new Date(c.expiry) - today) / 86400000) : null;
    var badge = i === 0 ? '<span style="background:#e74c3c;color:#fff;font-size:10px;padding:1px 6px;border-radius:10px;margin-left:4px">우선출고</span>' : '';
    html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee">' +
      '<span style="font-size:13px;font-weight:700;color:#555">' + (i+1) + '.</span>' +
      '<code style="font-size:12px;background:#f0f7ff;padding:2px 6px;border-radius:4px">' + c.code + '</code>' +
      '<span style="font-size:12px">' + c.qty + (c.unit||'') + '</span>' +
      (c.expiry ? '<span style="font-size:11px;color:' + (diff!==null&&diff<=30?'#e74c3c':'#888') + '">소비기한: ' + c.expiry + (diff!==null?' (D-'+diff+')':'') + '</span>' : '') +
      badge +
      '<button onclick="document.getElementById(\'whout_location\').value=\'' + c.code + '\';document.getElementById(\'whFifoResult\').style.display=\'none\'" style="margin-left:auto;background:#27ae60;color:#fff;border:none;border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer">선택</button>' +
      '</div>';
  });
  resultEl.style.display = '';
  resultEl.innerHTML = html;
}

// ── 출고 테이블 렌더 ──────────────────────────────
// 출고 이력 페이지네이션 상태
var _whOutPage = 1;
var _whOutPageSize = 20;

function whRenderOutTable() {
  var tbody = document.getElementById('whOutTableBody');
  if (!tbody) return;
  // 제품마스터 캐시 없으면 로딩 후 재렌더링
  if (!_whProductMasterCache) {
    whLoadProductMaster().then(function() { whRenderOutTable(); });
    return;
  }
  var _outSearchQ = (document.getElementById('whOutSearch') ? document.getElementById('whOutSearch').value.trim().toLowerCase() : '');
  // 검색어 변경 시 첫 페이지로 이동
  if (_outSearchQ) _whOutPage = 1;
  var data = whOutboundData.slice().sort(function(a,b){ return (b.outbound_date||'').localeCompare(a.outbound_date||''); });
  if (_outSearchQ) {
    data = data.filter(function(r) {
      return (r.item_name||'').toLowerCase().includes(_outSearchQ) ||
             (r.lot_no||'').toLowerCase().includes(_outSearchQ) ||
             (r.location||'').toLowerCase().includes(_outSearchQ) ||
             (r.destination||'').toLowerCase().includes(_outSearchQ);
    });
  }
  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#aaa;padding:30px"><i class="fas fa-inbox" style="font-size:24px;display:block;margin-bottom:8px"></i>' + (_outSearchQ ? '검색 결과가 없습니다.' : '등록된 출고 내역이 없습니다.') + '</td></tr>';
    document.getElementById('whOutPagination') && (document.getElementById('whOutPagination').innerHTML = '');
    return;
  }
  // 페이지네이션 계산
  var totalPages = Math.ceil(data.length / _whOutPageSize);
  if (_whOutPage > totalPages) _whOutPage = totalPages;
  var start = (_whOutPage - 1) * _whOutPageSize;
  var pageData = data.slice(start, start + _whOutPageSize);

  tbody.innerHTML = pageData.map(function(r) {
    return '<tr>' +
      '<td>' + (r.lot_no||'-') + '</td>' +
      '<td><span style="background:#fef9e7;color:#f39c12;padding:2px 8px;border-radius:12px;font-size:11px">' + (r.warehouse==='C'?'저온':'일반') + '</span></td>' +
      '<td><code style="font-size:11px">' + (r.location||'-') + '</code></td>' +
      '<td>' + (r.outbound_date||'-') + '</td>' +
      '<td><b>' + (r.item_name||'-') + '</b></td>' +
      '<td style="text-align:right">' + _whFmtQtyBreakdown(r.qty, r.unit, r.item_name, r.qty_ea, r.qty_box, r.qty_pt) + '</td>' +
      '<td>' + (r.unit||'') + '</td>' +
      '<td>' + (r.ref_lot||'-') + '</td>' +
      '<td>' + (r.destination||'-') + '</td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn btn-sm" onclick="whOpenEditOutModal(\'' + (r.id||'') + '\')" style="background:#e8f4fd;color:#2980b9;border:1px solid #2980b9;padding:3px 8px;font-size:11px;margin-right:4px"><i class="fas fa-edit"></i></button>' +
        '<button class="btn btn-sm" onclick="whDeleteOutbound(\'' + (r.id||'') + '\',\'' + (r.lot_no||'') + '\')" style="background:#fdedec;color:#e74c3c;border:1px solid #e74c3c;padding:3px 8px;font-size:11px"><i class="fas fa-trash"></i></button>' +
      '</td>' +
      '</tr>';
  }).join('');

  // 페이지네이션 렌더링
  var pg = document.getElementById('whOutPagination');
  if (!pg) return;
  if (totalPages <= 1) { pg.innerHTML = ''; return; }
  var btns = '';
  // 이전 버튼
  btns += '<button onclick="whOutGoPage(' + (_whOutPage-1) + ')" ' + (_whOutPage===1?'disabled':'') + ' style="padding:5px 10px;border:1px solid #ddd;border-radius:6px;background:' + (_whOutPage===1?'#f5f5f5':'#fff') + ';cursor:pointer;font-size:12px">&laquo;</button>';
  // 페이지 번호 (5개씩 표시)
  var startPg = Math.max(1, _whOutPage - 2);
  var endPg = Math.min(totalPages, startPg + 4);
  if (startPg > 1) btns += '<span style="padding:5px 4px;font-size:12px;color:#aaa">...</span>';
  for (var p = startPg; p <= endPg; p++) {
    var active = (p === _whOutPage);
    btns += '<button onclick="whOutGoPage(' + p + ')" style="padding:5px 10px;border:1px solid ' + (active?'#e74c3c':'#ddd') + ';border-radius:6px;background:' + (active?'#e74c3c':'#fff') + ';color:' + (active?'#fff':'#333') + ';cursor:pointer;font-size:12px;font-weight:' + (active?'bold':'normal') + '">' + p + '</button>';
  }
  if (endPg < totalPages) btns += '<span style="padding:5px 4px;font-size:12px;color:#aaa">...</span>';
  // 다음 버튼
  btns += '<button onclick="whOutGoPage(' + (_whOutPage+1) + ')" ' + (_whOutPage===totalPages?'disabled':'') + ' style="padding:5px 10px;border:1px solid #ddd;border-radius:6px;background:' + (_whOutPage===totalPages?'#f5f5f5':'#fff') + ';cursor:pointer;font-size:12px">&raquo;</button>';
  // 건수 정보
  btns += '<span style="font-size:11px;color:#888;margin-left:8px">' + data.length + '건 / ' + totalPages + '페이지</span>';
  pg.innerHTML = btns;
}

function whOutGoPage(p) {
  var totalPages = Math.ceil(whOutboundData.length / _whOutPageSize);
  if (p < 1 || p > totalPages) return;
  _whOutPage = p;
  whRenderOutTable();
  // 테이블 상단으로 스크롤
  var el = document.getElementById('whOutTableBody');
  if (el) el.closest('.table-section') && el.closest('.table-section').scrollIntoView({behavior:'smooth', block:'start'});
}

async function whDeleteOutbound(id, lotNo) {
  if (!confirm('이 출고 기록을 삭제하시겠습니까?\n(수입제품/OEM/자체생산 탭 출고 수량도 함께 취소됩니다)')) return;
  try {
    await apiDelete('wh_outbound', id);
    // logistics 콜렉션에서 동일 lot_no 출고 기록 삭제
    if (lotNo) {
      try {
        // 성능 개선: Firestore 재조회 대신 메모리 캐시 사용
        var lgAll = (typeof allLogisticsData !== 'undefined' && allLogisticsData.length > 0) ? allLogisticsData : await apiGetAll('logistics');
        var lgMatch = lgAll.filter(function(r) {
          return r.wh_lot_no === lotNo || r.lot_no === lotNo;
        });
        for (var i = 0; i < lgMatch.length; i++) {
          if (lgMatch[i].id) await apiDelete('logistics', lgMatch[i].id);
        }
      } catch(le) {
        console.warn('logistics 동기화 삭제 실패:', le);
      }
    }
    showToast('출고 취소 완료 (재고 복원)', 'success');
    whInvalidateMapCache(); // 캐시 무효화
    await whReloadAll();
    // logistics 탭도 갱신
    if (typeof loadLogisticsData === 'function') loadLogisticsData();
  } catch(e) {
    showToast('삭제 실패: ' + e.message, 'error');
  }
}

// ── 수불부 렌더 ───────────────────────────────────
// 최적화: stockMap을 인수로 받아 중복 계산 방지 (없으면 자체 계산)
function whRenderLedger(stockMap) {
  var tbody = document.getElementById('whLedgerBody');
  if (!tbody) return;
  stockMap = stockMap || whCalcStock();
  // 필터 값 읽기
  var whFilter = document.getElementById('whLedgerWarehouse') ? document.getElementById('whLedgerWarehouse').value : '';
  var qFilter = document.getElementById('whLedgerSearch') ? document.getElementById('whLedgerSearch').value.toLowerCase() : '';

  var rows = [];
  Object.entries(stockMap).forEach(function(entry) {
    var locCode = entry[0], items = entry[1];
    // 창고 필터
    if (whFilter && !locCode.startsWith(whFilter)) return;
    Object.entries(items).forEach(function(e) {
      var itemName = e[0], info = e[1];
      // 품목명 검색 필터
      if (qFilter && itemName.toLowerCase().indexOf(qFilter) === -1) return;
      var inQty = 0, outQty = 0;
      whInboundData.filter(function(r){ return r.location === locCode && (r.item_name||'미상') === itemName; }).forEach(function(r){ inQty += Number(r.qty)||0; });
      // 출고: 정확한 위치 매칭만 집계 (위치 없는 출고는 whCalcStock에서 이미 차감)
      whOutboundData.filter(function(r){ return (r.item_name||'미상') === itemName && r.location === locCode; }).forEach(function(r){ outQty += Number(r.qty)||0; });
      var warehouseLabel = locCode.startsWith('C') ? '❄️ 저온' : '🏭 일반';
      rows.push({ locCode: locCode, warehouseLabel: warehouseLabel, itemName: itemName, inQty: inQty, outQty: outQty, currentQty: info.qty, unit: info.unit, expiry: info.expiry });
    });
  });

  // 재고없음/마이너스 보이기 체크박스 (기본값: 미체크 = 숨김)
  var showZeroEl = document.getElementById('ledgerShowZero');
  var showZero = showZeroEl ? showZeroEl.checked : false;
  if (!showZero) rows = rows.filter(function(r) { return r.currentQty > 0; });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#aaa;padding:30px">등록된 재고가 없습니다.</td></tr>';
    return;
  }

  // 위치코드 정렬: 일반창고 → 냉장창고, A구역 → B구역, 1-1 → 1-2 → 2-1 → 2-2
  rows.sort(function(a, b) {
    var aCode = a.locCode, bCode = b.locCode;
    // 1. 창고 유형: W(일반) 먼저, C(냉장) 나중
    var aType = aCode.startsWith('C') ? 1 : 0;
    var bType = bCode.startsWith('C') ? 1 : 0;
    if (aType !== bType) return aType - bType;
    // 2. 구역 문자 (A, B, C, ...)
    var aParts = aCode.split('-'); // [W, A1, 1, 1]
    var bParts = bCode.split('-');
    var aZone = aParts[1] || ''; // 'A1'
    var bZone = bParts[1] || ''; // 'B2'
    var aZoneLetter = aZone.replace(/[0-9]/g, '');
    var bZoneLetter = bZone.replace(/[0-9]/g, '');
    if (aZoneLetter !== bZoneLetter) return aZoneLetter.localeCompare(bZoneLetter);
    // 3. 구역 번호
    var aZoneNum = parseInt(aZone.replace(/[^0-9]/g, '')) || 0;
    var bZoneNum = parseInt(bZone.replace(/[^0-9]/g, '')) || 0;
    if (aZoneNum !== bZoneNum) return aZoneNum - bZoneNum;
    // 4. 단(층)
    var aLevel = parseInt(aParts[2]) || 0;
    var bLevel = parseInt(bParts[2]) || 0;
    if (aLevel !== bLevel) return aLevel - bLevel;
    // 5. 파렉트 번호
    var aSlot = parseInt(aParts[3]) || 0;
    var bSlot = parseInt(bParts[3]) || 0;
    return aSlot - bSlot;
  });

  var today = new Date();
  tbody.innerHTML = rows.map(function(r) {
    var diff = r.expiry ? Math.ceil((new Date(r.expiry) - today) / 86400000) : null;
    var expiryColor = diff !== null && diff < 0 ? '#e74c3c' : (diff !== null && diff <= 30 ? '#e67e22' : '#555');
    var expiryText = r.expiry ? (r.expiry + (diff !== null ? ' (D-' + diff + ')' : '')) : '-';
    // 상태 배지
    var statusBadge = '';
    if (r.currentQty <= 0) {
      statusBadge = '<span style="background:#fdedec;color:#e74c3c;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700">재고없음</span>';
    } else if (diff !== null && diff < 0) {
      statusBadge = '<span style="background:#fdedec;color:#e74c3c;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700">기한만료</span>';
    } else if (diff !== null && diff <= 30) {
      statusBadge = '<span style="background:#fff3cd;color:#d68910;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700">임박</span>';
    } else {
      statusBadge = '<span style="background:#eafaf1;color:#27ae60;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700">정상</span>';
    }
    return '<tr>' +
      '<td><span style="font-size:12px">' + r.warehouseLabel + '</span></td>' +
      '<td><code style="font-size:11px">' + r.locCode + '</code></td>' +
      '<td><b>' + r.itemName + '</b></td>' +
      '<td style="text-align:right;color:#27ae60;font-weight:600">' + r.inQty.toLocaleString() + '</td>' +
      '<td style="text-align:right;color:#e74c3c;font-weight:600">' + r.outQty.toLocaleString() + '</td>' +
      '<td style="text-align:right;font-weight:700;font-size:14px">' + r.currentQty.toLocaleString() + '</td>' +
      '<td>' + (r.unit||'-') + '</td>' +
      '<td style="color:' + expiryColor + '">' + expiryText + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td style="text-align:center">' +
        (r.currentQty > 0
          ? '<button onclick="whOpenMoveModal(\'' + r.locCode.replace(/'/g,"\\'") + '\',\'' + r.itemName.replace(/'/g,"\\'") + '\')" style="padding:4px 10px;background:#fff3e0;color:#e67e22;border:1px solid #e67e22;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer"><i class=\"fas fa-exchange-alt\"></i> 이동</button>'
          : '<span style="color:#ccc;font-size:11px">재고없음</span>') +
      '</td>' +
      '</tr>';
  }).join('');
}

// ── 재고 실사 ─────────────────────────────────────
function whLoadStocktakeData() {
  var stockMap = whCalcStock();
  var tbody = document.getElementById('whStocktakeBody');
  if (!tbody) return;
  var allLocs = COLD_LOCATIONS.concat(WARM_LOCATIONS);
  var usedLocs = allLocs.filter(function(l) {
    var items = stockMap[l.code] || {};
    return Object.values(items).some(function(v){ return (v.qty||0) > 0; });
  });
  if (usedLocs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#aaa;padding:30px">재고가 있는 위치가 없습니다.</td></tr>';
    return;
  }
  tbody.innerHTML = usedLocs.map(function(l) {
    var items = stockMap[l.code] || {};
    return Object.entries(items).filter(function(e){ return (e[1].qty||0) > 0; }).map(function(e) {
      var itemName = e[0], info = e[1];
      var locAttr = l.code.replace(/'/g, "\\'");
      var itemAttr = itemName.replace(/'/g, "\\'");
      return '<tr>' +
        '<td><code style="font-size:11px;cursor:pointer;color:#2980b9;text-decoration:underline;text-underline-offset:2px" title="클릭하여 위치이동" onclick="whInlineMove(\'' + locAttr + '\', \'' + itemAttr + '\')">📦 ' + l.code + '</code></td>' +
        '<td><b>' + itemName + '</b></td>' +
        '<td style="font-weight:700;color:#2980b9">' + info.qty + ' ' + (info.unit||'') + '</td>' +
        '<td><input type="number" min="0" placeholder="실제수량" style="width:90px;padding:4px;border:1px solid #ddd;border-radius:4px" id="st_' + l.code.replace(/-/g,'_') + '_' + itemName.replace(/\s/g,'_') + '" /></td>' +
        '<td id="st_diff_' + l.code.replace(/-/g,'_') + '_' + itemName.replace(/\s/g,'_') + '" style="font-weight:700">-</td>' +
        '<td>' + (info.expiry||'-') + '</td>' +
        '</tr>';
    }).join('');
  }).join('');
}

function whCalcStocktakeDiff() {
  var rows = document.querySelectorAll('#whStocktakeBody tr');
  rows.forEach(function(row) {
    var cells = row.querySelectorAll('td');
    if (cells.length < 5) return;
    var sysQtyText = cells[2].textContent.trim().split(' ')[0];
    var sysQty = parseFloat(sysQtyText) || 0;
    var input = cells[3].querySelector('input');
    if (!input || input.value === '') return;
    var actualQty = parseFloat(input.value) || 0;
    var diff = actualQty - sysQty;
    var diffEl = cells[4];
    diffEl.textContent = (diff > 0 ? '+' : '') + diff;
    diffEl.style.color = diff === 0 ? '#27ae60' : '#e74c3c';
  });
}

async function whSubmitStocktake() {
  var dateEl = document.getElementById('whst_date');
  var date = dateEl ? dateEl.value : new Date().toISOString().split('T')[0];
  var rows = document.querySelectorAll('#whStocktakeBody tr');
  var records = [];
  rows.forEach(function(row) {
    var cells = row.querySelectorAll('td');
    if (cells.length < 5) return;
    var locCode = cells[0].textContent.trim();
    var itemName = cells[1].textContent.trim();
    var sysQty = parseFloat(cells[2].textContent.trim().split(' ')[0]) || 0;
    var input = cells[3].querySelector('input');
    if (!input || input.value === '') return;
    var actualQty = parseFloat(input.value) || 0;
    records.push({ location: locCode, item_name: itemName, sys_qty: sysQty, actual_qty: actualQty, diff: actualQty - sysQty, stocktake_date: date });
  });
  if (records.length === 0) { showToast('실사 수량을 입력해주세요.', 'warning'); return; }
  try {
    // ── 1. 실사 결과 저장 ──
    for (var i = 0; i < records.length; i++) {
      await apiPost('wh_stocktake', records[i]);
    }

    // ── 2. diff != 0 인 항목에 대해 WH-ADJ- 조정 레코드 자동 생성 ──
    var adjDate = date;
    var adjDateShort = adjDate.replace(/-/g,'').slice(2);
    var adjPrefix = 'WH-ADJ-' + adjDateShort;
    // 기존 ADJ lot_no 개수 조회 (중복 방지)
    var existingAdj = [];
    try { existingAdj = (await apiGetAll('wh_inbound')).filter(function(r){ return r.lot_no && r.lot_no.startsWith(adjPrefix); }); } catch(e2) {}
    var adjSeq = existingAdj.length;
    var adjCreated = 0;

    for (var j = 0; j < records.length; j++) {
      var rec = records[j];
      var diff = Number(rec.diff) || 0;
      if (diff === 0) continue;

      adjSeq++;
      var adjLot = adjPrefix + '-' + String(adjSeq).padStart(3, '0');

      if (diff > 0) {
        // 실사 수량 > 시스템 수량 → 플러스 조정: wh_inbound에 입고 조정 기록
        await apiPost('wh_inbound', {
          lot_no: adjLot,
          inbound_date: adjDate,
          warehouse: rec.location ? rec.location.charAt(0) : 'W',
          location: rec.location,
          item_name: rec.item_name,
          qty: diff,
          unit: 'ea',
          inbound_type: '재고조정',
          manager: '실사조정',
          memo: '재고실사 플러스 조정 (실사:' + rec.actual_qty + ' / 시스템:' + rec.sys_qty + ')',
          created_at: Date.now()
        });
      } else {
        // 실사 수량 < 시스템 수량 → 마이너스 조정: wh_outbound에 출고 조정 기록
        await apiPost('wh_outbound', {
          lot_no: adjLot,
          outbound_date: adjDate,
          warehouse: rec.location ? rec.location.charAt(0) : 'W',
          location: rec.location,
          item_name: rec.item_name,
          qty: Math.abs(diff),
          unit: 'ea',
          destination: '재고조정',
          manager: '실사조정',
          memo: '재고실사 마이너스 조정 (실사:' + rec.actual_qty + ' / 시스템:' + rec.sys_qty + ')',
          created_at: Date.now()
        });
      }
      adjCreated++;
    }

    var msg = '재고 실사 저장 완료 (' + records.length + '건)';
    if (adjCreated > 0) msg += ' — 재고 자동 조정 ' + adjCreated + '건 반영';
    showToast(msg, 'success');
    whInvalidateMapCache();
    await whReloadAll();
    // logistics 탭도 갱신
    if (typeof loadLogisticsData === 'function') loadLogisticsData();
  } catch(e) {
    showToast('저장 실패: ' + e.message, 'error');
  }
}

function whRenderStocktakeTable() {
  var tbody = document.getElementById('whStocktakeBody');
  if (!tbody) return;
  var data = whStocktakeData.slice().sort(function(a,b){ return (b.stocktake_date||'').localeCompare(a.stocktake_date||''); });
  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#aaa;padding:20px">실사 내역이 없습니다.</td></tr>';
    return;
  }
  tbody.innerHTML = data.map(function(r) {
    var diff = Number(r.diff) || 0;
    return '<tr>' +
      '<td>' + (r.stocktake_date||'-') + '</td>' +
      '<td><code style="font-size:11px">' + (r.location||'-') + '</code></td>' +
      '<td>' + (r.item_name||'-') + '</td>' +
      '<td>' + (r.sys_qty||0) + '</td>' +
      '<td>' + (r.actual_qty||0) + '</td>' +
      '<td style="font-weight:700;color:' + (diff===0?'#27ae60':'#e74c3c') + '">' + (diff>0?'+':'') + diff + '</td>' +
      '</tr>';
  }).join('');
}

async function whDeleteStocktake(id) {
  if (!confirm('삭제하시겠습니까?\n(연동된 재고 조정 기록도 함께 삭제됩니다)')) return;
  try {
    // 1. 삭제할 실사 레코드 조회 (날짜·위치·품목 정보 확보)
    var stRec = whStocktakeData.find(function(r){ return r.id === id; });
    await apiDelete('wh_stocktake', id);

    // 2. 연동된 WH-ADJ 조정 레코드 삭제
    if (stRec && stRec.stocktake_date && stRec.diff && Number(stRec.diff) !== 0) {
      var adjDateShort = (stRec.stocktake_date || '').replace(/-/g,'').slice(2);
      var adjPrefix = 'WH-ADJ-' + adjDateShort;
      var diff = Number(stRec.diff);
      var adjDeleted = 0;
      if (diff > 0) {
        // 플러스 조정: wh_inbound에서 WH-ADJ 레코드 찾아 삭제
        var inbAdj = whInboundData.filter(function(r) {
          return (r.lot_no||'').startsWith(adjPrefix) &&
                 r.location === stRec.location &&
                 r.item_name === stRec.item_name &&
                 r.inbound_type === '재고조정';
        });
        for (var i = 0; i < inbAdj.length; i++) {
          try { await apiDelete('wh_inbound', inbAdj[i].id); adjDeleted++; } catch(e2) {}
        }
      } else {
        // 마이너스 조정: wh_outbound에서 WH-ADJ 레코드 찾아 삭제
        var outAdj = whOutboundData.filter(function(r) {
          return (r.lot_no||'').startsWith(adjPrefix) &&
                 r.location === stRec.location &&
                 r.item_name === stRec.item_name &&
                 r.destination === '재고조정';
        });
        for (var j = 0; j < outAdj.length; j++) {
          try { await apiDelete('wh_outbound', outAdj[j].id); adjDeleted++; } catch(e3) {}
        }
      }
      showToast('삭제 완료' + (adjDeleted > 0 ? ' (재고 조정 ' + adjDeleted + '건 함께 삭제)' : ''), 'success');
    } else {
      showToast('삭제 완료', 'success');
    }

    whInvalidateMapCache();
    await whReloadAll();
  } catch(e) {
    showToast('삭제 실패: ' + e.message, 'error');
  }
}

function whPrintStocktakeReport() {
  var rows = document.querySelectorAll('#whStocktakeBody tr');
  var diffRows = [];
  rows.forEach(function(row) {
    var cells = row.querySelectorAll('td');
    if (cells.length < 5) return;
    var diffText = cells[4].textContent.trim();
    if (diffText !== '-' && diffText !== '0') diffRows.push(row.outerHTML);
  });
  if (diffRows.length === 0) { showToast('차이가 발생한 항목이 없습니다.', 'info'); return; }
  var isMobile = window.innerWidth <= 768;
  // 데스크탑: 기존 window.open 방식 유지
  if (!isMobile) {
    var win = window.open('', '_blank');
    win.document.write('<html><head><title>재고 실사 조정 보고서</title>' +
      '<style>body{font-family:sans-serif;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;font-size:12px}th{background:#f8f9fa}h2{color:#2C5F2E}</style></head><body>' +
      '<h2>재고 실사 조정 보고서</h2>' +
      '<p>작성일: ' + new Date().toLocaleDateString('ko-KR') + ' | 차이 발생 항목: ' + diffRows.length + '건</p>' +
      '<table><thead><tr><th>위치코드</th><th>품목명</th><th>전산수량</th><th>실제수량</th><th>차이</th><th>소비기한</th></tr></thead><tbody>' +
      diffRows.join('') + '</tbody></table></body></html>');
    win.document.close();
    win.print();
    return;
  }
  // 모바일: 모달 내 미리보기
  var modalId = 'whStocktakeReportModal';
  var existing = document.getElementById(modalId);
  if (existing) existing.remove();
  var m = document.createElement('div');
  m.id = modalId;
  m.className = 'modal-overlay show';
  m.innerHTML = '<div class="modal-dialog" style="max-width:700px">' +
    '<div class="modal-header"><h3><i class="fas fa-clipboard-check"></i> 재고 실사 조정 보고서</h3>' +
    '<button class="modal-close" onclick="document.getElementById(\'' + modalId + '\').remove()"><i class="fas fa-times"></i></button></div>' +
    '<div class="modal-body" style="padding:16px">' +
    '<div style="font-size:12px;color:#666;margin-bottom:12px">작성일: ' + new Date().toLocaleDateString('ko-KR') + ' | 차이 발생 항목: ' + diffRows.length + '건</div>' +
    '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">' +
    '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
    '<thead><tr style="background:#f8f9fa">' +
    '<th style="border:1px solid #ddd;padding:8px">위치코드</th>' +
    '<th style="border:1px solid #ddd;padding:8px">품목명</th>' +
    '<th style="border:1px solid #ddd;padding:8px">전산수량</th>' +
    '<th style="border:1px solid #ddd;padding:8px">실제수량</th>' +
    '<th style="border:1px solid #ddd;padding:8px">차이</th>' +
    '<th style="border:1px solid #ddd;padding:8px">소비기한</th>' +
    '</tr></thead><tbody>' + diffRows.join('') + '</tbody></table></div>' +
    '<div style="display:flex;gap:8px;margin-top:12px">' +
    '<button onclick="window.print()" style="flex:1;padding:10px;background:#2C5F2E;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:700"><i class="fas fa-print"></i> 인쇄</button>' +
    '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="flex:1;padding:10px;background:#f8f9fa;color:#555;border:1px solid #ddd;border-radius:8px;cursor:pointer">닫기</button>' +
    '</div></div></div>';
  document.body.appendChild(m);
}

// ── 라벨 출력 (제브라/빅솔론) ────────────────────
function whPrintLabel(lotNo) {
  var record = whInboundData.find(function(r){ return r.lot_no === lotNo; });
  if (!record) { showToast('해당 Lot No. 기록을 찾을 수 없습니다.', 'warning'); return; }

  // 기존 모달 제거
  var old = document.getElementById('whLabelModal');
  if (old) old.remove();

  var qrData = encodeURIComponent(JSON.stringify({ lot: record.lot_no, loc: record.location, item: record.item_name, expiry: record.expiry_date, qty: record.qty, unit: record.unit }));
  var savedIp = localStorage.getItem('whLabelPrinterIp') || '';

  // 라벨 HTML (미리보기 + 실제 인쇄 공용)
  var labelHtml = [
    '<div id="whLabelContent" style="width:100mm;min-height:60mm;padding:8px;box-sizing:border-box;font-family:Arial,sans-serif;border:1px solid #ddd;border-radius:4px;background:#fff">',
    '  <div style="display:flex;justify-content:space-between;align-items:flex-start">',
    '    <div style="flex:1;padding-right:8px">',
    '      <div style="font-size:9px;color:#888;font-weight:700;letter-spacing:1px;margin-bottom:2px">라이프켈캘 입고라벨</div>',
    '      <div style="font-size:13px;font-weight:700;color:#1a1a1a;margin-bottom:6px;line-height:1.3">' + (record.item_name||'-') + '</div>',
    '      <table style="font-size:10px;border-collapse:collapse;width:100%">',
    '        <tr><td style="color:#888;padding:1px 4px 1px 0;white-space:nowrap">Lot No.</td><td style="font-family:monospace;font-weight:700">' + (record.lot_no||'-') + '</td></tr>',
    '        <tr><td style="color:#888;padding:1px 4px 1px 0">위치</td><td style="font-weight:700;color:#2980b9">' + (record.location||'-') + '</td></tr>',
    '        <tr><td style="color:#888;padding:1px 4px 1px 0">수량</td><td>' + (record.qty||0) + ' ' + (record.unit||'') + '</td></tr>',
    '        <tr><td style="color:#888;padding:1px 4px 1px 0">소비기한</td><td style="color:#e74c3c;font-weight:700">' + (record.expiry_date||'-') + '</td></tr>',
    '        <tr><td style="color:#888;padding:1px 4px 1px 0">공급업체</td><td style="font-size:9px">' + (record.supplier||'-') + '</td></tr>',
    '      </table>',
    '    </div>',
    '    <div style="text-align:center">',
    '      <img src="https://api.qrserver.com/v1/create-qr-code/?size=90x90&data=' + qrData + '" alt="QR" style="width:90px;height:90px">',
    '      <div style="font-size:8px;color:#aaa;margin-top:2px">' + (record.lot_no||'') + '</div>',
    '    </div>',
    '  </div>',
    '  <div style="border-top:1px dashed #ddd;margin-top:6px;padding-top:4px;font-size:8px;color:#aaa;text-align:right">라이프컬처 창고관리시스템</div>',
    '</div>'
  ].join('');

  var m = document.createElement('div');
  m.id = 'whLabelModal';
  m.className = 'modal-overlay show';
  m.innerHTML = '<div class="modal-dialog" style="max-width:560px">' +
    '<div class="modal-header"><h3><i class="fas fa-print"></i> 라벨 출력</h3>' +
    '<button class="modal-close" onclick="document.getElementById(\'whLabelModal\').remove()"><i class="fas fa-times"></i></button></div>' +
    '<div class="modal-body" style="padding:16px">' +

    // 라벨 미리보기
    '<div style="margin-bottom:16px">' +
    '<div style="font-size:12px;font-weight:700;color:#555;margin-bottom:8px">📄 라벨 미리보기 (100 × 60mm)</div>' +
    '<div style="background:#f0f0f0;padding:12px;border-radius:8px;display:flex;justify-content:center">' + labelHtml + '</div>' +
    '</div>' +

    // 프린터 선택 섹션
    '<div style="background:#f8f9fa;border-radius:8px;padding:12px;margin-bottom:12px">' +
    '<div style="font-size:12px;font-weight:700;margin-bottom:10px">프린터 선택</div>' +

    // 1. 브라우저 인쇄 (가장 범용)
    '<div style="margin-bottom:8px">' +
    '<div style="font-size:11px;color:#888;margin-bottom:4px">① 브라우저 인쇄 (모든 프린터 호환)</div>' +
    '<button onclick="whPrintBrowserLabel(\'' + lotNo + '\')\" style="width:100%;padding:9px;background:#2C5F2E;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:13px"><i class="fas fa-print"></i> 브라우저로 인쇄</button>' +
    '</div>' +

    // 2. 제브라 ZPL
    '<div style="margin-bottom:8px">' +
    '<div style="font-size:11px;color:#888;margin-bottom:4px">② 제브라 라벨 프린터 (ZPL)</div>' +
    '<div style="display:flex;gap:6px">' +
    '<button onclick="whSendZplLabel(\'' + lotNo + '\')\" style="flex:1;padding:9px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px"><i class="fas fa-download"></i> ZPL 파일 다운로드</button>' +
    '<button onclick="whZplNetworkPrint(\'' + lotNo + '\')\" style="flex:1;padding:9px;background:#0d47a1;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px"><i class="fas fa-network-wired"></i> 네트워크 전송</button>' +
    '</div>' +
    '</div>' +

    // 3. 빅솔론 ESC/POS
    '<div style="margin-bottom:8px">' +
    '<div style="font-size:11px;color:#888;margin-bottom:4px">③ 빅솔론 라벨 프린터 (ESC/POS)</div>' +
    '<button onclick="whSendEscPosLabel(\'' + lotNo + '\')\" style="width:100%;padding:9px;background:#27ae60;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px"><i class="fas fa-download"></i> ESC/POS 파일 다운로드</button>' +
    '</div>' +

    // 네트워크 프린터 IP 설정
    '<div style="border-top:1px solid #dee2e6;padding-top:8px;margin-top:4px">' +
    '<div style="font-size:11px;color:#888;margin-bottom:4px">프린터 IP 주소 (네트워크 연결 시 입력)</div>' +
    '<div style="display:flex;gap:6px">' +
    '<input id="whPrinterIpInput" type="text" placeholder="192.168.1.100" value="' + savedIp + '" style="flex:1;padding:7px;border:1px solid #ddd;border-radius:6px;font-size:12px">' +
    '<button onclick="whSavePrinterIp()" style="padding:7px 12px;background:#6c757d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px">저장</button>' +
    '</div>' +
    '<div style="font-size:10px;color:#aaa;margin-top:4px">제브라 프린터는 9100포트, 빅솔론은 9100 또는 6101포트를 사용합니다.</div>' +
    '</div>' +
    '</div>' + // 백그라운드 닫기

    '</div></div>';
  document.body.appendChild(m);
}

function whSendZplLabel(lotNo) {
  var record = whInboundData.find(function(r){ return r.lot_no === lotNo; });
  if (!record) return;
  var zpl = '^XA\n' +
    '^FO20,20^A0N,28,28^FD' + (record.item_name||'') + '^FS\n' +
    '^FO20,55^A0N,22,22^FDLot: ' + (record.lot_no||'') + '^FS\n' +
    '^FO20,80^A0N,22,22^FD위치: ' + (record.location||'') + '^FS\n' +
    '^FO20,105^A0N,22,22^FD소비기한: ' + (record.expiry_date||'') + '^FS\n' +
    '^FO20,130^A0N,22,22^FD수량: ' + (record.qty||0) + ' ' + (record.unit||'') + '^FS\n' +
    '^FO200,20^BQN,2,4^FDQA,' + lotNo + '^FS\n' +
    '^XZ';
  var blob = new Blob([zpl], { type: 'text/plain' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'label_' + lotNo + '.zpl'; a.click();
  URL.revokeObjectURL(url);
  showToast('ZPL 파일 다운로드 완료. 제브라 프린터로 전송하세요.', 'success');
}

function whSendEscPosLabel(lotNo) {
  var record = whInboundData.find(function(r){ return r.lot_no === lotNo; });
  if (!record) return;
  var text = '================================\n' +
    '  ' + (record.item_name||'') + '\n' +
    '--------------------------------\n' +
    'Lot: ' + (record.lot_no||'') + '\n' +
    '위치: ' + (record.location||'') + '\n' +
    '소비기한: ' + (record.expiry_date||'') + '\n' +
    '수량: ' + (record.qty||0) + ' ' + (record.unit||'') + '\n' +
    '================================\n';
  var blob = new Blob([text], { type: 'text/plain' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'label_' + lotNo + '.txt'; a.click();
  URL.revokeObjectURL(url);
  showToast('ESC/POS 파일 다운로드 완료. 빅솔론 프린터로 전송하세요.', 'success');
}

function whPrintBrowserLabel(lotNo) {
  var record = whInboundData.find(function(r){ return r.lot_no === lotNo; });
  if (!record) return;
  var qrData = encodeURIComponent(JSON.stringify({ lot: record.lot_no, loc: record.location, item: record.item_name, expiry: record.expiry_date, qty: record.qty, unit: record.unit }));

  // iframe 방식으로 팝업 차단 우회 + 라벨 전용 CSS
  var printHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>입고라벨</title>' +
    '<style>' +
    '@page { size: 100mm 60mm; margin: 0; }' +
    'body { margin: 0; padding: 6px; font-family: Arial, sans-serif; width: 100mm; height: 60mm; box-sizing: border-box; }' +
    '.label-wrap { display: flex; justify-content: space-between; align-items: flex-start; height: 100%; }' +
    '.label-info { flex: 1; padding-right: 6px; }' +
    '.label-title { font-size: 7pt; color: #888; font-weight: 700; letter-spacing: 1px; margin-bottom: 2px; }' +
    '.label-name { font-size: 11pt; font-weight: 700; color: #000; margin-bottom: 5px; line-height: 1.3; }' +
    'table { font-size: 8pt; border-collapse: collapse; width: 100%; }' +
    'td { padding: 1px 3px 1px 0; }' +
    'td:first-child { color: #666; white-space: nowrap; width: 50px; }' +
    '.label-qr { text-align: center; }' +
    '.label-qr img { width: 80px; height: 80px; }' +
    '.label-qr-text { font-size: 6pt; color: #aaa; margin-top: 2px; }' +
    '.label-footer { border-top: 1px dashed #ccc; margin-top: 4px; padding-top: 3px; font-size: 6pt; color: #aaa; text-align: right; }' +
    '@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }' +
    '</style></head><body>' +
    '<div class="label-wrap">' +
    '  <div class="label-info">' +
    '    <div class="label-title">라이프컬처 입고라벨</div>' +
    '    <div class="label-name">' + (record.item_name||'-') + '</div>' +
    '    <table>' +
    '      <tr><td>Lot No.</td><td><b>' + (record.lot_no||'-') + '</b></td></tr>' +
    '      <tr><td>위치</td><td style="color:#1a73e8;font-weight:700">' + (record.location||'-') + '</td></tr>' +
    '      <tr><td>수량</td><td>' + (record.qty||0) + ' ' + (record.unit||'') + '</td></tr>' +
    '      <tr><td>소비기한</td><td style="color:#e74c3c;font-weight:700">' + (record.expiry_date||'-') + '</td></tr>' +
    '      <tr><td>공급업체</td><td style="font-size:7pt">' + (record.supplier||'-') + '</td></tr>' +
    '    </table>' +
    '  </div>' +
    '  <div class="label-qr">' +
    '    <img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=' + qrData + '" alt="QR">' +
    '    <div class="label-qr-text">' + (record.lot_no||'') + '</div>' +
    '  </div>' +
    '</div>' +
    '<div class="label-footer">라이프컬처 창고관리시스템</div>' +
    '</body></html>';

  // 기존 iframe 제거
  var oldFrame = document.getElementById('whLabelPrintFrame');
  if (oldFrame) oldFrame.remove();

  var iframe = document.createElement('iframe');
  iframe.id = 'whLabelPrintFrame';
  iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:100mm;height:60mm;border:none;';
  document.body.appendChild(iframe);

  iframe.contentDocument.open();
  iframe.contentDocument.write(printHtml);
  iframe.contentDocument.close();

  // QR 이미지 로드 대기 후 인쇄
  var qrImg = iframe.contentDocument.querySelector('img');
  var printed = false;
  function doPrint() {
    if (printed) return;
    printed = true;
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    // 라벨 모달 닫기
    var lm = document.getElementById('whLabelModal');
    if (lm) lm.remove();
  }
  if (qrImg) {
    qrImg.onload = doPrint;
    qrImg.onerror = doPrint;
    setTimeout(doPrint, 2000); // 최대 2초 대기
  } else {
    setTimeout(doPrint, 300);
  }
}

// ── 위치 라벨 출력 ────────────────────────────────
function whPrintLocLabel(locCode) {
  var qrData = encodeURIComponent(locCode);
  var isMobile = window.innerWidth <= 768;
  // 데스크탑: 기존 window.open 방식 유지
  if (!isMobile) {
    var win = window.open('', '_blank', 'width=350,height=400');
    win.document.write('<html><head><title>위치 라벨</title>' +
      '<style>body{font-family:sans-serif;padding:20px;text-align:center}h3{color:#2980b9}.code{font-size:24px;font-weight:700;color:#2C5F2E;margin:10px 0}hr{border:1px dashed #ccc}</style></head><body>' +
      '<h3>📍 위치 라벨</h3><hr>' +
      '<div class="code">' + locCode + '</div>' +
      '<img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=' + qrData + '" alt="QR" style="margin:10px 0">' +
      '<hr><div style="font-size:10px;color:#888">라이프컬처 창고관리시스템</div>' +
      '</body></html>');
    win.document.close();
    setTimeout(function(){ win.print(); }, 500);
    return;
  }
  // 모바일: 모달 내 미리보기
  var modalId = 'whLocLabelModal';
  var existing = document.getElementById(modalId);
  if (existing) existing.remove();
  var m = document.createElement('div');
  m.id = modalId;
  m.className = 'modal-overlay show';
  m.innerHTML = '<div class="modal-dialog" style="max-width:320px">' +
    '<div class="modal-header"><h3><i class="fas fa-map-marker-alt"></i> 위치 라벨 미리보기</h3>' +
    '<button class="modal-close" onclick="document.getElementById(\'' + modalId + '\').remove()"><i class="fas fa-times"></i></button></div>' +
    '<div class="modal-body" style="padding:16px">' +
    '<div style="border:2px dashed #2980b9;border-radius:8px;padding:16px;background:#fff;text-align:center">' +
    '<div style="font-size:14px;font-weight:700;color:#2980b9;margin-bottom:8px">📍 위치 라벨</div>' +
    '<div style="font-size:28px;font-weight:700;color:#2C5F2E;margin:10px 0;font-family:monospace">' + locCode + '</div>' +
    '<img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=' + qrData + '" alt="QR" style="margin:10px 0;border-radius:4px">' +
    '<div style="font-size:10px;color:#888">라이프컬처 창고관리시스템</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-top:12px">' +
    '<button onclick="window.print()" style="flex:1;padding:10px;background:#2980b9;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:700"><i class="fas fa-print"></i> 인쇄</button>' +
    '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="flex:1;padding:10px;background:#f8f9fa;color:#555;border:1px solid #ddd;border-radius:8px;cursor:pointer">닫기</button>' +
    '</div></div></div>';
  document.body.appendChild(m);
}

// ── 프린터 IP 저장 ────────────────────────────────
function whSavePrinterIp() {
  var ip = (document.getElementById('whPrinterIpInput') || {}).value || '';
  if (!ip) { showToast('IP 주소를 입력하세요.', 'warning'); return; }
  localStorage.setItem('whLabelPrinterIp', ip.trim());
  showToast('프린터 IP가 저장되었습니다: ' + ip.trim(), 'success');
}

// ── ZPL 네트워크 전송 (CORS 제약으로 직접 전송 불가 시 안내) ──
function whZplNetworkPrint(lotNo) {
  var record = whInboundData.find(function(r){ return r.lot_no === lotNo; });
  if (!record) return;
  var ip = localStorage.getItem('whLabelPrinterIp') || '';
  if (!ip) {
    showToast('먼저 프린터 IP 주소를 입력하고 저장하세요.', 'warning');
    return;
  }
  var zpl = '^XA\n' +
    '^CI28\n' +
    '^FO20,15^A0N,22,22^FD' + (record.item_name||'').substring(0,30) + '^FS\n' +
    '^FO20,42^A0N,18,18^FDLot: ' + (record.lot_no||'') + '^FS\n' +
    '^FO20,64^A0N,18,18^FD위치: ' + (record.location||'') + '^FS\n' +
    '^FO20,86^A0N,18,18^FD소비기한: ' + (record.expiry_date||'') + '^FS\n' +
    '^FO20,108^A0N,18,18^FD수량: ' + (record.qty||0) + ' ' + (record.unit||'') + '^FS\n' +
    '^FO220,10^BQN,2,4^FDQA,' + (record.lot_no||'') + '^FS\n' +
    '^XZ';

  // 브라우저에서 직접 TCP 소켓 연결은 불가 → fetch로 시도 후 실패 시 파일 다운로드 안내
  fetch('http://' + ip + ':9100', {
    method: 'POST',
    mode: 'no-cors',
    body: zpl,
    headers: { 'Content-Type': 'text/plain' }
  }).then(function() {
    showToast('ZPL 전송 완료 (IP: ' + ip + ':9100)', 'success');
  }).catch(function() {
    // 직접 전송 실패 시 파일 다운로드로 폴백
    showToast('직접 전송 실패. ZPL 파일을 다운로드하여 프린터 유틸리티로 전송하세요.', 'warning');
    whSendZplLabel(lotNo);
  });
}

// ── 엑셀 내보내기 ─────────────────────────────────
function whExport(type) {
  var data = type === 'in' ? whInboundData : whOutboundData;
  if (data.length === 0) { showToast('내보낼 데이터가 없습니다.', 'warning'); return; }
  var headers = type === 'in' ?
    ['Lot No','입고일','창고','위치','품목명','수량','단위','소비기한','제조번호','공급업체','메모'] :
    ['Lot No','출고일','창고','위치','품목명','수량','단위','참조Lot','출고처','메모'];
  var rows = data.map(function(r) {
    if (type === 'in') return [r.lot_no,r.inbound_date,r.warehouse,r.location,r.item_name,r.qty,r.unit,r.expiry_date,r.lot_no_product,r.supplier,r.memo];
    return [r.lot_no,r.outbound_date,r.warehouse,r.location,r.item_name,r.qty,r.unit,r.ref_lot,r.destination,r.memo];
  });
  var csv = [headers].concat(rows).map(function(r){ return r.map(function(c){ return '"'+(c||'')+'"'; }).join(','); }).join('\n');
  var blob = new Blob(['\uFEFF'+csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = (type==='in'?'입고':'출고') + '_' + new Date().toISOString().split('T')[0] + '.csv'; a.click();
  URL.revokeObjectURL(url);
}

// ── QR 스캔 출고 연동 ─────────────────────────────
function whOpenQrScanner() {
  var modal = document.getElementById('whQrScanModal');
  if (!modal) {
    var m = document.createElement('div');
    m.id = 'whQrScanModal';
    m.className = 'modal-overlay show';
    m.innerHTML = '<div class="modal-dialog" style="max-width:400px">' +
      '<div class="modal-header"><h3><i class="fas fa-qrcode"></i> QR/바코드 스캔</h3>' +
      '<button class="modal-close" onclick="whCloseQrScanner()"><i class="fas fa-times"></i></button></div>' +
      '<div class="modal-body">' +
      '<div id="whQrVideo" style="width:100%;background:#000;border-radius:8px;overflow:hidden;margin-bottom:12px;min-height:200px;display:flex;align-items:center;justify-content:center">' +
      '<video id="whQrVideoEl" style="width:100%" autoplay playsinline></video></div>' +
      '<div style="text-align:center;color:#555;font-size:13px;margin-bottom:12px">카메라로 QR코드 또는 바코드를 스캔하세요</div>' +
      '<div style="border-top:1px solid #eee;padding-top:12px">' +
      '<label style="font-size:12px;font-weight:700;display:block;margin-bottom:6px">직접 입력</label>' +
      '<div style="display:flex;gap:8px">' +
      '<input type="text" id="whQrManualInput" placeholder="Lot No. 또는 QR 데이터 입력" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
      '<button onclick="whProcessScan(document.getElementById(\'whQrManualInput\').value)" style="padding:8px 16px;background:#2C5F2E;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700">확인</button>' +
      '</div></div>' +
      '<div id="whQrScanResult" style="display:none;margin-top:12px"></div>' +
      '</div></div>';
    document.body.appendChild(m);
    whStartBarcodeDetector();
  } else {
    modal.classList.add('show');
    whStartBarcodeDetector();
  }
}

function whCloseQrScanner() {
  var modal = document.getElementById('whQrScanModal');
  if (modal) modal.classList.remove('show');
  var video = document.getElementById('whQrVideoEl');
  if (video && video.srcObject) {
    video.srcObject.getTracks().forEach(function(t){ t.stop(); });
    video.srcObject = null;
  }
}

async function whStartBarcodeDetector() {
  var video = document.getElementById('whQrVideoEl');
  if (!video) return;
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } });
    video.srcObject = stream;
    video.play();

    if ('BarcodeDetector' in window) {
      // 방법 1: BarcodeDetector API (쿨룸안드로이드/데스크탑 Chrome)
      var detector = new BarcodeDetector({ formats: ['qr_code','code_128','code_39','ean_13','ean_8'] });
      var scan = async function() {
        if (!video.srcObject) return;
        try {
          var barcodes = await detector.detect(video);
          if (barcodes.length > 0) {
            whProcessScan(barcodes[0].rawValue);
            return;
          }
        } catch(e) {}
        requestAnimationFrame(scan);
      };
      video.addEventListener('loadedmetadata', function(){ requestAnimationFrame(scan); }, { once: true });
      if (video.readyState >= 2) requestAnimationFrame(scan);
    } else if (typeof jsQR !== 'undefined') {
      // 방법 2: jsQR 폴백 (BarcodeDetector 미지원 환경)
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      var _scanning = true;
      var scanJsQR = function() {
        if (!video.srcObject || !_scanning) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
          if (code && code.data) {
            _scanning = false;
            whProcessScan(code.data);
            return;
          }
        }
        requestAnimationFrame(scanJsQR);
      };
      video.addEventListener('loadedmetadata', function(){ requestAnimationFrame(scanJsQR); }, { once: true });
      if (video.readyState >= 2) requestAnimationFrame(scanJsQR);
      // 모달 닫힐 시 스캔 중지
      var closeBtn = document.querySelector('#whQrScanModal .modal-close');
      if (closeBtn) closeBtn.addEventListener('click', function(){ _scanning = false; }, { once: true });
    } else {
      // 방법 3: 둘 다 미지원 시 안내 표시
      var container = document.getElementById('whQrVideo');
      if (container) {
        var msg = document.createElement('div');
        msg.style.cssText = 'position:absolute;bottom:8px;left:0;right:0;text-align:center;color:#fff;font-size:11px;background:rgba(0,0,0,0.5);padding:4px';
        msg.textContent = '이 브라우저는 카메라 QR 스캔을 지원하지 않습니다. 직접 입력을 이용해주세요.';
        container.style.position = 'relative';
        container.appendChild(msg);
      }
    }
  } catch(e) {
    var container = document.getElementById('whQrVideo');
    if (container) container.innerHTML = '<div style="color:#fff;padding:20px;text-align:center;font-size:13px">카메라 접근 불가<br><small>' + (e.message||'') + '</small><br><br>직접 입력을 이용해주세요</div>';
  }
}

function whProcessScan(rawValue) {
  if (!rawValue || !rawValue.trim()) return;
  var val = rawValue.trim();
  var resultEl = document.getElementById('whQrScanResult');

  // QR 데이터 파싱: 3단계 시도
  // 1) 원본 값이 JSON인 경우 (실제 QR 스캔 결과 - api.qrserver.com은 URL디코딩 후 QR 저장)
  // 2) encodeURIComponent된 JSON인 경우 (직접 입력 또는 일부 스캔너)
  // 3) Lot No. 직접 입력
  var parsed = null;
  // 시도 1: 원본 JSON 파싱
  try { parsed = JSON.parse(val); } catch(e) {}
  // 시도 2: URL디코딩 후 JSON 파싱
  if (!parsed || !parsed.lot) {
    try { parsed = JSON.parse(decodeURIComponent(val)); } catch(e) {}
  }

  if (parsed && parsed.lot) {
    whCloseQrScanner();
    var locEl = document.getElementById('whout_location');
    var itemEl = document.getElementById('whout_item_name');
    var refEl = document.getElementById('whout_ref_lot');
    if (locEl) locEl.value = parsed.loc || '';
    if (itemEl) itemEl.value = parsed.item || '';
    if (refEl) refEl.value = parsed.lot || '';
    var whEl = document.getElementById('whout_warehouse');
    if (whEl && parsed.loc) {
      whEl.value = parsed.loc.startsWith('C') ? 'C' : 'W';
      whBuildLocationSelect('whout');
      setTimeout(function(){ if (locEl) locEl.value = parsed.loc; }, 100);
    }
    // 수량/단위도 자동 입력
    var qtyEl = document.getElementById('whout_qty');
    var unitEl = document.getElementById('whout_unit');
    if (qtyEl && parsed.qty) qtyEl.value = parsed.qty;
    if (unitEl && parsed.unit) unitEl.value = parsed.unit;
    showToast('QR 스캔 완료: ' + parsed.lot, 'success');
    return;
  }

  // 시도 3: Lot No. 직접 조회
  var record = whInboundData.find(function(r){ return r.lot_no === val; });
  if (record) {
    whCloseQrScanner();
    var sv = function(id, v) { var el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
    var wh = (record.location||'').startsWith('C') ? 'C' : 'W';
    var whEl2 = document.getElementById('whout_warehouse');
    if (whEl2) { whEl2.value = wh; whBuildLocationSelect('whout'); }
    setTimeout(function(){ sv('whout_location', record.location); }, 100);
    sv('whout_item_name', record.item_name);
    sv('whout_qty', record.qty);
    sv('whout_unit', record.unit);
    sv('whout_ref_lot', record.lot_no);
    showToast('Lot No. ' + val + ' 조회 완료', 'success');
  } else {
    if (resultEl) {
      resultEl.style.display = '';
      resultEl.innerHTML = '<div style="color:#e74c3c">⚠️ "' + val + '"에 해당하는 입고 기록을 찾을 수 없습니다.</div>';
    }
    showToast('해당 Lot No. 또는 QR 코드를 찾을 수 없습니다.', 'warning');
  }
}

// ── 품목명 자동완성 (제품마스터 연동) ─────────────────
// 제품마스터 캐시
var _whProductMasterCache = null;
var _whProductMasterLoading = false;

async function whLoadProductMaster() {
  if (_whProductMasterCache !== null) return _whProductMasterCache;
  if (_whProductMasterLoading) {
    // 로딩 중이면 잠시 대기 후 재시도
    await new Promise(function(r){ setTimeout(r, 300); });
    return _whProductMasterCache || [];
  }
  _whProductMasterLoading = true;
  try {
    _whProductMasterCache = await apiGetAll('products');
  } catch(e) {
    _whProductMasterCache = [];
  }
  _whProductMasterLoading = false;
  return _whProductMasterCache || [];
}

// 입고유형 매핑: 제품마스터 product_type → whin_type 옵션값
var _whTypeMap = {
  '수입제품': '수입제품',
  '수입제품 (IMP)': '수입제품',
  'OEM': 'OEM제품',
  'OEM제품': 'OEM제품',
  '자체생산': '자체생산',
  '자체생산 (OWN)': '자체생산'
};

async function whItemNameFilter(query) {
  var dropdown = document.getElementById('whin_item_dropdown');
  if (!dropdown) return;

  var products = await whLoadProductMaster();
  var q = (query || '').trim().toLowerCase();

  // 검색어가 없으면 전체 목록 표시, 있으면 필터링
  var filtered = q
    ? products.filter(function(p) {
        return (p.product_name || '').toLowerCase().includes(q) ||
               (p.product_code || '').toLowerCase().includes(q);
      })
    : products;

  if (filtered.length === 0) {
    dropdown.innerHTML = '<div style="padding:12px 14px;color:#aaa;font-size:13px">검색 결과 없음</div>';
    dropdown.style.display = 'block';
    return;
  }

  dropdown.innerHTML = filtered.slice(0, 30).map(function(p) {
    var typeBadge = '';
    var pt = p.product_type || '';
    if (pt.includes('수입')) typeBadge = '<span style="font-size:10px;background:#e8f4fd;color:#2980b9;padding:1px 6px;border-radius:8px;margin-left:6px">수입</span>';
    else if (pt.includes('OEM')) typeBadge = '<span style="font-size:10px;background:#fef9e7;color:#d68910;padding:1px 6px;border-radius:8px;margin-left:6px">OEM</span>';
    else if (pt.includes('자체')) typeBadge = '<span style="font-size:10px;background:#eafaf1;color:#1e8449;padding:1px 6px;border-radius:8px;margin-left:6px">자체</span>';

    var codeTxt = p.product_code ? '<span style="font-size:10px;color:#aaa;margin-left:4px">[' + p.product_code + ']</span>' : '';

        var nameAttr = (p.product_name || '').replace(/"/g, '&quot;');
    var typeAttr = (p.product_type || '').replace(/"/g, '&quot;');
    return '<div onclick="whSelectItemName(this)"' +
      ' data-name="' + nameAttr + '"' +
      ' data-type="' + typeAttr + '"' +
      ' style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;gap:4px"' +
      ' onmouseover="this.style.background=\'#f0fff4\'" onmouseout="this.style.background=\'#fff\'">' +
      '<span style="font-weight:600;color:#222">' + (p.product_name || '-') + '</span>' +
      codeTxt + typeBadge +
      '</div>';
  }).join('');
  dropdown.style.display = 'block';
}

function whSelectItemName(el) {
  var productName = el ? el.getAttribute('data-name') : '';
  var productType = el ? el.getAttribute('data-type') : '';

  // 품목명 입력란에 선택한 제품명 설정
  var nameEl = document.getElementById('whin_item_name');
  if (nameEl) nameEl.value = productName;

  // 입고유형 자동 설정
  var typeEl = document.getElementById('whin_type');
  if (typeEl && productType) {
    var mapped = _whTypeMap[productType] || '';
    if (mapped) {
      for (var i = 0; i < typeEl.options.length; i++) {
        if (typeEl.options[i].value === mapped) {
          typeEl.selectedIndex = i;
          break;
        }
      }
    }
  }

  // 드롭다운 닫기
  var dropdown = document.getElementById('whin_item_dropdown');
  if (dropdown) dropdown.style.display = 'none';

  // 환산 수량 표시 업데이트
  whInCalcQty();
  // 위치 드롭다운 재빌드: 같은 제품 있는 위치 우선 표시
  var whInEl = document.getElementById('whin_warehouse');
  if (whInEl && whInEl.value) whBuildLocationSelect('whin');
}

// ── 입고 환산 수량 계산 및 표시 ──────────────────────────
function whInCalcQty() {
  var breakdownEl = document.getElementById('whin_qty_breakdown');
  if (!breakdownEl) return;
  var qty = parseInt(document.getElementById('whin_qty') ? document.getElementById('whin_qty').value : 0) || 0;
  var unit = document.getElementById('whin_unit') ? document.getElementById('whin_unit').value : 'ea';
  var itemName = document.getElementById('whin_item_name') ? document.getElementById('whin_item_name').value.trim() : '';
  if (!qty || !itemName) {
    breakdownEl.innerHTML = '<span style="color:#aaa">품목 선택 후 수량 입력 시 자동 표시</span>';
    return;
  }
  var products = _whProductMasterCache || [];
  var matchProduct = products.find(function(p) { return (p.product_name||'').trim() === itemName; });
  var qpb = matchProduct ? (parseInt(matchProduct.qty_per_box) || 0) : 0;
  var bpp = matchProduct ? (parseInt(matchProduct.boxes_per_pallet) || 0) : 0;
  var result = _whCalcBreakdown(qty, unit, qpb, bpp);
  var parts = [];
  if (result.qty_pt > 0) parts.push('<b>' + result.qty_pt + ' PT</b>');
  if (result.qty_box > 0) parts.push('<b>' + result.qty_box + ' Box</b>');
  if (result.qty_ea > 0) parts.push('<b>' + result.qty_ea + ' ea</b>');
  if (parts.length === 0) parts.push('<b>' + qty + ' ' + unit + '</b>');
  var hint = (qpb > 0 ? ' <small style="color:#888">(박스당 ' + qpb + 'ea' + (bpp > 0 ? ', PT당 ' + bpp + '박스' : '') + ')</small>' : '');
  breakdownEl.innerHTML = parts.join(' + ') + hint;
}

// ── 출고 환산 수량 계산 및 표시 ──────────────────────────
function whOutCalcQty() {
  var breakdownEl = document.getElementById('whout_qty_breakdown');
  if (!breakdownEl) return;
  var qty = parseInt(document.getElementById('whout_qty') ? document.getElementById('whout_qty').value : 0) || 0;
  var unit = document.getElementById('whout_unit') ? document.getElementById('whout_unit').value : 'ea';
  var itemName = document.getElementById('whout_item_name') ? document.getElementById('whout_item_name').value.trim() : '';
  if (!qty || !itemName) {
    breakdownEl.innerHTML = '<span style="color:#aaa">품목 선택 후 수량 입력 시 자동 표시</span>';
    return;
  }
  var products = _whProductMasterCache || [];
  var matchProduct = products.find(function(p) { return (p.product_name||'').trim() === itemName; });
  var qpb = matchProduct ? (parseInt(matchProduct.qty_per_box) || 0) : 0;
  var bpp = matchProduct ? (parseInt(matchProduct.boxes_per_pallet) || 0) : 0;
  var result = _whCalcBreakdown(qty, unit, qpb, bpp);
  var parts = [];
  if (result.qty_pt > 0) parts.push('<b>' + result.qty_pt + ' PT</b>');
  if (result.qty_box > 0) parts.push('<b>' + result.qty_box + ' Box</b>');
  if (result.qty_ea > 0) parts.push('<b>' + result.qty_ea + ' ea</b>');
  if (parts.length === 0) parts.push('<b>' + qty + ' ' + unit + '</b>');
  var hint = (qpb > 0 ? ' <small style="color:#888">(박스당 ' + qpb + 'ea' + (bpp > 0 ? ', PT당 ' + bpp + '박스' : '') + ')</small>' : '');
  breakdownEl.innerHTML = parts.join(' + ') + hint;
}

// ── 수량 환산 공통 헬퍼 ──────────────────────────────────
// qty(수량), unit(단위: pallet/box/ea/kg), qpb(박스당 낱개), bpp(파렛트당 박스)
// 반환: { qty_ea, qty_box, qty_pt } (낱개 기준 환산)
function _whCalcBreakdown(qty, unit, qpb, bpp) {
  var qty_ea = 0, qty_box = 0, qty_pt = 0;
  if (unit === 'pallet') {
    qty_pt = qty;
    qty_box = bpp > 0 ? qty * bpp : 0;
    qty_ea = qpb > 0 && bpp > 0 ? qty * bpp * qpb : (qpb > 0 ? 0 : 0);
  } else if (unit === 'box') {
    qty_box = qty;
    qty_pt = bpp > 0 ? Math.floor(qty / bpp) : 0;
    qty_ea = qpb > 0 ? qty * qpb : 0;
  } else if (unit === 'ea') {
    qty_ea = qty;
    qty_box = qpb > 0 ? Math.floor(qty / qpb) : 0;
    qty_pt = (qpb > 0 && bpp > 0) ? Math.floor(qty / (qpb * bpp)) : 0;
  } else {
    // kg 등 기타 단위는 낱개로 간주
    qty_ea = qty;
  }
  return { qty_ea: qty_ea, qty_box: qty_box, qty_pt: qty_pt };
}

// ── 수량 표시 헬퍼: 저장된 qty_ea/box/pt 우선, 없으면 제품마스터로 환산 ──────────
// 입고/출고 목록 테이블 수량 셀 표시용
function _whFmtQtyBreakdown(qty, unit, itemName, savedEa, savedBox, savedPt) {
  var qty_ea, qty_box, qty_pt;
  // 저장된 qty_ea/box/pt가 있으면 우선 사용
  if (savedEa !== undefined && savedEa !== null) {
    qty_ea = Number(savedEa) || 0;
    qty_box = Number(savedBox) || 0;
    qty_pt = Number(savedPt) || 0;
  } else {
    // 없으면 제품마스터에서 환산
    var products = _whProductMasterCache || [];
    var matchP = products.find(function(p) { return (p.product_name||'').trim() === (itemName||'').trim(); });
    var qpb = matchP ? (parseInt(matchP.qty_per_box) || 0) : 0;
    var bpp = matchP ? (parseInt(matchP.boxes_per_pallet) || 0) : 0;
    var bd = _whCalcBreakdown(Number(qty)||0, unit||'ea', qpb, bpp);
    qty_ea = bd.qty_ea; qty_box = bd.qty_box; qty_pt = bd.qty_pt;
  }
  var parts = [];
  if (qty_pt > 0) parts.push('<span style="color:#8e44ad;font-size:11px">' + qty_pt.toLocaleString() + ' PT</span>');
  if (qty_box > 0) parts.push('<span style="color:#2980b9;font-size:11px">' + qty_box.toLocaleString() + ' Box</span>');
  if (qty_ea > 0) parts.push('<span style="color:#27ae60;font-size:11px;font-weight:600">' + qty_ea.toLocaleString() + ' ea</span>');
  if (parts.length === 0) return '<span style="color:#555">' + (Number(qty)||0).toLocaleString() + ' ' + (unit||'') + '</span>';
  return parts.join('<br>');
}

// ── wh_outbound → logistics 레코드 변환 헬퍼 ──────────
// wh_outbound 데이터를 logistics 컬렉션 형식으로 변환 (출고 동기화용)
function _whBuildLogisticsOutRecord(d) {
  // ref_lot(연동 입고 Lot)에서 product_type 파악 시도
  var productType = d.product_type || '수입제품';
  // 연동 입고 Lot으로 원본 입고 데이터에서 product_type 찾기
  if (whInboundData && d.ref_lot) {
    var refIn = whInboundData.find(function(r){ return r.lot_no === d.ref_lot; });
    if (refIn && refIn.inbound_type) productType = refIn.inbound_type;
  }
  return {
    lot_no: d.lot_no || '',
    transaction_type: '출고',
    product_type: productType,
    date: d.outbound_date || '',
    product_name: d.item_name || '',
    product_code: d.ref_lot || '',
    quantity: Number(d.qty) || 0,
    unit: d.unit || 'ea',
    unit_price: 0,
    total_amount: 0,
    expiry_date: d.expiry_date || '',
    storage_location: (d.warehouse || '') + '-' + (d.location || ''),
    manager: d.manager || '',
    vendor: '',
    destination: d.destination || '',
    status: '출고완료',
    notes: d.memo || '',
    wh_lot_no: d.lot_no || '',
    wh_warehouse: d.warehouse || '',
    wh_location: d.location || ''
  };
}

// ── wh_inbound → logistics 레코드 변환 헬퍼 ──────────
// wh_inbound 데이터를 logistics 컬렉션 형식으로 변환
function _whBuildLogisticsRecord(d) {
  // inbound_type → product_type 매핑
  var typeMap = {
    '수입제품': '수입제품',
    'OEM제품': 'OEM제품',
    '자체생산': '자체생산',
    '기타': '기타'
  };
  var productType = typeMap[d.inbound_type] || d.inbound_type || '기타';
  // Lot No: wh_inbound의 lot_no를 그대로 사용
  return {
    lot_no: d.lot_no || '',
    transaction_type: '입고',
    product_type: productType,
    date: d.inbound_date || '',
    product_name: d.item_name || '',
    product_code: d.lot_no_product || '',
    quantity: Number(d.qty) || 0,
    unit: d.unit || 'pallet',
    unit_price: 0,
    total_amount: 0,
    expiry_date: d.expiry_date || '',
    storage_location: (d.warehouse || '') + '-' + (d.location || ''),
    manager: d.manager || '',
    vendor: d.supplier || '',
    destination: '',
    status: '입고완료',
    notes: d.memo || '',
    // 참조용 원본 wh_inbound 정보
    wh_lot_no: d.lot_no || '',
    wh_warehouse: d.warehouse || '',
    wh_location: d.location || ''
  };
}

// ── 입고 폼 제출 핸들러 ────────────────────────────
async function whHandleInSubmit(e) {
  if (e) e.preventDefault();
  var required = [
    { id: 'whin_warehouse', label: '창고구분' },
    { id: 'whin_location', label: '보관위치' },
    { id: 'whin_item_name', label: '품목명' },
    { id: 'whin_qty', label: '수량' },
    { id: 'whin_date', label: '입고일자' },
    { id: 'whin_expiry_date', label: '소비기한' },
    { id: 'whin_manager', label: '담당자' }
  ];
  for (var i = 0; i < required.length; i++) {
    var el = document.getElementById(required[i].id);
    if (!el || !el.value.trim()) {
      showToast(required[i].label + '을(를) 입력해주세요.', 'warning');
      if (el) el.focus();
      return;
    }
  }
  var lotEl = document.getElementById('whInLotDisplay');
  var data = {
    lot_no: lotEl ? (lotEl.dataset.lot || lotEl.textContent) : '',
    warehouse: document.getElementById('whin_warehouse').value,
    location: document.getElementById('whin_location').value,
    item_name: document.getElementById('whin_item_name').value.trim(),
    qty: Number(document.getElementById('whin_qty').value),
    unit: document.getElementById('whin_unit').value,
    inbound_date: document.getElementById('whin_date').value,
    inbound_type: document.getElementById('whin_type').value,
    mfg_date: (document.getElementById('whin_mfg_date') || {}).value || '',
    expiry_date: document.getElementById('whin_expiry_date').value,
    lot_no_product: (document.getElementById('whin_ref_lot') || {}).value || '',
    supplier: (document.getElementById('whin_supplier') || {}).value || '',
    temp: (document.getElementById('whin_temp') || {}).value || '',
    manager: document.getElementById('whin_manager').value.trim(),
    memo: (document.getElementById('whin_notes') || {}).value || ''
  };
  // 낱개/Box/PT 환산 수량 계산 및 저장 (하위 호환: 기존 qty 필드 유지)
  var _inProducts = _whProductMasterCache || [];
  var _inMatchP = _inProducts.find(function(p) { return (p.product_name||'').trim() === data.item_name; });
  var _inQpb = _inMatchP ? (parseInt(_inMatchP.qty_per_box) || 0) : 0;
  var _inBpp = _inMatchP ? (parseInt(_inMatchP.boxes_per_pallet) || 0) : 0;
  var _inBreakdown = _whCalcBreakdown(data.qty, data.unit, _inQpb, _inBpp);
  data.qty_ea = _inBreakdown.qty_ea;
  data.qty_box = _inBreakdown.qty_box;
  data.qty_pt = _inBreakdown.qty_pt;
  var submitBtn = document.querySelector('#whInForm button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 등록 중...'; }
  try {
    await apiPost('wh_inbound', data);
    // 전체 물류현황(전체현황 탭))에도 반영
    var lgRecord = _whBuildLogisticsRecord(data);
    await apiPost('logistics', lgRecord);
    showToast('입고 등록 완료: ' + data.lot_no, 'success');
    whInvalidateMapCache();
    await whReloadAll();
    whRefreshInLot();
    whResetInForm();
  } catch(err) {
    showToast('입고 등록 실패: ' + err.message, 'error');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-save"></i> 입고 등록'; }
  }
}

// ── 입고 폼 초기화 ────────────────────────────────
function whResetInForm() {
  var form = document.getElementById('whInForm');
  if (form) form.reset();
  // 날짜 기본값 복원
  var today = new Date().toISOString().split('T')[0];
  var dateEl = document.getElementById('whin_date');
  if (dateEl) dateEl.value = today;
  // 위치 드롭다운 초기화
  var locEl = document.getElementById('whin_location');
  if (locEl) locEl.innerHTML = '<option value="">창고 먼저 선택</option>';
  // 드롭다운 닫기
  var dropdown = document.getElementById('whin_item_dropdown');
  if (dropdown) dropdown.style.display = 'none';
  // 제품마스터 캐시 무효화 (최신 데이터 반영)
  _whProductMasterCache = null;
}

// ══════════════════════════════════════════════════
// 일괄 입고 등록 (인라인 테이블 + 엑셀 업로드)
// ══════════════════════════════════════════════════

var _whBulkRowCount = 0;

// 위치코드 목록 (창고 선택에 따라 동적 생성)
// onlyEmpty=true 이면 현재 재고가 있는 위치는 제외하고 빈 위치만 반환
function _whGetLocOptions(wh, onlyEmpty) {
  var locs = wh === 'C' ? COLD_LOCATIONS : (wh === 'W' ? WARM_LOCATIONS : []);
  if (!locs || locs.length === 0) return '<option value="">위치 선택</option>';

  // 현재 재고가 있는 위치 집합 계산
  var usedLocs = {};
  if (onlyEmpty) {
    var stockMap = whCalcStock();
    Object.keys(stockMap).forEach(function(loc) {
      var hasStock = Object.values(stockMap[loc]).some(function(v) { return (Number(v.qty) || 0) > 0; });
      if (hasStock) usedLocs[loc] = true;
    });
    // 현재 일괄입고 폼에서 이미 선택된 위치도 사용 중으로 처리
    var tbody = document.getElementById('whBulkBody');
    if (tbody) {
      tbody.querySelectorAll('select[id^="whBulkLoc_"]').forEach(function(sel) {
        if (sel.value) usedLocs[sel.value] = true;
      });
    }
  }

  var html = '<option value="">위치 선택</option>';
  var zoneKeys = [];
  locs.forEach(function(l) { if (zoneKeys.indexOf(l.zoneKey) < 0) zoneKeys.push(l.zoneKey); });
  var totalEmpty = 0;
  zoneKeys.forEach(function(zk) {
    var filtered = locs.filter(function(l) {
      return l.zoneKey === zk && (!onlyEmpty || !usedLocs[l.code]);
    });
    if (filtered.length === 0) return;
    totalEmpty += filtered.length;
    html += '<optgroup label="' + (wh === 'C' ? '저온' : '일반') + ' ' + zk + '구역 (빈 위치 ' + filtered.length + '개)">';
    filtered.forEach(function(l) {
      html += '<option value="' + l.code + '">' + l.code + '</option>';
    });
    html += '</optgroup>';
  });
  if (onlyEmpty && totalEmpty === 0) {
    html = '<option value="">빈 위치 없음</option>';
  }
  return html;
}

// 행 HTML 생성
function _whBulkRowHtml(idx, data) {
  data = data || {};
  var wh = data.warehouse || '';
  var locOpts = _whGetLocOptions(wh, true); // 빈 위치만 표시
  var today = new Date().toISOString().split('T')[0];
  var typeOpts = ['수입제품','OEM제품','자체생산','기타'].map(function(t) {
    return '<option value="' + t + '"' + (data.inbound_type === t ? ' selected' : '') + '>' + t + '</option>';
  }).join('');
  var unitOpts = ['pallet','box','ea','kg'].map(function(u) {
    return '<option value="' + u + '"' + ((data.unit||'pallet') === u ? ' selected' : '') + '>' + u + '</option>';
  }).join('');

  // 구역 자동 계산
  var zoneLabel = '';
  if (data.location) {
    var allLocs2 = (wh === 'C' ? COLD_LOCATIONS : WARM_LOCATIONS);
    var foundLoc = allLocs2.find(function(l){ return l.code === data.location; });
    if (foundLoc) zoneLabel = foundLoc.zoneKey + '구역';
  }

  return '<tr id="whBulkRow_' + idx + '" style="vertical-align:middle">' +
    '<td style="padding:4px 6px;border:1px solid #ddd;text-align:center;color:#aaa;font-size:11px">' + (idx + 1) + '</td>' +
    // 창고
    '<td style="padding:3px 4px;border:1px solid #ddd">' +
      '<select onchange="whBulkWarehouseChange(this,' + idx + ')" style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px">' +
        '<option value=""' + (!wh ? ' selected' : '') + '>선택</option>' +
        '<option value="C"' + (wh === 'C' ? ' selected' : '') + '>❄️ 저온(C)</option>' +
        '<option value="W"' + (wh === 'W' ? ' selected' : '') + '>🏭 일반(W)</option>' +
      '</select>' +
    '</td>' +
    // 위치코드
    '<td style="padding:3px 4px;border:1px solid #ddd">' +
      '<select id="whBulkLoc_' + idx + '" onchange="whBulkUpdateZone(this,' + idx + ')" style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px">' + locOpts + '</select>' +
    '</td>' +
    // 구역 (자동표시, 읽기전용)
    '<td style="padding:3px 4px;border:1px solid #ddd">' +
      '<input type="text" id="whBulkZone_' + idx + '" value="' + zoneLabel + '" readonly placeholder="자동" style="width:100%;padding:4px;border:1px solid #e0e0e0;border-radius:4px;font-size:12px;background:#f8f9fa;color:#555;cursor:default" />' +
    '</td>' +
    // 입고일
    '<td style="padding:3px 4px;border:1px solid #ddd">' +
      '<input type="date" value="' + (data.inbound_date || today) + '" style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px" />' +
    '</td>' +
    // 품목명
    '<td style="padding:3px 4px;border:1px solid #ddd;position:relative">' +
      '<input type="text" id="whBulkItem_' + idx + '" value="' + (data.item_name || '').replace(/"/g, '&quot;') + '" placeholder="품목명 입력..." autocomplete="off" ' +
      'oninput="whBulkItemInput(this,' + idx + ')" onblur="setTimeout(function(){var d=document.getElementById(\"whBulkItemDrop_' + idx + '\");if(d)d.style.display=\"none\"},200)" ' +
      'style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px;box-sizing:border-box" />' +
      '<div id="whBulkItemDrop_' + idx + '" style="display:none;position:absolute;z-index:9999;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.12);max-height:200px;overflow-y:auto;min-width:200px;left:4px;top:100%"></div>' +
    '</td>' +
    // 수량
    '<td style="padding:3px 4px;border:1px solid #ddd">' +
      '<input type="number" value="' + (data.qty || '') + '" min="1" placeholder="0" style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px" />' +
    '</td>' +
    // 단위
    '<td style="padding:3px 4px;border:1px solid #ddd">' +
      '<select style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px">' + unitOpts + '</select>' +
    '</td>' +
    // 소비기한
    '<td style="padding:3px 4px;border:1px solid #ddd">' +
      '<input type="date" value="' + (data.expiry_date || '') + '" style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px" />' +
    '</td>' +
    // 공급업체
    '<td style="padding:3px 4px;border:1px solid #ddd">' +
      '<input type="text" value="' + (data.supplier || '') + '" placeholder="공급업체" style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px" />' +
    '</td>' +
    // 담당자
    '<td style="padding:3px 4px;border:1px solid #ddd">' +
      '<input type="text" value="' + (data.manager || '') + '" placeholder="담당자" style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px" />' +
    '</td>' +
    // 입고유형
    '<td style="padding:3px 4px;border:1px solid #ddd">' +
      '<select style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px">' + typeOpts + '</select>' +
    '</td>' +
    // 관리 (복사 + 삭제)
    '<td style="padding:3px 6px;border:1px solid #ddd;text-align:center;white-space:nowrap">' +
      '<button onclick="whBulkCopyRow(' + idx + ')" title="이 행 복사" style="background:#e8f4fd;color:#2980b9;border:1px solid #2980b9;border-radius:4px;padding:3px 7px;cursor:pointer;font-size:11px"><i class="fas fa-copy"></i></button>' +
      '<button onclick="whBulkDeleteRow(' + idx + ')" title="행 삭제" style="background:#fdedec;color:#e74c3c;border:1px solid #e74c3c;border-radius:4px;padding:3px 7px;cursor:pointer;font-size:11px;margin-left:3px"><i class="fas fa-times"></i></button>' +
    '</td>' +
    '</tr>';
}

// 행 추가
function whBulkAddRow(data) {
  var tbody = document.getElementById('whBulkBody');
  if (!tbody) return;
  var idx = _whBulkRowCount++;
  var div = document.createElement('tbody');
  div.innerHTML = _whBulkRowHtml(idx, data || {});
  var tr = div.firstChild;
  tbody.appendChild(tr);
  // 위치코드 선택 복원 (데이터 있을 때 - setTimeout 없이 즉시 설정)
  if (data && data.location) {
    var locEl = document.getElementById('whBulkLoc_' + idx);
    if (locEl) {
      locEl.value = data.location;
      // 구역도 즉시 업데이트
      var zoneEl = document.getElementById('whBulkZone_' + idx);
      if (zoneEl) {
        var allLocs = COLD_LOCATIONS.concat(WARM_LOCATIONS);
        var found = allLocs.find(function(l){ return l.code === data.location; });
        zoneEl.value = found ? found.zoneKey + '구역' : '';
      }
    }
  }
}

// 창고 변경 시 위치코드 드롭다운 재빌드 + 구역 초기화
function whBulkWarehouseChange(sel, idx) {
  var wh = sel.value;
  var locEl = document.getElementById('whBulkLoc_' + idx);
  if (locEl) locEl.innerHTML = _whGetLocOptions(wh, true); // 빈 위치만 표시
  var zoneEl = document.getElementById('whBulkZone_' + idx);
  if (zoneEl) zoneEl.value = '';
}

// 위치코드 선택 시 구역 자동 표시
function whBulkUpdateZone(locSel, idx) {
  var code = locSel.value;
  var zoneEl = document.getElementById('whBulkZone_' + idx);
  if (!zoneEl) return;
  if (!code) { zoneEl.value = ''; return; }
  // 두 창고 모두에서 검색
  var allLocs = COLD_LOCATIONS.concat(WARM_LOCATIONS);
  var found = allLocs.find(function(l){ return l.code === code; });
  zoneEl.value = found ? found.zoneKey + '구역' : '';
}

// 행 복사
function whBulkCopyRow(idx) {
  var tr = document.getElementById('whBulkRow_' + idx);
  if (!tr) return;
  // td 인덱스 기반으로 읽기
  var d = _whBulkReadRow(tr);
  whBulkAddRow(d);
  showToast('행이 복사되었습니다.', 'success');
}

// 행 삭제
function whBulkDeleteRow(idx) {
  var tr = document.getElementById('whBulkRow_' + idx);
  if (tr) tr.remove();
}

// 전체 초기화
function whBulkClearAll() {
  if (!confirm('일괄 입력 내용을 모두 초기화하시겠습니까?')) return;
  var tbody = document.getElementById('whBulkBody');
  if (tbody) tbody.innerHTML = '';
  _whBulkRowCount = 0;
  whBulkAddRow();
}

// 행에서 데이터 읽기 - td 인덱스 기반 (가장 안전한 방식)
// TD 순서: 0=#, 1=창고, 2=위치코드, 3=구역, 4=입고일, 5=품목명, 6=수량, 7=단위, 8=소비기한, 9=공급업체, 10=담당자, 11=입고유형, 12=관리
function _whBulkReadRow(tr) {
  var tds = tr.querySelectorAll('td');
  function getVal(tdIdx) {
    if (!tds[tdIdx]) return '';
    var el = tds[tdIdx].querySelector('input, select');
    return el ? el.value : '';
  }
  function getValTrim(tdIdx) {
    return getVal(tdIdx).trim();
  }
  return {
    warehouse:    getVal(1),
    location:     getVal(2),
    // td[3] = 구역 (readonly, 저장 불필요)
    inbound_date: getVal(4),
    item_name:    getValTrim(5),
    qty:          Number(getVal(6)) || 0,
    unit:         getVal(7) || 'pallet',
    expiry_date:  getVal(8),
    supplier:     getValTrim(9),
    manager:      getValTrim(10),
    inbound_type: getVal(11) || '수입제품'
  };
}

// 전체 등록
async function whBulkSubmitAll() {
  var tbody = document.getElementById('whBulkBody');
  if (!tbody) return;
  var rows = tbody.querySelectorAll('tr');
  if (rows.length === 0) { showToast('등록할 행이 없습니다.', 'warning'); return; }

  var records = [];
  var errors = [];
  rows.forEach(function(tr, i) {
    var d = _whBulkReadRow(tr);
    if (!d.warehouse) { errors.push((i+1) + '행: 창고구분 필수'); return; }
    if (!d.location) { errors.push((i+1) + '행: 위치코드 필수'); return; }
    if (!d.inbound_date) { errors.push((i+1) + '행: 입고일 필수'); return; }
    if (!d.item_name) { errors.push((i+1) + '행: 품목명 필수'); return; }
    if (!d.qty || d.qty < 1) { errors.push((i+1) + '행: 수량 필수(1 이상)'); return; }
    if (!d.expiry_date) { errors.push((i+1) + '행: 소비기한 필수'); return; }
    if (!d.manager) { errors.push((i+1) + '행: 담당자 필수'); return; }
    records.push(d);
  });

  if (errors.length > 0) {
    showToast('입력 오류:\n' + errors.slice(0,3).join('\n') + (errors.length > 3 ? '\n...외 ' + (errors.length-3) + '건' : ''), 'warning');
    return;
  }

  if (!confirm(records.length + '건을 일괄 등록하시겠습니까?')) return;

  var btn = document.querySelector('[onclick="whBulkSubmitAll()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 등록 중...'; }

  // Lot No 시작 번호 계산
  var today = new Date().toISOString().split('T')[0].replace(/-/g,'').slice(2);
  var prefix = 'WH-IN-' + today;
  var fresh = await apiGetAll('wh_inbound');
  var seq = (fresh.filter(function(r){ return r.lot_no && r.lot_no.startsWith(prefix); }).length) + 1;

  // 제품마스터 캐시 보장
  var _bulkInProducts = _whProductMasterCache || await whLoadProductMaster();

  var successCount = 0;
  var failCount = 0;
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var lotNo = prefix + '-' + String(seq + i).padStart(3, '0');
    // qty_ea/qty_box/qty_pt 환산 계산
    var _bulkMatchP = _bulkInProducts.find(function(p) { return (p.product_name||'').trim() === r.item_name; });
    var _bulkQpb = _bulkMatchP ? (parseInt(_bulkMatchP.qty_per_box) || 0) : 0;
    var _bulkBpp = _bulkMatchP ? (parseInt(_bulkMatchP.boxes_per_pallet) || 0) : 0;
    var _bulkBd = _whCalcBreakdown(r.qty, r.unit, _bulkQpb, _bulkBpp);
    var payload = {
      lot_no: lotNo,
      warehouse: r.warehouse,
      location: r.location,
      inbound_date: r.inbound_date,
      inbound_type: r.inbound_type,
      item_name: r.item_name,
      qty: r.qty,
      unit: r.unit,
      qty_ea: _bulkBd.qty_ea,
      qty_box: _bulkBd.qty_box,
      qty_pt: _bulkBd.qty_pt,
      expiry_date: r.expiry_date,
      supplier: r.supplier,
      manager: r.manager,
      created_at: Date.now()
    };
    try {
      await apiPost('wh_inbound', payload);
      // 전체 물류현황(전체현황 탭)에도 반영
      var lgRec = _whBuildLogisticsRecord(payload);
      await apiPost('logistics', lgRec);
      successCount++;
    } catch(e) {
      failCount++;
    }
  }

  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> 전체 등록'; }

  if (successCount > 0) {
    showToast(successCount + '건 등록 완료' + (failCount > 0 ? ' (' + failCount + '건 실패)' : ''), 'success');
    whInvalidateMapCache();
    await whReloadAll();
    whRenderInTable();
    whRefreshInLot();
    // 등록 완료 후 테이블 초기화
    var tbody2 = document.getElementById('whBulkBody');
    if (tbody2) tbody2.innerHTML = '';
    _whBulkRowCount = 0;
    whBulkAddRow();
  } else {
    showToast('등록에 실패했습니다.', 'error');
  }
}

// ── 엑셀 양식 다운로드 ────────────────────────────
function whBulkDownloadTemplate() {
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리 로딩 중입니다. 잠시 후 다시 시도해주세요.', 'warning'); return; }

    var headers = ['창고(C=저온/W=일반)', '위치코드', '구역', '입고일(YYYY-MM-DD)', '품목명', '수량', '단위(pallet/box/ea/kg)', '소비기한(YYYY-MM-DD)', '공급업체', '담당자', '입고유형(수입제품/OEM제품/자체생산/기타)'];
  var examples = [
    ['C', 'C-A1-1-1', 'A구역', '2026-06-12', '제품명 예시', 10, 'pallet', '2027-06-12', '공급업체명', '홍길동', '수입제품'],
    ['W', 'W-A1-1-1', 'A구역', '2026-06-12', '제품명 예시2', 5, 'box', '2027-12-31', '공급업체명2', '김철수', 'OEM제품']
  ];
  var wb = XLSX.utils.book_new();
  var wsData = [headers].concat(examples);
  var ws = XLSX.utils.aoa_to_sheet(wsData);
  // 열 너비 설정 (11열)
  ws['!cols'] = [
    {wch:16},{wch:14},{wch:10},{wch:18},{wch:24},{wch:8},{wch:20},{wch:18},{wch:16},{wch:12},{wch:30}
  ];

  // 헤더 스타일 (배경색)
  var range = XLSX.utils.decode_range(ws['!ref']);
  for (var c = range.s.c; c <= range.e.c; c++) {
    var cellAddr = XLSX.utils.encode_cell({r: 0, c: c});
    if (!ws[cellAddr]) continue;
    ws[cellAddr].s = {
      fill: { fgColor: { rgb: 'D5F5E3' } },
      font: { bold: true },
      alignment: { horizontal: 'center' }
    };
  }

  XLSX.utils.book_append_sheet(wb, ws, '창고입고양식');

  // 위치코드 안내 시트
  var locHeaders = ['창고', '위치코드', '구역'];
  var locData = [locHeaders];
  COLD_LOCATIONS.forEach(function(l) { locData.push(['C (저온)', l.code, l.zoneKey + '구역']); });
  WARM_LOCATIONS.forEach(function(l) { locData.push(['W (일반)', l.code, l.zoneKey + '구역']); });
  var wsLoc = XLSX.utils.aoa_to_sheet(locData);
  wsLoc['!cols'] = [{wch:12},{wch:16},{wch:10}];
  XLSX.utils.book_append_sheet(wb, wsLoc, '위치코드목록');

  XLSX.writeFile(wb, '창고입고양식_' + new Date().toISOString().split('T')[0] + '.xlsx');
  showToast('엑셀 양식이 다운로드되었습니다.', 'success');
}

// ── 엑셀 파일 드롭/업로드 처리 ───────────────────
function whBulkHandleDrop(event) {
  event.preventDefault();
  var zone = document.getElementById('whBulkDropZone');
  if (zone) zone.classList.remove('dragover');
  var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) whBulkHandleFile(file);
}

function whBulkHandleFile(file) {
  if (!file) return;
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리 로딩 중입니다. 잠시 후 다시 시도해주세요.', 'warning'); return; }

  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = new Uint8Array(e.target.result);
      var wb = XLSX.read(data, { type: 'array', cellDates: true });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      if (rows.length < 2) { showToast('데이터가 없습니다. 양식을 확인해주세요.', 'warning'); return; }

      // 헤더 행 제거 후 데이터 파싱
      var dataRows = rows.slice(1).filter(function(r) {
        return r.some(function(c){ return c !== '' && c !== null && c !== undefined; });
      });

      if (dataRows.length === 0) { showToast('입력된 데이터가 없습니다.', 'warning'); return; }

      // 기존 테이블 초기화
      var tbody = document.getElementById('whBulkBody');
      if (tbody) tbody.innerHTML = '';
      _whBulkRowCount = 0;

      var added = 0;
      dataRows.forEach(function(r) {
        // 날짜 처리 (Date 객체 또는 문자열)
        // 로컈 날짜 기준으로 포맷 (한국 UTC+9에서 toISOString 사용 시 하루 줄어드는 문제 해결)
        function fmtDate(v) {
          if (!v) return '';
          if (v instanceof Date) {
            var y = v.getFullYear();
            var m = String(v.getMonth() + 1).padStart(2, '0');
            var d2 = String(v.getDate()).padStart(2, '0');
            return y + '-' + m + '-' + d2;
          }
          var s = String(v).trim();
          // YYYYMMDD 형식 처리
          if (/^\d{8}$/.test(s)) return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
          return s;
        }
        // 콜럼 순서: A=창고(0), B=위치코드(1), C=구역(2), D=입고일(3), E=품목명(4), F=수량(5), G=단위(6), H=소비기한(7), I=공급업체(8), J=담당자(9), K=입고유형(10)
        var d = {
          warehouse: String(r[0] || '').trim().toUpperCase(),
          location: String(r[1] || '').trim().toUpperCase(),
          // r[2] = 구역 (자동표시용, 저장에 불필요)
          inbound_date: fmtDate(r[3]),
          item_name: String(r[4] || '').trim(),
          qty: Number(r[5]) || '',
          unit: String(r[6] || 'pallet').trim(),
          expiry_date: fmtDate(r[7]),
          supplier: String(r[8] || '').trim(),
          manager: String(r[9] || '').trim(),
          inbound_type: String(r[10] || '수입제품').trim()
        };
        whBulkAddRow(d);
        added++;
      });

      showToast(added + '건의 데이터를 불러왔습니다. 확인 후 [전체 등록]을 눌러주세요.', 'success');
    } catch(err) {
      showToast('파일 읽기 오류: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);

  // input 초기화 (같은 파일 재업로드 가능하도록)
  var fi = document.getElementById('whBulkFileInput');
  if (fi) fi.value = '';
}

// 탭 전환 시 일괄 입력 테이블 초기화 (첫 진입 시 빈 행 1개 추가)
function whInitBulkTable() {
  var tbody = document.getElementById('whBulkBody');
  if (tbody && tbody.children.length === 0) {
    _whBulkRowCount = 0;
    whBulkAddRow();
  }
}

// ══════════════════════════════════════════════════
// 방안 A: 스마트 출고 추천 + 원클릭 자동채움
// ══════════════════════════════════════════════════

function whGetSmartCandidates(itemName) {
  if (!itemName) return [];
  var stockMap = whCalcStock();
  var candidates = [];
  var whFilter = (document.getElementById('whFifoWarehouse') || {}).value || '';
  Object.keys(stockMap).forEach(function(locCode) {
    if (whFilter && !locCode.startsWith(whFilter)) return;
    var info = stockMap[locCode][itemName];
    if (!info || (info.qty || 0) <= 0) return;
    candidates.push({
      code: locCode,
      qty: info.qty,
      unit: info.unit || '',
      expiry: info.expiry || '',
      lot: info.lot || '',
      warehouse: locCode.startsWith('C') ? '❄️ 저온' : '🏭 일반'
    });
  });
  // 1순위: 소비기한 짧은 순, 2순위: 수량 적은 순
  candidates.sort(function(a, b) {
    var ea = a.expiry || '9999-99-99';
    var eb = b.expiry || '9999-99-99';
    if (ea !== eb) return ea.localeCompare(eb);
    return (a.qty || 0) - (b.qty || 0);
  });
  return candidates;
}

function whRenderFifo() {
  var listEl = document.getElementById('whFifoList');
  if (!listEl) return;
  var itemName = ((document.getElementById('whFifoSearch') || {}).value || '').trim();
  if (!itemName) {
    listEl.innerHTML = '<div style="color:#aaa;font-size:13px"><i class="fas fa-search"></i> 품목명을 입력하면 소비기한 짧은 순 → 수량 적은 순으로 출고 위치를 안내합니다.</div>';
    return;
  }
  var candidates = whGetSmartCandidates(itemName);
  if (candidates.length === 0) {
    listEl.innerHTML = '<div style="color:#e74c3c;font-size:13px"><i class="fas fa-exclamation-triangle"></i> "' + itemName + '" 재고가 없습니다.</div>';
    return;
  }
  var today = new Date();
  var html = '<div style="display:flex;flex-wrap:wrap;gap:10px">';
  candidates.forEach(function(c, i) {
    var diff = c.expiry ? Math.ceil((new Date(c.expiry) - today) / 86400000) : null;
    var isFirst = i === 0;
    var cardBorder = isFirst ? '2px solid #e74c3c' : '1px solid #e0e0e0';
    var cardBg = isFirst ? '#fff5f5' : '#fafafa';
    var expiryColor = diff !== null && diff < 0 ? '#e74c3c' : (diff !== null && diff <= 30 ? '#e67e22' : '#555');
    var expiryText = c.expiry ? (c.expiry + (diff !== null ? ' (D-' + diff + ')' : '')) : '소비기한 미등록';
    var badge = isFirst
      ? '<span style="background:#e74c3c;color:#fff;font-size:10px;padding:2px 7px;border-radius:10px;font-weight:700">1순위 우선출고</span>'
      : '<span style="background:#f0f0f0;color:#555;font-size:10px;padding:2px 7px;border-radius:10px">' + (i+1) + '순위</span>';
    var escapedName = itemName.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    html += '<div style="background:' + cardBg + ';border:' + cardBorder + ';border-radius:10px;padding:12px 14px;min-width:200px;max-width:260px;flex:1">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">' + badge +
      '<span style="font-size:11px;color:#888">' + c.warehouse + '</span></div>' +
      '<div style="font-size:14px;font-weight:700;color:#222;margin-bottom:4px"><code style="background:#f0f4ff;padding:2px 6px;border-radius:4px;font-size:13px">' + c.code + '</code></div>' +
      '<div style="font-size:13px;color:#27ae60;font-weight:600;margin-bottom:4px"><i class="fas fa-boxes"></i> 잔여 ' + c.qty.toLocaleString() + ' ' + c.unit + '</div>' +
      '<div style="font-size:12px;color:' + expiryColor + ';margin-bottom:10px"><i class="fas fa-calendar-alt"></i> ' + expiryText + '</div>' +
      '<button onclick="whFifoSelectLocation(\'' + c.code + '\',\'' + (c.lot||'') + '\',\'' + escapedName + '\')" ' +
      'style="width:100%;background:#e74c3c;color:#fff;border:none;border-radius:7px;padding:7px 0;font-size:12px;font-weight:700;cursor:pointer">' +
      '<i class="fas fa-arrow-right"></i> 이 위치로 출고 등록</button>' +
      '</div>';
  });
  html += '</div>';
  var totalQty = candidates.reduce(function(s, c) { return s + (c.qty || 0); }, 0);
  html = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">' +
    '<span style="font-size:13px;font-weight:700;color:#856404"><i class="fas fa-warehouse"></i> ' + itemName + ' 전체 재고: <b style="color:#e74c3c">' + totalQty.toLocaleString() + '</b> ' + (candidates[0].unit||'') + ' (' + candidates.length + '개 위치)</span>' +
    '</div>' + html;
  listEl.innerHTML = html;
}

function whFifoSelectLocation(locCode, refLot, itemName) {
  var wh = locCode.startsWith('C') ? 'C' : 'W';
  var whEl = document.getElementById('whout_warehouse');
  if (whEl) { whEl.value = wh; whBuildLocationSelect('whout'); }
  setTimeout(function() {
    var locEl = document.getElementById('whout_location');
    if (locEl) locEl.value = locCode;
  }, 50);
  var nameEl = document.getElementById('whout_item_name');
  if (nameEl && itemName) nameEl.value = itemName;
  var refEl = document.getElementById('whout_ref_lot');
  if (refEl && refLot) refEl.value = refLot;
  var stockEl = document.getElementById('whout_stock_info');
  if (stockEl) whShowOutItemStock(itemName);
  var formEl = document.getElementById('whOutForm');
  if (formEl) formEl.closest('.form-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast(locCode + ' 위치가 출고 폼에 자동 입력되었습니다.', 'success');
}

function whOutItemInput(val) {
  whOutItemFilter(val);
  var fifoSearch = document.getElementById('whFifoSearch');
  if (fifoSearch) fifoSearch.value = val;
  whRenderFifo();
  whShowOutItemStock(val);
}

async function whOutItemFilter(query) {
  var dropdown = document.getElementById('whout_item_dropdown');
  if (!dropdown) return;
  var products = await whLoadProductMaster();
  var q = (query || '').trim().toLowerCase();
  var filtered = q ? products.filter(function(p) {
    return (p.product_name || '').toLowerCase().includes(q);
  }) : products;
  if (filtered.length === 0) { dropdown.style.display = 'none'; return; }
  dropdown.innerHTML = filtered.slice(0, 20).map(function(p) {
    var nameAttr = (p.product_name || '').replace(/"/g, '&quot;');
    return '<div onclick="whOutSelectItem(this)" data-name="' + nameAttr + '"' +
      ' style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0"' +
      ' onmouseover="this.style.background=\'#fff5f5\'" onmouseout="this.style.background=\'#fff\'">' +
      '<span style="font-weight:600">' + (p.product_name || '-') + '</span></div>';
  }).join('');
  dropdown.style.display = 'block';
}

function whOutSelectItem(el) {
  var name = el ? el.getAttribute('data-name') : '';
  var nameEl = document.getElementById('whout_item_name');
  if (nameEl) nameEl.value = name;
  var dropdown = document.getElementById('whout_item_dropdown');
  if (dropdown) dropdown.style.display = 'none';
  var fifoSearch = document.getElementById('whFifoSearch');
  if (fifoSearch) fifoSearch.value = name;
  whRenderFifo();
  whShowOutItemStock(name);
}

function whShowOutItemStock(itemName) {
  var stockEl = document.getElementById('whout_stock_info');
  if (!stockEl) return;
  if (!itemName || !itemName.trim()) { stockEl.style.display = 'none'; return; }
  var candidates = whGetSmartCandidates(itemName.trim());
  if (candidates.length === 0) {
    stockEl.style.display = '';
    stockEl.innerHTML = '<span style="color:#e74c3c;font-size:12px"><i class="fas fa-exclamation-triangle"></i> 재고 없음</span>';
    return;
  }
  var totalQty = candidates.reduce(function(s, c) { return s + c.qty; }, 0);
  var unit = candidates[0].unit || '';
  var firstExpiry = candidates[0].expiry;
  var today = new Date();
  var diff = firstExpiry ? Math.ceil((new Date(firstExpiry) - today) / 86400000) : null;
  var expiryTxt = firstExpiry ? (' | 최우선 소비기한: <b style="color:' + (diff!==null&&diff<=30?'#e74c3c':'#27ae60') + '">' + firstExpiry + (diff!==null?' (D-'+diff+')':'') + '</b>') : '';

  // 박스당 입수 정보 표시
  var boxTxt = '';
  var products = _whProductMasterCache || [];
  var matchProduct = products.find(function(p) { return (p.product_name||'').trim() === (itemName||'').trim(); });
  var qpb = matchProduct ? (parseInt(matchProduct.qty_per_box) || 0) : 0;
  if (qpb > 0) {
    var totalBoxes = Math.floor(totalQty / qpb);
    var remainder = totalQty % qpb;
    boxTxt = ' | <span style="color:#2980b9;font-size:12px"><i class="fas fa-box"></i> 박스당 ' + qpb + 'ea → <b>' + totalBoxes + '박스 ' + (remainder > 0 ? remainder + 'ea 낱개 남음' : '정확') + '</b></span>';
  }

  stockEl.style.display = '';
  stockEl.innerHTML = '<span style="color:#27ae60;font-size:12px"><i class="fas fa-boxes"></i> 총 재고: <b>' + totalQty.toLocaleString() + ' ' + unit + '</b> (' + candidates.length + '개 위치)' + expiryTxt + '</span>' + boxTxt;
}

async function whHandleOutSubmit(e) {
  if (e) e.preventDefault();
  var required = [
    { id: 'whout_warehouse', label: '창고구분' },
    { id: 'whout_location', label: '출고위치' },
    { id: 'whout_item_name', label: '품목명' },
    { id: 'whout_qty', label: '수량' },
    { id: 'whout_date', label: '출고일자' },
    { id: 'whout_manager', label: '담당자' }
  ];
  for (var i = 0; i < required.length; i++) {
    var el = document.getElementById(required[i].id);
    if (!el || !el.value.trim()) {
      showToast(required[i].label + '을(를) 입력해주세요.', 'warning');
      if (el) el.focus();
      return;
    }
  }
  var lotEl = document.getElementById('whOutLotDisplay');
  var data = {
    lot_no: lotEl ? (lotEl.dataset.lot || lotEl.textContent) : '',
    warehouse: document.getElementById('whout_warehouse').value,
    location: document.getElementById('whout_location').value,
    item_name: document.getElementById('whout_item_name').value.trim(),
    qty: Number(document.getElementById('whout_qty').value),
    unit: document.getElementById('whout_unit').value,
    outbound_date: document.getElementById('whout_date').value,
    destination: (document.getElementById('whout_destination') || {}).value || '',
    ref_lot: (document.getElementById('whout_ref_lot') || {}).value || '',
    manager: document.getElementById('whout_manager').value.trim(),
    memo: (document.getElementById('whout_notes') || {}).value || ''
  };
  // 낱개/Box/PT 환산 수량 계산 및 저장 (하위 호환: 기존 qty 필드 유지)
  var _outProducts = _whProductMasterCache || [];
  var _outMatchP = _outProducts.find(function(p) { return (p.product_name||'').trim() === data.item_name; });
  var _outQpb = _outMatchP ? (parseInt(_outMatchP.qty_per_box) || 0) : 0;
  var _outBpp = _outMatchP ? (parseInt(_outMatchP.boxes_per_pallet) || 0) : 0;
  var _outBreakdown = _whCalcBreakdown(data.qty, data.unit, _outQpb, _outBpp);
  data.qty_ea = _outBreakdown.qty_ea;
  data.qty_box = _outBreakdown.qty_box;
  data.qty_pt = _outBreakdown.qty_pt;
  var stockMap = whCalcStock();
  var locStock = ((stockMap[data.location] || {})[data.item_name]) || { qty: 0 };
  if (locStock.qty < data.qty) {
    showToast('재고 부족! ' + data.location + ' 현재 재고: ' + locStock.qty + ' ' + (data.unit||''), 'warning');
    return;
  }
  var submitBtn = document.querySelector('#whOutForm button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 등록 중...'; }
  try {
    await apiPost('wh_outbound', data);
    // wh_outbound가 단일 진실 공급원이므로 logistics 중복 동기화 저장 안 함
    showToast('출고 등록 완료: ' + data.lot_no, 'success');
    whInvalidateMapCache();
    await whReloadAll();
    whRefreshOutLot();
    whResetOutForm();
    whRenderFifo();
  } catch(err) {
    showToast('출고 등록 실패: ' + err.message, 'error');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-save"></i> 출고 등록'; }
  }
}

function whResetOutForm() {
  var form = document.getElementById('whOutForm');
  if (form) form.reset();
  var today = new Date().toISOString().split('T')[0];
  var dateEl = document.getElementById('whout_date');
  if (dateEl) dateEl.value = today;
  var locEl = document.getElementById('whout_location');
  if (locEl) locEl.innerHTML = '<option value="">창고 먼저 선택</option>';
  var dropdown = document.getElementById('whout_item_dropdown');
  if (dropdown) dropdown.style.display = 'none';
  var stockEl = document.getElementById('whout_stock_info');
  if (stockEl) stockEl.style.display = 'none';
}

// ── 일괄 입고 품목명 자동완성 ──────────────────────
async function whBulkItemInput(inputEl, idx) {
  var query = (inputEl.value || '').trim();
  var dropdown = document.getElementById('whBulkItemDrop_' + idx);
  if (!dropdown) return;
  if (!query) { dropdown.style.display = 'none'; return; }
  var q = query.toLowerCase();

  var products = await whLoadProductMaster();
  var seen = {};
  var filtered = [];
  products.forEach(function(p) {
    var name = (p.product_name || '').trim();
    if (name && name.toLowerCase().includes(q) && !seen[name]) {
      seen[name] = true;
      filtered.push(p);
    }
  });

  if (filtered.length === 0) {
    dropdown.innerHTML = '<div style="padding:10px 12px;color:#aaa;font-size:12px">검색 결과 없음</div>';
    dropdown.style.display = 'block';
    return;
  }

  dropdown.innerHTML = filtered.slice(0, 25).map(function(p) {
    var name = p.product_name || '';
    var nameAttr = name.replace(/"/g, '&quot;');
    var typeAttr = (p.product_type || '').replace(/"/g, '&quot;');
    var pt = p.product_type || '';
    var typeBadge = '';
    if (pt.includes('수입')) typeBadge = '<span style="font-size:10px;background:#e8f4fd;color:#2980b9;padding:1px 6px;border-radius:8px;margin-left:6px">수입</span>';
    else if (pt.includes('OEM')) typeBadge = '<span style="font-size:10px;background:#fef9e7;color:#d68910;padding:1px 6px;border-radius:8px;margin-left:6px">OEM</span>';
    else if (pt.includes('자체')) typeBadge = '<span style="font-size:10px;background:#eafaf1;color:#1e8449;padding:1px 6px;border-radius:8px;margin-left:6px">자체</span>';
    var codeTxt = p.product_code ? '<span style="font-size:10px;color:#aaa;margin-left:4px">[' + p.product_code + ']</span>' : '';
    return '<div onclick="whBulkItemSelect(this,' + idx + ')"' +
      ' data-name="' + nameAttr + '" data-type="' + typeAttr + '"' +
      ' style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;gap:4px"' +
      ' onmouseover="this.style.background=\'#f0fff4\'" onmouseout="this.style.background=\'#fff\'">' +
      '<span style="font-weight:600;color:#222">' + name + '</span>' + codeTxt + typeBadge +
      '</div>';
  }).join('');
  dropdown.style.display = 'block';
}

function whBulkItemSelect(el, idx) {
  var name = el ? el.getAttribute('data-name') : '';
  var type = el ? el.getAttribute('data-type') : '';
  // 품목명 입력
  var inp = document.getElementById('whBulkItem_' + idx);
  if (inp) inp.value = name;
  // 입고유형 자동 설정: 해당 행의 입고유형 select 찾기
  var tr = document.getElementById('whBulkRow_' + idx);
  if (tr && type) {
    var mapped = _whTypeMap[type] || '';
    if (mapped) {
      // TD 순서: 0=#, 1=창고, 2=위치, 3=구역, 4=입고일, 5=품목명, 6=수량, 7=단위, 8=소비기한, 9=공급업체, 10=담당자, 11=입고유형
      var tds = tr.querySelectorAll('td');
      if (tds[11]) {
        var typeSelect = tds[11].querySelector('select');
        if (typeSelect) {
          for (var i = 0; i < typeSelect.options.length; i++) {
            if (typeSelect.options[i].value === mapped) {
              typeSelect.selectedIndex = i;
              break;
            }
          }
        }
      }
    }
  }
  // 드롭다운 닫기
  var dropdown = document.getElementById('whBulkItemDrop_' + idx);
  if (dropdown) dropdown.style.display = 'none';
}

// ══════════════════════════════════════════════════
// 방안 B: 일괄 출고 요청서
// ══════════════════════════════════════════════════

var _whBulkOutRowCount = 0;

function _whBulkOutRowHtml(idx, data) {
  data = data || {};
  var today = new Date().toISOString().split('T')[0];
  return '<td style="padding:6px;border:1px solid #ddd;text-align:center;color:#888;font-size:12px">' + (idx+1) + '</td>' +
    '<td style="padding:4px;border:1px solid #ddd;min-width:200px;position:relative">' +
      '<input type="text" value="' + (data.item_name||'') + '" placeholder="품목명 입력..." ' +
      'style="width:100%;padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box" ' +
      'oninput="whBulkOutItemInput(this,' + idx + ')" autocomplete="off" />' +
      '<div id="whBulkOutDrop_' + idx + '" style="display:none;position:absolute;z-index:9999;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.1);max-height:200px;overflow-y:auto;min-width:200px;left:4px;top:100%"></div>' +
    '</td>' +
    '<td style="padding:4px;border:1px solid #ddd;min-width:80px">' +
      '<input type="number" value="' + (data.qty||'') + '" min="1" step="1" placeholder="0" ' +
      'style="width:100%;padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box" />' +
    '</td>' +
    '<td style="padding:4px;border:1px solid #ddd;min-width:80px">' +
      '<select style="width:100%;padding:5px 4px;border:1px solid #ddd;border-radius:4px;font-size:12px">' +
      ['pallet','box','ea','kg'].map(function(u){ return '<option' + (data.unit===u?' selected':'') + '>' + u + '</option>'; }).join('') +
      '</select>' +
    '</td>' +
    '<td style="padding:4px;border:1px solid #ddd;min-width:110px">' +
      '<input type="date" value="' + (data.date||today) + '" style="width:100%;padding:5px 4px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box" />' +
    '</td>' +
    '<td style="padding:4px;border:1px solid #ddd;min-width:120px">' +
      '<input type="text" value="' + (data.destination||'') + '" placeholder="출고처" style="width:100%;padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box" />' +
    '</td>' +
    '<td style="padding:4px;border:1px solid #ddd;min-width:90px">' +
      '<input type="text" value="' + (data.manager||'') + '" placeholder="담당자" style="width:100%;padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box" />' +
    '</td>' +
    '<td style="padding:4px;border:1px solid #ddd;text-align:center;min-width:70px">' +
      '<button onclick="whBulkOutCopyRow(' + idx + ')" style="background:#e8f4fd;color:#2980b9;border:1px solid #2980b9;border-radius:4px;padding:3px 7px;font-size:11px;cursor:pointer;margin-right:2px" title="행 복사"><i class="fas fa-copy"></i></button>' +
      '<button onclick="whBulkOutDeleteRow(' + idx + ')" style="background:#fdedec;color:#e74c3c;border:1px solid #e74c3c;border-radius:4px;padding:3px 7px;font-size:11px;cursor:pointer" title="행 삭제"><i class="fas fa-trash"></i></button>' +
    '</td>';
}

function whBulkOutAddRow(data) {
  var tbody = document.getElementById('whBulkOutBody');
  if (!tbody) return;
  var idx = _whBulkOutRowCount++;
  var tr = document.createElement('tr');
  tr.id = 'whBulkOutRow_' + idx;
  tr.innerHTML = _whBulkOutRowHtml(idx, data);
  tbody.appendChild(tr);
}

function whBulkOutCopyRow(idx) {
  var d = _whBulkOutReadRow(idx);
  if (d) whBulkOutAddRow(d);
}

function whBulkOutDeleteRow(idx) {
  var tr = document.getElementById('whBulkOutRow_' + idx);
  if (tr) tr.remove();
}

function whBulkOutClearAll() {
  var tbody = document.getElementById('whBulkOutBody');
  if (tbody) tbody.innerHTML = '';
  _whBulkOutRowCount = 0;
  var preview = document.getElementById('whBulkOutPreview');
  if (preview) preview.style.display = 'none';
  whBulkOutAddRow();
}

function _whBulkOutReadRow(idx) {
  var tr = document.getElementById('whBulkOutRow_' + idx);
  if (!tr) return null;
  var inputs = tr.querySelectorAll('input, select');
  return {
    item_name: (inputs[0] || {}).value || '',
    qty: Number((inputs[1] || {}).value) || 0,
    unit: (inputs[2] || {}).value || 'pallet',
    date: (inputs[3] || {}).value || '',
    destination: (inputs[4] || {}).value || '',
    manager: (inputs[5] || {}).value || ''
  };
}

async function whBulkOutItemInput(inputEl, idx) {
  var query = (inputEl.value || '').trim();
  var dropdown = document.getElementById('whBulkOutDrop_' + idx);
  if (!dropdown) return;
  if (!query) { dropdown.style.display = 'none'; return; }
  var q = query.toLowerCase();

  // 1) 제품마스터에서 검색
  var products = await whLoadProductMaster();
  var seen = {};
  var merged = [];
  products.forEach(function(p) {
    var name = (p.product_name || '').trim();
    if (name && name.toLowerCase().includes(q) && !seen[name]) {
      seen[name] = true;
      merged.push(name);
    }
  });

  // 2) wh_inbound 캐시에서 직접 검색 (제품마스터에 없는 품목 보완)
  // whInboundData: [{ item_name, qty, ... }] 형태
  var inboundNames = {};
  (whInboundData || []).forEach(function(r) {
    var name = (r.item_name || '').trim();
    if (name) inboundNames[name] = (inboundNames[name] || 0) + (Number(r.qty) || 0);
  });
  // wh_outbound 차감
  (whOutboundData || []).forEach(function(r) {
    var name = (r.item_name || '').trim();
    if (name && inboundNames[name] !== undefined) {
      inboundNames[name] -= (Number(r.qty) || 0);
    }
  });
  Object.keys(inboundNames).forEach(function(name) {
    if (name.toLowerCase().includes(q) && !seen[name]) {
      seen[name] = true;
      merged.push(name);
    }
  });

  if (merged.length === 0) { dropdown.style.display = 'none'; return; }
  dropdown.innerHTML = merged.slice(0, 20).map(function(name) {
    var nameAttr = name.replace(/"/g, '&quot;');
    var stock = inboundNames[name];
    var stockBadge = (stock !== undefined && stock > 0)
      ? '<span style="color:#27ae60;font-size:11px;margin-left:6px">(재고 ' + Math.round(stock).toLocaleString() + ')</span>'
      : '';
    return '<div onclick="whBulkOutSelectItem(this,' + idx + ')" data-name="' + nameAttr + '"' +
      ' style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #f0f0f0"' +
      ' onmouseover="this.style.background=\'#fff5f5\'" onmouseout="this.style.background=\'#fff\'">' +
      name + stockBadge + '</div>';
  }).join('');
  dropdown.style.display = 'block';
}

function whBulkOutSelectItem(el, idx) {
  var name = el ? el.getAttribute('data-name') : '';
  var tr = document.getElementById('whBulkOutRow_' + idx);
  if (tr) {
    var inp = tr.querySelector('input[type="text"]');
    if (inp) inp.value = name;
  }
  var dropdown = document.getElementById('whBulkOutDrop_' + idx);
  if (dropdown) dropdown.style.display = 'none';
}

function _whBulkOutReadAll() {
  var tbody = document.getElementById('whBulkOutBody');
  if (!tbody) return [];
  var rows = [];
  Array.prototype.forEach.call(tbody.querySelectorAll('tr[id^="whBulkOutRow_"]'), function(tr) {
    var idx = parseInt(tr.id.replace('whBulkOutRow_', ''));
    var d = _whBulkOutReadRow(idx);
    if (d && d.item_name && d.qty > 0) rows.push(d);
  });
  return rows;
}

function whAutoAssignLocations(itemName, needQty) {
  var candidates = whGetSmartCandidates(itemName);
  var assignments = [];
  var remaining = needQty;
  for (var i = 0; i < candidates.length && remaining > 0; i++) {
    var c = candidates[i];
    var take = Math.min(c.qty, remaining);
    assignments.push({
      location: c.code,
      warehouse: c.code.startsWith('C') ? 'C' : 'W',
      warehouseLabel: c.code.startsWith('C') ? '❄️ 저온' : '🏭 일반',
      qty: take,
      unit: c.unit,
      expiry: c.expiry,
      lot: c.lot,
      isSplit: false
    });
    remaining -= take;
  }
  if (assignments.length > 1) {
    assignments.forEach(function(a) { a.isSplit = true; });
  }
  return { assignments: assignments, remaining: remaining };
}

function whBulkOutPreview() {
  var rows = _whBulkOutReadAll();
  if (rows.length === 0) {
    showToast('출고 요청 내역을 입력해주세요.', 'warning');
    return;
  }
  var previewEl = document.getElementById('whBulkOutPreview');
  if (!previewEl) return;
  var today = new Date();
  var allAssignments = [];
  var hasError = false;
  var html = '<div style="font-weight:700;color:#e74c3c;margin-bottom:12px;font-size:14px"><i class="fas fa-clipboard-list"></i> 자동 위치 배정 결과 미리보기</div>';
  html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">';
  html += '<thead><tr style="background:#fdedec">' +
    '<th style="padding:8px;border:1px solid #f5c6cb">품목명</th>' +
    '<th style="padding:8px;border:1px solid #f5c6cb">요청수량</th>' +
    '<th style="padding:8px;border:1px solid #f5c6cb">배정위치</th>' +
    '<th style="padding:8px;border:1px solid #f5c6cb">출고수량</th>' +
    '<th style="padding:8px;border:1px solid #f5c6cb">소비기한</th>' +
    '<th style="padding:8px;border:1px solid #f5c6cb">분할여부</th>' +
    '<th style="padding:8px;border:1px solid #f5c6cb">상태</th>' +
    '</tr></thead><tbody>';
  rows.forEach(function(row) {
    var result = whAutoAssignLocations(row.item_name, row.qty);
    var shortage = result.remaining;
    if (result.assignments.length === 0) {
      hasError = true;
      html += '<tr style="background:#fff5f5">' +
        '<td style="padding:7px 8px;border:1px solid #eee;font-weight:700">' + row.item_name + '</td>' +
        '<td style="padding:7px 8px;border:1px solid #eee;text-align:right">' + row.qty + ' ' + row.unit + '</td>' +
        '<td colspan="4" style="padding:7px 8px;border:1px solid #eee;color:#e74c3c"><i class="fas fa-exclamation-triangle"></i> 재고 없음</td>' +
        '<td style="padding:7px 8px;border:1px solid #eee"><span style="background:#fdedec;color:#e74c3c;padding:2px 7px;border-radius:8px;font-size:11px">불가</span></td>' +
        '</tr>';
      return;
    }
    result.assignments.forEach(function(a, ai) {
      var diff = a.expiry ? Math.ceil((new Date(a.expiry) - today) / 86400000) : null;
      var expiryColor = diff !== null && diff < 0 ? '#e74c3c' : (diff !== null && diff <= 30 ? '#e67e22' : '#555');
      var expiryText = a.expiry ? (a.expiry + (diff !== null ? ' (D-' + diff + ')' : '')) : '-';
      var statusBadge = shortage > 0 && ai === result.assignments.length - 1
        ? '<span style="background:#fff3cd;color:#856404;padding:2px 7px;border-radius:8px;font-size:11px">부족 ' + shortage + '개</span>'
        : '<span style="background:#eafaf1;color:#27ae60;padding:2px 7px;border-radius:8px;font-size:11px">정상</span>';
      var splitBadge = a.isSplit
        ? '<span style="background:#e8f4fd;color:#2980b9;padding:2px 7px;border-radius:8px;font-size:11px">분할</span>'
        : '<span style="background:#f0f0f0;color:#888;padding:2px 7px;border-radius:8px;font-size:11px">단일</span>';
      html += '<tr>' +
        '<td style="padding:7px 8px;border:1px solid #eee;font-weight:' + (ai===0?'700':'400') + '">' + (ai===0?row.item_name:'↳ 분할') + '</td>' +
        '<td style="padding:7px 8px;border:1px solid #eee;text-align:right">' + (ai===0?row.qty+' '+row.unit:'') + '</td>' +
        '<td style="padding:7px 8px;border:1px solid #eee"><span style="font-size:11px;color:#888">' + a.warehouseLabel + '</span> <code style="font-size:11px;background:#f0f4ff;padding:1px 5px;border-radius:3px">' + a.location + '</code></td>' +
        '<td style="padding:7px 8px;border:1px solid #eee;text-align:right;font-weight:700;color:#e74c3c">' + a.qty + ' ' + a.unit + '</td>' +
        '<td style="padding:7px 8px;border:1px solid #eee;color:' + expiryColor + '">' + expiryText + '</td>' +
        '<td style="padding:7px 8px;border:1px solid #eee">' + splitBadge + '</td>' +
        '<td style="padding:7px 8px;border:1px solid #eee">' + statusBadge + '</td>' +
        '</tr>';
      allAssignments.push({
        item_name: row.item_name,
        qty: a.qty,
        unit: a.unit || row.unit,
        location: a.location,
        warehouse: a.warehouse,
        date: row.date,
        destination: row.destination,
        manager: row.manager,
        ref_lot: a.lot || ''
      });
    });
  });
  html += '</tbody></table></div>';
  if (hasError) {
    html += '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:10px;margin-top:10px;font-size:12px;color:#856404"><i class="fas fa-exclamation-triangle"></i> 일부 품목의 재고가 부족합니다. 재고 확인 후 다시 시도해주세요.</div>';
  }
  var validCount = allAssignments.length;
  html += '<div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;align-items:center">' +
    '<span style="font-size:13px;color:#555"><b>' + validCount + '건</b> 출고 등록 예정' + (hasError ? ' (일부 제외)' : '') + '</span>' +
    (validCount > 0
      ? '<button onclick="whBulkOutSubmitAll()" style="background:#e74c3c;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer"><i class="fas fa-save"></i> 전체 출고 등록 (' + validCount + '건)</button>'
      : '') +
    '<button onclick="document.getElementById(\'whBulkOutPreview\').style.display=\'none\'" style="background:#f0f0f0;color:#555;border:1px solid #ddd;border-radius:8px;padding:10px 16px;font-size:13px;cursor:pointer"><i class="fas fa-times"></i> 닫기</button>' +
    '</div>';
  previewEl._pendingData = allAssignments;
  previewEl.innerHTML = html;
  previewEl.style.display = 'block';
  previewEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function whBulkOutSubmitAll() {
  var previewEl = document.getElementById('whBulkOutPreview');
  if (!previewEl || !previewEl._pendingData || previewEl._pendingData.length === 0) {
    showToast('미리보기를 먼저 실행해주세요.', 'warning');
    return;
  }
  var assignments = previewEl._pendingData;
  var btn = previewEl.querySelector('button[onclick^="whBulkOutSubmitAll"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 등록 중...'; }
  var today = new Date().toISOString().split('T')[0].replace(/-/g,'').slice(2);
  var prefix = 'WH-OUT-' + today;
  var fresh = await apiGetAll('wh_outbound');
  var seqBase = fresh.filter(function(r){ return r.lot_no && r.lot_no.startsWith(prefix); }).length;
  // 제품마스터 캐시 보장
  var _bulkOutProducts = _whProductMasterCache || await whLoadProductMaster();

  var success = 0, fail = 0;
  for (var i = 0; i < assignments.length; i++) {
    var a = assignments[i];
    var seq = String(seqBase + i + 1).padStart(3, '0');
    var lotNo = prefix + '-' + seq;
    // qty_ea/qty_box/qty_pt 환산 계산
    var _boMatchP = _bulkOutProducts.find(function(p) { return (p.product_name||'').trim() === a.item_name; });
    var _boQpb = _boMatchP ? (parseInt(_boMatchP.qty_per_box) || 0) : 0;
    var _boBpp = _boMatchP ? (parseInt(_boMatchP.boxes_per_pallet) || 0) : 0;
    var _boBd = _whCalcBreakdown(a.qty, a.unit, _boQpb, _boBpp);
    try {
      var outData = {
        lot_no: lotNo,
        warehouse: a.warehouse,
        location: a.location,
        item_name: a.item_name,
        qty: a.qty,
        unit: a.unit,
        qty_ea: _boBd.qty_ea,
        qty_box: _boBd.qty_box,
        qty_pt: _boBd.qty_pt,
        outbound_date: a.date,
        destination: a.destination,
        manager: a.manager,
        ref_lot: a.ref_lot,
        memo: '일괄출고요청서'
      };
      await apiPost('wh_outbound', outData);
      // wh_outbound가 단일 진실 공급원이므로 logistics 중복 동기화 저장 안 함
      success++;
    } catch(err) {
      fail++;
    }
  }
  showToast('일괄 출고 완료: ' + success + '건 성공' + (fail > 0 ? ', ' + fail + '건 실패' : ''), success > 0 ? 'success' : 'error');
  whInvalidateMapCache();
  await whReloadAll();
  whRefreshOutLot();
  previewEl.style.display = 'none';
  previewEl._pendingData = null;
  whBulkOutClearAll();
  whRenderFifo();
}

function whInitBulkOutTable() {
  var tbody = document.getElementById('whBulkOutBody');
  if (tbody && tbody.children.length === 0) {
    _whBulkOutRowCount = 0;
    whBulkOutAddRow();
  }
}

// 일괄 출고 직접 등록 (미리보기 없이 바로 등록)
async function whBulkOutDirectSubmit() {
  var rows = _whBulkOutReadAll();
  if (rows.length === 0) {
    showToast('출고 요청 내역을 입력해주세요.', 'warning');
    return;
  }
  var allAssignments = [];
  var hasError = false;
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var result = whAutoAssignLocations(row.item_name, row.qty);
    if (result.assignments.length === 0) {
      showToast('"' + row.item_name + '" 재고가 없습니다. 미리보기로 확인해주세요.', 'warning');
      hasError = true;
      break;
    }
    if (result.remaining > 0) {
      showToast('"' + row.item_name + '" 재고 부족 (' + result.remaining + '개 부족). 미리보기로 확인해주세요.', 'warning');
      hasError = true;
      break;
    }
    result.assignments.forEach(function(a) {
      allAssignments.push({
        item_name: row.item_name,
        qty: a.qty,
        unit: a.unit || row.unit,
        location: a.location,
        warehouse: a.warehouse,
        date: row.date,
        destination: row.destination,
        manager: row.manager,
        ref_lot: a.lot || ''
      });
    });
  }
  if (hasError) return;
  if (!confirm('총 ' + allAssignments.length + '건을 출고 등록하시겠습니까?')) return;
  var btn = document.querySelector('button[onclick="whBulkOutDirectSubmit()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 등록 중...'; }
  var todayStr = new Date().toISOString().split('T')[0].replace(/-/g,'').slice(2);
  var prefix = 'WH-OUT-' + todayStr;
  var fresh = await apiGetAll('wh_outbound');
  var seqBase = fresh.filter(function(r){ return r.lot_no && r.lot_no.startsWith(prefix); }).length;
  // 제품마스터 캐시 보장
  var _bdProducts = _whProductMasterCache || await whLoadProductMaster();

  var success = 0, fail = 0;
  for (var i = 0; i < allAssignments.length; i++) {
    var a = allAssignments[i];
    var seq = String(seqBase + i + 1).padStart(3, '0');
    var lotNo = prefix + '-' + seq;
    // qty_ea/qty_box/qty_pt 환산 계산
    var _bdMatchP = _bdProducts.find(function(p) { return (p.product_name||'').trim() === a.item_name; });
    var _bdQpb = _bdMatchP ? (parseInt(_bdMatchP.qty_per_box) || 0) : 0;
    var _bdBpp = _bdMatchP ? (parseInt(_bdMatchP.boxes_per_pallet) || 0) : 0;
    var _bdBd = _whCalcBreakdown(a.qty, a.unit, _bdQpb, _bdBpp);
    try {
      var outData2 = {
        lot_no: lotNo,
        warehouse: a.warehouse,
        location: a.location,
        item_name: a.item_name,
        qty: a.qty,
        unit: a.unit,
        qty_ea: _bdBd.qty_ea,
        qty_box: _bdBd.qty_box,
        qty_pt: _bdBd.qty_pt,
        outbound_date: a.date,
        destination: a.destination,
        manager: a.manager,
        ref_lot: a.ref_lot,
        memo: '일괄출고요청서'
      };
      await apiPost('wh_outbound', outData2);
      // wh_outbound가 단일 진실 공급원이므로 logistics 중복 동기화 저장 안 함
      success++;
    } catch(err) {
      fail++;
    }
  }
  showToast('일괄 출고 완료: ' + success + '건 성공' + (fail > 0 ? ', ' + fail + '건 실패' : ''), success > 0 ? 'success' : 'error');
  whInvalidateMapCache();
  await whReloadAll();
  whRefreshOutLot();
  whBulkOutClearAll();
  whRenderFifo();
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> 출고 등록'; }
}

// ══════════════════════════════════════════════════════════════════
// 원격 QR 스캔 연결 (모바일 ↔ PC 실시간 연동)
// ══════════════════════════════════════════════════════════════════
var _remoteSessionId = null;
var _remoteScanListener = null;
var _remoteScanCount = 0;

function whOpenRemoteScanModal() {
  var modal = document.getElementById('remoteScanModal');
  if (!modal) return;
  modal.style.display = 'flex';
  // 이미 연결 중이면 연결 상태 복원
  if (_remoteSessionId) {
    document.getElementById('remoteScanSessionInput').value = _remoteSessionId;
    document.getElementById('remoteScanConnected').style.display = '';
    document.getElementById('btnDisconnectRemote').style.display = '';
    document.getElementById('remoteSessionDisplay').textContent = _remoteSessionId;
    document.getElementById('remoteScanReceived').textContent = _remoteScanCount + '건';
  }
}

function whCloseRemoteScanModal() {
  var modal = document.getElementById('remoteScanModal');
  if (modal) modal.style.display = 'none';
}

async function whConnectRemoteScan() {
  var sessionId = (document.getElementById('remoteScanSessionInput').value || '').trim();
  if (!sessionId || sessionId.length !== 4 || !/^\d{4}$/.test(sessionId)) {
    showToast('4자리 숫자 세션 ID를 입력해주세요', 'error');
    return;
  }
  // 기존 리스너 해제
  if (_remoteScanListener) {
    _remoteScanListener();
    _remoteScanListener = null;
  }
  _remoteSessionId = sessionId;
  _remoteScanCount = 0;
  document.getElementById('remoteScanConnected').style.display = '';
  document.getElementById('btnDisconnectRemote').style.display = '';
  document.getElementById('remoteSessionDisplay').textContent = sessionId;
  document.getElementById('remoteScanReceived').textContent = '0건';
  showToast('세션 ' + sessionId + ' 연결 대기 중...', 'success');

  try {
    var db = firebase.firestore();
    // 연결 시점 이후 스캔된 항목만 수신
    var connectedAt = new Date();
    _remoteScanListener = db.collection('qr_scan_queue')
      .where('session_id', '==', sessionId)
      .where('status', '==', 'pending')
      .onSnapshot(function(snapshot) {
        snapshot.docChanges().forEach(function(change) {
          if (change.type === 'added') {
            var data = change.doc.data();
            // 연결 이전 데이터 무시 (serverTimestamp 없을 수 있으므로 local 시간 비교)
            var scannedAt = data.scanned_at_local ? new Date(data.scanned_at_local) : null;
            if (scannedAt && scannedAt < connectedAt) return;
            // 폼에 자동 입력
            whApplyRemoteScan(data);
            // 처리 완료 표시
            change.doc.ref.update({ status: 'processed' });
            _remoteScanCount++;
            document.getElementById('remoteScanReceived').textContent = _remoteScanCount + '건';
          }
        });
      }, function(err) {
        showToast('원격 스캔 수신 오류: ' + err.message, 'error');
      });
  } catch(e) {
    showToast('연결 실패: ' + e.message, 'error');
  }
}

function whDisconnectRemoteScan() {
  if (_remoteScanListener) {
    _remoteScanListener();
    _remoteScanListener = null;
  }
  _remoteSessionId = null;
  _remoteScanCount = 0;
  document.getElementById('remoteScanConnected').style.display = 'none';
  document.getElementById('btnDisconnectRemote').style.display = 'none';
  document.getElementById('remoteScanSessionInput').value = '';
  showToast('원격 스캔 연결 해제됨', 'success');
}

function whApplyRemoteScan(data) {
  // 스캔된 데이터를 현재 활성 탭의 폼에 자동 입력
  var lotNo = data.lot_no || data.raw_value || '';
  var itemName = data.item_name || '';
  var location = data.location || '';
  var expiryDate = data.expiry_date || '';
  var qty = data.qty || '';
  var unit = data.unit || '';

  // 출고 탭이 활성화된 경우 출고 폼에 입력
  var outContent = document.getElementById('tabContent_wh_out');
  var inContent = document.getElementById('tabContent_wh_in');
  var outActive = outContent && outContent.classList.contains('active');
  var inActive = inContent && inContent.classList.contains('active');

  if (outActive) {
    // 출고 폼 자동 입력
    if (itemName) {
      var itemEl = document.getElementById('whout_item_name');
      if (itemEl) { itemEl.value = itemName; itemEl.dispatchEvent(new Event('input')); }
    }
    if (location) {
      var locEl = document.getElementById('whout_location');
      if (locEl) locEl.value = location;
    }
    if (lotNo) {
      var refEl = document.getElementById('whout_ref_lot');
      if (refEl) refEl.value = lotNo;
    }
    if (qty) {
      var qtyEl = document.getElementById('whout_qty');
      if (qtyEl) qtyEl.value = qty;
    }
    // FIFO 가이드 갱신
    if (itemName && typeof whRenderFifo === 'function') whRenderFifo(itemName);
    showToast('📱 스캔 수신: ' + (itemName || lotNo), 'success');
  } else if (inActive) {
    // 입고 폼 자동 입력
    if (itemName) {
      var inItemEl = document.getElementById('whin_item_name');
      if (inItemEl) { inItemEl.value = itemName; inItemEl.dispatchEvent(new Event('input')); }
    }
    if (location) {
      var inLocEl = document.getElementById('whin_location');
      if (inLocEl) inLocEl.value = location;
    }
    if (expiryDate) {
      var inExpEl = document.getElementById('whin_expiry_date');
      if (inExpEl) inExpEl.value = expiryDate;
    }
    if (qty) {
      var inQtyEl = document.getElementById('whin_qty');
      if (inQtyEl) inQtyEl.value = qty;
    }
    if (unit) {
      var inUnitEl = document.getElementById('whin_unit');
      if (inUnitEl) inUnitEl.value = unit;
    }
    showToast('📱 스캔 수신: ' + (itemName || lotNo), 'success');
  } else {
    // 탭이 활성화되지 않은 경우 스캔 입력창에 표시
    var scanInput = document.getElementById('whScanInput');
    if (scanInput) {
      scanInput.value = lotNo;
      whProcessScan(lotNo);
    }
    showToast('📱 스캔 수신: ' + (itemName || lotNo), 'success');
  }

  // 모달이 열려있으면 닫기
  whCloseRemoteScanModal();
}

// ── 창고 위치 이동 ────────────────────────────────
function whOpenMoveModal(locCode, itemName) {
  document.getElementById('whMoveFromLoc').value = locCode;
  document.getElementById('whMoveItemName').value = itemName;
  document.getElementById('whMoveItemDisplay').textContent = itemName;
  document.getElementById('whMoveFromDisplay').textContent = '현 위치: ' + locCode;
  document.getElementById('whMove_memo').value = '';

  // 목적지 창고 기본값: 현재 위치와 동일한 창고 유형
  var whType = locCode.startsWith('C') ? 'C' : 'W';
  var whSel = document.getElementById('whMove_warehouse');
  if (whSel) { whSel.value = whType; whBuildLocationSelect('whMove'); }

  var modal = document.getElementById('whMoveModal');
  if (modal) { modal.style.display = 'flex'; }
}

function whCloseMoveModal() {
  var modal = document.getElementById('whMoveModal');
  if (modal) { modal.style.display = 'none'; }
}

async function whSaveMove() {
  var fromLoc  = document.getElementById('whMoveFromLoc').value;
  var itemName = document.getElementById('whMoveItemName').value;
  var toLoc    = document.getElementById('whMove_location').value;
  var toWh     = document.getElementById('whMove_warehouse').value;
  var memo     = document.getElementById('whMove_memo').value;

  if (!toLoc) { showToast('이동할 위치를 선택해주세요.', 'warning'); return; }
  if (toLoc === fromLoc) { showToast('현재 위치와 동일합니다.', 'warning'); return; }

  // 해당 품목·위치의 입고 레코드를 모두 새 위치로 업데이트
  var targets = whInboundData.filter(function(r) {
    return r.location === fromLoc && (r.item_name || '미상') === itemName;
  });

  if (targets.length === 0) {
    showToast('이동할 입고 기록을 찾을 수 없습니다.', 'error');
    return;
  }

  try {
    for (var i = 0; i < targets.length; i++) {
      var rec = targets[i];
      var updated = Object.assign({}, rec, {
        warehouse: toWh,
        location: toLoc,
        memo: (rec.memo ? rec.memo + ' | ' : '') + '위치이동: ' + fromLoc + ' → ' + toLoc + (memo ? ' (' + memo + ')' : '')
      });
      var recId = updated.id;
      delete updated.id;
      await apiPut('wh_inbound', recId, updated);
    }
    showToast('이동 완료: ' + fromLoc + ' → ' + toLoc + ' (' + targets.length + '건)', 'success');
    whCloseMoveModal();
    whInvalidateMapCache();
    // _calledByUser 플래그 설정 → logistics 탭 자동 갱신 보장
    whLoadAll._calledByUser = true;
    await whReloadAll();
    whLoadAll._calledByUser = false;
    if (typeof loadLogisticsData === 'function') await loadLogisticsData();
  } catch(e) {
    showToast('이동 실패: ' + e.message, 'error');
  }
}

// ── 재고실사 품목명 자동완성 ──────────────────────────────────
async function whStItemFilter(query) {
  var dropdown = document.getElementById('whst_item_dropdown');
  if (!dropdown) return;
  var products = await whLoadProductMaster();
  var q = (query || '').trim().toLowerCase();
  var filtered = q ? products.filter(function(p) {
    return (p.product_name || '').toLowerCase().includes(q) ||
           (p.product_code || '').toLowerCase().includes(q);
  }) : products;
  if (filtered.length === 0) {
    dropdown.innerHTML = '<div style="padding:12px 14px;color:#aaa;font-size:13px">검색 결과 없음</div>';
    dropdown.style.display = 'block';
    return;
  }
  dropdown.innerHTML = filtered.slice(0, 30).map(function(p) {
    var typeBadge = '';
    var pt = p.product_type || '';
    if (pt.includes('수입')) typeBadge = '<span style="font-size:10px;background:#e8f4fd;color:#2980b9;padding:1px 6px;border-radius:8px;margin-left:6px">수입</span>';
    else if (pt.includes('OEM')) typeBadge = '<span style="font-size:10px;background:#fef9e7;color:#d68910;padding:1px 6px;border-radius:8px;margin-left:6px">OEM</span>';
    else if (pt.includes('자체')) typeBadge = '<span style="font-size:10px;background:#eafaf1;color:#1e8449;padding:1px 6px;border-radius:8px;margin-left:6px">자체</span>';
    var codeTxt = p.product_code ? '<span style="font-size:10px;color:#aaa;margin-left:4px">[' + p.product_code + ']</span>' : '';
    var nameAttr = (p.product_name || '').replace(/"/g, '&quot;');
    return '<div onclick="whStSelectItem(this)" data-name="' + nameAttr + '"' +
      ' style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;gap:4px"' +
      ' onmouseover="this.style.background=\'#f0fff4\'" onmouseout="this.style.background=\'#fff\'">' +
      '<span style="font-weight:600;color:#222">' + (p.product_name || '-') + '</span>' +
      codeTxt + typeBadge + '</div>';
  }).join('');
  dropdown.style.display = 'block';
}

function whStSelectItem(el) {
  var name = el ? el.getAttribute('data-name') : '';
  var nameEl = document.getElementById('whst_item_name');
  if (nameEl) nameEl.value = name;
  var dropdown = document.getElementById('whst_item_dropdown');
  if (dropdown) dropdown.style.display = 'none';
  // 전산 수량 자동 계산 (재고실사 위치 선택 후 자동 계산)
  if (typeof whCalcStocktakeDiff === 'function') whCalcStocktakeDiff();
}

// ── 입고 수정 모달 품목명 자동완성 ────────────────────────────
async function whInEditItemFilter(query) {
  var dropdown = document.getElementById('whInEdit_item_dropdown');
  if (!dropdown) return;
  var products = await whLoadProductMaster();
  var q = (query || '').trim().toLowerCase();
  var filtered = q ? products.filter(function(p) {
    return (p.product_name || '').toLowerCase().includes(q) ||
           (p.product_code || '').toLowerCase().includes(q);
  }) : products;
  if (filtered.length === 0) {
    dropdown.innerHTML = '<div style="padding:12px 14px;color:#aaa;font-size:13px">검색 결과 없음</div>';
    dropdown.style.display = 'block';
    return;
  }
  dropdown.innerHTML = filtered.slice(0, 30).map(function(p) {
    var typeBadge = '';
    var pt = p.product_type || '';
    if (pt.includes('수입')) typeBadge = '<span style="font-size:10px;background:#e8f4fd;color:#2980b9;padding:1px 6px;border-radius:8px;margin-left:6px">수입</span>';
    else if (pt.includes('OEM')) typeBadge = '<span style="font-size:10px;background:#fef9e7;color:#d68910;padding:1px 6px;border-radius:8px;margin-left:6px">OEM</span>';
    else if (pt.includes('자체')) typeBadge = '<span style="font-size:10px;background:#eafaf1;color:#1e8449;padding:1px 6px;border-radius:8px;margin-left:6px">자체</span>';
    var codeTxt = p.product_code ? '<span style="font-size:10px;color:#aaa;margin-left:4px">[' + p.product_code + ']</span>' : '';
    var nameAttr = (p.product_name || '').replace(/"/g, '&quot;');
    var typeAttr = (p.product_type || '').replace(/"/g, '&quot;');
    return '<div onclick="whInEditSelectItem(this)" data-name="' + nameAttr + '" data-type="' + typeAttr + '"' +
      ' style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;gap:4px"' +
      ' onmouseover="this.style.background=\'#f0fff4\'" onmouseout="this.style.background=\'#fff\'">' +
      '<span style="font-weight:600;color:#222">' + (p.product_name || '-') + '</span>' +
      codeTxt + typeBadge + '</div>';
  }).join('');
  dropdown.style.display = 'block';
}

function whInEditSelectItem(el) {
  var name = el ? el.getAttribute('data-name') : '';
  var type = el ? el.getAttribute('data-type') : '';
  var nameEl = document.getElementById('whInEdit_item_name');
  if (nameEl) nameEl.value = name;
  // 입고유형 자동 설정
  var typeEl = document.getElementById('whInEdit_type');
  if (typeEl && type) {
    var mapped = _whTypeMap[type] || '';
    if (mapped) {
      for (var i = 0; i < typeEl.options.length; i++) {
        if (typeEl.options[i].value === mapped) { typeEl.selectedIndex = i; break; }
      }
    }
  }
  var dropdown = document.getElementById('whInEdit_item_dropdown');
  if (dropdown) dropdown.style.display = 'none';
}

// ── 출고 위치 선택 시 재고 상세 표시 ──────────────────────────
function whOutLocationChange() {
  var locEl = document.getElementById('whout_location');
  var stockDiv = document.getElementById('whout_location_stock');
  if (!locEl || !stockDiv) return;
  var loc = locEl.value;
  if (!loc) {
    stockDiv.style.display = 'none';
    return;
  }
  var stockMap = whCalcStock();
  var items = stockMap[loc] || {};
  var hasStock = Object.values(items).some(function(v) { return (Number(v.qty) || 0) > 0; });
  if (!hasStock) {
    stockDiv.style.display = 'none';
    return;
  }
  var lines = Object.entries(items)
    .filter(function(e) { return (Number(e[1].qty) || 0) > 0; })
    .map(function(e) {
      var itemName = e[0];
      var info = e[1];
      var expiryTxt = info.expiry ? ' | 소비기한: ' + info.expiry : '';
      return '<span style="font-weight:600">' + itemName + '</span> ' + info.qty + ' ' + (info.unit || '') + expiryTxt;
    });
  stockDiv.style.display = 'block';
  stockDiv.innerHTML = '<i class="fas fa-boxes" style="margin-right:4px"></i><b>이 위치 재고:</b> ' + lines.join(' &nbsp;/&nbsp; ');
}

// ── 재고실사 현황 테이블 인라인 위치이동 ──────────────────────
// 위치코드 셀 클릭 시 팝오버로 빈 위치 목록 표시 → 선택 즉시 이동
function whInlineMove(fromLoc, itemName) {
  // 기존 팝오버 제거
  var existing = document.getElementById('whInlineMovePopover');
  if (existing) { existing.remove(); }

  // 빈 위치 목록 계산
  var stockMap = whCalcStock();
  var wh = fromLoc.charAt(0); // 'C' or 'W'
  var allLocs = wh === 'C' ? COLD_LOCATIONS : WARM_LOCATIONS;
  var emptyLocs = allLocs.filter(function(l) {
    if (l.code === fromLoc) return false;
    var items = stockMap[l.code] || {};
    return !Object.values(items).some(function(v) { return (Number(v.qty) || 0) > 0; });
  });

  // 팝오버 생성
  var popover = document.createElement('div');
  popover.id = 'whInlineMovePopover';
  popover.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.18);padding:20px;min-width:320px;max-width:420px;max-height:80vh;overflow-y:auto';

  var header = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
    '<div><b style="font-size:15px">위치 이동</b><br>' +
    '<span style="font-size:12px;color:#888">' + fromLoc + ' → 선택한 위치로 이동</span><br>' +
    '<span style="font-size:12px;color:#2980b9;font-weight:600">' + itemName + '</span></div>' +
    '<button onclick="document.getElementById(\'whInlineMovePopover\').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:#aaa;padding:4px">✕</button>' +
    '</div>';

  var overlay = document.createElement('div');
  overlay.id = 'whInlineMoveOverlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3);z-index:9998';
  overlay.onclick = function() {
    var p = document.getElementById('whInlineMovePopover');
    var o = document.getElementById('whInlineMoveOverlay');
    if (p) p.remove();
    if (o) o.remove();
  };

  if (emptyLocs.length === 0) {
    popover.innerHTML = header + '<div style="text-align:center;color:#e74c3c;padding:20px">빈 위치가 없습니다.</div>';
  } else {
    var listHtml = '<div style="font-size:12px;color:#888;margin-bottom:8px">빈 위치 ' + emptyLocs.length + '개 — 클릭하면 즉시 이동됩니다</div>';
    listHtml += emptyLocs.map(function(l) {
      var locAttr = l.code.replace(/'/g, "\\'");
      var itemAttr = itemName.replace(/'/g, "\\'");
      return '<div onclick="whDoInlineMove(\'' + locAttr + '\', \'' + locAttr.charAt(0) + '\', \'' + fromLoc.replace(/'/g,"\\'") + '\', \'' + itemAttr + '\')"' +
        ' style="padding:8px 12px;cursor:pointer;border-radius:6px;border:1px solid #e0e0e0;margin-bottom:6px;font-size:13px;display:flex;align-items:center;gap:8px"' +
        ' onmouseover="this.style.background=\'#e8f4fd\';this.style.borderColor=\'#2980b9\'"' +
        ' onmouseout="this.style.background=\'#fff\';this.style.borderColor=\'#e0e0e0\'">' +
        '<code style="font-size:12px;background:#f5f5f5;padding:2px 6px;border-radius:4px">' + l.code + '</code>' +
        '<span style="color:#555">' + l.level + '단 ' + l.slot + '번파레트</span>' +
        '</div>';
    }).join('');
    popover.innerHTML = header + listHtml;
  }

  document.body.appendChild(overlay);
  document.body.appendChild(popover);
}

async function whDoInlineMove(toLoc, toWh, fromLoc, itemName) {
  // 팝오버 닫기
  var p = document.getElementById('whInlineMovePopover');
  var o = document.getElementById('whInlineMoveOverlay');
  if (p) p.remove();
  if (o) o.remove();

  if (!toLoc || toLoc === fromLoc) { showToast('이동할 위치를 선택해주세요.', 'warning'); return; }

  var targets = whInboundData.filter(function(r) {
    return r.location === fromLoc && (r.item_name || '미상') === itemName;
  });

  if (targets.length === 0) {
    showToast('이동할 입고 기록을 찾을 수 없습니다.', 'error');
    return;
  }

  try {
    for (var i = 0; i < targets.length; i++) {
      var rec = targets[i];
      var updated = Object.assign({}, rec, {
        warehouse: toWh,
        location: toLoc,
        memo: (rec.memo ? rec.memo + ' | ' : '') + '위치이동: ' + fromLoc + ' → ' + toLoc
      });
      var recId = updated.id;
      delete updated.id;
      await apiPut('wh_inbound', recId, updated);
    }
    showToast('이동 완료: ' + fromLoc + ' → ' + toLoc + ' (' + targets.length + '건)', 'success');
    whInvalidateMapCache();
    whLoadAll._calledByUser = true;
    await whReloadAll();
    whLoadAll._calledByUser = false;
    if (typeof loadLogisticsData === 'function') await loadLogisticsData();
  } catch(e) {
    showToast('이동 실패: ' + e.message, 'error');
  }
}

// ── FIFO 검색 품목명 자동완성 ──────────────────────────────────
async function whFifoItemFilter(query) {
  var dropdown = document.getElementById('whFifoDropdown');
  if (!dropdown) { whRenderFifo(); return; }
  var q = (query || '').trim();
  // 드롭다운 닫기 (빈 입력)
  if (!q) {
    dropdown.style.display = 'none';
    whRenderFifo();
    return;
  }
  var products = await whLoadProductMaster();
  var qLow = q.toLowerCase();
  var filtered = products.filter(function(p) {
    return (p.product_name || '').toLowerCase().indexOf(qLow) !== -1;
  });
  if (filtered.length === 0) {
    dropdown.style.display = 'none';
    whRenderFifo();
    return;
  }
  dropdown.innerHTML = filtered.slice(0, 30).map(function(p) {
    var nameAttr = (p.product_name || '').replace(/"/g, '&quot;');
    var nameDisplay = (p.product_name || '').replace(
      new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      function(m) { return '<b style="color:#856404">' + m + '</b>'; }
    );
    return '<div onclick="whFifoSelectItem(this)" data-name="' + nameAttr + '"' +
      ' style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid #fff3cd"' +
      ' onmouseover="this.style.background=\'#fff8e1\'" onmouseout="this.style.background=\'#fff\'">' +
      nameDisplay + '</div>';
  }).join('');
  dropdown.style.display = 'block';
  // 외부 클릭 시 닫기
  document.addEventListener('click', function closeFifoDropdown(e) {
    if (!dropdown.contains(e.target) && e.target.id !== 'whFifoSearch') {
      dropdown.style.display = 'none';
      document.removeEventListener('click', closeFifoDropdown);
    }
  });
}

function whFifoSelectItem(el) {
  var name = el ? el.getAttribute('data-name') : '';
  var searchEl = document.getElementById('whFifoSearch');
  if (searchEl) searchEl.value = name;
  var dropdown = document.getElementById('whFifoDropdown');
  if (dropdown) dropdown.style.display = 'none';
  whRenderFifo();
}

// ── 입고 위치 선택 시 현재고 정보 표시 ──────────────────────────
function whInLocationChange() {
  var locEl = document.getElementById('whin_location');
  var infoEl = document.getElementById('whin_location_stock');
  if (!locEl || !infoEl) return;
  var locCode = locEl.value;
  var itemName = (document.getElementById('whin_item_name') || {}).value || '';
  itemName = itemName.trim();
  if (!locCode) { infoEl.style.display = 'none'; return; }
  var stockMap = whCalcStock();
  var items = stockMap[locCode] || {};
  var entries = Object.entries(items).filter(function(e) { return (Number(e[1].qty) || 0) > 0; });
  if (entries.length === 0) {
    infoEl.style.display = 'block';
    infoEl.style.background = '#f0f8ff';
    infoEl.style.borderColor = '#90caf9';
    infoEl.style.color = '#1565c0';
    infoEl.innerHTML = '<i class="fas fa-info-circle"></i> 빈 위치입니다. 새 재고가 등록됩니다.';
    return;
  }
  var hasSame = itemName && items[itemName] && (Number(items[itemName].qty) || 0) > 0;
  if (hasSame) {
    infoEl.style.display = 'block';
    infoEl.style.background = '#e8f5e9';
    infoEl.style.borderColor = '#a5d6a7';
    infoEl.style.color = '#2e7d32';
    infoEl.innerHTML = '<i class="fas fa-check-circle"></i> <b>' + itemName + '</b> 현재고 <b>' + items[itemName].qty + ' ' + (items[itemName].unit || '') + '</b> — 이 위치에 합산 입고됩니다.';
  } else {
    infoEl.style.display = 'block';
    infoEl.style.background = '#fff8e1';
    infoEl.style.borderColor = '#ffe082';
    infoEl.style.color = '#856404';
    var summary = entries.map(function(e) { return e[0] + ' ' + e[1].qty + (e[1].unit ? ' ' + e[1].unit : ''); }).join(' / ');
    infoEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> 이 위치에 다른 제품이 있습니다: ' + summary;
  }
}

// ── 출고 수정 모달 ──────────────────────────────────────────────
function whOpenEditOutModal(id) {
  var r = whOutboundData.find(function(d) { return d.id === id; });
  if (!r) { showToast('출고 데이터를 찾을 수 없습니다.', 'error'); return; }

  document.getElementById('whOutEditId').value = id;
  document.getElementById('whOutEdit_date').value = r.outbound_date || '';
  document.getElementById('whOutEdit_item_name').value = r.item_name || '';
  document.getElementById('whOutEdit_qty').value = r.qty || '';
  document.getElementById('whOutEdit_manager').value = r.manager || '';
  document.getElementById('whOutEdit_destination').value = r.destination || '';
  document.getElementById('whOutEdit_notes').value = r.notes || '';

  // 창고/위치 설정
  var whEl = document.getElementById('whOutEdit_warehouse');
  if (whEl) {
    whEl.value = r.warehouse || (r.location && r.location.startsWith('C') ? 'C' : 'W');
    whBuildLocationSelect('whOutEdit');
  }
  setTimeout(function() {
    var locEl = document.getElementById('whOutEdit_location');
    if (locEl) locEl.value = r.location || '';
  }, 50);

  // 단위 설정
  var unitEl = document.getElementById('whOutEdit_unit');
  if (unitEl) unitEl.value = r.unit || 'ea';

  var modal = document.getElementById('whOutEditModal');
  if (modal) { modal.style.display = 'flex'; }
}

function whCloseEditOutModal() {
  var modal = document.getElementById('whOutEditModal');
  if (modal) modal.style.display = 'none';
}

async function whSaveOutEdit() {
  var id = document.getElementById('whOutEditId').value;
  if (!id) return;

  var qty = parseInt(document.getElementById('whOutEdit_qty').value) || 0;
  if (qty <= 0) { showToast('수량을 올바르게 입력해 주세요.', 'error'); return; }

  var unit = document.getElementById('whOutEdit_unit').value || 'ea';
  var itemName = document.getElementById('whOutEdit_item_name').value.trim();

  // ea 환산
  var products = _whProductMasterCache || [];
  var matchProduct = products.find(function(p) { return (p.product_name||'').trim() === itemName; });
  var qpb = matchProduct ? (parseInt(matchProduct.qty_per_box) || 0) : 0;
  var bpp = matchProduct ? (parseInt(matchProduct.boxes_per_pallet) || 0) : 0;
  var breakdown = _whCalcBreakdown(qty, unit, qpb, bpp);

  var updateData = {
    outbound_date: document.getElementById('whOutEdit_date').value,
    warehouse: document.getElementById('whOutEdit_warehouse').value,
    location: document.getElementById('whOutEdit_location').value,
    item_name: itemName,
    qty: qty,
    unit: unit,
    qty_ea: breakdown.qty_ea,
    qty_box: breakdown.qty_box,
    qty_pt: breakdown.qty_pt,
    manager: document.getElementById('whOutEdit_manager').value.trim(),
    destination: document.getElementById('whOutEdit_destination').value.trim(),
    notes: document.getElementById('whOutEdit_notes').value.trim()
  };

  try {
    await apiPatch('wh_outbound', id, updateData);
    showToast('출고 수정 완료', 'success');
    whCloseEditOutModal();
    whInvalidateMapCache();
    await whReloadAll();
  } catch(e) {
    showToast('수정 실패: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════
// 출고관리 엑셀 양식 다운로드 & 업로드
// ══════════════════════════════════════════════════

// ── 출고 엑셀 양식 다운로드 ──────────────────────
function whOutDownloadTemplate() {
  if (typeof XLSX === 'undefined') {
    showToast('엑셀 라이브러리 로딩 중입니다. 잠시 후 다시 시도해주세요.', 'warning');
    return;
  }

  var headers = ['품목명 *', '수량 *', '단위(pallet/box/ea/kg)', '출고일(YYYY-MM-DD) *', '출고처', '담당자 *', '비고'];
  var examples = [
    ['찹쌀 누룽지스낵 23g*18입', 10, 'box', new Date().toISOString().split('T')[0], '쿠팡', '홍길동', ''],
    ['타미티미 커피콩 캔디 100g', 5, 'box', new Date().toISOString().split('T')[0], '네이버스토어', '김철수', '박람회 출고'],
    ['꿀이구마 한입 미니약과', 2, 'pallet', new Date().toISOString().split('T')[0], '오프라인매장', '이영희', '']
  ];

  var wb = XLSX.utils.book_new();
  var wsData = [headers].concat(examples);
  var ws = XLSX.utils.aoa_to_sheet(wsData);

  // 열 너비
  ws['!cols'] = [
    {wch:30}, {wch:8}, {wch:22}, {wch:20}, {wch:16}, {wch:12}, {wch:20}
  ];

  // 헤더 스타일 (빨간 계열)
  var range = XLSX.utils.decode_range(ws['!ref']);
  for (var c = range.s.c; c <= range.e.c; c++) {
    var cellAddr = XLSX.utils.encode_cell({r: 0, c: c});
    if (!ws[cellAddr]) continue;
    ws[cellAddr].s = {
      fill: { fgColor: { rgb: 'FDEDEC' } },
      font: { bold: true },
      alignment: { horizontal: 'center' }
    };
  }

  XLSX.utils.book_append_sheet(wb, ws, '창고출고양식');

  // 제품명 목록 시트
  var prodHeaders = ['제품명', '제품코드'];
  var prodData = [prodHeaders];
  if (_whProductMasterCache) {
    _whProductMasterCache.forEach(function(p) {
      prodData.push([p.product_name || p.name || '', p.product_code || p.code || '']);
    });
  }
  var wsProd = XLSX.utils.aoa_to_sheet(prodData);
  wsProd['!cols'] = [{wch:30}, {wch:24}];
  XLSX.utils.book_append_sheet(wb, wsProd, '제품명목록');

  // 단위 안내 시트
  var unitData = [
    ['단위', '설명'],
    ['pallet', '파레트 단위'],
    ['box', '박스 단위'],
    ['ea', '낱개 단위'],
    ['kg', '무게(kg) 단위']
  ];
  var wsUnit = XLSX.utils.aoa_to_sheet(unitData);
  wsUnit['!cols'] = [{wch:12}, {wch:20}];
  XLSX.utils.book_append_sheet(wb, wsUnit, '단위안내');

  XLSX.writeFile(wb, '창고출고양식_' + new Date().toISOString().split('T')[0] + '.xlsx');
  showToast('출고 엑셀 양식이 다운로드되었습니다.', 'success');
}

// ── 출고 엑셀 드롭 처리 ──────────────────────────
function whOutHandleDrop(event) {
  event.preventDefault();
  var zone = document.getElementById('whOutDropZone');
  if (zone) zone.classList.remove('dragover');
  var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) whOutHandleFile(file);
}

// ── 출고 엑셀 파일 파싱 및 테이블 채우기 ─────────
function whOutHandleFile(file) {
  if (!file) return;
  if (typeof XLSX === 'undefined') {
    showToast('엑셀 라이브러리 로딩 중입니다. 잠시 후 다시 시도해주세요.', 'warning');
    return;
  }

  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = new Uint8Array(e.target.result);
      var wb = XLSX.read(data, { type: 'array', cellDates: true });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      if (rows.length < 2) {
        showToast('데이터가 없습니다. 양식을 확인해주세요.', 'warning');
        return;
      }

      // 헤더 제거 후 빈 행 필터
      var dataRows = rows.slice(1).filter(function(r) {
        return r.some(function(c) { return c !== '' && c !== null && c !== undefined; });
      });

      if (dataRows.length === 0) {
        showToast('입력된 데이터가 없습니다.', 'warning');
        return;
      }

      // 날짜 포맷 헬퍼
      function fmtDate(v) {
        if (!v) return '';
        if (v instanceof Date) {
          var y = v.getFullYear();
          var m = String(v.getMonth() + 1).padStart(2, '0');
          var d2 = String(v.getDate()).padStart(2, '0');
          return y + '-' + m + '-' + d2;
        }
        var s = String(v).trim();
        if (/^\d{8}$/.test(s)) return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
        return s;
      }

      // 기존 일괄출고 테이블 초기화
      var tbody = document.getElementById('whBulkOutBody');
      if (tbody) tbody.innerHTML = '';
      if (typeof _whBulkOutRowCount !== 'undefined') _whBulkOutRowCount = 0;

      var added = 0;
      dataRows.forEach(function(r) {
        // 컬럼 순서: A=품목명(0), B=수량(1), C=단위(2), D=출고일(3), E=출고처(4), F=담당자(5), G=비고(6)
        var d = {
          item_name:   String(r[0] || '').trim(),
          qty:         Number(r[1]) || '',
          unit:        String(r[2] || 'box').trim(),
          date:        fmtDate(r[3]),
          destination: String(r[4] || '').trim(),
          manager:     String(r[5] || '').trim()
        };
        if (!d.item_name) return; // 품목명 없는 행 스킵
        if (typeof whBulkOutAddRow === 'function') whBulkOutAddRow(d);
        added++;
      });

      showToast(added + '건의 출고 데이터를 불러왔습니다. 확인 후 [출고 등록]을 눌러주세요.', 'success');

      // 드롭존 텍스트 업데이트
      var zone = document.getElementById('whOutDropZone');
      if (zone) {
        zone.style.background = '#eafaf1';
        zone.style.borderColor = '#27ae60';
        zone.style.color = '#27ae60';
        zone.querySelector('div').textContent = '✅ ' + added + '건 불러오기 완료 — 다시 업로드하려면 클릭';
      }
    } catch(err) {
      showToast('파일 읽기 오류: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);

  // input 초기화 (같은 파일 재업로드 가능)
  var fi = document.getElementById('whOutFileInput');
  if (fi) fi.value = '';
}


// =====================================================
// ── 전체 위치코드 실사 모드 ──────────────────────────
// 관리자 허가 체계 + 전체 위치코드 그리드 + 드래그 이동 + 실재고 수정
// =====================================================

// 전체 실사 모드 상태
var _whFullStocktakeUnlocked = false;
var _whFullStocktakeWarehouse = 'C'; // 현재 선택된 창고 ('C' or 'W')
var _whFullStocktakeDragSrc = null; // 드래그 소스 카드 정보 { locCode, itemName }

// ── 관리자 허가 요청 모달 ──────────────────────────────────
function whRequestFullStocktakeApproval() {
  var user = getCurrentUser();
  // 이미 관리자로 로그인된 경우 즉시 허가
  if (user && user.role === 'admin') {
    whGrantFullStocktake();
    return;
  }

  // 관리자 비밀번호 입력 모달
  var modalId = 'whFullApproveModal';
  var existing = document.getElementById(modalId);
  if (existing) existing.remove();

  var m = document.createElement('div');
  m.id = modalId;
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center';
  m.innerHTML =
    '<div style="background:#fff;border-radius:14px;width:90%;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,0.2);overflow:hidden">' +
      '<div style="background:linear-gradient(135deg,#8e44ad,#6c3483);padding:16px 20px;display:flex;align-items:center;justify-content:space-between">' +
        '<h3 style="color:#fff;font-size:15px;margin:0"><i class="fas fa-key"></i> 관리자 허가</h3>' +
        '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;opacity:0.7">&times;</button>' +
      '</div>' +
      '<div style="padding:20px">' +
        '<div style="font-size:13px;color:#555;margin-bottom:16px">전체 위치코드 실사 모드를 활성화하려면<br>관리자 비밀번호를 입력하세요.</div>' +
        '<div style="margin-bottom:12px">' +
          '<label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:5px">관리자 이메일</label>' +
          '<input type="email" id="whApproveEmail" placeholder="admin@lifeculture.co.kr" value="admin@lifeculture.co.kr" style="width:100%;padding:9px 12px;border:1.5px solid #ddd;border-radius:8px;font-size:13px;box-sizing:border-box" />' +
        '</div>' +
        '<div style="margin-bottom:16px">' +
          '<label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:5px">관리자 비밀번호 <span style="color:#e74c3c">*</span></label>' +
          '<input type="password" id="whApprovePassword" placeholder="비밀번호 입력" style="width:100%;padding:9px 12px;border:1.5px solid #ddd;border-radius:8px;font-size:13px;box-sizing:border-box" onkeydown="if(event.key===\'Enter\')whVerifyAdminApproval()" autofocus />' +
        '</div>' +
        '<div id="whApproveError" style="display:none;color:#e74c3c;font-size:12px;margin-bottom:10px;padding:8px;background:#fdedec;border-radius:6px"></div>' +
        '<div style="display:flex;gap:8px">' +
          '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="flex:1;padding:10px;background:#f8f9fa;color:#555;border:1px solid #ddd;border-radius:8px;cursor:pointer;font-size:13px">취소</button>' +
          '<button onclick="whVerifyAdminApproval()" style="flex:1;padding:10px;background:#8e44ad;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700"><i class="fas fa-unlock"></i> 허가</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(m);
  setTimeout(function() {
    var pw = document.getElementById('whApprovePassword');
    if (pw) pw.focus();
  }, 100);
}

function whVerifyAdminApproval() {
  var emailEl = document.getElementById('whApproveEmail');
  var pwEl = document.getElementById('whApprovePassword');
  var errEl = document.getElementById('whApproveError');
  if (!pwEl) return;

  var email = (emailEl ? emailEl.value : 'admin@lifeculture.co.kr').trim();
  var password = pwEl.value;

  // localStorage에서 사용자 목록 조회
  var USERS_KEY = 'lc_users';
  var users = [];
  try { users = JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); } catch(e) {}

  // DEFAULT_USERS fallback
  if (users.length === 0 && typeof DEFAULT_USERS !== 'undefined') {
    users = DEFAULT_USERS;
  }

  var adminUser = users.find(function(u) {
    return u.email.toLowerCase() === email.toLowerCase() && u.password === password && u.role === 'admin' && u.active;
  });

  if (!adminUser) {
    if (errEl) {
      errEl.textContent = '관리자 이메일 또는 비밀번호가 올바르지 않습니다.';
      errEl.style.display = 'block';
    }
    if (pwEl) { pwEl.value = ''; pwEl.focus(); }
    return;
  }

  // 허가 성공
  var modal = document.getElementById('whFullApproveModal');
  if (modal) modal.remove();
  whGrantFullStocktake();
}

function whGrantFullStocktake() {
  _whFullStocktakeUnlocked = true;
  // UI 업데이트
  var statusEl = document.getElementById('whFullStocktakeStatus');
  if (statusEl) {
    statusEl.innerHTML = '<i class="fas fa-unlock" style="color:#2ecc71"></i> <span style="color:#2ecc71">허가됨 — 실사 모드 활성</span>';
  }
  var approveBtn = document.getElementById('whFullStocktakeApproveBtn');
  if (approveBtn) approveBtn.style.display = 'none';
  var saveBtn = document.getElementById('whFullStocktakeSaveBtn');
  if (saveBtn) saveBtn.style.display = '';
  var lockBtn = document.getElementById('whFullStocktakeLockBtn');
  if (lockBtn) lockBtn.style.display = '';

  // 잠금 오버레이 숨기고 그리드 표시
  var overlay = document.getElementById('whFullStocktakeLockOverlay');
  if (overlay) overlay.style.display = 'none';
  var grid = document.getElementById('whFullStocktakeGrid');
  if (grid) grid.style.display = '';

  // 오늘 날짜 설정
  var dateEl = document.getElementById('whFullStocktakeDate');
  if (dateEl && !dateEl.value) {
    dateEl.value = new Date().toISOString().split('T')[0];
  }

  // 그리드 렌더링
  whRenderFullStocktakeGrid();
  showToast('전체 위치코드 실사 모드가 활성화되었습니다.', 'success');
}

function whLockFullStocktake() {
  if (!confirm('실사 모드를 잠금하시겠습니까?\n저장하지 않은 수정 내용은 사라집니다.')) return;
  _whFullStocktakeUnlocked = false;
  var statusEl = document.getElementById('whFullStocktakeStatus');
  if (statusEl) statusEl.innerHTML = '<i class="fas fa-lock"></i> 관리자 허가 필요';
  var approveBtn = document.getElementById('whFullStocktakeApproveBtn');
  if (approveBtn) approveBtn.style.display = '';
  var saveBtn = document.getElementById('whFullStocktakeSaveBtn');
  if (saveBtn) saveBtn.style.display = 'none';
  var lockBtn = document.getElementById('whFullStocktakeLockBtn');
  if (lockBtn) lockBtn.style.display = 'none';
  var overlay = document.getElementById('whFullStocktakeLockOverlay');
  if (overlay) overlay.style.display = '';
  var grid = document.getElementById('whFullStocktakeGrid');
  if (grid) grid.style.display = 'none';
}

// ── 창고 선택 ──────────────────────────────────────────
function whFullStocktakeSetWarehouse(wh) {
  _whFullStocktakeWarehouse = wh;
  var btnC = document.getElementById('whFullWh_C');
  var btnW = document.getElementById('whFullWh_W');
  if (btnC) {
    btnC.style.borderColor = wh === 'C' ? '#8e44ad' : '#ddd';
    btnC.style.color = wh === 'C' ? '#8e44ad' : '#555';
    btnC.style.background = wh === 'C' ? '#f5eef8' : '#fff';
  }
  if (btnW) {
    btnW.style.borderColor = wh === 'W' ? '#8e44ad' : '#ddd';
    btnW.style.color = wh === 'W' ? '#8e44ad' : '#555';
    btnW.style.background = wh === 'W' ? '#f5eef8' : '#fff';
  }
  if (_whFullStocktakeUnlocked) whRenderFullStocktakeGrid();
}

// ── 전체 위치코드 그리드 렌더링 ──────────────────────────
function whRenderFullStocktakeGrid() {
  var inner = document.getElementById('whFullStocktakeGridInner');
  var emptyEl = document.getElementById('whFullStocktakeEmpty');
  if (!inner) return;
  var stockMap = whCalcStock();
  var locs = _whFullStocktakeWarehouse === 'C' ? COLD_LOCATIONS : WARM_LOCATIONS;
  var prefix = _whFullStocktakeWarehouse === 'C' ? 'C' : 'W';
  inner.innerHTML = '';
  // ── 컨테이너를 flex column으로 변경 (구역별 가로 한 줄) ──
  inner.style.cssText = 'display:flex;flex-direction:column;gap:6px';

  // 구역별 그룹화: zoneKey 기준
  var zoneMap = {};
  var zoneOrder = [];
  locs.forEach(function(l) {
    if (!zoneMap[l.zoneKey]) { zoneMap[l.zoneKey] = []; zoneOrder.push(l.zoneKey); }
    zoneMap[l.zoneKey].push(l);
  });

  zoneOrder.forEach(function(zoneKey) {
    var zoneLocs = zoneMap[zoneKey];
    // 구역 라벨 (A1구역 등)
    var zoneLabel = document.createElement('div');
    zoneLabel.className = 'wh-full-st-zone-label';
    zoneLabel.dataset.zoneKey = zoneKey;
    var hasAnyStock = zoneLocs.some(function(l) {
      var items = stockMap[l.code] || {};
      return Object.values(items).some(function(v) { return (Number(v.qty) || 0) > 0; });
    });
    zoneLabel.style.cssText = 'font-size:11px;font-weight:700;color:#666;padding:8px 4px 2px;border-bottom:2px solid #d0d0d0;margin-top:4px;letter-spacing:0.5px';
    zoneLabel.textContent = prefix + '-' + zoneKey + ' 구역 (' + zoneLocs.length + '파레트)';

    // 구역 내 카드들을 가로 한 줄로 배치하는 행 컨테이너
    var rowWrap = document.createElement('div');
    rowWrap.className = 'wh-full-st-zone-row';
    rowWrap.dataset.zoneKey = zoneKey;
    rowWrap.style.cssText = 'display:flex;flex-wrap:nowrap;gap:8px;overflow-x:auto;overflow-y:visible;padding:4px 0 8px;align-items:flex-start;width:100%;box-sizing:border-box;-webkit-overflow-scrolling:touch';

    // 단(level) 순서대로 카드 배치
    var sortedLocs = zoneLocs.slice().sort(function(a, b) {
      if (a.level !== b.level) return a.level - b.level;
      return a.slot - b.slot;
    });
    sortedLocs.forEach(function(l) {
      var card = whCreateFullStocktakeCard(l, stockMap);
      card.style.cssText += ';flex:0 0 200px;min-width:180px;max-width:220px;box-sizing:border-box';
      rowWrap.appendChild(card);
    });

    inner.appendChild(zoneLabel);
    inner.appendChild(rowWrap);
  });
  whFilterFullStocktakeGrid();
}

// ── 위치 카드 생성 ──────────────────────────────────────
function whCreateFullStocktakeCard(locObj, stockMap) {
  var locCode = locObj.code;
  var items = stockMap[locCode] || {};
  var hasStock = Object.values(items).some(function(v) { return (Number(v.qty) || 0) > 0; });
  var card = document.createElement('div');
  card.className = 'wh-full-st-card';
  card.dataset.locCode = locCode;
  card.dataset.hasStock = hasStock ? '1' : '0';
  // 카드 자체는 드래그 비활성화 → 드래그 핸들(⠿)에만 드래그 활성화
  card.draggable = false;
  card.addEventListener('dragover', whFullStDragOver);
  card.addEventListener('dragleave', whFullStDragLeave);
  card.addEventListener('drop', whFullStDrop);
  // 카드 스타일
  var borderColor = hasStock ? '#8e44ad' : '#ddd';
  var bgColor = hasStock ? '#fdf5ff' : '#f8f9fa';
  card.style.cssText = 'border:1.5px solid ' + borderColor + ';border-radius:10px;padding:10px 12px;background:' + bgColor + ';transition:all 0.15s;position:relative';
  // 위치코드 헤더 (드래그 핸들 포함)
  var slotLabel = locObj.slot === 1 ? '파레트 1' : '파레트 2';
  var header = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
    '<div style="display:flex;align-items:center;gap:4px;flex:1;min-width:0">' +
      '<input type="text" class="wh-fs-loc-input" ' +
        'data-orig-loc="' + locCode + '" ' +
        'value="' + locCode + '" ' +
        'title="위치코드 수정 후 Enter 또는 Tab 누르면 해당 위치로 이동" ' +
        'style="font-size:11px;font-weight:700;color:' + (hasStock ? '#6c3483' : '#aaa') + ';background:' + (hasStock ? '#ede0f7' : '#f0f0f0') + ';padding:2px 7px;border-radius:6px;border:1.5px solid transparent;min-width:0;flex:1;cursor:pointer" ' +
        'onfocus="this.style.borderColor=\'#8e44ad\';this.style.cursor=\'text\'" ' +
        'onblur="this.style.borderColor=\'transparent\';this.style.cursor=\'pointer\';whFullStLocInputBlur(this)" ' +
        'onkeydown="if(event.key===\'Enter\'||event.key===\'Tab\'){event.preventDefault();whFullStLocInputBlur(this);}" ' +
      '/>' +
      '<span style="font-size:9px;color:#bbb;white-space:nowrap">' + slotLabel + '</span>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:4px">' +
      '<button class="wh-fs-add-btn" data-loc="' + locCode + '" title="이 위치에 품목 추가" style="font-size:11px;color:#27ae60;background:none;border:none;cursor:pointer;padding:2px 4px;border-radius:4px">＋</button>' +
      '<span class="wh-fs-drag-handle" data-loc="' + locCode + '" draggable="true" title="드래그하여 위치 이동" style="font-size:14px;color:#aaa;cursor:grab;padding:2px 4px;border-radius:4px;user-select:none">⠿</span>' +
    '</div>' +
  '</div>';
  // 재고 항목 목록
  var itemsHtml = '';
  var activeItems = Object.entries(items).filter(function(e) { return (Number(e[1].qty) || 0) > 0; });
  if (activeItems.length === 0) {
    // 빈 위치: 품목명+수량 직접 입력 폼 표시
    var emptyLocSafeId = locCode.replace(/[^a-zA-Z0-9]/g, '_');
    itemsHtml =
      '<div style="font-size:11px;color:#bbb;text-align:center;padding:4px 0 6px">빈 위치</div>' +
      '<div id="wfst_new_wrap_' + emptyLocSafeId + '" style="background:#f0fff4;border:1px dashed #27ae60;border-radius:6px;padding:6px 8px">' +
        '<div style="font-size:10px;color:#27ae60;font-weight:700;margin-bottom:5px">+ 품목 직접 입력</div>' +
        '<input type="text" id="wfst_new_name_' + emptyLocSafeId + '" placeholder="품목명" ' +
          'style="width:100%;padding:4px 7px;border:1px solid #b2dfdb;border-radius:4px;font-size:11px;box-sizing:border-box;margin-bottom:4px" />' +
        '<div style="display:flex;gap:4px;margin-bottom:4px">' +
          '<input type="number" id="wfst_new_qty_' + emptyLocSafeId + '" min="1" step="1" placeholder="수량" ' +
            'style="flex:1;padding:4px 7px;border:1px solid #b2dfdb;border-radius:4px;font-size:11px" />' +
          '<input type="text" id="wfst_new_unit_' + emptyLocSafeId + '" placeholder="단위" value="ea" ' +
            'style="width:40px;padding:4px 5px;border:1px solid #b2dfdb;border-radius:4px;font-size:11px" />' +
        '</div>' +
        '<div style="display:flex;gap:4px;align-items:center">' +
          '<span style="font-size:10px;color:#888;white-space:nowrap">소비기한</span>' +
          '<input type="date" id="wfst_new_expiry_' + emptyLocSafeId + '" ' +
            'style="flex:1;padding:3px 5px;border:1px solid #b2dfdb;border-radius:4px;font-size:11px" />' +
          '<button class="wh-fs-new-save-btn" data-loc="' + locCode + '" data-safe-id="' + emptyLocSafeId + '" ' +
            'style="padding:4px 8px;background:#27ae60;color:#fff;border:none;border-radius:4px;font-size:11px;cursor:pointer;font-weight:700">저장</button>' +
        '</div>' +
      '</div>';
  } else {
    activeItems.forEach(function(entry) {
      var itemName = entry[0];
      var info = entry[1];
      var sysQty = Number(info.qty) || 0;
      var safeId = locCode.replace(/[^a-zA-Z0-9]/g, '_') + '__' + itemName.replace(/[^a-zA-Z0-9가-힣]/g, '_');
      // 입고 레코드 ID 수집 (품목명 변경/삭제 시 사용)
      var inboundIds = whInboundData
        .filter(function(r) { return r.location === locCode && r.item_name === itemName; })
        .map(function(r) { return r.id; });
      itemsHtml +=
        '<div style="margin-bottom:6px;padding:6px 8px;background:#fff;border-radius:6px;border:1px solid #e8d5f5">' +
          '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">' +
            '<input type="text" ' +
              'id="wfst_name_' + safeId + '" ' +
              'data-loc="' + locCode + '" ' +
              'data-orig-name="' + itemName.replace(/"/g, '&quot;') + '" ' +
              'data-inbound-ids="' + inboundIds.join(',') + '" ' +
              'value="' + itemName.replace(/"/g, '&quot;') + '" ' +
              'title="클릭하여 품목명 수정" ' +
              'onfocus="this.style.background=\"#fffde7\";this.style.borderColor=\"#f39c12\"" ' +
              'onblur="this.style.background=\"transparent\";this.style.borderColor=\"transparent\";whFullStNameBlur(this)" ' +
              'style="flex:1;font-size:11px;font-weight:700;color:#333;border:1px solid transparent;border-radius:4px;padding:2px 5px;background:transparent;min-width:0;cursor:text" />' +
            '<span style="font-size:9px;color:#bbb" title="품목명 클릭 시 수정 가능">✎</span>' +
            '<button class="wh-fs-del-btn" ' +
              'data-loc="' + locCode + '" ' +
              'data-item="' + itemName.replace(/"/g, '&quot;') + '" ' +
              'data-ids="' + inboundIds.join(',') + '" ' +
              'title="이 품목 재고 삭제" ' +
              'style="font-size:11px;color:#e74c3c;background:none;border:none;cursor:pointer;padding:2px 4px;border-radius:4px;line-height:1">✕</button>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<span style="font-size:10px;color:#888">전산:</span>' +
            '<span style="font-size:12px;font-weight:700;color:#2980b9">' + sysQty + '</span>' +
            '<span style="font-size:10px;color:#888">' + (info.unit || '') + '</span>' +
            '<span style="font-size:10px;color:#aaa;margin-left:4px">→ 실재고:</span>' +
            '<input type="number" min="0" step="1" ' +
              'id="wfst_' + safeId + '" ' +
              'data-loc="' + locCode + '" ' +
              'data-item="' + itemName.replace(/"/g, '&quot;') + '" ' +
              'data-sys="' + sysQty + '" ' +
              'placeholder="' + sysQty + '" ' +
              'oninput="whFullStCalcDiff(this)" ' +
              'style="width:60px;padding:3px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;font-weight:700" />' +
          '</div>' +
          '<div id="wfst_diff_' + safeId + '" style="font-size:11px;font-weight:700;margin-top:3px;color:#aaa">-</div>' +
        '</div>';
    });
  }
  card.innerHTML = header + itemsHtml;
  // 드래그 핸들에 이벤트 바인딩 (innerHTML 후 DOM에서 찾아야 함)
  var handle = card.querySelector('.wh-fs-drag-handle');
  if (handle) {
    handle.addEventListener('dragstart', function(e) {
      _whFullStocktakeDragSrc = { locCode: locCode, card: card };
      card.style.opacity = '0.5';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', locCode);
      e.stopPropagation();
    });
    handle.addEventListener('dragend', function(e) {
      card.style.opacity = '1';
      var hs = card.dataset.hasStock === '1';
      card.style.borderColor = hs ? '#8e44ad' : '#ddd';
      card.style.background = hs ? '#fdf5ff' : '#f8f9fa';
      _whFullStocktakeDragSrc = null;
    });
  }
  // 삭제 버튼 이벤트 바인딩 (data-attribute 방식)
  card.querySelectorAll('.wh-fs-del-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var dloc = btn.dataset.loc;
      var ditem = btn.dataset.item;
      var dids = btn.dataset.ids ? btn.dataset.ids.split(',').filter(function(x) { return x; }) : [];
      whFullStDeleteItem(dloc, ditem, dids);
    });
  });
  // 품목 추가 버튼 이벤트 바인딩
  var addBtn = card.querySelector('.wh-fs-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      whFullStAddItem(addBtn.dataset.loc);
    });
  }
  // 빈위치 저장 버튼 이벤트 바인딩
  var newSaveBtn = card.querySelector('.wh-fs-new-save-btn');
  if (newSaveBtn) {
    newSaveBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      whFullStNewItemSave(newSaveBtn.dataset.loc, newSaveBtn.dataset.safeId);
    });
  }
  return card;
}

// ── 실재고 차이 계산 ──────────────────────────────────────
function whFullStCalcDiff(input) {
  if (!input) return;
  var sysQty = Number(input.dataset.sys) || 0;
  var actualQty = input.value !== '' ? (Number(input.value) || 0) : null;
  var safeId = input.id.replace('wfst_', '');
  var diffEl = document.getElementById('wfst_diff_' + safeId);
  if (!diffEl) return;
  if (actualQty === null) {
    diffEl.textContent = '-';
    diffEl.style.color = '#aaa';
    return;
  }
  var diff = actualQty - sysQty;
  diffEl.textContent = (diff > 0 ? '+' : '') + diff + ' ' + (diff === 0 ? '✓' : '');
  diffEl.style.color = diff === 0 ? '#27ae60' : (diff > 0 ? '#e67e22' : '#e74c3c');

  // 차이 있는 항목만 필터 적용 시 카드 업데이트
  whFilterFullStocktakeGrid();
}

// ── 그리드 필터 ──────────────────────────────────────────
function whFilterFullStocktakeGrid() {
  var inner = document.getElementById('whFullStocktakeGridInner');
  var emptyEl = document.getElementById('whFullStocktakeEmpty');
  if (!inner) return;

  var searchVal = (document.getElementById('whFullStocktakeSearch') || {}).value || '';
  var q = searchVal.trim().toLowerCase();
  var showEmpty = document.getElementById('whFullShowEmpty');
  var showDiffOnly = document.getElementById('whFullShowDiffOnly');
  var showEmptyChecked = showEmpty ? showEmpty.checked : true;
  var showDiffOnlyChecked = showDiffOnly ? showDiffOnly.checked : false;

  var cards = inner.querySelectorAll('.wh-full-st-card');
  var visibleCount = 0;
  cards.forEach(function(card) {
    var locCode = card.dataset.locCode || '';
    var hasStock = card.dataset.hasStock === '1';
    var show = true;

    // 검색 필터
    if (q) {
      var cardText = card.textContent.toLowerCase();
      if (!locCode.toLowerCase().includes(q) && !cardText.includes(q)) {
        show = false;
      }
    }

    // 빈 위치 필터
    if (!showEmptyChecked && !hasStock) show = false;

    // 차이 있는 항목만 필터
    if (showDiffOnlyChecked) {
      var hasDiff = false;
      var inputs = card.querySelectorAll('input[type="number"]');
      inputs.forEach(function(inp) {
        if (inp.value !== '') {
          var sys = Number(inp.dataset.sys) || 0;
          var actual = Number(inp.value) || 0;
          if (actual !== sys) hasDiff = true;
        }
      });
      if (!hasDiff) show = false;
    }

    card.style.display = show ? '' : 'none';
    if (show) visibleCount++;
  });

  if (emptyEl) emptyEl.style.display = visibleCount === 0 ? '' : 'none';
  // 구역 라벨 + zone-row: 보이는 카드가 없으면 숨김
  var rows = inner.querySelectorAll('.wh-full-st-zone-row');
  rows.forEach(function(row) {
    var zoneKey = row.dataset.zoneKey;
    var hasVisible = row.querySelectorAll('.wh-full-st-card:not([style*="display: none"])').length > 0;
    // display:none 체크는 style 속성으로 판단
    var cards2 = row.querySelectorAll('.wh-full-st-card');
    var anyVisible = false;
    cards2.forEach(function(c) { if (c.style.display !== 'none') anyVisible = true; });
    row.style.display = anyVisible ? 'flex' : 'none';
    // 라벨도 동기화
    var label = inner.querySelector('.wh-full-st-zone-label[data-zone-key="' + zoneKey + '"]');
    if (label) label.style.display = anyVisible ? '' : 'none';
  });
}


// ── 위치코드 input blur 핸들러 (위치 이동) ──────────────────
async function whFullStLocInputBlur(input) {
  if (!_whFullStocktakeUnlocked) { input.value = input.dataset.origLoc || ''; return; }
  var newLoc = (input.value || '').trim().toUpperCase();
  var origLoc = (input.dataset.origLoc || '').trim();
  if (!newLoc || newLoc === origLoc) { input.value = origLoc; return; }
  // 유효한 위치코드인지 확인
  var allLocs = COLD_LOCATIONS.concat(WARM_LOCATIONS);
  var targetLocObj = allLocs.find(function(l) { return l.code === newLoc; });
  if (!targetLocObj) {
    showToast('유효하지 않은 위치코드입니다: ' + newLoc, 'warning');
    input.value = origLoc;
    return;
  }
  var recs = whInboundData.filter(function(r) { return r.location === origLoc; });
  var outRecs = whOutboundData.filter(function(r) { return r.location === origLoc; });
  if (recs.length === 0 && outRecs.length === 0) {
    // 빈 위치인 경우 단순 위치코드 표시만 변경 (실제 DB 변경 없음)
    showToast('빈 위치는 위치코드를 변경할 데이터가 없습니다.', 'info');
    input.value = origLoc;
    return;
  }
  var totalCount = recs.length + outRecs.length;
  if (!confirm(origLoc + ' 위치의 레코드 ' + totalCount + '건(입고 ' + recs.length + '건 + 출고 ' + outRecs.length + '건)을\n' + newLoc + ' 으로 이동합니다.\n\n계속하시겠습니까?')) {
    input.value = origLoc;
    return;
  }
  try {
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i]; var rId = r.id;
      var ru = Object.assign({}, r, { location: newLoc, warehouse: newLoc.charAt(0) });
      delete ru.id;
      await apiPut('wh_inbound', rId, ru);
    }
    for (var j = 0; j < outRecs.length; j++) {
      var o = outRecs[j]; var oId = o.id;
      var ou = Object.assign({}, o, { location: newLoc, warehouse: newLoc.charAt(0) });
      delete ou.id;
      await apiPut('wh_outbound', oId, ou);
    }
    showToast('위치 이동 완료: ' + origLoc + ' → ' + newLoc + ' (' + totalCount + '건)', 'success');
    whInvalidateMapCache();
    await whReloadAll();
    if (_whFullStocktakeUnlocked) whRenderFullStocktakeGrid();
  } catch(e) {
    showToast('위치 이동 실패: ' + e.message, 'error');
    input.value = origLoc;
  }
}

// ── 품목명 blur 핸들러 (품목명 변경 저장) ──────────────────
async function whFullStNameBlur(input) {
  if (!_whFullStocktakeUnlocked) return;
  var newName = (input.value || '').trim();
  var origName = input.dataset.origName || '';
  // &quot; 이스케이프 복원 후 비교
  var origNameDecoded = origName.replace(/&quot;/g, '"');
  if (!newName || newName === origNameDecoded) { input.value = origNameDecoded; return; }
  var locCode = input.dataset.loc || '';
  // ids 우선 사용, 없으면 locCode+origName으로 직접 조회
  var idsStr = input.dataset.inboundIds || '';
  var ids = idsStr ? idsStr.split(',').filter(Boolean) : [];
  if (ids.length === 0 && locCode && origNameDecoded) {
    ids = whInboundData
      .filter(function(r) { return r.location === locCode && r.item_name === origNameDecoded; })
      .map(function(r) { return r.id; });
  }
  if (ids.length === 0) {
    showToast('변경할 입고 레코드를 찾을 수 없습니다.', 'warning');
    input.value = origNameDecoded;
    return;
  }
  if (!confirm('"' + origNameDecoded + '" → "' + newName + '" 으로 품목명을 변경합니다.\n해당 위치의 입고 레코드 ' + ids.length + '건이 모두 변경됩니다.\n\n계속하시겠습니까?')) {
    input.value = origNameDecoded;
    return;
  }
  try {
    for (var i = 0; i < ids.length; i++) {
      var rec = whInboundData.find(function(r) { return r.id === ids[i]; });
      if (!rec) continue;
      var updated = Object.assign({}, rec, {
        item_name: newName,
        memo: (rec.memo ? rec.memo + ' | ' : '') + '품목명변경: ' + origNameDecoded + ' → ' + newName
      });
      var recId = updated.id; delete updated.id;
      await apiPut('wh_inbound', recId, updated);
    }
    showToast('품목명 변경 완료: ' + origNameDecoded + ' → ' + newName + ' (' + ids.length + '건)', 'success');
    input.dataset.origName = newName;
    whInvalidateMapCache();
    await whReloadAll();
    if (_whFullStocktakeUnlocked) whRenderFullStocktakeGrid();
  } catch(e) {
    showToast('품목명 변경 실패: ' + e.message, 'error');
    input.value = origNameDecoded;
  }
}
// ── 품목 삭제 ────────────────────────────────────
async function whFullStDeleteItem(locCode, itemName, inboundIds) {
  if (!_whFullStocktakeUnlocked) { showToast('관리자 허가가 필요합니다.', 'warning'); return; }
  // itemName &quot; 디코딩
  itemName = (itemName || '').replace(/&quot;/g, '"');
  if (!Array.isArray(inboundIds)) inboundIds = [];
  // inboundIds가 비어있으면 locCode+itemName으로 직접 조회
  if (inboundIds.length === 0 && locCode && itemName) {
    inboundIds = whInboundData
      .filter(function(r) { return r.location === locCode && r.item_name === itemName; })
      .map(function(r) { return r.id; });
  }
  var totalQty = whInboundData
    .filter(function(r) { return r.location === locCode && r.item_name === itemName; })
    .reduce(function(s, r) { return s + (Number(r.qty) || 0); }, 0);
  var outQty = whOutboundData
    ? whOutboundData.filter(function(r) { return r.location === locCode && r.item_name === itemName; })
        .reduce(function(s, r) { return s + (Number(r.qty) || 0); }, 0)
    : 0;
  var netQty = totalQty - outQty;
  if (!confirm('[⚠️ 주의] ' + locCode + ' 위치의 "' + itemName + '" 재고를 삭제합니다.\n현재고: ' + netQty + '\n입고 레코드 ' + inboundIds.length + '건이 모두 삭제됩니다.\n\n계속하시겠습니까?')) return;
  try {
    for (var i = 0; i < inboundIds.length; i++) {
      await apiDelete('wh_inbound', inboundIds[i]);
    }
    // 연관 출고 레코드도 삭제 (선택)
    var outRecs = whOutboundData
      ? whOutboundData.filter(function(r) { return r.location === locCode && r.item_name === itemName; })
      : [];
    if (outRecs.length > 0) {
      if (confirm('연관된 출고 레코드 ' + outRecs.length + '건도 삭제하시겠습니까?\n(아니오를 누르면 출고 레코드는 유지됩니다)')) {
        for (var j = 0; j < outRecs.length; j++) {
          await apiDelete('wh_outbound', outRecs[j].id);
        }
      }
    }
    showToast('삭제 완료: ' + locCode + ' / ' + itemName, 'success');
    whInvalidateMapCache();
    await whReloadAll();
    if (_whFullStocktakeUnlocked) whRenderFullStocktakeGrid();
  } catch(e) {
    showToast('삭제 실패: ' + e.message, 'error');
  }
}
// ── 품목 추가 (재고 있는 위치에 새 품목 추가) ────────────────
function whFullStAddItem(locCode) {
  if (!_whFullStocktakeUnlocked) { showToast('관리자 허가가 필요합니다.', 'warning'); return; }
  var modalId = 'whFullStAddItemModal';
  var existing = document.getElementById(modalId);
  if (existing) existing.remove();
  var today = new Date().toISOString().split('T')[0];
  var m = document.createElement('div');
  m.id = modalId;
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10002;display:flex;align-items:center;justify-content:center';
  m.innerHTML =
    '<div style="background:#fff;border-radius:14px;width:90%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.2);overflow:hidden">' +
      '<div style="background:#e8f8f5;border-bottom:1px solid #b2dfdb;padding:12px 16px;display:flex;align-items:center;justify-content:space-between">' +
        '<h3 style="color:#27ae60;font-size:14px;margin:0"><i class="fas fa-plus-circle"></i> ' + locCode + ' 품목 추가</h3>' +
        '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:#aaa">&times;</button>' +
      '</div>' +
      '<div style="padding:16px;display:flex;flex-direction:column;gap:10px">' +
        '<div><label style="font-size:11px;font-weight:700;color:#555;display:block;margin-bottom:4px">품목명 <span style="color:red">*</span></label>' +
          '<input type="text" id="whFsAddName" placeholder="품목명 입력" style="width:100%;padding:7px 10px;border:1.5px solid #b2dfdb;border-radius:7px;font-size:12px;box-sizing:border-box" /></div>' +
        '<div style="display:flex;gap:8px">' +
          '<div style="flex:1"><label style="font-size:11px;font-weight:700;color:#555;display:block;margin-bottom:4px">수량 <span style="color:red">*</span></label>' +
            '<input type="number" id="whFsAddQty" min="1" step="1" placeholder="0" style="width:100%;padding:7px 10px;border:1.5px solid #b2dfdb;border-radius:7px;font-size:12px;box-sizing:border-box" /></div>' +
          '<div style="width:70px"><label style="font-size:11px;font-weight:700;color:#555;display:block;margin-bottom:4px">단위</label>' +
            '<input type="text" id="whFsAddUnit" value="ea" style="width:100%;padding:7px 10px;border:1.5px solid #b2dfdb;border-radius:7px;font-size:12px;box-sizing:border-box" /></div>' +
        '</div>' +
        '<div><label style="font-size:11px;font-weight:700;color:#555;display:block;margin-bottom:4px">소비기한 (선택)</label>' +
          '<input type="date" id="whFsAddExpiry" value="" style="width:100%;padding:7px 10px;border:1.5px solid #b2dfdb;border-radius:7px;font-size:12px;box-sizing:border-box" /></div>' +
        '<div style="display:flex;gap:8px;margin-top:4px">' +
          '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="flex:1;padding:9px;background:#f8f9fa;color:#555;border:1px solid #ddd;border-radius:8px;cursor:pointer;font-size:13px">취소</button>' +
          '<button onclick="whFullStAddItemSave(\'' + locCode.replace(/'/g,"\\\'")+'\',' + '\'' + modalId + '\'' + ')" style="flex:1;padding:9px;background:#27ae60;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700"><i class="fas fa-plus"></i> 추가</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(m);
  setTimeout(function() { var el = document.getElementById('whFsAddName'); if (el) el.focus(); }, 100);
}
async function whFullStAddItemSave(locCode, modalId) {
  var nameEl = document.getElementById('whFsAddName');
  var qtyEl = document.getElementById('whFsAddQty');
  var unitEl = document.getElementById('whFsAddUnit');
  var expiryEl = document.getElementById('whFsAddExpiry');
  var itemName = (nameEl ? nameEl.value.trim() : '');
  var qty = qtyEl ? (Number(qtyEl.value) || 0) : 0;
  var unit = unitEl ? (unitEl.value.trim() || 'ea') : 'ea';
  var expiry = expiryEl ? expiryEl.value : '';
  if (!itemName) { showToast('품목명을 입력하세요.', 'warning'); return; }
  if (qty <= 0) { showToast('수량을 입력하세요.', 'warning'); return; }
  var today = new Date().toISOString().split('T')[0];
  var dateShort = today.replace(/-/g,'').slice(2);
  var prefix = 'WH-ADJ-' + dateShort;
  var existingAdj = [];
  try { existingAdj = (await apiGetAll('wh_inbound')).filter(function(r) { return r.lot_no && r.lot_no.startsWith(prefix); }); } catch(e2) {}
  var seq = existingAdj.length + 1;
  var lotNo = prefix + '-' + String(seq).padStart(3,'0');
  try {
    await apiPost('wh_inbound', {
      lot_no: lotNo,
      inbound_date: today,
      warehouse: locCode.charAt(0),
      location: locCode,
      item_name: itemName,
      qty: qty,
      unit: unit,
      expiry_date: expiry || '',
      inbound_type: '재고조정',
      manager: '실사추가',
      memo: '전체실사 모드 직접추가',
      created_at: Date.now()
    });
    var modal = document.getElementById(modalId);
    if (modal) modal.remove();
    showToast('추가 완료: ' + locCode + ' / ' + itemName + ' ' + qty + unit, 'success');
    whInvalidateMapCache();
    await whReloadAll();
    if (_whFullStocktakeUnlocked) whRenderFullStocktakeGrid();
  } catch(e) {
    showToast('추가 실패: ' + e.message, 'error');
  }
}
// ── 빈 위치 직접 저장 ─────────────────────────────────
async function whFullStNewItemSave(locCode, safeId) {
  if (!_whFullStocktakeUnlocked) { showToast('관리자 허가가 필요합니다.', 'warning'); return; }
  var nameEl = document.getElementById('wfst_new_name_' + safeId);
  var qtyEl = document.getElementById('wfst_new_qty_' + safeId);
  var unitEl = document.getElementById('wfst_new_unit_' + safeId);
  var expiryEl = document.getElementById('wfst_new_expiry_' + safeId);
  var itemName = (nameEl ? nameEl.value.trim() : '');
  var qty = qtyEl ? (Number(qtyEl.value) || 0) : 0;
  var unit = unitEl ? (unitEl.value.trim() || 'ea') : 'ea';
  var expiryDate = expiryEl ? (expiryEl.value || '') : '';
  if (!itemName) { showToast('품목명을 입력하세요.', 'warning'); if (nameEl) nameEl.focus(); return; }
  if (qty <= 0) { showToast('수량을 입력하세요.', 'warning'); if (qtyEl) qtyEl.focus(); return; }
  var today = new Date().toISOString().split('T')[0];
  var dateShort = today.replace(/-/g,'').slice(2);
  var prefix = 'WH-ADJ-' + dateShort;
  var existingAdj = [];
  try { existingAdj = (await apiGetAll('wh_inbound')).filter(function(r) { return r.lot_no && r.lot_no.startsWith(prefix); }); } catch(e2) {}
  var seq = existingAdj.length + 1;
  var lotNo = prefix + '-' + String(seq).padStart(3,'0');
  try {
    await apiPost('wh_inbound', {
      lot_no: lotNo,
      inbound_date: today,
      warehouse: locCode.charAt(0),
      location: locCode,
      item_name: itemName,
      qty: qty,
      unit: unit,
      expiry_date: expiryDate,
      inbound_type: '재고조정',
      manager: '실사추가',
      memo: '전체실사 모드 빈위치 직접입력',
      created_at: Date.now()
    });
    showToast('저장 완료: ' + locCode + ' / ' + itemName + ' ' + qty + unit, 'success');
    whInvalidateMapCache();
    await whReloadAll();
    if (_whFullStocktakeUnlocked) whRenderFullStocktakeGrid();
  } catch(e) {
    showToast('저장 실패: ' + e.message, 'error');
  }
}
// ── 드래그&드롭 이벤트 핸들러 ──────────────────────────────
function whFullStDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  var card = e.currentTarget;
  if (_whFullStocktakeDragSrc && card !== _whFullStocktakeDragSrc.card) {
    card.style.borderColor = '#e67e22';
    card.style.background = '#fff8f0';
  }
}

function whFullStDragLeave(e) {
  var card = e.currentTarget;
  var hasStock = card.dataset.hasStock === '1';
  card.style.borderColor = hasStock ? '#8e44ad' : '#ddd';
  card.style.background = hasStock ? '#fdf5ff' : '#f8f9fa';
}

function whFullStDragEnd(e) {
  var card = e.currentTarget;
  card.style.opacity = '1';
  var hasStock = card.dataset.hasStock === '1';
  card.style.borderColor = hasStock ? '#8e44ad' : '#ddd';
  card.style.background = hasStock ? '#fdf5ff' : '#f8f9fa';
  _whFullStocktakeDragSrc = null;
}

function whFullStDrop(e) {
  e.preventDefault();
  var toCard = e.currentTarget;
  if (!_whFullStocktakeDragSrc) return;
  var fromCard = _whFullStocktakeDragSrc.card;
  if (toCard === fromCard) return;

  var fromLoc = fromCard.dataset.locCode;
  var toLoc = toCard.dataset.locCode;

  // 드롭 대상 스타일 초기화
  var toHasStock = toCard.dataset.hasStock === '1';
  toCard.style.borderColor = toHasStock ? '#8e44ad' : '#ddd';
  toCard.style.background = toHasStock ? '#fdf5ff' : '#f8f9fa';

  // 출발지에 재고가 없으면 이동 불가
  if (fromCard.dataset.hasStock !== '1') {
    showToast('이동할 재고가 없습니다.', 'warning');
    return;
  }

  // 이동 확인 모달
  whShowFullStMoveConfirm(fromLoc, toLoc);
}

// ── 위치 이동 확인 모달 ──────────────────────────────────
function whShowFullStMoveConfirm(fromLoc, toLoc) {
  var stockMap = whCalcStock();
  var fromItems = stockMap[fromLoc] || {};
  var activeItems = Object.entries(fromItems).filter(function(e) { return (Number(e[1].qty) || 0) > 0; });

  if (activeItems.length === 0) {
    showToast('이동할 재고가 없습니다.', 'warning');
    return;
  }

  var toItems = stockMap[toLoc] || {};
  var toHasStock = Object.values(toItems).some(function(v) { return (Number(v.qty) || 0) > 0; });

  var modalId = 'whFullStMoveModal';
  var existing = document.getElementById(modalId);
  if (existing) existing.remove();

  var itemListHtml = activeItems.map(function(e) {
    return '<li style="font-size:12px;color:#555;margin-bottom:3px"><b>' + e[0] + '</b>: ' + e[1].qty + ' ' + (e[1].unit || '') + '</li>';
  }).join('');

  var warningHtml = toHasStock
    ? '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:12px;color:#856404"><i class="fas fa-exclamation-triangle"></i> 대상 위치(' + toLoc + ')에 이미 재고가 있습니다. 이동 후 같은 위치에 여러 품목이 보관됩니다.</div>'
    : '';

  var m = document.createElement('div');
  m.id = modalId;
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center';
  m.innerHTML =
    '<div style="background:#fff;border-radius:14px;width:90%;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,0.2);overflow:hidden">' +
      '<div style="background:#fff8f0;border-bottom:1px solid #fde8c8;padding:14px 18px;display:flex;align-items:center;justify-content:space-between">' +
        '<h3 style="color:#e67e22;font-size:14px;margin:0"><i class="fas fa-exchange-alt"></i> 위치 이동 확인</h3>' +
        '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:#aaa">&times;</button>' +
      '</div>' +
      '<div style="padding:16px">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;font-size:13px">' +
          '<code style="background:#f5f5f5;padding:4px 8px;border-radius:6px;font-weight:700">' + fromLoc + '</code>' +
          '<span style="color:#e67e22;font-size:16px">→</span>' +
          '<code style="background:#f5f5f5;padding:4px 8px;border-radius:6px;font-weight:700">' + toLoc + '</code>' +
        '</div>' +
        warningHtml +
        '<div style="font-size:12px;color:#888;margin-bottom:6px">이동할 재고:</div>' +
        '<ul style="margin:0 0 14px 0;padding-left:16px">' + itemListHtml + '</ul>' +
        '<div style="margin-bottom:14px">' +
          '<label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:5px">이동 사유 (선택)</label>' +
          '<input type="text" id="whFullStMoveMemo" placeholder="예) 창고 정리, 위치 변경" style="width:100%;padding:8px 10px;border:1.5px solid #ddd;border-radius:8px;font-size:12px;box-sizing:border-box" />' +
        '</div>' +
        '<div style="display:flex;gap:8px">' +
          '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="flex:1;padding:9px;background:#f8f9fa;color:#555;border:1px solid #ddd;border-radius:8px;cursor:pointer;font-size:13px">취소</button>' +
          '<button onclick="whDoFullStMove(\'' + fromLoc.replace(/'/g, "\\'") + '\',\'' + toLoc.replace(/'/g, "\\'") + '\')" style="flex:1;padding:9px;background:#e67e22;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700"><i class="fas fa-exchange-alt"></i> 이동</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(m);
}

// ── 위치 이동 실행 ──────────────────────────────────────
async function whDoFullStMove(fromLoc, toLoc) {
  var memoEl = document.getElementById('whFullStMoveMemo');
  var memo = memoEl ? memoEl.value.trim() : '';
  var modal = document.getElementById('whFullStMoveModal');
  if (modal) modal.remove();

  var targets = whInboundData.filter(function(r) {
    return r.location === fromLoc;
  });

  if (targets.length === 0) {
    showToast('이동할 입고 기록을 찾을 수 없습니다.', 'error');
    return;
  }

  var toWh = toLoc.charAt(0);
  try {
    for (var i = 0; i < targets.length; i++) {
      var rec = targets[i];
      var updated = Object.assign({}, rec, {
        warehouse: toWh,
        location: toLoc,
        memo: (rec.memo ? rec.memo + ' | ' : '') + '위치이동: ' + fromLoc + ' → ' + toLoc + (memo ? ' (' + memo + ')' : '')
      });
      var recId = updated.id;
      delete updated.id;
      await apiPut('wh_inbound', recId, updated);
    }
    showToast('이동 완료: ' + fromLoc + ' → ' + toLoc + ' (' + targets.length + '건)', 'success');
    whInvalidateMapCache();
    await whReloadAll();
    if (typeof loadLogisticsData === 'function') await loadLogisticsData();
    // 그리드 재렌더링
    if (_whFullStocktakeUnlocked) whRenderFullStocktakeGrid();
  } catch(e) {
    showToast('이동 실패: ' + e.message, 'error');
  }
}

// ── 전체 실사 저장 ──────────────────────────────────────
async function whSaveFullStocktake() {
  if (!_whFullStocktakeUnlocked) {
    showToast('관리자 허가가 필요합니다.', 'warning');
    return;
  }

  var dateEl = document.getElementById('whFullStocktakeDate');
  var date = dateEl ? dateEl.value : new Date().toISOString().split('T')[0];
  if (!date) { showToast('실사일자를 입력해주세요.', 'warning'); return; }

  // 입력된 실재고 수집
  var inputs = document.querySelectorAll('#whFullStocktakeGridInner input[type="number"][data-loc]');
  var records = [];
  inputs.forEach(function(inp) {
    if (inp.value === '') return;
    var locCode = inp.dataset.loc;
    var itemName = inp.dataset.item;
    var sysQty = Number(inp.dataset.sys) || 0;
    var actualQty = Number(inp.value) || 0;
    var diff = actualQty - sysQty;
    records.push({
      location: locCode,
      item_name: itemName,
      sys_qty: sysQty,
      actual_qty: actualQty,
      diff: diff,
      stocktake_date: date
    });
  });

  if (records.length === 0) {
    showToast('실사 수량을 입력한 항목이 없습니다.', 'warning');
    return;
  }

  // 차이 있는 항목 수 확인
  var diffCount = records.filter(function(r) { return r.diff !== 0; }).length;
  var confirmMsg = '총 ' + records.length + '건의 실사 결과를 저장합니다.';
  if (diffCount > 0) confirmMsg += '\n차이 발생 ' + diffCount + '건은 재고 조정 기록이 자동 생성됩니다.';
  if (!confirm(confirmMsg + '\n\n계속하시겠습니까?')) return;

  try {
    // 실사 결과 저장
    for (var i = 0; i < records.length; i++) {
      await apiPost('wh_stocktake', records[i]);
    }

    // diff != 0 인 항목에 대해 WH-ADJ 조정 레코드 자동 생성
    var adjDate = date;
    var adjDateShort = adjDate.replace(/-/g, '').slice(2);
    var adjPrefix = 'WH-ADJ-' + adjDateShort;
    var existingAdj = [];
    try { existingAdj = (await apiGetAll('wh_inbound')).filter(function(r) { return r.lot_no && r.lot_no.startsWith(adjPrefix); }); } catch(e2) {}
    var adjSeq = existingAdj.length;
    var adjCreated = 0;

    for (var j = 0; j < records.length; j++) {
      var rec = records[j];
      var diff = Number(rec.diff) || 0;
      if (diff === 0) continue;
      adjSeq++;
      var adjLot = adjPrefix + '-' + String(adjSeq).padStart(3, '0');
      if (diff > 0) {
        await apiPost('wh_inbound', {
          lot_no: adjLot,
          inbound_date: adjDate,
          warehouse: rec.location ? rec.location.charAt(0) : 'W',
          location: rec.location,
          item_name: rec.item_name,
          qty: diff,
          unit: 'ea',
          inbound_type: '재고조정',
          manager: '실사조정',
          memo: '전체실사 플러스 조정 (실사:' + rec.actual_qty + ' / 시스템:' + rec.sys_qty + ')',
          created_at: Date.now()
        });
      } else {
        await apiPost('wh_outbound', {
          lot_no: adjLot,
          outbound_date: adjDate,
          warehouse: rec.location ? rec.location.charAt(0) : 'W',
          location: rec.location,
          item_name: rec.item_name,
          qty: Math.abs(diff),
          unit: 'ea',
          destination: '재고조정',
          manager: '실사조정',
          memo: '전체실사 마이너스 조정 (실사:' + rec.actual_qty + ' / 시스템:' + rec.sys_qty + ')',
          created_at: Date.now()
        });
      }
      adjCreated++;
    }

    var msg = '전체 실사 저장 완료 (' + records.length + '건)';
    if (adjCreated > 0) msg += ' — 재고 자동 조정 ' + adjCreated + '건 반영';
    showToast(msg, 'success');
    // ── 전체 물류관리 연동 갱신 ──────────────────────────────
    showToast('물류관리 전체 데이터 동기화 중...', 'info');
    whInvalidateMapCache();
    // 1) warehouse-mgmt 전체 재로드 (입고/출고/실사/원장/맵/KPI)
    await whReloadAll();
    // 2) logistics.js 재고현황 및 물류 테이블 갱신
    if (typeof loadLogisticsData === 'function') await loadLogisticsData();
    // 3) 창고맵 갱신 (현재 선택된 맵 타입 유지)
    var freshMap = whCalcStock();
    whUpdateDashKpi(freshMap);
    whUpdateMapKpi(freshMap);
    var mapTab = document.getElementById('tabContent_wh_map');
    if (mapTab) { whShowMap(whCurrentMap || 'cold', freshMap); }
    // 4) 재고원장 갱신
    whRenderLedger(freshMap);
    // 5) 입고/출고 테이블 갱신
    whRenderInTable();
    whRenderOutTable();
    // 6) 실사 이력 테이블 갱신
    whRenderStocktakeTable();
    // 7) FIFO 갱신
    if (typeof whRenderFifo === 'function') whRenderFifo();
    // 8) 재고검증 탭 갱신 (검색 결과가 열려있으면 재검색)
    if (typeof vfySearch === 'function') {
      var vfyInput = document.getElementById('vfyItemInput');
      if (vfyInput && vfyInput.value.trim()) { vfySearch(); }
    }
    // 9) lgRenderStockTable (재고현황 테이블)
    if (typeof lgRenderStockTable === 'function') lgRenderStockTable();
    // 10) InventoryStore 이벤트 발행 → 구독 모듈 자동 갱신
    if (window.InventoryStore) {
      window.InventoryStore.emit('warehouse:updated', {
        wh_inbound: whInboundData,
        wh_outbound: whOutboundData,
        wh_stocktake: whStocktakeData
      });
    }
    showToast('전체 동기화 완료', 'success');
    // 그리드 재렌더링 (스크롤 위치 유지)
    var gridEl = document.getElementById('whFullStocktakeGridInner');
    var scrollTop = gridEl ? (gridEl.closest('[style*="overflow"]') || document.documentElement).scrollTop : 0;
    whRenderFullStocktakeGrid();
    setTimeout(function() {
      var scrollTarget = gridEl ? (gridEl.closest('[style*="overflow"]') || document.documentElement) : null;
      if (scrollTarget) scrollTarget.scrollTop = scrollTop;
    }, 50);
  } catch(e) {
    showToast('저장 실패: ' + e.message, 'error');
  }
}

// ── 기존 실사 등록 폼 관련 누락 함수 추가 ──────────────────
// whHandleStocktakeSubmit: 실사 등록 폼 submit 핸들러
async function whHandleStocktakeSubmit(e) {
  if (e) e.preventDefault();
  var wh = (document.getElementById('whst_warehouse') || {}).value || '';
  var loc = (document.getElementById('whst_location') || {}).value || '';
  var date = (document.getElementById('whst_date') || {}).value || '';
  var manager = ((document.getElementById('whst_manager') || {}).value || '').trim();
  var itemName = ((document.getElementById('whst_item_name') || {}).value || '').trim();
  var actualQty = document.getElementById('whst_actual_qty');
  var reason = (document.getElementById('whst_reason') || {}).value || '';
  var notes = ((document.getElementById('whst_notes') || {}).value || '').trim();

  if (!loc) { showToast('위치코드를 선택해주세요.', 'warning'); return; }
  if (!date) { showToast('실사일자를 입력해주세요.', 'warning'); return; }
  if (!manager) { showToast('담당자를 입력해주세요.', 'warning'); return; }
  if (!itemName) { showToast('품목명을 입력해주세요.', 'warning'); return; }
  if (!actualQty || actualQty.value === '') { showToast('실제 수량을 입력해주세요.', 'warning'); return; }

  var sysQtyEl = document.getElementById('whst_system_qty');
  var sysQty = sysQtyEl ? (Number(sysQtyEl.value) || 0) : 0;
  var actual = Number(actualQty.value) || 0;
  var diff = actual - sysQty;

  var record = {
    warehouse: wh,
    location: loc,
    stocktake_date: date,
    manager: manager,
    item_name: itemName,
    sys_qty: sysQty,
    actual_qty: actual,
    diff: diff,
    reason: reason,
    notes: notes,
    created_at: Date.now()
  };

  try {
    await apiPost('wh_stocktake', record);

    // diff != 0 이면 재고 조정 레코드 생성
    if (diff !== 0) {
      var adjDateShort = date.replace(/-/g, '').slice(2);
      var adjPrefix = 'WH-ADJ-' + adjDateShort;
      var existingAdj = [];
      try { existingAdj = (await apiGetAll('wh_inbound')).filter(function(r) { return r.lot_no && r.lot_no.startsWith(adjPrefix); }); } catch(e2) {}
      var adjSeq = existingAdj.length + 1;
      var adjLot = adjPrefix + '-' + String(adjSeq).padStart(3, '0');
      if (diff > 0) {
        await apiPost('wh_inbound', {
          lot_no: adjLot, inbound_date: date, warehouse: wh, location: loc,
          item_name: itemName, qty: diff, unit: 'ea', inbound_type: '재고조정',
          manager: '실사조정',
          memo: '재고실사 플러스 조정 (실사:' + actual + ' / 시스템:' + sysQty + ')',
          created_at: Date.now()
        });
      } else {
        await apiPost('wh_outbound', {
          lot_no: adjLot, outbound_date: date, warehouse: wh, location: loc,
          item_name: itemName, qty: Math.abs(diff), unit: 'ea', destination: '재고조정',
          manager: '실사조정',
          memo: '재고실사 마이너스 조정 (실사:' + actual + ' / 시스템:' + sysQty + ')',
          created_at: Date.now()
        });
      }
      showToast('실사 등록 완료 (재고 조정 ' + Math.abs(diff) + ' 반영)', 'success');
    } else {
      showToast('실사 등록 완료', 'success');
    }

    // 폼 초기화
    var form = document.getElementById('whStocktakeForm');
    if (form) form.reset();
    var today = new Date().toISOString().split('T')[0];
    var dateEl2 = document.getElementById('whst_date');
    if (dateEl2) dateEl2.value = today;

    whInvalidateMapCache();
    await whReloadAll();
    if (typeof loadLogisticsData === 'function') loadLogisticsData();
    whRenderStocktakeTable();
  } catch(err) {
    showToast('저장 실패: ' + err.message, 'error');
  }
}

// whLookupSystemQty: 전산재고 조회 버튼 핸들러
function whLookupSystemQty() {
  var loc = (document.getElementById('whst_location') || {}).value || '';
  var itemName = ((document.getElementById('whst_item_name') || {}).value || '').trim();
  if (!loc) { showToast('위치코드를 먼저 선택해주세요.', 'warning'); return; }
  if (!itemName) { showToast('품목명을 먼저 입력해주세요.', 'warning'); return; }
  var stockMap = whCalcStock();
  var locItems = stockMap[loc] || {};
  var info = locItems[itemName] || { qty: 0 };
  var sysQtyEl = document.getElementById('whst_system_qty');
  if (sysQtyEl) sysQtyEl.value = info.qty || 0;
  showToast(loc + ' / ' + itemName + ' 전산재고: ' + (info.qty || 0), 'info');
  whCalcDiff();
}

// whCalcDiff: 실사 등록 폼 차이 자동 계산
function whCalcDiff() {
  var sysQtyEl = document.getElementById('whst_system_qty');
  var actualQtyEl = document.getElementById('whst_actual_qty');
  var diffEl = document.getElementById('whst_diff_qty');
  if (!sysQtyEl || !actualQtyEl || !diffEl) return;
  var sysQty = Number(sysQtyEl.value) || 0;
  var actualQty = actualQtyEl.value !== '' ? (Number(actualQtyEl.value) || 0) : null;
  if (actualQty === null) { diffEl.value = ''; return; }
  diffEl.value = actualQty - sysQty;
}

// ── 재고실사 탭 활성화 시 전체 실사 모드 초기화 ──────────────
function whInitFullStocktakeSection() {
  // 날짜 초기화
  var dateEl = document.getElementById('whFullStocktakeDate');
  if (dateEl && !dateEl.value) {
    dateEl.value = new Date().toISOString().split('T')[0];
  }
  // 현재 로그인 사용자가 admin이면 자동 허가 상태 표시
  var user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
  if (user && user.role === 'admin' && !_whFullStocktakeUnlocked) {
    // admin은 즉시 사용 가능 안내만 표시 (자동 허가는 하지 않음 - 명시적 클릭 필요)
    var statusEl = document.getElementById('whFullStocktakeStatus');
    if (statusEl) {
      statusEl.innerHTML = '<i class="fas fa-crown" style="color:#f8c471"></i> <span style="color:#f8c471">관리자 계정 — 클릭하여 즉시 활성화</span>';
    }
  }
}


// =====================================================
// ── 쿠팡 출고 예약 & 번들 관리 ────────────────────────
// 밀크런 / 로켓 / 그로스 채널별 파렛트 출고 예약
// 번들 구성 (이종/동종 제품 묶음), 예약일 자동 출고
// =====================================================

// ── 상태 변수 ──────────────────────────────────────────
var _cpBundleData = [];        // 등록된 번들 목록 (localStorage 저장)
var _cpReservationData = [];   // 출고 예약 목록 (wh_cp_reservation 테이블)
var _cpItemRows = [];          // 현재 예약 폼의 품목 행 목록
var _cpCurrentTab = 'reserve'; // 현재 활성 탭

var CP_BUNDLE_KEY = 'lc_cp_bundles';
var CP_CHANNELS = { '밀크런': '🥛', '로켓': '🚀', '그로스': '📦' };

// ── 초기화 ──────────────────────────────────────────────
function cpInit() {
  // 번들 데이터 로드
  try { _cpBundleData = JSON.parse(localStorage.getItem(CP_BUNDLE_KEY) || '[]'); } catch(e) { _cpBundleData = []; }
  // 예약 데이터 로드
  cpLoadReservations();
  // 오늘 날짜 설정
  var dateEl = document.getElementById('cp_out_date');
  if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().split('T')[0];
  // 번들 미리보기 렌더링
  cpRenderBundlePreview();
}

async function cpLoadReservations() {
  try {
    _cpReservationData = await apiGetAll('wh_cp_reservation');
  } catch(e) {
    _cpReservationData = [];
  }
  cpUpdatePendingBadge();
  cpRenderPending();
  cpRenderHistory();
}

// ── 탭 전환 ────────────────────────────────────────────
function cpSwitchTab(tab) {
  _cpCurrentTab = tab;
  ['reserve', 'pending', 'history'].forEach(function(t) {
    var btn = document.getElementById('cpTab_' + t);
    var content = document.getElementById('cpContent_' + t);
    var isActive = t === tab;
    if (btn) {
      btn.style.borderBottom = isActive ? '3px solid #e8551a' : '3px solid transparent';
      btn.style.color = isActive ? '#e8551a' : '#888';
      btn.style.fontWeight = isActive ? '700' : '600';
    }
    if (content) content.style.display = isActive ? '' : 'none';
  });
  if (tab === 'pending') cpRenderPending();
  if (tab === 'history') cpRenderHistory();
}

// ── 채널 변경 ──────────────────────────────────────────
function cpChannelChange() {
  // 채널별 기본 창고 설정 (밀크런=저온, 로켓/그로스=일반)
  var ch = (document.getElementById('cp_channel') || {}).value || '';
  var whEl = document.getElementById('cp_warehouse');
  if (whEl && ch === '밀크런') whEl.value = 'C';
  else if (whEl && (ch === '로켓' || ch === '그로스')) whEl.value = 'W';
}

function cpBuildLocSelect() {
  // 위치 선택은 품목별로 처리하므로 여기서는 창고 필터만 저장
}

// ── 품목 행 추가 ────────────────────────────────────────
function cpAddItem() {
  var idx = _cpItemRows.length;
  _cpItemRows.push({ type: 'item', itemName: '', qty: 1, unit: 'ea', location: '' });
  cpRenderItemList();
  // 새로 추가된 행의 품목명 입력에 포커스
  setTimeout(function() {
    var el = document.getElementById('cpItem_name_' + idx);
    if (el) el.focus();
  }, 50);
}

// ── 번들 행 추가 ────────────────────────────────────────
function cpAddBundle() {
  if (_cpBundleData.length === 0) {
    showToast('등록된 번들이 없습니다. 번들 관리 버튼을 눌러 먼저 번들을 등록하세요.', 'warning');
    cpShowBundleModal();
    return;
  }
  var idx = _cpItemRows.length;
  _cpItemRows.push({ type: 'bundle', bundleId: '', qty: 1 });
  cpRenderItemList();
  setTimeout(function() {
    var el = document.getElementById('cpItem_bundle_' + idx);
    if (el) el.focus();
  }, 50);
}

// ── 품목 목록 렌더링 ────────────────────────────────────
function cpRenderItemList() {
  var container = document.getElementById('cpItemList');
  if (!container) return;
  if (_cpItemRows.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:#bbb;padding:16px;font-size:12px">품목 추가 버튼을 눌러 출고할 품목을 추가하세요.</div>';
    return;
  }
  container.innerHTML = _cpItemRows.map(function(row, idx) {
    if (row.type === 'bundle') {
      var bundleOptions = _cpBundleData.map(function(b) {
        return '<option value="' + b.id + '"' + (row.bundleId === b.id ? ' selected' : '') + '>' + b.name + '</option>';
      }).join('');
      return '<div style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:#f5eef8;border:1px solid #d7bde2;border-radius:8px">' +
        '<span style="font-size:11px;font-weight:700;color:#8e44ad;white-space:nowrap;min-width:30px"><i class="fas fa-layer-group"></i></span>' +
        '<select id="cpItem_bundle_' + idx + '" onchange="_cpItemRows[' + idx + '].bundleId=this.value" style="flex:2;padding:5px 8px;border:1px solid #d7bde2;border-radius:6px;font-size:12px">' +
          '<option value="">번들 선택</option>' + bundleOptions +
        '</select>' +
        '<input type="number" min="1" step="1" value="' + (row.qty || 1) + '" oninput="_cpItemRows[' + idx + '].qty=Number(this.value)||1" style="width:60px;padding:5px 6px;border:1px solid #d7bde2;border-radius:6px;font-size:12px;text-align:center" />' +
        '<span style="font-size:11px;color:#888">세트</span>' +
        '<button onclick="cpRemoveItem(' + idx + ')" style="padding:4px 8px;background:#fdedec;color:#e74c3c;border:1px solid #f5c6cb;border-radius:5px;cursor:pointer;font-size:11px"><i class="fas fa-times"></i></button>' +
      '</div>';
    } else {
      // 일반 품목
      var stockInfo = '';
      if (row.itemName) {
        var stockMap = whCalcStock();
        var wh = (document.getElementById('cp_warehouse') || {}).value || '';
        var totalQty = 0;
        Object.keys(stockMap).forEach(function(loc) {
          if (wh && !loc.startsWith(wh + '-')) return;
          if (stockMap[loc][row.itemName]) totalQty += Number(stockMap[loc][row.itemName].qty) || 0;
        });
        stockInfo = '<span style="font-size:10px;color:#27ae60;margin-left:4px">재고:' + totalQty + '</span>';
      }
      return '<div style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:#fff5f0;border:1px solid #fdd5c8;border-radius:8px">' +
        '<span style="font-size:11px;font-weight:700;color:#e8551a;white-space:nowrap;min-width:30px"><i class="fas fa-box"></i></span>' +
        '<div style="flex:2;position:relative">' +
          '<input type="text" id="cpItem_name_' + idx + '" value="' + (row.itemName || '') + '" placeholder="품목명 입력..." autocomplete="off" ' +
            'oninput="_cpItemRows[' + idx + '].itemName=this.value;cpItemAutocomplete(this,' + idx + ')" ' +
            'onblur="setTimeout(function(){var d=document.getElementById(\'cpAc_' + idx + '\');if(d)d.style.display=\'none\';},200)" ' +
            'style="width:100%;padding:5px 8px;border:1px solid #fdd5c8;border-radius:6px;font-size:12px;box-sizing:border-box" />' +
          '<div id="cpAc_' + idx + '" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #fdd5c8;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.1);z-index:9999;max-height:180px;overflow-y:auto"></div>' +
          stockInfo +
        '</div>' +
        '<input type="number" min="1" step="1" value="' + (row.qty || 1) + '" oninput="_cpItemRows[' + idx + '].qty=Number(this.value)||1;cpRenderItemList()" style="width:60px;padding:5px 6px;border:1px solid #fdd5c8;border-radius:6px;font-size:12px;text-align:center" />' +
        '<select onchange="_cpItemRows[' + idx + '].unit=this.value" style="padding:5px 6px;border:1px solid #fdd5c8;border-radius:6px;font-size:12px">' +
          ['ea','box','pallet'].map(function(u) { return '<option value="' + u + '"' + (row.unit === u ? ' selected' : '') + '>' + u + '</option>'; }).join('') +
        '</select>' +
        '<button onclick="cpRemoveItem(' + idx + ')" style="padding:4px 8px;background:#fdedec;color:#e74c3c;border:1px solid #f5c6cb;border-radius:5px;cursor:pointer;font-size:11px"><i class="fas fa-times"></i></button>' +
      '</div>';
    }
  }).join('');
}

// ── 품목 자동완성 ────────────────────────────────────────
async function cpItemAutocomplete(inputEl, idx) {
  var q = inputEl.value.trim();
  var ddId = 'cpAc_' + idx;
  var dd = document.getElementById(ddId);
  if (!dd) return;
  if (q.length < 1) { dd.style.display = 'none'; return; }

  var products = _whProductMasterCache || [];
  var matches = products.filter(function(p) {
    return (p.product_name || '').toLowerCase().includes(q.toLowerCase());
  }).slice(0, 12);

  if (matches.length === 0) { dd.style.display = 'none'; return; }

  dd.innerHTML = matches.map(function(p) {
    return '<div onclick="cpSelectItem(' + idx + ',\'' + (p.product_name || '').replace(/'/g, "\\'") + '\')" ' +
      'style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #f0f0f0" ' +
      'onmouseover="this.style.background=\'#fff5f0\'" onmouseout="this.style.background=\'#fff\'">' +
      p.product_name + '</div>';
  }).join('');
  dd.style.display = 'block';
}

function cpSelectItem(idx, name) {
  if (_cpItemRows[idx]) _cpItemRows[idx].itemName = name;
  var inputEl = document.getElementById('cpItem_name_' + idx);
  if (inputEl) inputEl.value = name;
  var dd = document.getElementById('cpAc_' + idx);
  if (dd) dd.style.display = 'none';
  cpRenderItemList();
}

function cpRemoveItem(idx) {
  _cpItemRows.splice(idx, 1);
  cpRenderItemList();
}

// ── 폼 초기화 ──────────────────────────────────────────
function cpResetForm() {
  _cpItemRows = [];
  var fields = ['cp_channel', 'cp_warehouse', 'cp_manager', 'cp_memo'];
  fields.forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
  var dateEl = document.getElementById('cp_out_date');
  if (dateEl) dateEl.value = new Date().toISOString().split('T')[0];
  cpRenderItemList();
}

// ── 예약 저장 ──────────────────────────────────────────
async function cpSaveReservation() {
  var channel = (document.getElementById('cp_channel') || {}).value || '';
  var outDate = (document.getElementById('cp_out_date') || {}).value || '';
  var manager = ((document.getElementById('cp_manager') || {}).value || '').trim();
  var memo = ((document.getElementById('cp_memo') || {}).value || '').trim();
  var warehouse = (document.getElementById('cp_warehouse') || {}).value || '';

  if (!channel) { showToast('채널을 선택해주세요.', 'warning'); return; }
  if (!outDate) { showToast('출고 예약일을 입력해주세요.', 'warning'); return; }
  if (!manager) { showToast('담당자를 입력해주세요.', 'warning'); return; }
  if (_cpItemRows.length === 0) { showToast('출고 품목을 추가해주세요.', 'warning'); return; }

  // 품목 유효성 검사
  for (var i = 0; i < _cpItemRows.length; i++) {
    var row = _cpItemRows[i];
    if (row.type === 'item' && !row.itemName) {
      showToast((i + 1) + '번 품목명을 입력해주세요.', 'warning'); return;
    }
    if (row.type === 'bundle' && !row.bundleId) {
      showToast((i + 1) + '번 번들을 선택해주세요.', 'warning'); return;
    }
    if (!row.qty || row.qty < 1) {
      showToast((i + 1) + '번 항목의 수량을 입력해주세요.', 'warning'); return;
    }
  }

  // 예약 레코드 생성
  var record = {
    channel: channel,
    scheduled_date: outDate,
    warehouse: warehouse,
    manager: manager,
    memo: memo,
    items: JSON.stringify(_cpItemRows),
    status: 'pending',  // pending / done / cancelled
    created_at: Date.now()
  };

  try {
    await apiPost('wh_cp_reservation', record);
    showToast('출고 예약 저장 완료 (' + channel + ' / ' + outDate + ')', 'success');
    cpResetForm();
    await cpLoadReservations();
    cpSwitchTab('pending');
  } catch(e) {
    showToast('예약 저장 실패: ' + e.message, 'error');
  }
}

// ── 대기 목록 렌더링 ────────────────────────────────────
function cpRenderPending() {
  var tbody = document.getElementById('cpPendingBody');
  if (!tbody) return;
  var q = ((document.getElementById('cpPendingSearch') || {}).value || '').toLowerCase();
  var today = new Date().toISOString().split('T')[0];

  var rows = _cpReservationData.filter(function(r) {
    if (r.status !== 'pending') return false;
    if (q && !((r.channel || '').toLowerCase().includes(q) || (r.items || '').toLowerCase().includes(q) || (r.memo || '').toLowerCase().includes(q))) return false;
    return true;
  }).sort(function(a, b) { return (a.scheduled_date || '').localeCompare(b.scheduled_date || ''); });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#aaa;padding:20px">대기 중인 예약이 없습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(function(r) {
    var chIcon = CP_CHANNELS[r.channel] || '';
    var isOverdue = r.scheduled_date < today;
    var isToday = r.scheduled_date === today;
    var statusBadge = isOverdue
      ? '<span style="background:#e74c3c;color:#fff;border-radius:10px;padding:2px 8px;font-size:11px">지연</span>'
      : isToday
        ? '<span style="background:#27ae60;color:#fff;border-radius:10px;padding:2px 8px;font-size:11px">오늘</span>'
        : '<span style="background:#f39c12;color:#fff;border-radius:10px;padding:2px 8px;font-size:11px">대기</span>';

    var items = [];
    try { items = JSON.parse(r.items || '[]'); } catch(e2) {}
    var itemSummary = items.map(function(item) {
      if (item.type === 'bundle') {
        var b = _cpBundleData.find(function(bd) { return bd.id === item.bundleId; });
        return (b ? b.name : '번들') + ' x' + item.qty;
      }
      return (item.itemName || '?') + ' x' + item.qty + (item.unit ? ' ' + item.unit : '');
    }).join(', ');

    return '<tr style="' + (isOverdue ? 'background:#fff5f5' : isToday ? 'background:#f0fff4' : '') + '">' +
      '<td><span style="font-weight:700">' + chIcon + ' ' + (r.channel || '-') + '</span></td>' +
      '<td style="font-weight:700;color:' + (isOverdue ? '#e74c3c' : isToday ? '#27ae60' : '#333') + '">' + (r.scheduled_date || '-') + '</td>' +
      '<td style="font-size:12px;max-width:200px;word-break:break-all">' + itemSummary + '</td>' +
      '<td>' + items.length + '종</td>' +
      '<td>' + (r.warehouse === 'C' ? '❄️저온' : r.warehouse === 'W' ? '🏭일반' : '전체') + '</td>' +
      '<td>' + (r.manager || '-') + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td style="white-space:nowrap">' +
        '<button onclick="cpExecuteReservation(\'' + r.id + '\')" style="padding:4px 8px;background:#27ae60;color:#fff;border:none;border-radius:5px;font-size:11px;cursor:pointer;margin-right:3px"><i class="fas fa-play"></i> 출고</button>' +
        '<button onclick="cpCancelReservation(\'' + r.id + '\')" style="padding:4px 8px;background:#f8f9fa;color:#e74c3c;border:1px solid #f5c6cb;border-radius:5px;font-size:11px;cursor:pointer"><i class="fas fa-times"></i></button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

// ── 출고 이력 렌더링 ────────────────────────────────────
function cpRenderHistory() {
  var tbody = document.getElementById('cpHistBody');
  if (!tbody) return;
  var chFilter = ((document.getElementById('cpHistChannel') || {}).value || '');
  var q = ((document.getElementById('cpHistSearch') || {}).value || '').toLowerCase();

  var rows = _cpReservationData.filter(function(r) {
    if (r.status !== 'done') return false;
    if (chFilter && r.channel !== chFilter) return false;
    if (q && !((r.channel || '').toLowerCase().includes(q) || (r.items || '').toLowerCase().includes(q))) return false;
    return true;
  }).sort(function(a, b) { return (b.executed_date || b.scheduled_date || '').localeCompare(a.executed_date || a.scheduled_date || ''); });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#aaa;padding:20px">출고 이력이 없습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(function(r) {
    var chIcon = CP_CHANNELS[r.channel] || '';
    var items = [];
    try { items = JSON.parse(r.items || '[]'); } catch(e2) {}
    var itemSummary = items.map(function(item) {
      if (item.type === 'bundle') {
        var b = _cpBundleData.find(function(bd) { return bd.id === item.bundleId; });
        return (b ? b.name : '번들') + ' x' + item.qty;
      }
      return (item.itemName || '?') + ' x' + item.qty + (item.unit ? ' ' + item.unit : '');
    }).join(', ');

    return '<tr>' +
      '<td><span style="font-weight:700">' + chIcon + ' ' + (r.channel || '-') + '</span></td>' +
      '<td>' + (r.executed_date || r.scheduled_date || '-') + '</td>' +
      '<td style="font-size:12px;max-width:200px;word-break:break-all">' + itemSummary + '</td>' +
      '<td>' + items.length + '종</td>' +
      '<td>' + (r.warehouse === 'C' ? '❄️저온' : r.warehouse === 'W' ? '🏭일반' : '-') + ' ' + (r.executed_location || '') + '</td>' +
      '<td>' + (r.manager || '-') + '</td>' +
      '<td style="font-size:11px"><code>' + (r.out_lot_nos || '-') + '</code></td>' +
      '<td>' +
        '<button onclick="cpDeleteHistory(\'' + r.id + '\')" style="padding:4px 8px;background:#f8f9fa;color:#e74c3c;border:1px solid #f5c6cb;border-radius:5px;font-size:11px;cursor:pointer"><i class="fas fa-trash"></i></button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

// ── 대기 배지 업데이트 ──────────────────────────────────
function cpUpdatePendingBadge() {
  var badge = document.getElementById('cpPendingBadge');
  if (!badge) return;
  var cnt = _cpReservationData.filter(function(r) { return r.status === 'pending'; }).length;
  badge.textContent = cnt;
  badge.style.display = cnt > 0 ? '' : 'none';
}

// ── 예약 출고 실행 (단건) ────────────────────────────────
async function cpExecuteReservation(id) {
  var reservation = _cpReservationData.find(function(r) { return r.id === id; });
  if (!reservation) { showToast('예약을 찾을 수 없습니다.', 'error'); return; }

  var items = [];
  try { items = JSON.parse(reservation.items || '[]'); } catch(e) {}
  if (items.length === 0) { showToast('출고할 품목이 없습니다.', 'warning'); return; }

  // 번들을 개별 품목으로 펼치기
  var expandedItems = cpExpandItems(items);
  if (expandedItems.length === 0) { showToast('번들 내 품목을 확인해주세요.', 'warning'); return; }

  var today = new Date().toISOString().split('T')[0];
  var outDate = reservation.scheduled_date || today;
  var stockMap = whCalcStock();
  var wh = reservation.warehouse || '';

  // 재고 부족 사전 체크
  var shortages = [];
  expandedItems.forEach(function(item) {
    var totalAvail = 0;
    Object.keys(stockMap).forEach(function(loc) {
      if (wh && !loc.startsWith(wh + '-')) return;
      if (stockMap[loc][item.itemName]) totalAvail += Number(stockMap[loc][item.itemName].qty) || 0;
    });
    if (totalAvail < item.qty) {
      shortages.push(item.itemName + ' (필요:' + item.qty + ', 재고:' + totalAvail + ')');
    }
  });

  if (shortages.length > 0) {
    if (!confirm('재고 부족 항목이 있습니다:\n' + shortages.join('\n') + '\n\n그래도 출고 처리하시겠습니까? (부족분은 0으로 처리됩니다)')) return;
  }

  var chIcon = CP_CHANNELS[reservation.channel] || '';
  if (!confirm(chIcon + ' ' + reservation.channel + ' 출고 예약을 실행합니다.\n예약일: ' + outDate + '\n품목 ' + expandedItems.length + '종\n\n계속하시겠습니까?')) return;

  try {
    var lotNos = [];
    var locations = [];

    for (var i = 0; i < expandedItems.length; i++) {
      var item = expandedItems[i];
      // FIFO: 소비기한 짧은 순으로 위치 선택
      var bestLoc = cpFindBestLocation(stockMap, item.itemName, item.qty, wh);
      if (!bestLoc) continue;

      // Lot No 생성
      var dateShort = outDate.replace(/-/g, '').slice(2);
      var prefix = 'CP-' + (reservation.channel || 'OUT').slice(0, 2).toUpperCase() + '-' + dateShort;
      var existingLots = whOutboundData.filter(function(r) { return r.lot_no && r.lot_no.startsWith(prefix); });
      var seq = existingLots.length + lotNos.length + 1;
      var lotNo = prefix + '-' + String(seq).padStart(3, '0');

      var outRecord = {
        lot_no: lotNo,
        outbound_date: outDate,
        warehouse: bestLoc.charAt(0),
        location: bestLoc,
        item_name: item.itemName,
        qty: item.qty,
        unit: item.unit || 'ea',
        destination: '쿠팡 ' + (reservation.channel || ''),
        manager: reservation.manager || '',
        memo: '[쿠팡 ' + reservation.channel + '] ' + (reservation.memo || '') + (item.bundleName ? ' (번들:' + item.bundleName + ')' : ''),
        created_at: Date.now()
      };

      await apiPost('wh_outbound', outRecord);
      lotNos.push(lotNo);
      locations.push(bestLoc);

      // stockMap 즉시 업데이트 (다음 품목 처리 시 반영)
      if (!stockMap[bestLoc]) stockMap[bestLoc] = {};
      if (!stockMap[bestLoc][item.itemName]) stockMap[bestLoc][item.itemName] = { qty: 0 };
      stockMap[bestLoc][item.itemName].qty -= item.qty;
    }

    // 예약 상태 업데이트
    var updatedRes = Object.assign({}, reservation, {
      status: 'done',
      executed_date: today,
      out_lot_nos: lotNos.join(', '),
      executed_location: [...new Set(locations)].join(', ')
    });
    var resId = updatedRes.id;
    delete updatedRes.id;
    await apiPut('wh_cp_reservation', resId, updatedRes);

    showToast('쿠팡 ' + reservation.channel + ' 출고 완료 (' + lotNos.length + '건 Lot 생성)', 'success');
    whInvalidateMapCache();
    await whReloadAll();
    await cpLoadReservations();
    cpSwitchTab('history');
  } catch(e) {
    showToast('출고 실패: ' + e.message, 'error');
  }
}

// ── FIFO 최적 위치 찾기 ──────────────────────────────────
function cpFindBestLocation(stockMap, itemName, qty, warehouseFilter) {
  var bestLoc = null;
  var bestExpiry = '9999-99-99';
  Object.keys(stockMap).forEach(function(loc) {
    if (warehouseFilter && !loc.startsWith(warehouseFilter + '-')) return;
    var info = stockMap[loc][itemName];
    if (!info || info.qty <= 0) return;
    var exp = info.expiry || '9999-99-99';
    if (!bestLoc || exp < bestExpiry) {
      bestLoc = loc;
      bestExpiry = exp;
    }
  });
  return bestLoc;
}

// ── 번들 → 개별 품목 펼치기 ────────────────────────────
function cpExpandItems(items) {
  var result = [];
  items.forEach(function(item) {
    if (item.type === 'bundle') {
      var bundle = _cpBundleData.find(function(b) { return b.id === item.bundleId; });
      if (!bundle || !bundle.components) return;
      bundle.components.forEach(function(comp) {
        result.push({
          itemName: comp.itemName,
          qty: (Number(comp.qty) || 1) * (Number(item.qty) || 1),
          unit: comp.unit || 'ea',
          bundleName: bundle.name
        });
      });
    } else {
      result.push({
        itemName: item.itemName,
        qty: Number(item.qty) || 1,
        unit: item.unit || 'ea'
      });
    }
  });
  return result;
}

// ── 예약 취소 ──────────────────────────────────────────
async function cpCancelReservation(id) {
  if (!confirm('이 예약을 취소하시겠습니까?')) return;
  var reservation = _cpReservationData.find(function(r) { return r.id === id; });
  if (!reservation) return;
  var updated = Object.assign({}, reservation, { status: 'cancelled' });
  var rId = updated.id; delete updated.id;
  try {
    await apiPut('wh_cp_reservation', rId, updated);
    showToast('예약이 취소되었습니다.', 'success');
    await cpLoadReservations();
  } catch(e) {
    showToast('취소 실패: ' + e.message, 'error');
  }
}

// ── 이력 삭제 ──────────────────────────────────────────
async function cpDeleteHistory(id) {
  if (!confirm('이 이력을 삭제하시겠습니까?')) return;
  try {
    await apiDelete('wh_cp_reservation', id);
    showToast('삭제 완료', 'success');
    await cpLoadReservations();
  } catch(e) {
    showToast('삭제 실패: ' + e.message, 'error');
  }
}

// ── 오늘 예약 자동 출고 실행 ────────────────────────────
async function cpRunScheduledOut() {
  var today = new Date().toISOString().split('T')[0];
  var dueReservations = _cpReservationData.filter(function(r) {
    return r.status === 'pending' && r.scheduled_date <= today;
  });

  if (dueReservations.length === 0) {
    showToast('오늘 이전 예약된 출고가 없습니다.', 'info');
    return;
  }

  if (!confirm('오늘까지 예약된 출고 ' + dueReservations.length + '건을 자동 처리합니다.\n\n계속하시겠습니까?')) return;

  var successCount = 0;
  var failCount = 0;

  for (var i = 0; i < dueReservations.length; i++) {
    try {
      await cpExecuteReservationSilent(dueReservations[i]);
      successCount++;
    } catch(e) {
      failCount++;
      console.error('[쿠팡 자동출고] 실패:', dueReservations[i].id, e);
    }
  }

  var msg = '자동 출고 완료: ' + successCount + '건 성공';
  if (failCount > 0) msg += ', ' + failCount + '건 실패';
  showToast(msg, failCount > 0 ? 'warning' : 'success');
  whInvalidateMapCache();
  await whReloadAll();
  await cpLoadReservations();
}

// ── 자동 출고 (confirm 없이) ────────────────────────────
async function cpExecuteReservationSilent(reservation) {
  var items = [];
  try { items = JSON.parse(reservation.items || '[]'); } catch(e) {}
  var expandedItems = cpExpandItems(items);
  if (expandedItems.length === 0) return;

  var today = new Date().toISOString().split('T')[0];
  var outDate = reservation.scheduled_date || today;
  var stockMap = whCalcStock();
  var wh = reservation.warehouse || '';
  var lotNos = [];
  var locations = [];

  for (var i = 0; i < expandedItems.length; i++) {
    var item = expandedItems[i];
    var bestLoc = cpFindBestLocation(stockMap, item.itemName, item.qty, wh);
    if (!bestLoc) continue;

    var dateShort = outDate.replace(/-/g, '').slice(2);
    var prefix = 'CP-' + (reservation.channel || 'OUT').slice(0, 2).toUpperCase() + '-' + dateShort;
    var existingLots = whOutboundData.filter(function(r) { return r.lot_no && r.lot_no.startsWith(prefix); });
    var seq = existingLots.length + lotNos.length + 1;
    var lotNo = prefix + '-' + String(seq).padStart(3, '0');

    await apiPost('wh_outbound', {
      lot_no: lotNo,
      outbound_date: outDate,
      warehouse: bestLoc.charAt(0),
      location: bestLoc,
      item_name: item.itemName,
      qty: item.qty,
      unit: item.unit || 'ea',
      destination: '쿠팡 ' + (reservation.channel || ''),
      manager: reservation.manager || '',
      memo: '[쿠팡 ' + reservation.channel + ' 자동출고] ' + (reservation.memo || '') + (item.bundleName ? ' (번들:' + item.bundleName + ')' : ''),
      created_at: Date.now()
    });
    lotNos.push(lotNo);
    locations.push(bestLoc);

    if (!stockMap[bestLoc]) stockMap[bestLoc] = {};
    if (!stockMap[bestLoc][item.itemName]) stockMap[bestLoc][item.itemName] = { qty: 0 };
    stockMap[bestLoc][item.itemName].qty -= item.qty;
  }

  var updatedRes = Object.assign({}, reservation, {
    status: 'done',
    executed_date: today,
    out_lot_nos: lotNos.join(', '),
    executed_location: [...new Set(locations)].join(', ')
  });
  var resId = updatedRes.id; delete updatedRes.id;
  await apiPut('wh_cp_reservation', resId, updatedRes);
}

// ── 번들 관리 모달 ──────────────────────────────────────
function cpShowBundleModal() {
  var modalId = 'cpBundleModal';
  var existing = document.getElementById(modalId);
  if (existing) existing.remove();

  var m = document.createElement('div');
  m.id = modalId;
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
  m.innerHTML =
    '<div style="background:#fff;border-radius:14px;width:100%;max-width:600px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.2)">' +
      '<div style="background:linear-gradient(135deg,#8e44ad,#6c3483);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:1">' +
        '<h3 style="color:#fff;font-size:15px;margin:0"><i class="fas fa-layer-group"></i> 번들 관리</h3>' +
        '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer">&times;</button>' +
      '</div>' +
      '<div style="padding:16px">' +
        '<div style="font-size:12px;color:#888;margin-bottom:14px">번들은 여러 제품을 묶어 하나의 SKU로 출고하는 방식입니다. 동일 제품 또는 다른 제품끼리 묶을 수 있습니다.</div>' +
        '<!-- 번들 등록 폼 -->' +
        '<div style="background:#f9f0ff;border:1px solid #e0c8f0;border-radius:10px;padding:14px;margin-bottom:16px">' +
          '<div style="font-size:13px;font-weight:700;color:#6c3483;margin-bottom:10px"><i class="fas fa-plus-circle"></i> 새 번들 등록</div>' +
          '<div style="margin-bottom:10px">' +
            '<label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:4px">번들명 <span style="color:#e74c3c">*</span></label>' +
            '<input type="text" id="cpBundleName" placeholder="예) 샤오커 오라비타팝스 1+2" style="width:100%;padding:8px 10px;border:1.5px solid #ddd;border-radius:8px;font-size:13px;box-sizing:border-box" />' +
          '</div>' +
          '<div id="cpBundleComponents" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px">' +
            cpRenderBundleCompRow(0) +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-bottom:10px">' +
            '<button onclick="cpAddBundleComp()" style="padding:6px 12px;background:#f5eef8;color:#8e44ad;border:1px solid #d7bde2;border-radius:6px;font-size:12px;cursor:pointer"><i class="fas fa-plus"></i> 구성 추가</button>' +
          '</div>' +
          '<button onclick="cpSaveBundle()" style="width:100%;padding:10px;background:#8e44ad;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700"><i class="fas fa-save"></i> 번들 저장</button>' +
        '</div>' +
        '<!-- 등록된 번들 목록 -->' +
        '<div style="font-size:13px;font-weight:700;color:#555;margin-bottom:8px">등록된 번들 (' + _cpBundleData.length + '개)</div>' +
        '<div id="cpBundleList">' + cpRenderBundleListHtml() + '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(m);
}

// ── 번들 구성 행 HTML ────────────────────────────────────
var _cpBundleCompCount = 1;
function cpRenderBundleCompRow(idx) {
  return '<div id="cpBundleComp_' + idx + '" style="display:flex;align-items:center;gap:6px;padding:8px;background:#fff;border:1px solid #e0c8f0;border-radius:6px">' +
    '<span style="font-size:11px;color:#888;min-width:20px">' + (idx + 1) + '</span>' +
    '<div style="flex:2;position:relative">' +
      '<input type="text" id="cpBcName_' + idx + '" placeholder="제품명 입력..." autocomplete="off" ' +
        'oninput="cpBundleCompAc(this,' + idx + ')" ' +
        'onblur="setTimeout(function(){var d=document.getElementById(\'cpBcAc_' + idx + '\');if(d)d.style.display=\'none\';},200)" ' +
        'style="width:100%;padding:5px 8px;border:1px solid #e0c8f0;border-radius:6px;font-size:12px;box-sizing:border-box" />' +
      '<div id="cpBcAc_' + idx + '" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #e0c8f0;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.1);z-index:9999;max-height:180px;overflow-y:auto"></div>' +
    '</div>' +
    '<input type="number" id="cpBcQty_' + idx + '" min="1" step="1" value="1" style="width:55px;padding:5px 6px;border:1px solid #e0c8f0;border-radius:6px;font-size:12px;text-align:center" />' +
    '<select id="cpBcUnit_' + idx + '" style="padding:5px 6px;border:1px solid #e0c8f0;border-radius:6px;font-size:12px">' +
      '<option value="ea">ea</option><option value="box">box</option>' +
    '</select>' +
    (idx > 0 ? '<button onclick="cpRemoveBundleComp(' + idx + ')" style="padding:4px 7px;background:#fdedec;color:#e74c3c;border:1px solid #f5c6cb;border-radius:5px;cursor:pointer;font-size:11px"><i class="fas fa-times"></i></button>' : '<span style="width:28px"></span>') +
  '</div>';
}

function cpAddBundleComp() {
  var container = document.getElementById('cpBundleComponents');
  if (!container) return;
  var idx = container.children.length;
  _cpBundleCompCount = idx + 1;
  var div = document.createElement('div');
  div.innerHTML = cpRenderBundleCompRow(idx);
  container.appendChild(div.firstElementChild);
}

function cpRemoveBundleComp(idx) {
  var el = document.getElementById('cpBundleComp_' + idx);
  if (el) el.remove();
}

function cpBundleCompAc(inputEl, idx) {
  var q = inputEl.value.trim();
  var ddId = 'cpBcAc_' + idx;
  var dd = document.getElementById(ddId);
  if (!dd) return;
  if (q.length < 1) { dd.style.display = 'none'; return; }
  var products = _whProductMasterCache || [];
  var matches = products.filter(function(p) { return (p.product_name || '').toLowerCase().includes(q.toLowerCase()); }).slice(0, 10);
  if (matches.length === 0) { dd.style.display = 'none'; return; }
  dd.innerHTML = matches.map(function(p) {
    return '<div onclick="document.getElementById(\'cpBcName_' + idx + '\').value=\'' + (p.product_name || '').replace(/'/g, "\\'") + '\';document.getElementById(\'cpBcAc_' + idx + '\').style.display=\'none\'" ' +
      'style="padding:7px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid #f0f0f0" ' +
      'onmouseover="this.style.background=\'#f5eef8\'" onmouseout="this.style.background=\'#fff\'">' +
      p.product_name + '</div>';
  }).join('');
  dd.style.display = 'block';
}

function cpSaveBundle() {
  var nameEl = document.getElementById('cpBundleName');
  var name = nameEl ? nameEl.value.trim() : '';
  if (!name) { showToast('번들명을 입력해주세요.', 'warning'); return; }

  // 구성 수집
  var container = document.getElementById('cpBundleComponents');
  var components = [];
  if (container) {
    var rows = container.querySelectorAll('[id^="cpBundleComp_"]');
    rows.forEach(function(row) {
      var idx = row.id.replace('cpBundleComp_', '');
      var nameInput = document.getElementById('cpBcName_' + idx);
      var qtyInput = document.getElementById('cpBcQty_' + idx);
      var unitInput = document.getElementById('cpBcUnit_' + idx);
      if (nameInput && nameInput.value.trim()) {
        components.push({
          itemName: nameInput.value.trim(),
          qty: Number((qtyInput || {}).value) || 1,
          unit: (unitInput || {}).value || 'ea'
        });
      }
    });
  }

  if (components.length === 0) { showToast('구성 제품을 최소 1개 이상 입력해주세요.', 'warning'); return; }

  var bundle = {
    id: 'bundle_' + Date.now(),
    name: name,
    components: components,
    created_at: Date.now()
  };

  _cpBundleData.push(bundle);
  localStorage.setItem(CP_BUNDLE_KEY, JSON.stringify(_cpBundleData));

  showToast('번들 저장 완료: ' + name, 'success');

  // 모달 내 목록 업데이트
  var listEl = document.getElementById('cpBundleList');
  if (listEl) listEl.innerHTML = cpRenderBundleListHtml();
  var countEl = document.querySelector('#cpBundleModal div[style*="font-size:13px;font-weight:700"]');
  if (countEl) countEl.textContent = '등록된 번들 (' + _cpBundleData.length + '개)';

  // 폼 초기화
  if (nameEl) nameEl.value = '';
  var compContainer = document.getElementById('cpBundleComponents');
  if (compContainer) compContainer.innerHTML = cpRenderBundleCompRow(0);

  // 번들 미리보기 업데이트
  cpRenderBundlePreview();
}

function cpRenderBundleListHtml() {
  if (_cpBundleData.length === 0) {
    return '<div style="text-align:center;color:#bbb;padding:20px;font-size:12px">등록된 번들이 없습니다.</div>';
  }
  return _cpBundleData.map(function(b) {
    var compHtml = (b.components || []).map(function(c) {
      return '<span style="background:#f0e6ff;color:#6c3483;border-radius:4px;padding:1px 6px;font-size:11px;margin-right:3px">' + c.itemName + ' x' + c.qty + '</span>';
    }).join('');
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#fff;border:1px solid #e0c8f0;border-radius:8px;margin-bottom:6px">' +
      '<div>' +
        '<div style="font-size:13px;font-weight:700;color:#333;margin-bottom:4px">' + b.name + '</div>' +
        '<div>' + compHtml + '</div>' +
      '</div>' +
      '<button onclick="cpDeleteBundle(\'' + b.id + '\')" style="padding:5px 9px;background:#fdedec;color:#e74c3c;border:1px solid #f5c6cb;border-radius:6px;font-size:11px;cursor:pointer;white-space:nowrap"><i class="fas fa-trash"></i></button>' +
    '</div>';
  }).join('');
}

function cpDeleteBundle(id) {
  if (!confirm('이 번들을 삭제하시겠습니까?')) return;
  _cpBundleData = _cpBundleData.filter(function(b) { return b.id !== id; });
  localStorage.setItem(CP_BUNDLE_KEY, JSON.stringify(_cpBundleData));
  var listEl = document.getElementById('cpBundleList');
  if (listEl) listEl.innerHTML = cpRenderBundleListHtml();
  cpRenderBundlePreview();
  showToast('번들이 삭제되었습니다.', 'success');
}

function cpRenderBundlePreview() {
  var el = document.getElementById('cpBundlePreview');
  if (!el) return;
  if (_cpBundleData.length === 0) {
    el.innerHTML = '<div style="text-align:center;color:#bbb;padding:20px;font-size:12px">번들 관리 버튼을 눌러 번들을 등록하세요.</div>';
    return;
  }
  el.innerHTML = _cpBundleData.map(function(b) {
    var compHtml = (b.components || []).map(function(c) {
      return c.itemName + ' x' + c.qty;
    }).join(' + ');
    return '<div style="padding:8px 10px;background:#fff;border:1px solid #e0c8f0;border-radius:7px;margin-bottom:5px">' +
      '<div style="font-size:12px;font-weight:700;color:#6c3483">' + b.name + '</div>' +
      '<div style="font-size:11px;color:#888;margin-top:2px">' + compHtml + '</div>' +
    '</div>';
  }).join('');
}

// ── wh_out 탭 활성화 시 쿠팡 섹션 초기화 ──────────────────
function cpInitOnTabSwitch() {
  if (typeof cpInit === 'function') cpInit();
}
