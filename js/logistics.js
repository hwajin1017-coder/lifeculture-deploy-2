// =====================================================
// 물류관리 JS (수입제품 / OEM제품 / 자체생산 구분)
// =====================================================

var allLogisticsData = [];
var lgEditingId = null;
var lgEditingSource = 'logistics'; // 'logistics' | 'wh_outbound'
var allWhInboundData = [];   // 창고 입고 데이터 (wh_inbound)
var allWhOutboundData = [];  // 창고 출고 데이터 (wh_outbound)

document.addEventListener('DOMContentLoaded', async () => {
  // new Date() 1회 생성 후 재사용
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');

  const dateEl = document.getElementById('lg_date');
  if (dateEl) dateEl.value = today;
  // 전체현황 기본 기간 (이번달)
  const fromEl = document.getElementById('allDateFrom');
  const toEl = document.getElementById('allDateTo');
  if (fromEl) fromEl.value = `${y}-${m}-01`;
  if (toEl) toEl.value = today;

  // LotNo 생성 (날짜기반 임시 LotNo, 데이터 로드 없이 즉시 생성)
  await lgRefreshLotNoFast();
  // logistics 데이터 직접 로드 (warehouse-mgmt.js 의존 제거)
  await loadLogisticsData();

  const form = document.getElementById('logisticsForm');
  if (form) form.addEventListener('submit', lgHandleSubmit);

  // InventoryStore 이벤트 리스너 - 창고 입출고 후 재고 현황 자동 갱신 (개선 5)
  if (window.InventoryStore) {
    window.InventoryStore.on('warehouse:updated', function(detail) {
      // 창고 데이터가 변경되면 logistics.js 전역 변수도 동기화
      if (detail && detail.wh_inbound) allWhInboundData = detail.wh_inbound;
      if (detail && detail.wh_outbound) allWhOutboundData = detail.wh_outbound;
      // 재고 현황 테이블 즉시 갱신
      if (typeof lgRenderStockTable === 'function') lgRenderStockTable();
      lgUpdateKpiCards();
    });
  }
});

// =====================================================
// Lot No 자동생성
// =====================================================
// 빠른 버전: Firestore 조회 없이 날짜+랜덤으로 임시 LotNo 생성 (데이터 로드 후 정확한 번호로 교체)
async function lgRefreshLotNoFast() {
  const display = document.getElementById('lgLotDisplay');
  if (!display) return;
  display.textContent = '생성 중...';
  const type = document.getElementById('lg_transaction_type')?.value || 'IN';
  const prodType = document.getElementById('lg_product_type')?.value || '';
  const typeCode = type === '입고' ? 'IN' : type === '출고' ? 'OUT' : type === '반품' ? 'RET' : 'ADJ';
  const prodCode = prodType === '수입제품' ? 'IMP' : prodType === 'OEM제품' ? 'OEM' : prodType === '자체생산' ? 'OWN' : 'LOG';
  const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '').slice(2);
  const rand = String(Math.floor(Math.random() * 900) + 100);
  const lot = `LG-${prodCode}-${typeCode}-${dateStr}-${rand}`;
  display.textContent = lot;
  display.dataset.lot = lot;
}

async function lgRefreshLotNo() {
  const display = document.getElementById('lgLotDisplay');
  if (!display) return;
  display.textContent = '생성 중...';
  const lot = await lgGenerateLotNo();
  display.textContent = lot;
  display.dataset.lot = lot;
}

async function lgGenerateLotNo() {
  try {
    const type = document.getElementById('lg_transaction_type')?.value || 'IN';
    const prodType = document.getElementById('lg_product_type')?.value || '';
    const typeCode = type === '입고' ? 'IN' : type === '출고' ? 'OUT' : type === '반품' ? 'RET' : 'ADJ';
    const prodCode = prodType === '수입제품' ? 'IMP' : prodType === 'OEM제품' ? 'OEM' : prodType === '자체생산' ? 'OWN' : 'LOG';
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '').slice(2);
    // 캐시 사용 (Firestore 재조회 없음 - 성능 최적화)
    const data = (typeof allLogisticsData !== 'undefined') ? allLogisticsData : [];
    const prefix = `LG-${prodCode}-${typeCode}-${dateStr}`;
    const todayLots = data.filter(r => r.lot_no && r.lot_no.startsWith(prefix));
    const seq = String(todayLots.length + 1).padStart(3, '0');
    return `${prefix}-${seq}`;
  } catch(e) {
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '').slice(2);
    const rand = String(Math.floor(Math.random() * 999) + 1).padStart(3, '0');
    return `LG-LOG-IN-${dateStr}-${rand}`;
  }
}

// =====================================================
// 거래유형 변경
// =====================================================
async function lgHandleTransactionType() {
  await lgRefreshLotNo();
  const type = document.getElementById('lg_transaction_type')?.value;
  const statusEl = document.getElementById('lg_status');
  if (statusEl) {
    if (type === '입고') statusEl.value = '입고완료';
    else if (type === '출고') statusEl.value = '출고완료';
    else if (type === '반품') statusEl.value = '반품';
  }
}

// =====================================================
// 제품유형 변경 → 전용 섹션 표시
// =====================================================
function lgShowProductSections() {
  const prodType = document.getElementById('lg_product_type')?.value;
  const importSec = document.getElementById('lg_import_section');
  const oemSec = document.getElementById('lg_oem_section');
  const ownSec = document.getElementById('lg_own_section');
  if (importSec) importSec.style.display = prodType === '수입제품' ? '' : 'none';
  if (oemSec) oemSec.style.display = prodType === 'OEM제품' ? '' : 'none';
  if (ownSec) ownSec.style.display = prodType === '자체생산' ? '' : 'none';
}

// =====================================================
// 금액 자동계산
// =====================================================
function lgCalcAmount() {
  const qty = parseFloat(document.getElementById('lg_quantity')?.value) || 0;
  const price = parseFloat(document.getElementById('lg_unit_price')?.value) || 0;
  const totalEl = document.getElementById('lg_total_amount');
  if (totalEl) totalEl.value = (qty * price).toFixed(0);
}

// =====================================================
// 데이터 로드
// =====================================================
// 스켈레톤 행 생성 헬퍼
function lgSkeletonRows(cols, count) {
  count = count || 5;
  var rows = '';
  for (var i = 0; i < count; i++) {
    rows += '<tr class="skeleton-row">';
    for (var j = 0; j < cols; j++) {
      var w = (j === 0) ? '60%' : (j === cols-1) ? '40%' : '80%';
      rows += '<td><div class="skeleton skeleton-cell" style="width:' + w + '"></div></td>';
    }
    rows += '</tr>';
  }
  return rows;
}

async function loadLogisticsData() {
  try {
    // logistics, wh_inbound, wh_outbound, products 병렬 조회
    const results = await Promise.all([
      apiGetAll('logistics'),
      apiGetAll('wh_inbound'),
      apiGetAll('wh_outbound'),
      apiGetAll('products')
    ]);
    allLogisticsData = (results[0] || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    allWhInboundData = results[1] || [];
    allWhOutboundData = results[2] || [];
    // 제품마스터 캐시 선로딩 (환산 표시용)
    _lgProductCache = results[3] || [];
    // warehouse-mgmt.js 전역 변수도 동기화 (입출고 등록 후 whLoadAll 호출 시 일치하도록)
    if (typeof whInboundData !== 'undefined') whInboundData = allWhInboundData;
    if (typeof whOutboundData !== 'undefined') whOutboundData = allWhOutboundData;
    // InventoryStore 공유 스토어에 저장 (모듈 간 데이터 공유)
    if (window.InventoryStore) {
      window.InventoryStore.setAll({
        logistics: allLogisticsData,
        wh_inbound: allWhInboundData,
        wh_outbound: allWhOutboundData
      });
    }
    lgUpdateKpiCards();
    // 성능 개선: 현재 활성 탭만 렌더링 (비활성 탭은 탭 전환 시 렌더링)
    const activeTab = document.querySelector('.tab-btn.active');
    const activeTabId = activeTab ? activeTab.id : 'tabAll';
    const tabMap = { 'tabImport': 'import', 'tabOem': 'oem', 'tabOwn': 'own', 'tabAll': 'all',
                     'tabWhMap': 'wh_map', 'tabWhIn': 'wh_in', 'tabWhOut': 'wh_out', 'tabWhStocktake': 'wh_stocktake' };
    const currentTab = tabMap[activeTabId] || 'all';
    if (['import','oem','own','all'].includes(currentTab)) {
      lgFilterTable(currentTab);
    }
    // 재고현황은 탭에 관계없이 항상 갱신 (스켈레톤 상태로 멈추는 문제 해결)
    if (typeof lgRenderStockTable === 'function') lgRenderStockTable();
    // LotNo는 캐시 기반으로만 갱신 (Firestore 재조회 없음)
  } catch(e) {
    console.error('[logistics] 데이터 로드 실패:', e);
    // 오류 시 재시도 버튼과 함께 오류 메시지 표시 (로딩 고착 방지)
    var errMsg = '<tr><td colspan="8" style="text-align:center;padding:30px">' +
      '<div style="color:#e74c3c;margin-bottom:10px"><i class="fas fa-exclamation-triangle"></i> 데이터를 불러오지 못했습니다.</div>' +
      '<button onclick="loadLogisticsData()" style="padding:6px 16px;background:#2ecc71;color:#fff;border:none;border-radius:4px;cursor:pointer">다시 시도</button>' +
      '</td></tr>';
    var errMsg11 = errMsg.replace('colspan="8"', 'colspan="11"');
    var tbodies = ['stockTableBody','allTableBody','importTableBody','oemTableBody','ownTableBody'];
    tbodies.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = id === 'allTableBody' ? errMsg11 : errMsg;
    });
    if (typeof showToast === 'function') showToast('데이터 로드 실패. 네트워크 연결을 확인해 주세요.', 'error');
  }
}

// =====================================================
// KPI 카드 업데이트
// =====================================================
function lgUpdateKpiCards() {
  // logistics 콜렉션 기준 (WH-IN- 동기화 기록 제외)
  const lgFiltered = allLogisticsData.filter(r => !(r.lot_no || '').startsWith('WH-IN-'));
  // wh_inbound 데이터를 logistics 형식으로 변환
  const whInRows = (allWhInboundData || []).map(r => ({
    product_type: r.inbound_type || '수입제품',
    status: '입고완료',
    transaction_type: '입고'
  }));
  const allCombined = [...lgFiltered, ...whInRows];
  const importCount = allCombined.filter(r => r.product_type === '수입제품').length;
  const oemCount = allCombined.filter(r => r.product_type === 'OEM제품' || r.product_type === 'OEM').length;
  const ownCount = allCombined.filter(r => r.product_type === '자체생산').length;
  const pendingCount = allLogisticsData.filter(r => r.status === '입고대기').length;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('kpi_import', importCount.toLocaleString());
  set('kpi_oem', oemCount.toLocaleString());
  set('kpi_own', ownCount.toLocaleString());
  set('kpi_pending', pendingCount.toLocaleString());
}

// =====================================================
// 테이블 필터 및 렌더링
// =====================================================
function lgFilterTable(tab) {
  const isMobile = window.innerWidth <= 768;
  if (tab === 'import') {
    const q = (document.getElementById('importSearch')?.value || '').toLowerCase();
    const sf = document.getElementById('importStatusFilter')?.value || '';
    const data = allLogisticsData.filter(r =>
      r.product_type === '수입제품' &&
      (!q || (r.product_name || '').toLowerCase().includes(q)) &&
      (!sf || r.status === sf)
    ).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (isMobile) {
      lgShowMobileCard('importCardView', 'importTableWrap', data, 'import');
    } else {
      lgShowDesktopTable('importCardView', 'importTableWrap');
      lgRenderTable('importTableBody', data, 'import');
    }
    const el = document.getElementById('importCount');
    if (el) el.textContent = `${data.length}건`;
  } else if (tab === 'oem') {
    const q = (document.getElementById('oemSearch')?.value || '').toLowerCase();
    const sf = document.getElementById('oemStatusFilter')?.value || '';
    const data = allLogisticsData.filter(r =>
      r.product_type === 'OEM제품' &&
      (!q || (r.product_name || '').toLowerCase().includes(q)) &&
      (!sf || r.status === sf)
    ).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (isMobile) {
      lgShowMobileCard('oemCardView', 'oemTableWrap', data, 'oem');
    } else {
      lgShowDesktopTable('oemCardView', 'oemTableWrap');
      lgRenderTable('oemTableBody', data, 'oem');
    }
    const el = document.getElementById('oemCount');
    if (el) el.textContent = `${data.length}건`;
  } else if (tab === 'own') {
    const q = (document.getElementById('ownSearch')?.value || '').toLowerCase();
    const sf = document.getElementById('ownStatusFilter')?.value || '';
    const data = allLogisticsData.filter(r =>
      r.product_type === '자체생산' &&
      (!q || (r.product_name || '').toLowerCase().includes(q)) &&
      (!sf || r.status === sf)
    ).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (isMobile) {
      lgShowMobileCard('ownCardView', 'ownTableWrap', data, 'own');
    } else {
      lgShowDesktopTable('ownCardView', 'ownTableWrap');
      lgRenderTable('ownTableBody', data, 'own');
    }
    const el = document.getElementById('ownCount');
    if (el) el.textContent = `${data.length}건`;
  } else if (tab === 'all') {
    const q = (document.getElementById('allSearch')?.value || '').toLowerCase();
    const typeF = document.getElementById('allTypeFilter')?.value || '';
    const txF = document.getElementById('allTxFilter')?.value || '';
    const from = document.getElementById('allDateFrom')?.value || '';
    const to = document.getElementById('allDateTo')?.value || '';
    // logistics 콜렉션에서 WH-OUT- / WH-IN- 창고 동기화 기록 제외
    // 창고 입/출고는 wh_inbound / wh_outbound에서만 표시 (단일 진실 공급원)
    const lgFiltered = allLogisticsData.filter(r => !(r.lot_no || '').startsWith('WH-OUT-') && !(r.lot_no || '').startsWith('WH-IN-'));
    // wh_inbound 전체를 logistics 형식으로 변환
    const whInRows = (allWhInboundData || []).map(r => ({
      id: r.id,
      lot_no: r.lot_no || r.id || '',
      product_type: r.inbound_type || '수입제품',
      transaction_type: '입고',
      date: r.inbound_date || r.date || '',
      product_name: r.item_name || '',
      quantity: Number(r.qty) || 0,
      unit: r.unit || 'ea',
      total_amount: null,
      expiry_date: r.expiry_date || '',
      status: '입고완료',
      manager: r.manager || '',
      notes: r.memo || '',
      _from_wh_inbound: true
    }));
    // wh_outbound 전체를 logistics 형식으로 변환
    // wh_inbound 데이터를 lot_no 기준으로 인덱싱 (product_type 연동용)
    const _whInMap = {};
    (allWhInboundData || []).forEach(r => { if (r.lot_no) _whInMap[r.lot_no] = r; });
    const whOutRows = (allWhOutboundData || []).map(r => {
      // product_type 우선순위: 1) 직접 저장된 값 2) ref_lot로 입고 레코드에서 가져오기 3) 없으면 null
      var ptype = r.product_type || null;
      if (!ptype && r.ref_lot && _whInMap[r.ref_lot]) {
        ptype = _whInMap[r.ref_lot].inbound_type || null;
      }
      return {
        id: r.id,
        lot_no: r.lot_no || r.id || '',
        product_type: ptype || '',
        transaction_type: '출고',
        date: r.outbound_date || r.out_date || r.date || '',
        product_name: r.item_name || '',
        quantity: r.qty,
        unit: r.unit || 'ea',
        total_amount: null,
        expiry_date: r.expiry_date || '',
        status: '출고완료',
        manager: r.manager || '',
        notes: r.destination || r.memo || '',
        _from_wh_outbound: true
      };
    });
    const combined = [...lgFiltered, ...whInRows, ...whOutRows];
    const data = combined.filter(r =>
      (!q || (r.product_name || '').toLowerCase().includes(q)) &&
      (!typeF || r.product_type === typeF) &&
      (!txF || r.transaction_type === txF) &&
      (!from || (r.date || '') >= from) &&
      (!to || (r.date || '') <= to)
    ).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (isMobile) {
      lgShowMobileCard('allCardView', 'allTableWrap', data, 'all');
    } else {
      lgShowDesktopTable('allCardView', 'allTableWrap');
      lgRenderTable('allTableBody', data, 'all');
    }
    const el = document.getElementById('allCount');
    const el2 = document.getElementById('allResultCount');
    if (el) el.textContent = `${data.length}건`;
    if (el2) el2.textContent = `${data.length}건 조회됨`;
  }
}

function lgShowMobileCard(cardId, tableWrapId, data, tab) {
  const card = document.getElementById(cardId);
  const wrap = document.getElementById(tableWrapId);
  if (card) { card.style.display = 'block'; lgRenderCardView(cardId, data, tab); }
  if (wrap) wrap.style.display = 'none';
}

function lgShowDesktopTable(cardId, tableWrapId) {
  const card = document.getElementById(cardId);
  const wrap = document.getElementById(tableWrapId);
  if (card) card.style.display = 'none';
  if (wrap) wrap.style.display = 'block';
}

// ── 모바일 카드뷰 렌더링 (데스크탑은 기존 테이블 유지) ──
function lgRenderCardView(containerId, data, tab) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!data.length) {
    container.innerHTML = '<div style="text-align:center;padding:32px;color:#aaa"><i class="fas fa-inbox" style="font-size:32px;display:block;margin-bottom:8px"></i>등록된 내역이 없습니다.</div>';
    return;
  }
  const txColor = { '입고': '#27ae60', '출고': '#e74c3c', '반품': '#e67e22', '조정': '#8e44ad' };
  const statusClass = { '입고대기': 'status-입고대기', '입고완료': 'status-입고완료', '출고중': 'status-출고중', '출고완료': 'status-출고완료', '반품': 'status-반품' };
  const typeClass = { '수입제품': 'type-import', 'OEM제품': 'type-oem', '자체생산': 'type-own' };
  const now = new Date();
  container.innerHTML = data.map(r => {
    const txBadge = `<span style="color:${txColor[r.transaction_type]||'#555'};font-weight:700;font-size:12px">${r.transaction_type||'-'}</span>`;
    const statusBadge = `<span class="status-badge ${statusClass[r.status]||''}" style="font-size:11px">${r.status||'-'}</span>`;
    const typeBadge = tab === 'all' ? `<span class="product-type-badge ${typeClass[r.product_type]||''}" style="font-size:11px">${r.product_type||'-'}</span>` : '';
    let expiryHtml = r.expiry_date || '-';
    if (r.expiry_date) {
      const daysLeft = Math.ceil((new Date(r.expiry_date) - now) / 86400000);
      if (daysLeft <= 30 && daysLeft > 0) expiryHtml = `<span style="color:#e67e22;font-weight:700">${r.expiry_date} <small>(D-${daysLeft})</small></span>`;
      else if (daysLeft <= 0) expiryHtml = `<span style="color:#e74c3c;font-weight:700">${r.expiry_date} <small>(만료)</small></span>`;
    }
    const totalFmt = r.total_amount ? Number(r.total_amount).toLocaleString() + '원' : '-';
    const extraInfo = tab === 'import' ? `<div style="font-size:11px;color:#666">원산지: ${r.origin||'-'}</div>` :
      tab === 'oem' ? `<div style="font-size:11px;color:#666">OEM제조사: ${r.oem_manufacturer||'-'}</div>` :
      tab === 'own' ? `<div style="font-size:11px;color:#666">공정: ${r.process||'-'} | 생산Lot: ${r.production_lot||'-'}</div>` :
      `<div style="font-size:11px;color:#666">${typeBadge}</div>`;
    return `<div style="background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:8px;box-shadow:0 1px 4px rgba(0,0,0,0.08);border-left:3px solid ${txColor[r.transaction_type]||'#ddd'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
        <div>
          <div style="font-weight:700;font-size:13px">${r.product_name||'-'}</div>
          <div style="font-size:10px;color:#888;font-family:monospace;margin-top:2px">${r.lot_no||'-'}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">${txBadge}${statusBadge}</div>
      </div>
      <div style="display:flex;gap:12px;font-size:12px;color:#555;flex-wrap:wrap;margin-bottom:6px">
        <span><i class="fas fa-calendar" style="color:#aaa"></i> ${r.date||'-'}</span>
        <span><i class="fas fa-boxes" style="color:#aaa"></i> ${r.quantity!=null?Number(r.quantity).toLocaleString():'-'} ${r.unit||''}</span>
        <span style="color:#1e8449;font-weight:700">${totalFmt}</span>
      </div>
      ${extraInfo}
      <div style="font-size:11px;color:#666;margin-top:4px">소비기한: ${expiryHtml} | 담당: ${r.manager||'-'}</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="edit-row-btn" onclick="lgOpenEditModal('${r.id}')" style="flex:1;padding:6px;font-size:12px"><i class="fas fa-edit"></i> 수정</button>
        <button class="edit-row-btn" style="flex:1;padding:6px;font-size:12px;color:#e74c3c;border-color:#e74c3c" onclick="lgDeleteRecord('${r.id}')"><i class="fas fa-trash"></i> 삭제</button>
      </div>
    </div>`;
  }).join('');
}

function lgRenderTable(tbodyId, data, tab) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  if (!data.length) {
    const colCount = tab === 'all' ? 12 : 13;
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty-msg"><i class="fas fa-inbox"></i> 등록된 내역이 없습니다.</td></tr>`;
    return;
  }

  // 제품마스터 캐시 없으면 비동기 로딩 후 재렌더링
  if (!_lgProductCache) {
    lgGetProductCache().then(function() { lgRenderTable(tbodyId, data, tab); });
    return;
  }

  const txColor = { '입고': '#27ae60', '출고': '#e74c3c', '반품': '#e67e22', '조정': '#8e44ad' };
  const statusClass = { '입고대기': 'status-입고대기', '입고완료': 'status-입고완료', '출고중': 'status-출고중', '출고완료': 'status-출고완료', '반품': 'status-반품' };
  const typeClass = { '수입제품': 'type-import', 'OEM제품': 'type-oem', '자체생산': 'type-own' };

  // 제품마스터 캐시 (동기 접근, 없으면 빈 배열)
  const _pmCache = _lgProductCache || [];

  // 낱개/Box/PT 환산 표시 헬퍼
  function _lgFmtBreakdown(qty, unit, productName, savedEa, savedBox, savedPt) {
    let ea, box, pt;
    if (savedEa !== undefined && savedEa !== null) {
      ea = Number(savedEa) || 0;
      box = Number(savedBox) || 0;
      pt = Number(savedPt) || 0;
    } else {
      const pm = _pmCache.find(p => (p.product_name||'').trim() === (productName||'').trim());
      const qpb = pm ? (parseInt(pm.qty_per_box) || 0) : 0;
      const bpp = pm ? (parseInt(pm.boxes_per_pallet) || 0) : 0;
      const n = Number(qty) || 0;
      const u = unit || 'ea';
      if (u === 'pallet') {
        pt = n; box = bpp > 0 ? n * bpp : 0; ea = (qpb > 0 && bpp > 0) ? n * bpp * qpb : 0;
      } else if (u === 'box') {
        box = n; pt = bpp > 0 ? Math.floor(n / bpp) : 0; ea = qpb > 0 ? n * qpb : 0;
      } else {
        ea = n; box = qpb > 0 ? Math.floor(n / qpb) : 0; pt = (qpb > 0 && bpp > 0) ? Math.floor(n / (qpb * bpp)) : 0;
      }
    }
    const parts = [];
    if (pt > 0) parts.push(`<span style="color:#8e44ad;font-size:11px">${pt.toLocaleString()} PT</span>`);
    if (box > 0) parts.push(`<span style="color:#2980b9;font-size:11px">${box.toLocaleString()} Box</span>`);
    if (ea > 0) parts.push(`<span style="color:#27ae60;font-size:11px;font-weight:600">${ea.toLocaleString()} ea</span>`);
    if (parts.length === 0) return `<span style="color:#555">${(Number(qty)||0).toLocaleString()} ${unit||''}</span>`;
    return parts.join(' / ');
  }

  tbody.innerHTML = data.map(r => {
    const txBadge = `<span style="color:${txColor[r.transaction_type]||'#555'};font-weight:700">${r.transaction_type || '-'}</span>`;
    const statusBadge = `<span class="status-badge ${statusClass[r.status] || ''}">${r.status || '-'}</span>`;
    const typeBadge = `<span class="product-type-badge ${typeClass[r.product_type] || ''}">${r.product_type || '-'}</span>`;

    let expiryHtml = r.expiry_date || '-';
    if (r.expiry_date) {
      const daysLeft = Math.ceil((new Date(r.expiry_date) - new Date()) / (1000 * 60 * 60 * 24));
      if (daysLeft <= 30 && daysLeft > 0) {
        expiryHtml = `<span style="color:#e67e22;font-weight:700">${r.expiry_date} <small>(D-${daysLeft})</small></span>`;
      } else if (daysLeft <= 0) {
        expiryHtml = `<span style="color:#e74c3c;font-weight:700">${r.expiry_date} <small>(만료)</small></span>`;
      }
    }

    const qcVal = r.oem_qc || r.own_qc || '';
    const qcBadge = qcVal === '합격' ? '✅ 합격' : qcVal === '불합격' ? '❌ 불합격' : qcVal === '특채' ? '⚠️ 특채' : '-';
    const totalFmt = r.total_amount ? Number(r.total_amount).toLocaleString() + '원' : '-';

    if (tab === 'import') {
      return `<tr>
        <td style="font-size:11px">${r.lot_no || '-'}</td>
        <td>${txBadge}</td>
        <td>${r.date || '-'}</td>
        <td><strong>${r.product_name || '-'}</strong></td>
        <td style="text-align:right">${_lgFmtBreakdown(r.quantity, r.unit, r.product_name, r.qty_ea, r.qty_box, r.qty_pt)}</td>
        <td>${r.unit || '-'}</td>
        <td style="text-align:right;color:#1e8449">${totalFmt}</td>
        <td>${r.origin || '-'}</td>
        <td>${expiryHtml}</td>
        <td>${statusBadge}</td>
        <td>${r.manager || '-'}</td>
        <td>${r.notes || '-'}</td>
        <td>
          <button class="edit-row-btn" onclick="lgOpenEditModal('${r.id}')"><i class="fas fa-edit"></i></button>
          <button class="edit-row-btn" style="color:#e74c3c;border-color:#e74c3c" onclick="lgDeleteRecord('${r.id}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    } else if (tab === 'oem') {
      return `<tr>
        <td style="font-size:11px">${r.lot_no || '-'}</td>
        <td>${txBadge}</td>
        <td>${r.date || '-'}</td>
        <td><strong>${r.product_name || '-'}</strong></td>
        <td style="text-align:right">${_lgFmtBreakdown(r.quantity, r.unit, r.product_name, r.qty_ea, r.qty_box, r.qty_pt)}</td>
        <td>${r.unit || '-'}</td>
        <td style="text-align:right;color:#1e8449">${totalFmt}</td>
        <td>${r.oem_manufacturer || '-'}</td>
        <td>${expiryHtml}</td>
        <td>${qcBadge}</td>
        <td>${statusBadge}</td>
        <td>${r.manager || '-'}</td>
        <td>
          <button class="edit-row-btn" onclick="lgOpenEditModal('${r.id}')"><i class="fas fa-edit"></i></button>
          <button class="edit-row-btn" style="color:#e74c3c;border-color:#e74c3c" onclick="lgDeleteRecord('${r.id}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    } else if (tab === 'own') {
      return `<tr>
        <td style="font-size:11px">${r.lot_no || '-'}</td>
        <td>${txBadge}</td>
        <td>${r.date || '-'}</td>
        <td><strong>${r.product_name || '-'}</strong></td>
        <td style="text-align:right">${_lgFmtBreakdown(r.quantity, r.unit, r.product_name, r.qty_ea, r.qty_box, r.qty_pt)}</td>
        <td>${r.unit || '-'}</td>
        <td style="text-align:right;color:#1e8449">${totalFmt}</td>
        <td>${r.process || '-'}</td>
        <td style="font-size:11px">${r.production_lot || '-'}</td>
        <td>${expiryHtml}</td>
        <td>${statusBadge}</td>
        <td>${r.manager || '-'}</td>
        <td>
          <button class="edit-row-btn" onclick="lgOpenEditModal('${r.id}')"><i class="fas fa-edit"></i></button>
          <button class="edit-row-btn" style="color:#e74c3c;border-color:#e74c3c" onclick="lgDeleteRecord('${r.id}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    } else {
      // 소스 파악 (wh_inbound / wh_outbound / logistics)
      const rowSrc = r._from_wh_inbound ? 'wh_inbound' : r._from_wh_outbound ? 'wh_outbound' : 'logistics';
      // 제품규격 조회
      const _pmAll = _lgProductCache || [];
      const _pmMatchAll = _pmAll.find(p => (p.product_name||'').trim() === (r.product_name||'').trim());
      const specAll = r.specification || (_pmMatchAll ? (_pmMatchAll.specification || _pmMatchAll.spec_code || '') : '');
      return `<tr>
        <td style="font-size:11px">${r.lot_no || '-'}</td>
        <td>${typeBadge}</td>
        <td>${txBadge}</td>
        <td>${r.date || '-'}</td>
        <td><strong>${r.product_name || '-'}</strong></td>
        <td style="font-size:11px;color:#555">${specAll || '-'}</td>
        <td style="text-align:right">${_lgFmtBreakdown(r.quantity, r.unit, r.product_name, r.qty_ea, r.qty_box, r.qty_pt)}</td>
        <td>${expiryHtml}</td>
        <td>${statusBadge}</td>
        <td>${r.manager || '-'}</td>
        <td>${r.notes || '-'}</td>
        <td>
          <button class="edit-row-btn" onclick="lgOpenEditModal('${r.id}','${rowSrc}')"><i class="fas fa-edit"></i></button>
          <button class="edit-row-btn" style="color:#e74c3c;border-color:#e74c3c" onclick="lgDeleteRecord('${r.id}','${rowSrc}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }
  }).join('');
}

// =====================================================
// 폼 제출
// =====================================================
async function lgHandleSubmit(e) {
  e.preventDefault();

  const strVal = (id) => document.getElementById(id)?.value?.trim() || '';
  const numVal = (id) => parseFloat(document.getElementById(id)?.value) || 0;

  const lot = document.getElementById('lgLotDisplay')?.dataset?.lot || document.getElementById('lgLotDisplay')?.textContent || '';
  const prodType = strVal('lg_product_type');
  const txType = strVal('lg_transaction_type');

  if (!txType) { showToast('거래유형을 선택하세요.', 'warning'); return; }
  if (!prodType) { showToast('제품유형을 선택하세요.', 'warning'); return; }
  if (!strVal('lg_product_name')) { showToast('제품명을 입력하세요.', 'warning'); return; }
  if (!strVal('lg_manager')) { showToast('담당자를 입력하세요.', 'warning'); return; }

  const record = {
    lot_no: lot,
    transaction_type: txType,
    product_type: prodType,
    date: strVal('lg_date'),
    product_name: strVal('lg_product_name'),
    product_code: strVal('lg_product_code'),
    quantity: numVal('lg_quantity'),
    unit: strVal('lg_unit'),
    unit_price: numVal('lg_unit_price'),
    total_amount: numVal('lg_total_amount'),
    expiry_date: strVal('lg_expiry_date'),
    storage_location: strVal('lg_storage_location'),
    manager: strVal('lg_manager'),
    vendor: strVal('lg_vendor'),
    destination: strVal('lg_destination'),
    status: strVal('lg_status'),
    notes: strVal('lg_notes'),
  };

  // 제품유형별 추가 필드
  if (prodType === '수입제품') {
    record.origin = strVal('lg_origin');
    record.importer = strVal('lg_importer');
    record.customs_no = strVal('lg_customs_no');
    record.arrival_date = strVal('lg_arrival_date');
  } else if (prodType === 'OEM제품') {
    record.oem_manufacturer = strVal('lg_oem_manufacturer');
    record.oem_contract_no = strVal('lg_oem_contract_no');
    record.oem_delivery_date = strVal('lg_oem_delivery_date');
    record.oem_qc = strVal('lg_oem_qc');
  } else if (prodType === '자체생산') {
    record.production_lot = strVal('lg_production_lot');
    record.process = strVal('lg_process');
    record.production_date = strVal('lg_production_date');
    record.own_qc = strVal('lg_own_qc');
  }

  const btn = document.querySelector('#logisticsForm button[type="submit"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...'; }

  try {
    await apiPost('logistics', record);
    showToast(`✅ ${prodType} ${txType} 등록 완료! Lot: ${lot}`, 'success');
    lgResetForm();
    await loadLogisticsData();
  } catch(err) {
    showToast('저장 실패: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> 등록'; }
  }
}

// =====================================================
// 폼 초기화
// =====================================================
function lgResetForm() {
  const form = document.getElementById('logisticsForm');
  if (form) form.reset();
  const today = new Date().toISOString().split('T')[0];
  const dateEl = document.getElementById('lg_date');
  if (dateEl) dateEl.value = today;
  // 제품유형 섹션 숨기기
  ['lg_import_section', 'lg_oem_section', 'lg_own_section'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  lgRefreshLotNo();
}

// =====================================================
// 엑셀 내보내기
// =====================================================
async function lgExport(tab) {
  // tab === 'all' 일 때: 현재 재고 현황 테이블 데이터를 출력
  if (tab === 'all') {
    if (!_lgProductCache) {
      try { await lgGetProductCache(); } catch(e) { _lgProductCache = []; }
    }

    var q = (document.getElementById('stockSearch') ? document.getElementById('stockSearch').value : '').toLowerCase();
    var typeF = document.getElementById('allTypeFilter') ? document.getElementById('allTypeFilter').value : '';
    var stockMap = {};

    // 1패스: logistics 입고 (WH-IN- 제외 → 중복 방지)
    allLogisticsData.forEach(function(r) {
      if ((r.lot_no || '').startsWith('WH-IN-')) return;
      var name = (r.product_name || r.item_name || '').trim();
      var expiry = (r.expiry_date || r.expiry || '').trim();
      var unit = (r.unit || 'ea').trim();
      var ptype = (r.product_type || '').trim();
      var qty = Number(r.quantity || r.qty || 0);
      var tx = (r.transaction_type || '입고').trim();
      if (!name) return;
      if (tx !== '입고' && tx !== '반품') return;
      var key = name + '||' + expiry;
      if (!stockMap[key]) {
        stockMap[key] = { name: name, expiry: expiry, unit: unit, ptype: ptype, inQty: 0, outQty: 0,
          inQty_ea: 0, inQty_box: 0, inQty_pt: 0, outQty_ea: 0, outQty_box: 0, outQty_pt: 0 };
      }
      stockMap[key].inQty += qty;
      stockMap[key].inQty_ea += Number(r.qty_ea !== undefined ? r.qty_ea : qty) || 0;
      stockMap[key].inQty_box += Number(r.qty_box || 0);
      stockMap[key].inQty_pt += Number(r.qty_pt || 0);
    });

    function buildNameIndex() {
      var idx = {};
      Object.keys(stockMap).forEach(function(k) {
        var n = k.split('||')[0];
        if (!idx[n] || (stockMap[k].expiry || '9999') < (stockMap[idx[n]].expiry || '9999')) idx[n] = k;
      });
      return idx;
    }

    // 2패스: logistics 출고 (WH-OUT- 제외 → 중복 방지)
    var nameIdx2 = buildNameIndex();
    allLogisticsData.forEach(function(r) {
      if ((r.lot_no || '').startsWith('WH-OUT-')) return;
      var name = (r.product_name || r.item_name || '').trim();
      var expiry = (r.expiry_date || r.expiry || '').trim();
      var qty = Number(r.quantity || r.qty || 0);
      var tx = (r.transaction_type || '입고').trim();
      if (!name || tx !== '출고') return;
      var key = name + '||' + expiry;
      var targetKey = stockMap[key] ? key : (nameIdx2[name] || null);
      if (!targetKey) {
        stockMap[key] = { name: name, expiry: expiry, unit: (r.unit || 'ea'), ptype: (r.product_type || ''), inQty: 0, outQty: 0,
          inQty_ea: 0, inQty_box: 0, inQty_pt: 0, outQty_ea: 0, outQty_box: 0, outQty_pt: 0 };
        targetKey = key;
      }
      stockMap[targetKey].outQty += qty;
      stockMap[targetKey].outQty_ea += Number(r.qty_ea !== undefined ? r.qty_ea : qty) || 0;
      stockMap[targetKey].outQty_box += Number(r.qty_box || 0);
      stockMap[targetKey].outQty_pt += Number(r.qty_pt || 0);
    });

    // 3패스: wh_inbound 전체 직접 집계
    (allWhInboundData || []).forEach(function(r) {
      var name = (r.item_name || '').trim();
      var expiry = (r.expiry_date || '').trim();
      var unit = (r.unit || 'ea').trim();
      var ptype = r.inbound_type || '수입제품';
      var qty = Number(r.qty || 0);
      if (!name || !qty) return;
      var key = name + '||' + expiry;
      if (!stockMap[key]) {
        stockMap[key] = { name: name, expiry: expiry, unit: unit, ptype: ptype, inQty: 0, outQty: 0,
          inQty_ea: 0, inQty_box: 0, inQty_pt: 0, outQty_ea: 0, outQty_box: 0, outQty_pt: 0 };
      }
      stockMap[key].inQty += qty;
      stockMap[key].inQty_ea += Number(r.qty_ea !== undefined ? r.qty_ea : qty) || 0;
      stockMap[key].inQty_box += Number(r.qty_box || 0);
      stockMap[key].inQty_pt += Number(r.qty_pt || 0);
      if (!stockMap[key].ptype) stockMap[key].ptype = ptype;
    });

    // 4패스: wh_outbound 전체 직접 집계
    var _whInLotMap = {};
    (allWhInboundData || []).forEach(function(r) {
      if (r.lot_no) _whInLotMap[r.lot_no] = r;
    });
    (allWhOutboundData || []).forEach(function(r) {
      var name = (r.item_name || '').trim();
      var qty = Number(r.qty || 0);
      if (!name || !qty) return;
      var expiry = (r.expiry_date || '').trim();
      var exactKey = name + '||' + expiry;
      var matchedKey = null;
      if (stockMap[exactKey]) {
        matchedKey = exactKey;
      } else if (!expiry && r.ref_lot && _whInLotMap[r.ref_lot]) {
        var refExpiry = (_whInLotMap[r.ref_lot].expiry_date || '').trim();
        var refKey = name + '||' + refExpiry;
        if (stockMap[refKey]) matchedKey = refKey;
      }
      if (!matchedKey) {
        var candidates = Object.keys(stockMap).filter(function(k) {
          return k.startsWith(name + '||');
        });
        if (candidates.length > 0) {
          candidates.sort(function(a, b) {
            var stockA = stockMap[a].inQty - stockMap[a].outQty;
            var stockB = stockMap[b].inQty - stockMap[b].outQty;
            if (stockA > 0 && stockB <= 0) return -1;
            if (stockA <= 0 && stockB > 0) return 1;
            return (stockMap[a].expiry || '9999').localeCompare(stockMap[b].expiry || '9999');
          });
          matchedKey = candidates[0];
        }
      }
      if (!matchedKey) {
        matchedKey = name + '||' + expiry;
        stockMap[matchedKey] = { name: name, expiry: expiry, unit: (r.unit || 'ea'), ptype: '', inQty: 0, outQty: 0,
          inQty_ea: 0, inQty_box: 0, inQty_pt: 0, outQty_ea: 0, outQty_box: 0, outQty_pt: 0 };
      }
      stockMap[matchedKey].outQty += qty;
      stockMap[matchedKey].outQty_ea += Number(r.qty_ea !== undefined ? r.qty_ea : qty) || 0;
      stockMap[matchedKey].outQty_box += Number(r.qty_box || 0);
      stockMap[matchedKey].outQty_pt += Number(r.qty_pt || 0);
    });

    var rows = Object.values(stockMap);
    if (q) rows = rows.filter(function(r) { return r.name.toLowerCase().indexOf(q) !== -1; });
    if (typeF) rows = rows.filter(function(r) { return r.ptype === typeF; });
    else rows = rows.filter(function(r) { return r.ptype !== '회수입고'; });
    var hideZeroEl = document.getElementById('stockHideZero');
    var showZero = hideZeroEl ? hideZeroEl.checked : false;
    if (!showZero) rows = rows.filter(function(r) { return (r.inQty - r.outQty) > 0; });
    rows.sort(function(a, b) {
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return (a.expiry || '').localeCompare(b.expiry || '');
    });

    var expProducts = _lgProductCache || [];
    var wb = XLSX.utils.book_new();
    var wsData = [];
    wsData.push(['현재 재고 현황', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    wsData.push(['다운로드: ' + new Date().toLocaleDateString('ko-KR'), '', '', '', '', '', '', '', '', '', '', '', '', '']);
    wsData.push([]);
    wsData.push(['제품명', '제품규격', '제품유형', '소비기한',
      '입고수량(ea)', '입고수량(Box)', '입고수량(PT)',
      '출고수량(ea)', '출고수량(Box)', '출고수량(PT)',
      '현재고(ea)', '현재고(Box)', '현재고(PT)',
      '단위', '상태']);

    var typeColors = { '수입제품': 'FF2980B9', 'OEM제품': 'FFD68910', '자체생산': 'FF1E8449', '회수입고': 'FF8E44AD', '기타': 'FF888888' };
    var statusColors = { '정상': 'FF1E8449', '부족': 'FFD68910', '재고없음': 'FFAAAAAA', '마이너스': 'FFE74C3C' };

    rows.forEach(function(r) {
      var stock = r.inQty - r.outQty;
      var stockEa = r.inQty_ea - r.outQty_ea;
      var pmMatch = expProducts.find(function(p) { return (p.product_name || '').trim() === r.name; });
      var qpb = pmMatch ? (parseInt(pmMatch.qty_per_box) || 0) : 0;
      var bpp = pmMatch ? (parseInt(pmMatch.boxes_per_pallet) || 0) : 0;
      var specVal = pmMatch ? (pmMatch.specification || pmMatch.spec_code || '') : '';
      var inEa = r.inQty_ea || 0;
      var inBox = r.inQty_box || (qpb > 0 ? Math.floor(inEa / qpb) : 0);
      var inPt = r.inQty_pt || ((qpb > 0 && bpp > 0) ? Math.floor(inEa / (qpb * bpp)) : 0);
      var outEa = r.outQty_ea || 0;
      var outBox = r.outQty_box || (qpb > 0 ? Math.floor(outEa / qpb) : 0);
      var outPt = r.outQty_pt || ((qpb > 0 && bpp > 0) ? Math.floor(outEa / (qpb * bpp)) : 0);
      var stockBox = qpb > 0 ? Math.floor(stockEa / qpb) : 0;
      var stockPt = (qpb > 0 && bpp > 0) ? Math.floor(stockEa / (qpb * bpp)) : 0;
      var status = stock < 0 ? '마이너스' : (stock === 0 ? '재고없음' : (stock <= 10 ? '부족' : '정상'));
      wsData.push([r.name, specVal || '-', r.ptype || '-', r.expiry || '-',
        inEa, inBox, inPt,
        outEa, outBox, outPt,
        stockEa, stockBox, stockPt,
        r.unit || 'ea', status]);
    });

    var ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      {wch:28},{wch:16},{wch:10},{wch:12},
      {wch:10},{wch:10},{wch:8},
      {wch:10},{wch:10},{wch:8},
      {wch:10},{wch:10},{wch:8},
      {wch:6},{wch:10}
    ];
    ws['!merges'] = [
      { s:{r:0,c:0}, e:{r:0,c:14} },
      { s:{r:1,c:0}, e:{r:1,c:14} }
    ];

    var headerRow = 3;
    var dataStartRow = 4;
    var hdrCols = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O'];
    hdrCols.forEach(function(col) {
      var cellRef = col + (headerRow + 1);
      if (!ws[cellRef]) ws[cellRef] = { v: '', t: 's' };
      ws[cellRef].s = {
        font: { bold: true, color: { rgb: 'FFFFFFFF' } },
        fill: { fgColor: { rgb: 'FF2C3E50' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: { bottom: { style: 'thin', color: { rgb: 'FFCCCCCC' } } }
      };
    });

    for (var ri = dataStartRow; ri < wsData.length; ri++) {
      var rowData = wsData[ri];
      var isEven = (ri - dataStartRow) % 2 === 0;
      var rowBg = isEven ? 'FFFAFAFA' : 'FFFFFFFF';
      var curEaVal = rowData[10];
      if (typeof curEaVal === 'number' && curEaVal < 0) rowBg = 'FFFFF0F0';
      hdrCols.forEach(function(col, ci) {
        var cellRef = col + (ri + 1);
        if (!ws[cellRef]) ws[cellRef] = { v: '', t: 's' };
        var cellStyle = {
          fill: { fgColor: { rgb: rowBg } },
          alignment: { vertical: 'center' },
          border: { bottom: { style: 'hair', color: { rgb: 'FFE0E0E0' } } }
        };
        if (ci === 2) {
          var tc = typeColors[rowData[2]] || 'FF888888';
          cellStyle.font = { color: { rgb: tc }, bold: true };
          cellStyle.alignment = { horizontal: 'center', vertical: 'center' };
        }
        if (ci >= 4 && ci <= 12) cellStyle.alignment = { horizontal: 'center', vertical: 'center' };
        if (ci >= 10 && ci <= 12) cellStyle.font = { bold: true };
        if (ci === 14) {
          var sc = statusColors[rowData[14]] || 'FF333333';
          cellStyle.font = { color: { rgb: sc }, bold: true };
          cellStyle.alignment = { horizontal: 'center', vertical: 'center' };
        }
        ws[cellRef].s = cellStyle;
      });
    }

    XLSX.utils.book_append_sheet(wb, ws, '현재재고현황');
    XLSX.writeFile(wb, '현재재고현황_' + new Date().toISOString().split('T')[0] + '.xlsx');
    showToast('현재 재고 현황 엑셀 다운로드 완료!', 'success');
    return;
  }

  // import / oem / own 탭: 거래이력 출력
  let data = [];
  if (tab === 'import') data = allLogisticsData.filter(r => r.product_type === '수입제품');
  else if (tab === 'oem') data = allLogisticsData.filter(r => r.product_type === 'OEM제품');
  else if (tab === 'own') data = allLogisticsData.filter(r => r.product_type === '자체생산');
  else data = allLogisticsData;

  var headers2 = ['Lot No', '제품유형', '거래유형', '거래일자', '제품명', '수량', '단위', '소비기한', '상태', '담당자', '비고'];
  var rows2 = data.map(function(r) { return [
    r.lot_no || '', r.product_type || '', r.transaction_type || '', r.date || '',
    r.product_name || '', r.quantity || 0, r.unit || '',
    r.expiry_date || '', r.status || '', r.manager || '', r.notes || ''
  ]; });
  var csvContent2 = [headers2, ...rows2].map(function(row) { return row.map(function(cell) { return '"' + cell + '"'; }).join(','); }).join('\n');
  var blob2 = new Blob(['\uFEFF' + csvContent2], { type: 'text/csv;charset=utf-8;' });
  var url2 = URL.createObjectURL(blob2);
  var a2 = document.createElement('a');
  a.href = url;
  a.download = `물류현황_${tab}_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('엑셀 파일 다운로드 완료!', 'success');
}

// =====================================================
// 수정 모달
// =====================================================
async function lgOpenEditModal(id, source) {
  // source: 'wh_inbound' | 'wh_outbound' | undefined(logistics)
  // wh_inbound 행 → 기존 창고 입고 수정 모달로 라우팅
  if (source === 'wh_inbound' || (!source && !allLogisticsData.find(r => r.id === id) && allWhInboundData.find(r => r.id === id))) {
    const rec = allWhInboundData.find(r => r.id === id);
    if (!rec) { showToast('입고 기록을 찾을 수 없습니다.', 'warning'); return; }
    // whInboundData가 logistics.js에서 접근 가능하도록 allWhInboundData 활용
    // warehouse-mgmt.js의 whOpenInEditModal은 whInboundData를 사용하므로 직접 모달 채우기
    const sv = (eid, v) => { const el = document.getElementById(eid); if (el) el.value = v != null ? v : ''; };
    sv('whInEditId', rec.id);
    sv('whInEdit_date', rec.inbound_date || '');
    sv('whInEdit_item_name', rec.item_name || '');
    sv('whInEdit_qty', rec.qty || '');
    sv('whInEdit_mfg_date', rec.mfg_date || '');
    sv('whInEdit_expiry_date', rec.expiry_date || '');
    sv('whInEdit_ref_lot', rec.lot_no_product || '');
    sv('whInEdit_supplier', rec.supplier || '');
    sv('whInEdit_temp', rec.temp || '');
    sv('whInEdit_manager', rec.manager || '');
    sv('whInEdit_memo', rec.memo || '');
    const whEl = document.getElementById('whInEdit_warehouse');
    if (whEl) { whEl.value = rec.warehouse || 'C'; if (typeof whBuildLocationSelect === 'function') whBuildLocationSelect('whInEdit'); }
    setTimeout(() => { sv('whInEdit_location', rec.location || ''); }, 150);
    const typeEl = document.getElementById('whInEdit_type');
    if (typeEl) { const tv = rec.inbound_type || rec.type || ''; Array.from(typeEl.options).forEach((o,i)=>{ if(o.value===tv) typeEl.selectedIndex=i; }); }
    const unitEl = document.getElementById('whInEdit_unit');
    if (unitEl) { Array.from(unitEl.options).forEach((o,i)=>{ if(o.value===(rec.unit||'pallet')) unitEl.selectedIndex=i; }); }
    const modal = document.getElementById('whInEditModal');
    if (modal) modal.classList.add('show');
    return;
  }
  // wh_outbound 행 → 출고 수정 모달
  if (source === 'wh_outbound' || (!source && !allLogisticsData.find(r => r.id === id) && allWhOutboundData.find(r => r.id === id))) {
    const rec = allWhOutboundData.find(r => r.id === id);
    if (!rec) { showToast('출고 기록을 찾을 수 없습니다.', 'warning'); return; }
    lgEditingId = id;
    lgEditingSource = 'wh_outbound';
    document.getElementById('lgEditModalBody').innerHTML = `
      <div class="form-grid form-grid-2">
        <div class="form-group"><label>출고일자</label><input type="date" id="le_date" value="${rec.outbound_date||rec.date||''}" /></div>
        <div class="form-group"><label>단위</label>
          <select id="le_unit">${['ea','box','kg','L','pallet'].map(u=>`<option ${(rec.unit||'ea')===u?'selected':''}>${u}</option>`).join('')}</select></div>
        <div class="form-group span-2"><label>품목명</label><input type="text" id="le_product_name" value="${rec.item_name||''}" /></div>
        <div class="form-group"><label>수량</label><input type="number" id="le_quantity" value="${rec.qty||0}" step="1" /></div>
        <div class="form-group"><label>담당자</label><input type="text" id="le_manager" value="${rec.manager||''}" /></div>
        <div class="form-group"><label>출고처</label><input type="text" id="le_destination" value="${rec.destination||''}" /></div>
        <div class="form-group span-2"><label>비고</label><input type="text" id="le_notes" value="${rec.memo||rec.notes||''}" /></div>
      </div>
    `;
    document.getElementById('lgEditModal').classList.add('show');
    return;
  }
  lgEditingId = id;
  lgEditingSource = 'logistics';
  const rec = allLogisticsData.find(r => r.id === id);
  if (!rec) return;

  document.getElementById('lgEditModalBody').innerHTML = `
    <div class="form-grid form-grid-2">
      <div class="form-group"><label>거래유형</label>
        <select id="le_transaction_type">
          ${['입고','출고','반품','조정'].map(t => `<option ${rec.transaction_type===t?'selected':''}>${t}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>제품유형</label>
        <select id="le_product_type">
          ${['수입제품','OEM제품','자체생산'].map(t => `<option ${rec.product_type===t?'selected':''}>${t}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>거래일자</label><input type="date" id="le_date" value="${rec.date||''}" /></div>
      <div class="form-group"><label>상태</label>
        <select id="le_status">
          ${['입고대기','입고완료','출고중','출고완료','반품'].map(s => `<option ${rec.status===s?'selected':''}>${s}</option>`).join('')}
        </select></div>
      <div class="form-group span-2"><label>제품명</label><input type="text" id="le_product_name" value="${rec.product_name||''}" /></div>
      <div class="form-group"><label>수량</label><input type="number" id="le_quantity" value="${rec.quantity||0}" step="1" /></div>
      <div class="form-group"><label>단위</label>
        <select id="le_unit">${['ea','box','kg','L','pallet'].map(u=>`<option ${rec.unit===u?'selected':''}>${u}</option>`).join('')}</select></div>
      <div class="form-group"><label>단가 (원)</label><input type="number" id="le_unit_price" value="${rec.unit_price||0}" /></div>
      <div class="form-group"><label>총금액 (원)</label><input type="number" id="le_total_amount" value="${rec.total_amount||0}" /></div>
      <div class="form-group"><label>소비기한</label><input type="date" id="le_expiry_date" value="${rec.expiry_date||''}" /></div>
      <div class="form-group"><label>담당자</label><input type="text" id="le_manager" value="${rec.manager||''}" /></div>
      <div class="form-group"><label>거래처</label><input type="text" id="le_vendor" value="${rec.vendor||''}" /></div>
      <div class="form-group span-2"><label>비고</label><input type="text" id="le_notes" value="${rec.notes||''}" /></div>
    </div>
  `;
  document.getElementById('lgEditModal').classList.add('show');
}

function lgCloseEditModal() {
  document.getElementById('lgEditModal').classList.remove('show');
  lgEditingId = null;
  lgEditingSource = 'logistics';
}

async function lgSaveEdit() {
  if (!lgEditingId) return;
  try {
    // wh_outbound 행 수정
    if (lgEditingSource === 'wh_outbound') {
      const rec = allWhOutboundData.find(r => r.id === lgEditingId);
      if (!rec) { showToast('출고 기록을 찾을 수 없습니다.', 'warning'); return; }
      const updated = {
        ...rec,
        outbound_date: document.getElementById('le_date')?.value || rec.outbound_date,
        item_name: document.getElementById('le_product_name')?.value || rec.item_name,
        qty: parseFloat(document.getElementById('le_quantity')?.value) || rec.qty,
        unit: document.getElementById('le_unit')?.value || rec.unit,
        manager: document.getElementById('le_manager')?.value || rec.manager,
        destination: document.getElementById('le_destination')?.value || rec.destination,
        memo: document.getElementById('le_notes')?.value || rec.memo,
      };
      await apiPut('wh_outbound', lgEditingId, updated);
      showToast('출고 수정 완료!', 'success');
      lgCloseEditModal();
      if (typeof whInvalidateMapCache === 'function') whInvalidateMapCache();
      // ── 연동 갱신: 창고 재고현황 + 물류현황 동시 반영 ──
      if (typeof whLoadAll === 'function') whLoadAll();
      await loadLogisticsData();
      return;
    }
    // logistics 행 수정
    const rec = allLogisticsData.find(r => r.id === lgEditingId);
    const updated = {
      ...rec,
      transaction_type: document.getElementById('le_transaction_type')?.value || rec.transaction_type,
      product_type: document.getElementById('le_product_type')?.value || rec.product_type,
      date: document.getElementById('le_date')?.value || rec.date,
      status: document.getElementById('le_status')?.value || rec.status,
      product_name: document.getElementById('le_product_name')?.value || rec.product_name,
      quantity: parseFloat(document.getElementById('le_quantity')?.value) || 0,
      unit: document.getElementById('le_unit')?.value || rec.unit,
      unit_price: parseFloat(document.getElementById('le_unit_price')?.value) || 0,
      total_amount: parseFloat(document.getElementById('le_total_amount')?.value) || 0,
      expiry_date: document.getElementById('le_expiry_date')?.value || rec.expiry_date,
      manager: document.getElementById('le_manager')?.value || rec.manager,
      vendor: document.getElementById('le_vendor')?.value || rec.vendor,
      notes: document.getElementById('le_notes')?.value || rec.notes,
    };
    await apiPut('logistics', lgEditingId, updated);
    showToast('수정 완료!', 'success');
    lgCloseEditModal();
    // ── 연동 갱신: 재고현황 + 물류현황 동시 반영 ──
    if (typeof whInvalidateMapCache === 'function') whInvalidateMapCache();
    if (typeof whLoadAll === 'function') whLoadAll();
    await loadLogisticsData();
  } catch(e) {
    showToast('수정 실패: ' + e.message, 'error');
  }
}

async function lgDeleteRecord(id, source) {
  const targetId = id || lgEditingId;
  const src = source || lgEditingSource || 'logistics';
  showConfirm('이 내역을 삭제하시겠습니까?', async () => {
    try {
      if (src === 'wh_outbound') {
        const rec = allWhOutboundData.find(r => r.id === targetId);
        const lotNo = rec ? rec.lot_no : '';
        await apiDelete('wh_outbound', targetId);
        // logistics 연동 삭제 — Firestore 재조회 없이 캐시 사용
        if (lotNo) {
          try {
            const lgMatch = allLogisticsData.filter(r => r.wh_lot_no === lotNo || r.lot_no === lotNo);
            for (const m of lgMatch) { if (m.id) await apiDelete('logistics', m.id); }
          } catch(le) { console.warn('logistics 연동 삭제 실패:', le); }
        }
        if (typeof whInvalidateMapCache === 'function') whInvalidateMapCache();
      } else if (src === 'wh_inbound') {
        const rec = allWhInboundData.find(r => r.id === targetId);
        const lotNo = rec ? rec.lot_no : '';
        await apiDelete('wh_inbound', targetId);
        // logistics 연동 삭제 — Firestore 재조회 없이 캐시 사용
        if (lotNo) {
          try {
            const lgMatch = allLogisticsData.filter(r => (r.wh_lot_no === lotNo || r.lot_no === lotNo) && r.transaction_type === '입고');
            for (const m of lgMatch) { if (m.id) await apiDelete('logistics', m.id); }
          } catch(le) { console.warn('logistics 연동 삭제 실패:', le); }
        }
        if (typeof whInvalidateMapCache === 'function') whInvalidateMapCache();
      } else {
        await apiDelete('logistics', targetId);
      }
      showToast('삭제되었습니다.', 'success');
      lgCloseEditModal();
      await loadLogisticsData();
    } catch(e) {
      showToast('삭제 실패: ' + e.message, 'error');
    }
  });
}

// ===========================
// 제품 자동검색 (제품마스터 연동)
// ===========================
let _lgProductCache = null;

async function lgGetProductCache() {
  if (_lgProductCache) return _lgProductCache;
  try {
    _lgProductCache = await apiGetAll('products');
  } catch(e) {
    _lgProductCache = [];
  }
  return _lgProductCache;
}

async function lgProductSearch(keyword) {
  const dropdown = document.getElementById('lgProductDropdown');
  if (!dropdown) return;
  const q = (keyword || '').trim().toLowerCase();
  const products = await lgGetProductCache();
  const matched = (q.length > 0
    ? products.filter(p => {
        const name = (p.product_name || '').toLowerCase();
        const code = (p.product_code || '').toLowerCase();
        return name.includes(q) || code.includes(q);
      })
    : products
  ).slice(0, 30);

  if (matched.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  dropdown.innerHTML = matched.map(p => {
    const typeLabel = p.product_type === '자체생산'
      ? '<span style="color:#1e8449;font-size:10px;font-weight:700">[OWN]</span>'
      : p.product_type === 'OEM'
      ? '<span style="color:#d68910;font-size:10px;font-weight:700">[OEM]</span>'
      : '<span style="color:#2980b9;font-size:10px;font-weight:700">[IMP]</span>';
    const safeP = JSON.stringify(p).replace(/"/g, '&quot;');
    return `<div onclick="lgSelectProduct(JSON.parse(this.dataset.p))" data-p="${safeP}"
      style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:13px"
      onmouseover="this.style.background='#f0f8f1'" onmouseout="this.style.background=''"
    >
      ${typeLabel} <strong>${p.product_name}</strong>
      <span style="color:#888;font-size:11px;margin-left:6px">${p.product_code || ''}</span>
      ${p.specification ? `<span style="color:#aaa;font-size:11px"> · ${p.specification}</span>` : ''}
    </div>`;
  }).join('');
  dropdown.style.display = 'block';
}

function lgSelectProduct(p) {
  const nameEl = document.getElementById('lg_product_name');
  const codeEl = document.getElementById('lg_product_code');
  const unitEl = document.getElementById('lg_unit');
  const expiryEl = document.getElementById('lg_expiry_date');
  const dropdown = document.getElementById('lgProductDropdown');

  if (nameEl) nameEl.value = p.product_name || '';
  if (codeEl) codeEl.value = p.product_code || '';
  if (unitEl && p.unit) {
    const opt = Array.from(unitEl.options).find(o => o.value === p.unit);
    if (opt) unitEl.value = p.unit;
  }
  if (expiryEl && p.shelf_life_date) expiryEl.value = p.shelf_life_date;

  // 제품유형 자동 설정
  const typeEl = document.getElementById('lg_product_type');
  if (typeEl && p.product_type) {
    const map = { '자체생산': '자체생산', 'OEM': 'OEM제품', '수입제품': '수입제품', '농산물': '수입제품' };
    const mapped = map[p.product_type];
    if (mapped) {
      typeEl.value = mapped;
      if (typeof lgRefreshLotNo === 'function') lgRefreshLotNo();
      if (typeof lgShowProductSections === 'function') lgShowProductSections();
    }
  }

  if (dropdown) dropdown.style.display = 'none';
}

// 드롭다운 외부 클릭 시 닫기
document.addEventListener('click', function(e) {
  const dropdown = document.getElementById('lgProductDropdown');
  const input = document.getElementById('lg_product_name');
  if (dropdown && input && !input.contains(e.target) && !dropdown.contains(e.target)) {
    dropdown.style.display = 'none';
  }
});

// ===========================
// 재고 현황 집계 및 렌더링
// 같은 품목명 + 소비기한 기준으로 입고/출고 합산
// ===========================
async function lgRenderStockTable() {
  var tbody = document.getElementById('stockTableBody');
  if (!tbody) return;

  // 제품마스터 캐시 보장: null이면 로딩 대기
  if (!_lgProductCache) {
    try { await lgGetProductCache(); } catch(e) { _lgProductCache = []; }
  }

  var q = (document.getElementById('stockSearch') ? document.getElementById('stockSearch').value : '').toLowerCase();
  var typeF = document.getElementById('allTypeFilter') ? document.getElementById('allTypeFilter').value : '';

  var stockMap = {};
  // ──────────────────────────────────────────────────
  // 단일 진실 공급원 기반 집계
  //  1패스: logistics 입고 (WH-IN- 제외 → 중복 방지)
  //  2패스: logistics 출고 (WH-OUT- 제외 → 중복 방지)
  //  3패스: wh_inbound 전체 직접 집계 (단일 진실 공급원)
  //  4패스: wh_outbound 전체 직접 집계 (단일 진실 공급원)
  // 수량 세분화: inQty_ea/inQty_box/inQty_pt, outQty_ea/outQty_box/outQty_pt
  // 하위 호환: qty_ea/qty_box/qty_pt 없으면 qty를 qty_ea로 간주
  // ──────────────────────────────────────────────────
  // 1패스 재실행: logistics에서 WH-IN- 제외하고 입고 집계
  allLogisticsData.forEach(function(r) {
    if ((r.lot_no || '').startsWith('WH-IN-')) return; // 창고입고 동기화 기록 제외
    var name = (r.product_name || r.item_name || '').trim();
    var expiry = (r.expiry_date || r.expiry || '').trim();
    var unit = (r.unit || 'ea').trim();
    var ptype = (r.product_type || '').trim();
    var qty = Number(r.quantity || r.qty || 0);
    var tx = (r.transaction_type || '입고').trim();
    if (!name) return;
    if (tx !== '입고' && tx !== '반품') return;
    var key = name + '||' + expiry;
    if (!stockMap[key]) {
      stockMap[key] = { name: name, expiry: expiry, unit: unit, ptype: ptype, inQty: 0, outQty: 0,
        inQty_ea: 0, inQty_box: 0, inQty_pt: 0, outQty_ea: 0, outQty_box: 0, outQty_pt: 0 };
    }
    stockMap[key].inQty += qty;
    // qty_ea/qty_box/qty_pt 있으면 세분화 집계, 없으면 qty를 qty_ea로 간주
    stockMap[key].inQty_ea += Number(r.qty_ea !== undefined ? r.qty_ea : qty) || 0;
    stockMap[key].inQty_box += Number(r.qty_box || 0);
    stockMap[key].inQty_pt += Number(r.qty_pt || 0);
  });
  // nameIndex: 품목명 → 가장 소비기한 빠른 key (O(n) 검색용 인덱스)
  function buildNameIndex() {
    var idx = {};
    Object.keys(stockMap).forEach(function(k) {
      var n = k.split('||')[0];
      if (!idx[n] || (stockMap[k].expiry||'9999') < (stockMap[idx[n]].expiry||'9999')) idx[n] = k;
    });
    return idx;
  }
  // 2패스 재실행: logistics 출고 집계 (WH-OUT- 제외)
  var nameIdx2 = buildNameIndex();
  allLogisticsData.forEach(function(r) {
    if ((r.lot_no || '').startsWith('WH-OUT-')) return;
    var name = (r.product_name || r.item_name || '').trim();
    var expiry = (r.expiry_date || r.expiry || '').trim();
    var qty = Number(r.quantity || r.qty || 0);
    var tx = (r.transaction_type || '입고').trim();
    if (!name || tx !== '출고') return;
    var key = name + '||' + expiry;
    var targetKey = stockMap[key] ? key : (nameIdx2[name] || null);
    if (!targetKey) {
      stockMap[key] = { name: name, expiry: expiry, unit: (r.unit||'ea'), ptype: (r.product_type||''), inQty: 0, outQty: 0,
        inQty_ea: 0, inQty_box: 0, inQty_pt: 0, outQty_ea: 0, outQty_box: 0, outQty_pt: 0 };
      targetKey = key;
    }
    stockMap[targetKey].outQty += qty;
    stockMap[targetKey].outQty_ea += Number(r.qty_ea !== undefined ? r.qty_ea : qty) || 0;
    stockMap[targetKey].outQty_box += Number(r.qty_box || 0);
    stockMap[targetKey].outQty_pt += Number(r.qty_pt || 0);
  });
  // 3패스: 창고 입고(wh_inbound) 집계 - 단일 진실 공급원
  (allWhInboundData || []).forEach(function(r) {
    var name = (r.item_name || '').trim();
    var expiry = (r.expiry_date || '').trim();
    var unit = (r.unit || 'ea').trim();
    var ptype = r.inbound_type || '수입제품';
    var qty = Number(r.qty || 0);
    if (!name || !qty) return;
    var key = name + '||' + expiry;
    if (!stockMap[key]) {
      stockMap[key] = { name: name, expiry: expiry, unit: unit, ptype: ptype, inQty: 0, outQty: 0,
        inQty_ea: 0, inQty_box: 0, inQty_pt: 0, outQty_ea: 0, outQty_box: 0, outQty_pt: 0 };
    }
    stockMap[key].inQty += qty;
    // 하위 호환: qty_ea 없으면 qty 사용
    stockMap[key].inQty_ea += Number(r.qty_ea !== undefined ? r.qty_ea : qty) || 0;
    stockMap[key].inQty_box += Number(r.qty_box || 0);
    stockMap[key].inQty_pt += Number(r.qty_pt || 0);
    // ptype이 없으면 wh_inbound 값으로 채움
    if (!stockMap[key].ptype) stockMap[key].ptype = ptype;
  });
  // 4패스: 창고 출고(wh_outbound) 집계
  // 매칭 우선순위: 1) 품목명+소비기한 정확 매칭 2) ref_lot로 입고 레코드 소비기한 조회 3) FIFO(가장 빠른 소비기한)
  var _whInLotMap = {};
  (allWhInboundData || []).forEach(function(r) {
    if (r.lot_no) _whInLotMap[r.lot_no] = r;
  });
  (allWhOutboundData || []).forEach(function(r) {
    var name = (r.item_name || '').trim();
    var qty = Number(r.qty || 0);
    if (!name || !qty) return;
    var expiry = (r.expiry_date || '').trim();
    // 1) 정확 매칭: 품목명 + 소비기한
    var exactKey = name + '||' + expiry;
    var matchedKey = null;
    if (stockMap[exactKey]) {
      matchedKey = exactKey;
    } else if (!expiry && r.ref_lot && _whInLotMap[r.ref_lot]) {
      // 2) ref_lot으로 입고 레코드의 소비기한 조회
      var refExpiry = (_whInLotMap[r.ref_lot].expiry_date || '').trim();
      var refKey = name + '||' + refExpiry;
      if (stockMap[refKey]) matchedKey = refKey;
    }
    if (!matchedKey) {
      // 3) FIFO: 같은 품목명 중 소비기한이 가장 빠른 키 (재고가 남아있는 것 우선)
      var candidates = Object.keys(stockMap).filter(function(k) {
        return k.startsWith(name + '||');
      });
      if (candidates.length > 0) {
        // 재고 있는 것 우선, 없으면 소비기한 빠른 순
        candidates.sort(function(a, b) {
          var stockA = stockMap[a].inQty - stockMap[a].outQty;
          var stockB = stockMap[b].inQty - stockMap[b].outQty;
          if (stockA > 0 && stockB <= 0) return -1;
          if (stockA <= 0 && stockB > 0) return 1;
          return (stockMap[a].expiry || '9999').localeCompare(stockMap[b].expiry || '9999');
        });
        matchedKey = candidates[0];
      }
    }
    if (!matchedKey) {
      // 매칭 실패: 새 키 생성 (출고만 있는 경우)
      matchedKey = name + '||' + expiry;
      stockMap[matchedKey] = { name: name, expiry: expiry, unit: (r.unit||'ea'), ptype: '', inQty: 0, outQty: 0,
        inQty_ea: 0, inQty_box: 0, inQty_pt: 0, outQty_ea: 0, outQty_box: 0, outQty_pt: 0 };
    }
    stockMap[matchedKey].outQty += qty;
    // 하위 호환: qty_ea 없으면 qty 사용
    stockMap[matchedKey].outQty_ea += Number(r.qty_ea !== undefined ? r.qty_ea : qty) || 0;
    stockMap[matchedKey].outQty_box += Number(r.qty_box || 0);
    stockMap[matchedKey].outQty_pt += Number(r.qty_pt || 0);
  });

  var rows = Object.values(stockMap);
  if (q) rows = rows.filter(function(r) { return r.name.toLowerCase().indexOf(q) !== -1; });
  // 재고현황 유형 필터: 회수입고는 유형 필터에서 제외 (재고에는 포함)
  if (typeF) rows = rows.filter(function(r) { return r.ptype === typeF; });
  else rows = rows.filter(function(r) { return r.ptype !== '회수입고'; });
  // 재고없음/마이너스 보이기 체크박스 (기본값: 미체크 = 숨김)
  var hideZeroEl = document.getElementById('stockHideZero');
  var showZero = hideZeroEl ? hideZeroEl.checked : false;
  if (!showZero) rows = rows.filter(function(r) { return (r.inQty - r.outQty) > 0; });
  rows.sort(function(a, b) {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return (a.expiry || '').localeCompare(b.expiry || '');
  });

  var countEl = document.getElementById('stockResultCount');
  var countEl2 = document.getElementById('stockCount');
  if (countEl) countEl.textContent = rows.length + '품목';
  if (countEl2) countEl2.textContent = rows.length + '품목';

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="15" style="text-align:center;color:#aaa;padding:30px"><i class="fas fa-inbox" style="font-size:24px;display:block;margin-bottom:8px"></i>재고 데이터가 없습니다.</td></tr>';
    return;
  }

  var typeColors = { '수입제품': '#2980b9', 'OEM제품': '#d68910', '자체생산': '#1e8449', '기타': '#888' };
  var typeBg = { '수입제품': '#e8f4fd', 'OEM제품': '#fef9e7', '자체생산': '#eafaf1', '기타': '#f0f0f0' };

  tbody.innerHTML = rows.map(function(r) {
    var stock = r.inQty - r.outQty;
    var stockEa = r.inQty_ea - r.outQty_ea;
    var color = typeColors[r.ptype] || '#888';
    var bg = typeBg[r.ptype] || '#f0f0f0';
    var expiryStatus = '';
    var expiryStyle = '';
    if (r.expiry) {
      var today = new Date();
      var exp = new Date(r.expiry);
      var diff = Math.floor((exp - today) / (1000 * 60 * 60 * 24));
      if (diff < 0) {
        expiryStatus = '<span style="background:#fdedec;color:#e74c3c;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700;margin-left:4px">기한만료</span>';
        expiryStyle = 'color:#e74c3c;font-weight:700';
      } else if (diff <= 30) {
        expiryStatus = '<span style="background:#fff3cd;color:#d68910;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700;margin-left:4px">임박(' + diff + '일)</span>';
        expiryStyle = 'color:#d68910;font-weight:600';
      }
    }
    var stockBadge = '';
    if (stock < 0) {
      stockBadge = '<span style="background:#4a0000;color:#ff6b6b;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700" title="출고량이 입고량을 초과합니다. 데이터를 확인해주세요.">⚠ 마이너스</span>';
    } else if (stock === 0) {
      stockBadge = '<span style="background:#fdedec;color:#e74c3c;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700">재고없음</span>';
    } else if (stock <= 10) {
      stockBadge = '<span style="background:#fff3cd;color:#d68910;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700">부족</span>';
    } else {
      stockBadge = '<span style="background:#eafaf1;color:#27ae60;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700">정상</span>';
    }
    // 입고/출고 낱개·Box·PT 세분 표시
    function fmtQtyCell(ea, box, pt, colorStyle) {
      var parts = [];
      if (pt > 0) parts.push('<span style="color:#8e44ad;font-size:11px">' + pt.toLocaleString() + ' PT</span>');
      if (box > 0) parts.push('<span style="color:#2980b9;font-size:11px">' + box.toLocaleString() + ' Box</span>');
      if (ea > 0) parts.push('<span style="' + colorStyle + ';font-size:11px">' + ea.toLocaleString() + ' ea</span>');
      return parts.length > 0 ? parts.join('<br>') : '<span style="color:#aaa">-</span>';
    }
    // 현재고 Box/PT 환산 (제품마스터 연동)
    var pmList = _lgProductCache || [];
    var pmMatch = pmList.find(function(p) { return (p.product_name||'').trim() === r.name; });
    var qpb = pmMatch ? (parseInt(pmMatch.qty_per_box) || 0) : 0;
    var bpp = pmMatch ? (parseInt(pmMatch.boxes_per_pallet) || 0) : 0;
    var specVal = pmMatch ? (pmMatch.specification || pmMatch.spec_code || '') : '';
    // 입고 ea/box/pt 계산 (저장값 없으면 제품마스터 환산)
    var inEa = r.inQty_ea || 0;
    var inBox = r.inQty_box || (qpb > 0 ? Math.floor(inEa / qpb) : 0);
    var inPt = r.inQty_pt || ((qpb > 0 && bpp > 0) ? Math.floor(inEa / (qpb * bpp)) : 0);
    // 출고 ea/box/pt 계산
    var outEa = r.outQty_ea || 0;
    var outBox = r.outQty_box || (qpb > 0 ? Math.floor(outEa / qpb) : 0);
    var outPt = r.outQty_pt || ((qpb > 0 && bpp > 0) ? Math.floor(outEa / (qpb * bpp)) : 0);
    // 현재고 ea/box/pt
    var stockBox = qpb > 0 ? Math.floor(stockEa / qpb) : 0;
    var stockPt = (qpb > 0 && bpp > 0) ? Math.floor(stockEa / (qpb * bpp)) : 0;
    var eaColor = stock <= 0 ? '#e74c3c' : '#222';
    return '<tr>' +
      '<td><b>' + r.name + '</b></td>' +
      '<td style="font-size:11px;color:#555">' + (specVal || '-') + '</td>' +
      '<td><span style="background:' + bg + ';color:' + color + ';padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700">' + (r.ptype || '-') + '</span></td>' +
      '<td style="' + expiryStyle + '">' + (r.expiry || '-') + expiryStatus + '</td>' +
      '<td style="text-align:right;background:#f1f8f2;color:#2e7d32">' + inEa.toLocaleString() + '</td>' +
      '<td style="text-align:right;background:#f1f8f2;color:#2e7d32">' + inBox.toLocaleString() + '</td>' +
      '<td style="text-align:right;background:#f1f8f2;color:#2e7d32">' + inPt.toLocaleString() + '</td>' +
      '<td style="text-align:right;background:#fff5f5;color:#c62828">' + outEa.toLocaleString() + '</td>' +
      '<td style="text-align:right;background:#fff5f5;color:#c62828">' + outBox.toLocaleString() + '</td>' +
      '<td style="text-align:right;background:#fff5f5;color:#c62828">' + outPt.toLocaleString() + '</td>' +
      '<td style="text-align:right;background:#f0f2ff;color:' + eaColor + ';font-weight:700">' + stockEa.toLocaleString() + '</td>' +
      '<td style="text-align:right;background:#f0f2ff;color:#283593">' + stockBox.toLocaleString() + '</td>' +
      '<td style="text-align:right;background:#f0f2ff;color:#283593">' + stockPt.toLocaleString() + '</td>' +
      '<td>' + r.unit + '</td>' +
      '<td>' + stockBadge + '</td>' +
      '</tr>';
  }).join('');
}
