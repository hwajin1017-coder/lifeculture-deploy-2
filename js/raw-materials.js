// =====================================================
// 원료수불부 JS (v3 - 출고 UI 개선 + FIFO 확인)
// - 입고: QC 수입검사, 소비기한, 검수자 포함
// - 출고: QC 제거, 선입선출(FIFO) 확인 패널, 출고목적 추가
// - 자재코드 선택 → 품목명 자동입력 + Lot No 자동생성
// =====================================================

let allRawData = [];
let filteredData = [];
let allMasterData = [];
let currentPage = 1;
const pageSize = 15;
let editingId = null;

document.addEventListener('DOMContentLoaded', async () => {
  // new Date() 1회 생성 후 재사용 (중복 생성 제거)
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');

  const dateEl = document.getElementById('f_receive_date');
  if (dateEl) dateEl.value = today;

  // 기간 필터 기본값 (이번달)
  const fromEl = document.getElementById('journalFrom');
  const toEl = document.getElementById('journalTo');
  if (fromEl) fromEl.value = `${y}-${m}-01`;
  if (toEl) toEl.value = today;

  // Promise.all 병렬 로드 (독립적인 두 컬렉션을 동시에 요청)
  await Promise.all([loadMasterData(), loadRawMaterials()]);
  renderStockSummaryCards();

  const form = document.getElementById('rawForm');
  if (form) form.addEventListener('submit', handleSubmit);
});

// =====================================================
// 자재마스터 로드 → 자재코드 드롭다운
// =====================================================
async function loadMasterData() {
  try {
    const res = await apiGetAll('materials_master');
    allMasterData = res.sort((a, b) => (a.material_name || '').localeCompare(b.material_name || ''));
    buildMaterialSelect();
  } catch(e) {
    console.warn('[raw-materials] 자재마스터 로드 실패:', e);
  }
}

function buildMaterialSelect() {
  const sel = document.getElementById('f_item_code_select');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- 자재코드 선택 (클릭하면 품목명 자동입력) --</option>';
  allMasterData.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.material_code || '';
    opt.dataset.name = m.material_name || '';
    opt.dataset.type = m.material_type || '';
    opt.dataset.unit = m.unit || '';
    opt.dataset.price = m.standard_price || '';
    opt.dataset.supplier = m.supplier || '';
    opt.dataset.origin = m.origin_country || '';
    opt.dataset.shelfDays = m.shelf_life_days || '';
    opt.textContent = `[${m.material_code || '-'}] ${m.material_name || '-'} (${m.material_type || '-'})`;
    sel.appendChild(opt);
  });
}

// 자재코드 선택 → 자동입력 + Lot No 자동생성
async function onMaterialSelect() {
  const sel = document.getElementById('f_item_code_select');
  const selected = sel.options[sel.selectedIndex];
  if (!selected || !selected.value) return;

  const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined && val !== '') el.value = val; };
  set('f_item_code', selected.value);
  set('f_item_name', selected.dataset.name);
  set('f_supplier', selected.dataset.supplier);
  set('f_country', selected.dataset.origin);
  set('f_unit_price', selected.dataset.price);

  const typeEl = document.getElementById('f_item_type');
  if (typeEl && selected.dataset.type) typeEl.value = selected.dataset.type;
  const unitEl = document.getElementById('f_unit');
  if (unitEl && selected.dataset.unit) unitEl.value = selected.dataset.unit;

  // 소비기한 자동계산
  if (selected.dataset.shelfDays && parseInt(selected.dataset.shelfDays) > 0) {
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + parseInt(selected.dataset.shelfDays));
    const expEl = document.getElementById('f_expiry_date');
    if (expEl) expEl.value = expDate.toISOString().split('T')[0];
  }

  await refreshLotNo();
  calcCurrentStock();

  // 출고 모드이면 FIFO 즉시 로드
  const type = document.getElementById('f_transaction_type')?.value;
  if (type === '출고' && selected.dataset.name) {
    loadFifoSuggestion(selected.dataset.name);
  }

  showToast(`✅ [${selected.value}] ${selected.dataset.name} 자동입력 완료`, 'success');
}

// =====================================================
// Lot No 자동생성
// 형식: [자재코드]-[YYMMDD]-[연간순번2자리]
// 예) BSN-260615-01 (브라질 세하도 NY2 생두, 2026년 첫 번째 입고)
// 출고/조정 시에는 Lot No 표시 영역 숨김
// =====================================================
async function refreshLotNo() {
  const display = document.getElementById('lotDisplay');
  const lotWrap = document.getElementById('lotWrap');
  if (!display) return;

  const type = document.getElementById('f_transaction_type')?.value || '입고';

  // 출고/조정 시 Lot No 표시 숨김 (출고는 source_lot 사용)
  if (type !== '입고') {
    if (lotWrap) lotWrap.style.display = 'none';
    display.textContent = '';
    display.dataset.lot = '';
    return;
  }

  if (lotWrap) lotWrap.style.display = '';
  display.textContent = '생성 중...';

  // 자재코드 가져오기
  const itemCode = document.getElementById('f_item_code')?.value?.trim() || '';
  const receiveDateEl = document.getElementById('f_receive_date');
  const receiveDate = receiveDateEl?.value || new Date().toISOString().split('T')[0];

  const lot = await generateRawLotNo(itemCode, receiveDate);
  display.textContent = lot;
  display.dataset.lot = lot;
}

// [자재코드]-[YYMMDD]-[연간순번2자리] 형식 생성
async function generateRawLotNo(itemCode, receiveDate) {
  try {
    // 날짜 파싱 (YYYY-MM-DD → YYMMDD)
    const d = receiveDate ? new Date(receiveDate) : new Date();
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateStr = `${yy}${mm}${dd}`;

    // 자재코드가 없으면 폴백 (RM-YYMMDD-NNN)
    if (!itemCode) {
      const data = await apiGetAll('raw_materials');
      const fallbackPrefix = `RM-${dateStr}`;
      const existing = data.filter(r => r.lot_no && r.lot_no.startsWith(fallbackPrefix));
      return `${fallbackPrefix}-${String(existing.length + 1).padStart(2, '0')}`;
    }

    // 해당 연도(YY)에 동일 자재코드로 입고된 레코드 수 조회
    const data = await apiGetAll('raw_materials');
    const yearPrefix = `${itemCode}-${yy}`; // 예) BSN-26
    const sameYearInbound = data.filter(r =>
      r.transaction_type === '입고' &&
      r.lot_no &&
      r.lot_no.startsWith(yearPrefix)
    );
    const seq = String(sameYearInbound.length + 1).padStart(2, '0');
    return `${itemCode}-${dateStr}-${seq}`;
  } catch(e) {
    const d = receiveDate ? new Date(receiveDate) : new Date();
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const rand = String(Math.floor(Math.random() * 99) + 1).padStart(2, '0');
    return `${itemCode || 'RM'}-${yy}${mm}${dd}-${rand}`;
  }
}

// =====================================================
// 거래유형 변경 - 입고/출고 UI 전환
// =====================================================
async function handleTransactionType() {
  await refreshLotNo();
  const type = document.getElementById('f_transaction_type')?.value;
  const isOut = type === '출고';
  const isIn  = type === '입고';

  // 입고 전용 섹션 (QC 수입검사)
  const inSec = document.getElementById('inSection');
  if (inSec) inSec.style.display = isIn ? '' : 'none';

  // 출고 전용 섹션 (출고 목적, 참조 Lot)
  const outSec = document.getElementById('outSection');
  if (outSec) outSec.style.display = isOut ? '' : 'none';

  // FIFO 확인 패널 (출고 시에만)
  const fifoPanel = document.getElementById('fifoPanel');
  if (fifoPanel) fifoPanel.style.display = isOut ? '' : 'none';

  // 수량 레이블 및 슬롯 표시/숨김 변경
  const qtyLabelEl = document.getElementById('qty_label');
  const qtyInput = document.getElementById('f_qty');
  const carryOverWrap = document.getElementById('carryOverWrap');
  const usedQtyWrap = document.getElementById('usedQtyWrap');
  const balanceWrap = document.getElementById('balanceWrap');
  const balanceLabel = document.getElementById('balance_label');

  if (isOut) {
    // 출고: 이월재고/금일사용량 숨김, 출고수량/출고후재고로 변경
    if (carryOverWrap) carryOverWrap.style.display = 'none';
    if (usedQtyWrap) usedQtyWrap.style.display = 'none';
    if (qtyLabelEl) qtyLabelEl.innerHTML = '출고수량 <span class="required">*</span>';
    if (qtyInput) { qtyInput.placeholder = '출고할 수량 입력'; }
    if (balanceLabel) balanceLabel.textContent = '출고 후 재고 (자동계산)';
  } else {
    // 입고: 모두 표시
    if (carryOverWrap) carryOverWrap.style.display = '';
    if (usedQtyWrap) usedQtyWrap.style.display = '';
    if (qtyLabelEl) qtyLabelEl.innerHTML = '금일입고수량 <span class="required">*</span>';
    if (qtyInput) { qtyInput.placeholder = '0.00'; }
    if (balanceLabel) balanceLabel.textContent = '현재재고 (자동계산)';
  }

  // 이미 품목이 선택되어 있다면 FIFO 로드
  const itemName = document.getElementById('f_item_name')?.value;
  if (isOut && itemName) loadFifoSuggestion(itemName);

  calcCurrentStock();
}

// =====================================================
// 선입선출(FIFO) 확인 패널 로드
// =====================================================
async function loadFifoSuggestion(itemName) {
  const fifoList = document.getElementById('fifoList');
  if (!fifoList || !itemName) return;
  fifoList.innerHTML = '<div class="fifo-empty"><i class="fas fa-spinner fa-spin"></i> 조회 중...</div>';

  try {
    const allData = await apiGetAll('raw_materials');

    // 해당 품목의 입고 레코드
    const inboundLots = allData.filter(r =>
      r.transaction_type === '입고' &&
      (r.item_name || '').trim() === itemName.trim()
    );

    if (!inboundLots.length) {
      fifoList.innerHTML = '<div class="fifo-empty">해당 품목의 입고 Lot이 없습니다.</div>';
      return;
    }

    // 출고 레코드에서 source_lot 기준으로 사용량 집계
    const outboundData = allData.filter(r =>
      r.transaction_type === '출고' &&
      (r.item_name || '').trim() === itemName.trim()
    );
    const usedBySourceLot = {};
    outboundData.forEach(r => {
      const src = r.source_lot || '';
      if (src) {
        // out_qty 우선, 없으면 receive_qty 또는 used_qty 사용
        usedBySourceLot[src] = (usedBySourceLot[src] || 0) + parseFloat(r.out_qty || r.receive_qty || r.used_qty || 0);
      }
      // reference_lot 기반 연동 (로스팅 자동 출고 등)
      const ref = r.reference_lot || '';
      if (ref && !src) {
        usedBySourceLot[ref] = (usedBySourceLot[ref] || 0) + parseFloat(r.out_qty || r.used_qty || r.receive_qty || 0);
      }
    });

    // 소비기한 오름차순 정렬 (FIFO)
    const sorted = inboundLots.sort((a, b) => {
      const ea = a.expiry_date || '9999-99-99';
      const eb = b.expiry_date || '9999-99-99';
      return ea.localeCompare(eb);
    });

    const rows = sorted.map((lot, idx) => {
      const inQty = parseFloat(lot.receive_qty || 0);
      const usedQty = usedBySourceLot[lot.lot_no] || 0;
      const remaining = inQty - usedQty;
      if (remaining <= 0) return ''; // 소진된 Lot 제외

      const daysLeft = lot.expiry_date
        ? Math.ceil((new Date(lot.expiry_date) - new Date()) / (1000 * 60 * 60 * 24))
        : null;
      const expiryClass = daysLeft !== null && daysLeft <= 30 ? 'fifo-lot-expiry' : '';
      const expiryText = lot.expiry_date
        ? `${lot.expiry_date}${daysLeft !== null ? ` (D-${daysLeft})` : ''}`
        : '소비기한 없음';
      const isFirst = idx === 0;

      return `<div class="fifo-lot-row${isFirst ? ' fifo-selected' : ''}" data-remaining="${remaining}" onclick="selectFifoLot('${lot.lot_no}')">
        <div style="min-width:24px;font-weight:700;color:${isFirst?'#856404':'#aaa'}">${idx + 1}</div>
        <span class="fifo-lot-badge">${lot.lot_no || '-'}</span>
        <div style="flex:1">
          <div style="font-weight:600">${lot.item_name || '-'}</div>
          <div class="${expiryClass}" style="font-size:11px">소비기한: ${expiryText}</div>
        </div>
        <div class="fifo-lot-qty">잔여 ${remaining.toFixed(2)} ${lot.unit || ''}</div>
        ${isFirst ? '<span style="font-size:10px;background:#f0c040;color:#5d4037;padding:2px 6px;border-radius:6px;font-weight:700">우선출고</span>' : ''}
      </div>`;
    }).filter(Boolean).join('');

    if (!rows) {
      fifoList.innerHTML = '<div class="fifo-empty">잔여 재고가 있는 입고 Lot이 없습니다. (모두 소진)</div>';
    } else {
      fifoList.innerHTML = rows;
    }
  } catch(e) {
    fifoList.innerHTML = `<div class="fifo-empty">FIFO 조회 실패: ${e.message}</div>`;
  }
}

// FIFO 목록에서 Lot 클릭 시 source_lot 자동 입력
function selectFifoLot(lotNo) {
  const el = document.getElementById('f_source_lot');
  if (el) el.value = lotNo;

  // 선택 표시 업데이트 및 잔량 data 저장
  document.querySelectorAll('.fifo-lot-row').forEach(row => row.classList.remove('fifo-selected'));
  const clickedRow = event.currentTarget;
  clickedRow.classList.add('fifo-selected');

  // 잔량을 data attribute에서 읽어 balance 필드에 반영
  const remaining = parseFloat(clickedRow.dataset.remaining || 0);
  const balEl = document.getElementById('f_balance');
  const outQty = parseFloat(document.getElementById('f_qty')?.value) || 0;
  if (balEl) {
    const afterBalance = remaining - outQty;
    balEl.value = afterBalance.toFixed(2);
    balEl.style.color = afterBalance < 0 ? '#e74c3c' : '#1e8449';
  }
  showToast(`✅ 출고 Lot: ${lotNo} 선택됨 (잔량: ${remaining})`, 'success');
}

// =====================================================
// 현재재고 자동계산
// 입고: 이월재고 + 금일입고 - 금일사용량
// 출고: FIFO 선택 Lot의 재고 - 출고수량 (단순 표시용)
// =====================================================
function calcCurrentStock() {
  const type = document.getElementById('f_transaction_type')?.value;
  const balEl = document.getElementById('f_balance');
  if (!balEl) return;

  if (type === '출고') {
    // 출고 시: source_lot 재고 - 출고수량 표시
    const outQty = parseFloat(document.getElementById('f_qty')?.value) || 0;
    // FIFO 패널에서 선택된 Lot의 재고를 가져와 차감 표시
    const sourceLotEl = document.getElementById('f_source_lot');
    const sourceLot = sourceLotEl?.value || '';
    if (sourceLot) {
      // FIFO 패널에서 재고 읽기
      const fifoRows = document.querySelectorAll('.fifo-lot-row');
      let lotRemain = null;
      fifoRows.forEach(row => {
        const badge = row.querySelector('.fifo-lot-badge');
        if (badge && badge.textContent.trim() === sourceLot) {
          const qtyText = row.querySelector('.fifo-lot-qty')?.textContent || '';
          const match = qtyText.match(/[\d.]+/);
          if (match) lotRemain = parseFloat(match[0]);
        }
      });
      if (lotRemain !== null) {
        const afterBalance = lotRemain - outQty;
        balEl.value = afterBalance.toFixed(2);
        balEl.style.color = afterBalance < 0 ? '#e74c3c' : '#1e8449';
        return;
      }
    }
    // source_lot 미선택 시 0 표시 (Lot 선택 후 재계산)
    balEl.value = '0.00';
    balEl.style.color = '#1e8449';
  } else {
    // 입고: 이월재고 + 금일입고 - 금일사용량
    const carryOver = parseFloat(document.getElementById('f_carry_over')?.value) || 0;
    const inQty = parseFloat(document.getElementById('f_qty')?.value) || 0;
    const usedQty = parseFloat(document.getElementById('f_used_qty')?.value) || 0;
    const balance = carryOver + inQty - usedQty;
    balEl.value = balance.toFixed(2);
    balEl.style.color = balance < 0 ? '#e74c3c' : '#1e8449';
  }
}

// =====================================================
// 폼 제출
// =====================================================
async function handleSubmit(e) {
  e.preventDefault();
  const type = document.getElementById('f_transaction_type').value;
  if (!type) { showToast('거래유형을 선택하세요.', 'warning'); return; }

  const strVal = (id) => document.getElementById(id)?.value?.trim() || '';
  const numVal = (id) => parseFloat(document.getElementById(id)?.value) || 0;

  const lot = document.getElementById('lotDisplay')?.dataset?.lot || document.getElementById('lotDisplay')?.textContent || '';

  // 입고/출고에 따라 담당자 필드 다름
  const manager = type === '출고' ? strVal('f_manager') : strVal('f_manager_in');

  const isOut = type === '출고';
  const record = {
    lot_no: lot,
    transaction_type: type,
    receive_date: strVal('f_receive_date'),
    item_type: strVal('f_item_type'),
    item_code: strVal('f_item_code'),
    item_name: strVal('f_item_name'),
    supplier: strVal('f_supplier'),
    // 입고 전용 수량 필드
    carry_over: isOut ? 0 : numVal('f_carry_over'),
    receive_qty: isOut ? 0 : numVal('f_qty'),
    used_qty: isOut ? 0 : numVal('f_used_qty'),
    // 출고 수량
    out_qty: isOut ? numVal('f_qty') : 0,
    balance: numVal('f_balance'),
    unit: strVal('f_unit'),
    unit_price: numVal('f_unit_price'),
    country_of_origin: strVal('f_country'),
    storage_location: strVal('f_storage_location'),
    // 입고 전용
    production_date: strVal('f_production_date'),
    expiry_date: strVal('f_expiry_date'),
    qc_result: strVal('f_qc_result'),
    inspector: strVal('f_inspector'),
    manufacturer: strVal('f_manufacturer'),
    // 출고 전용
    source_lot: strVal('f_source_lot'),
    out_purpose: strVal('f_out_purpose'),
    reference_lot: strVal('f_reference_lot'),
    // 공통
    manager: manager,
    notes: strVal('f_notes'),
  };

  // 유효성 검사 - 공통
  if (!record.item_name) { showToast('품목명을 입력하세요.', 'warning'); return; }
  if (!record.unit) { showToast('단위를 선택하세요.', 'warning'); return; }
  const qty = isOut ? record.out_qty : record.receive_qty;
  if (!qty || qty <= 0) { showToast('수량을 입력하세요.', 'warning'); return; }
  if (!record.manager) { showToast('담당자를 입력하세요.', 'warning'); return; }

  // 유효성 검사 - 입고 전용
  if (type === '입고') {
    // 소비기한은 선택 사항 (생두 등 소비기한 없는 품목 허용)
    if (!record.qc_result) { showToast('QC 수입검사 결과를 선택하세요.', 'warning'); return; }
  }

  // 유효성 검사 - 출고 전용
  if (type === '출고') {
    if (!record.out_purpose) { showToast('출고 목적을 선택하세요.', 'warning'); return; }
  }

  const btn = document.querySelector('#rawForm button[type="submit"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...'; }

  try {
    await apiPost('raw_materials', record);
    showToast(`✅ ${type} 등록 완료! Lot: ${lot}`, 'success');
    // KPI 집계 캐시 업데이트 (입고 건수 집계)
    if (typeof updateKpiCache === 'function') updateKpiCache('raw_materials', record, +1);
    resetForm();
    await loadRawMaterials();
    renderStockSummaryCards();
  } catch (err) {
    showToast('저장 실패: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> 등록'; }
  }
}

// =====================================================
// 폼 초기화
// =====================================================
function resetForm() {
  const form = document.getElementById('rawForm');
  if (form) form.reset();
  const today = new Date().toISOString().split('T')[0];
  const dateEl = document.getElementById('f_receive_date');
  if (dateEl) dateEl.value = today;
  const balEl = document.getElementById('f_balance');
  if (balEl) { balEl.value = ''; balEl.style.color = ''; }
  // UI 상태 초기화 (입고 기본)
  const inSec = document.getElementById('inSection');
  const outSec = document.getElementById('outSection');
  const fifoPanel = document.getElementById('fifoPanel');
  if (inSec) inSec.style.display = '';
  if (outSec) outSec.style.display = 'none';
  if (fifoPanel) fifoPanel.style.display = 'none';
  refreshLotNo();
}

// =====================================================
// 데이터 로드
// =====================================================
async function loadRawMaterials() {
  try {
    const res = await apiGetAll('raw_materials');
    // 거래일자(receive_date) 내림차순 정렬, 같은 날짜는 등록순(created_at) 내림차순
    allRawData = (res || []).sort((a, b) => {
      const dateA = a.receive_date || '';
      const dateB = b.receive_date || '';
      if (dateB !== dateA) return dateB.localeCompare(dateA);
      return (b.created_at || 0) - (a.created_at || 0);
    });
    applyFilter();
    renderStockSummaryCards();
  } catch (e) {
    const tb = document.getElementById('rawTableBody');
    if (tb) tb.innerHTML = `<tr><td colspan="16" class="empty-msg">데이터 로드 실패: ${e.message}</td></tr>`;
  }
}

// =====================================================
// 필터 적용
// =====================================================
function applyFilter() {
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const typeFilter = document.getElementById('typeFilter')?.value || '';
  filteredData = allRawData.filter(r => {
    const matchQ = !q ||
      (r.item_name || '').toLowerCase().includes(q) ||
      (r.lot_no || '').toLowerCase().includes(q) ||
      (r.item_code || '').toLowerCase().includes(q);
    const matchType = !typeFilter || r.transaction_type === typeFilter;
    return matchQ && matchType;
  });
  currentPage = 1;
  renderTable();
}

function filterTable() { applyFilter(); }

// =====================================================
// 테이블 렌더링 (수불부 현황)
// =====================================================
function renderTable() {
  const tbody = document.getElementById('rawTableBody');
  if (!tbody) return;
  const start = (currentPage - 1) * pageSize;
  const pageData = filteredData.slice(start, start + pageSize);

  if (!pageData.length) {
    tbody.innerHTML = `<tr><td colspan="16"><div class="empty-msg"><i class="fas fa-inbox"></i> 등록된 내역이 없습니다.</div></td></tr>`;
  } else {
    tbody.innerHTML = pageData.map(r => {
      const isIn = r.transaction_type === '입고';
      const isOut = r.transaction_type === '출고';
      const typeColor = isIn ? 'badge-success' : isOut ? 'badge-danger' : 'badge-warning';

      // QC 배지 (입고만 해당)
      const qcBadge = isIn
        ? (r.qc_result === '합격'
          ? '<span class="qc-badge qc-합격">✅ 합격</span>'
          : r.qc_result === '불합격'
            ? '<span class="qc-badge qc-불합격">❌ 불합격</span>'
            : r.qc_result === '특채'
              ? '<span class="qc-badge qc-특채">⚠️ 특채</span>'
              : '-')
        : (isOut ? `<span style="font-size:11px;color:#888">${r.out_purpose || '출고'}</span>` : '-');

      // 소비기한 임박 체크 (30일 이내)
      let expiryHtml = r.expiry_date || '-';
      if (r.expiry_date) {
        const daysLeft = Math.ceil((new Date(r.expiry_date) - new Date()) / (1000 * 60 * 60 * 24));
        if (daysLeft <= 30 && daysLeft > 0) {
          expiryHtml = `<span style="color:#e67e22;font-weight:700">${r.expiry_date} <small>(D-${daysLeft})</small></span>`;
        } else if (daysLeft <= 0) {
          expiryHtml = `<span style="color:#e74c3c;font-weight:700">${r.expiry_date} <small>(만료)</small></span>`;
        }
      }

      return `<tr>
        <td><span class="badge badge-lot" style="cursor:pointer;background:${isIn?'#eafaf1':isOut?'#fdedec':'#fff3cd'};color:${isIn?'#27ae60':isOut?'#e74c3c':'#856404'};border:1px solid ${isIn?'#a9dfbf':isOut?'#f5b7b1':'#ffc107'}" onclick="goToTrace('${r.lot_no||''}')">${r.lot_no || '-'}</span></td>
        <td><span class="badge ${typeColor}">${r.transaction_type || '-'}</span></td>
        <td>${r.receive_date || '-'}</td>
        <td>${r.item_type || '-'}</td>
        <td><strong>${r.item_name || '-'}</strong></td>
        <td style="color:#888">${r.carry_over != null ? numFormat(r.carry_over, 2) : '-'}</td>
        <td style="color:${isIn?'#27ae60':'inherit'};font-weight:${isIn?'700':'400'}">${r.receive_qty != null ? numFormat(r.receive_qty, 2) : '-'}</td>
        <td style="color:${isOut?'#e74c3c':'inherit'}">${r.used_qty != null ? numFormat(r.used_qty, 2) : '-'}</td>
        <td><strong style="color:#1e8449">${r.balance != null ? numFormat(r.balance, 2) : '-'}</strong></td>
        <td>${r.unit || '-'}</td>
        <td style="font-size:12px">${r.production_date || '-'}</td>
        <td>${expiryHtml}</td>
        <td>${qcBadge}</td>
        <td>${r.manager || r.inspector || '-'}</td>
        <td>${r.supplier || '-'}</td>
        <td>${r.notes || (r.source_lot ? `참조: ${r.source_lot}` : '-')}</td>
        <td>
          <button class="edit-row-btn" onclick="openEditModal('${r.id}')"><i class="fas fa-edit"></i></button>
          <button class="edit-row-btn" style="color:#e74c3c;border-color:#e74c3c" onclick="deleteRecord('${r.id}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');
  }

  const countEl = document.getElementById('tableCount');
  if (countEl) countEl.textContent = `전체 ${filteredData.length}건`;
  renderPagination();
}

// =====================================================
// 재고 현황 카드
// =====================================================
function renderStockSummaryCards() {
  const container = document.getElementById('stockSummaryCards');
  if (!container) return;

  const stockMap = {};
  const sorted = [...allRawData].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  sorted.forEach(r => {
    if (!r.item_name) return;
    if (!stockMap[r.item_name]) stockMap[r.item_name] = { name: r.item_name, balance: 0, unit: r.unit || '' };
    if (r.transaction_type === '입고') stockMap[r.item_name].balance += parseFloat(r.receive_qty || 0);
    else if (r.transaction_type === '출고') {
      // out_qty 우선, 없으면 used_qty, 그도 없으면 receive_qty 폴백
      const outAmt = parseFloat(r.out_qty || r.used_qty || r.receive_qty || 0);
      stockMap[r.item_name].balance -= outAmt;
    }
    else if (r.transaction_type === '조정') stockMap[r.item_name].balance = parseFloat(r.balance || 0);
    // balance 필드가 있으면 해당 시점 재고로 덮어쓰기 (입고 레코드에만 적용)
    if (r.transaction_type === '입고' && r.balance != null && r.balance !== '') {
      stockMap[r.item_name].balance = parseFloat(r.balance);
    }
  });

  const items = Object.values(stockMap);
  if (!items.length) { container.innerHTML = ''; return; }

  container.innerHTML = items.map(it => {
    const low = it.balance <= 10;
    return `<div class="kpi-card" style="border-left:4px solid ${low?'#e74c3c':'#27ae60'}">
      <div class="kpi-icon" style="background:${low?'#fdedec':'#eafaf1'};color:${low?'#e74c3c':'#27ae60'}">
        <i class="fas fa-seedling"></i>
      </div>
      <div class="kpi-info">
        <div class="kpi-value" style="font-size:18px">${numFormat(it.balance, 2)} <small style="font-size:12px">${it.unit}</small></div>
        <div class="kpi-label">${it.name}</div>
        ${low ? '<div style="font-size:10px;color:#e74c3c;font-weight:700"><i class="fas fa-exclamation-triangle"></i> 재고 부족</div>' : ''}
      </div>
    </div>`;
  }).join('');
}

// =====================================================
// 입출고 일지 (기간별)
// =====================================================
async function loadJournal() {
  const from = document.getElementById('journalFrom')?.value;
  const to = document.getElementById('journalTo')?.value;
  const type = document.getElementById('journalType')?.value || '';
  const search = (document.getElementById('journalSearch')?.value || '').toLowerCase();

  if (!from || !to) { showToast('조회 기간을 선택하세요.', 'warning'); return; }

  const filtered = allRawData.filter(r => {
    const d = r.receive_date || '';
    const matchDate = d >= from && d <= to;
    const matchType = !type || r.transaction_type === type;
    const matchSearch = !search || (r.item_name || '').toLowerCase().includes(search) || (r.lot_no || '').toLowerCase().includes(search);
    return matchDate && matchType && matchSearch;
  }).sort((a, b) => (a.receive_date || '').localeCompare(b.receive_date || ''));

  const tbody = document.getElementById('journalTableBody');
  const countEl = document.getElementById('journalResultCount');
  const summaryEl = document.getElementById('journalSummary');

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="16" class="empty-msg">해당 기간에 입출고 내역이 없습니다.</td></tr>`;
    if (countEl) countEl.textContent = '0건';
    if (summaryEl) summaryEl.style.display = 'none';
    return;
  }

  tbody.innerHTML = filtered.map((r, i) => {
    const isIn = r.transaction_type === '입고';
    const isOut = r.transaction_type === '출고';
    const typeColor = isIn ? '#27ae60' : isOut ? '#e74c3c' : '#f39c12';
    const qcBadge = isIn
      ? (r.qc_result === '합격' ? '✅ 합격' : r.qc_result === '불합격' ? '❌ 불합격' : r.qc_result === '특채' ? '⚠️ 특채' : '-')
      : (isOut ? (r.out_purpose || '출고') : '-');

    return `<tr>
      <td>${i + 1}</td>
      <td style="font-size:11px">${r.lot_no || '-'}</td>
      <td>${r.receive_date || '-'}</td>
      <td><span style="color:${typeColor};font-weight:700">${r.transaction_type || '-'}</span></td>
      <td>${r.item_type || '-'}</td>
      <td><strong>${r.item_name || '-'}</strong></td>
      <td style="text-align:right">${r.carry_over != null ? numFormat(r.carry_over, 2) : '-'}</td>
      <td style="text-align:right;color:${isIn?'#27ae60':'inherit'};font-weight:${isIn?'700':'400'}">${r.receive_qty != null ? numFormat(r.receive_qty, 2) : '-'}</td>
      <td style="text-align:right;color:${isOut?'#e74c3c':'inherit'}">${r.used_qty != null ? numFormat(r.used_qty, 2) : '-'}</td>
      <td style="text-align:right;font-weight:700;color:#1e8449">${r.balance != null ? numFormat(r.balance, 2) : '-'}</td>
      <td>${r.unit || '-'}</td>
      <td style="font-size:12px">${r.production_date || '-'}</td>
      <td>${r.expiry_date || '-'}</td>
      <td>${qcBadge}</td>
      <td>${r.manager || r.inspector || '-'}</td>
      <td>${r.supplier || '-'}</td>
      <td>${r.notes || (r.source_lot ? `참조: ${r.source_lot}` : '-')}</td>
    </tr>`;
  }).join('');

  const sumIn = filtered.reduce((s, r) => s + parseFloat(r.receive_qty || 0), 0);
  const sumUsed = filtered.reduce((s, r) => s + parseFloat(r.used_qty || 0), 0);
  document.getElementById('sumIn').textContent = numFormat(sumIn, 2);
  document.getElementById('sumUsed').textContent = numFormat(sumUsed, 2);
  document.getElementById('sumCount').textContent = filtered.length;
  if (summaryEl) summaryEl.style.display = 'block';
  if (countEl) countEl.textContent = `${filtered.length}건 조회됨 (${from} ~ ${to})`;
}

function printJournal() {
  const from = document.getElementById('journalFrom')?.value || '';
  const to = document.getElementById('journalTo')?.value || '';
  const header = document.getElementById('journalPrintHeader');
  const period = document.getElementById('journalPrintPeriod');
  if (header) header.style.display = 'block';
  if (period) period.textContent = `조회 기간: ${from} ~ ${to}`;
  window.print();
  if (header) header.style.display = 'none';
}

function exportJournal() {
  const from = document.getElementById('journalFrom')?.value || '';
  const to = document.getElementById('journalTo')?.value || '';
  const type = document.getElementById('journalType')?.value || '';
  const search = (document.getElementById('journalSearch')?.value || '').toLowerCase();

  const filtered = allRawData.filter(r => {
    const d = r.receive_date || '';
    const matchDate = d >= from && d <= to;
    const matchType = !type || r.transaction_type === type;
    const matchSearch = !search || (r.item_name || '').toLowerCase().includes(search);
    return matchDate && matchType && matchSearch;
  }).sort((a, b) => (a.receive_date || '').localeCompare(b.receive_date || ''));

  const headers = ['No', 'Lot No', '거래일자', '거래유형', '품목구분', '품목명', '이월재고', '금일입고', '금일사용량', '현재재고', '단위', '생산일자', '소비기한', 'QC/출고목적', '담당자', '공급업체', '비고'];
  const rows = filtered.map((r, i) => [
    i + 1, r.lot_no || '', r.receive_date || '', r.transaction_type || '',
    r.item_type || '', r.item_name || '',
    r.carry_over || 0, r.receive_qty || 0, r.used_qty || 0, r.balance || 0,
    r.unit || '', r.production_date || '', r.expiry_date || '',
    r.qc_result || r.out_purpose || r.quality_status || '',
    r.manager || r.inspector || '', r.supplier || '',
    r.notes || (r.source_lot ? `참조: ${r.source_lot}` : '')
  ]);

  const csvContent = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `입출고일지_${from}_${to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('엑셀 파일 다운로드 완료!', 'success');
}

function exportLedger() {
  const headers = ['Lot No', '거래유형', '거래일자', '품목구분', '품목명', '이월재고', '금일입고', '금일사용량', '현재재고', '단위', '생산일자', '소비기한', 'QC/출고목적', '담당자', '공급업체', '비고'];
  const rows = filteredData.map(r => [
    r.lot_no || '', r.transaction_type || '', r.receive_date || '',
    r.item_type || '', r.item_name || '',
    r.carry_over || 0, r.receive_qty || 0, r.used_qty || 0, r.balance || 0,
    r.unit || '', r.production_date || '', r.expiry_date || '',
    r.qc_result || r.out_purpose || r.quality_status || '',
    r.manager || r.inspector || '', r.supplier || '',
    r.notes || (r.source_lot ? `참조: ${r.source_lot}` : '')
  ]);
  const csvContent = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `원료수불부_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('엑셀 파일 다운로드 완료!', 'success');
}

// =====================================================
// 페이지네이션
// =====================================================
function renderPagination() {
  const totalPages = Math.ceil(filteredData.length / pageSize);
  const pg = document.getElementById('pagination');
  if (!pg) return;
  if (totalPages <= 1) { pg.innerHTML = ''; return; }
  let html = '';
  if (currentPage > 1) html += `<button class="page-btn" onclick="changePage(${currentPage-1})"><i class="fas fa-chevron-left"></i></button>`;
  for (let i = Math.max(1, currentPage-2); i <= Math.min(totalPages, currentPage+2); i++) {
    html += `<button class="page-btn ${i===currentPage?'active':''}" onclick="changePage(${i})">${i}</button>`;
  }
  if (currentPage < totalPages) html += `<button class="page-btn" onclick="changePage(${currentPage+1})"><i class="fas fa-chevron-right"></i></button>`;
  pg.innerHTML = html;
}
function changePage(p) { currentPage = p; renderTable(); }

// =====================================================
// 수정 모달
// =====================================================
async function openEditModal(id) {
  editingId = id;
  const rec = allRawData.find(r => r.id === id);
  if (!rec) return;

  const isOut = rec.transaction_type === '출고';
  const qcOptions = ['합격', '불합격', '특채'].map(q =>
    `<option ${rec.qc_result === q ? 'selected' : ''}>${q}</option>`
  ).join('');

  document.getElementById('editModalBody').innerHTML = `
    <div class="form-grid form-grid-2">
      <div class="form-group"><label>거래유형</label>
        <select id="e_transaction_type">
          ${['입고','출고','조정'].map(t => `<option ${rec.transaction_type===t?'selected':''}>${t}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>거래일자</label><input type="date" id="e_receive_date" value="${rec.receive_date||''}" /></div>
      <div class="form-group"><label>품목명</label><input type="text" id="e_item_name" value="${rec.item_name||''}" /></div>
      <div class="form-group"><label>품목구분</label>
        <select id="e_item_type">
          ${['생두','부재료','포장재','기타'].map(t => `<option ${rec.item_type===t?'selected':''}>${t}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>이월재고</label><input type="number" id="e_carry_over" value="${rec.carry_over||0}" step="0.01" /></div>
      ${isOut
        ? `<div class="form-group"><label>출고수량</label><input type="number" id="e_out_qty" value="${rec.out_qty||rec.used_qty||0}" step="0.01" /></div>`
        : `<div class="form-group"><label>금일입고수량</label><input type="number" id="e_receive_qty" value="${rec.receive_qty||0}" step="0.01" /></div>`
      }
      <div class="form-group"><label>금일사용량</label><input type="number" id="e_used_qty" value="${rec.used_qty||0}" step="0.01" /></div>
      <div class="form-group"><label>현재재고</label><input type="number" id="e_balance" value="${rec.balance||0}" step="0.01" /></div>
      <div class="form-group"><label>단위</label>
        <select id="e_unit">${['kg','g','L','mL','ea','box'].map(u=>`<option ${rec.unit===u?'selected':''}>${u}</option>`).join('')}</select></div>
      ${isOut ? `
      <div class="form-group"><label>출고 목적</label>
        <select id="e_out_purpose">
          ${['생산투입','폐기','반품','샘플','기타'].map(p=>`<option ${rec.out_purpose===p?'selected':''}>${p}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>출고 Lot 참조</label><input type="text" id="e_source_lot" value="${rec.source_lot||''}" /></div>
      ` : `
      <div class="form-group"><label>생산일자</label><input type="date" id="e_production_date" value="${rec.production_date||''}" /></div>
      <div class="form-group"><label>소비기한</label><input type="date" id="e_expiry_date" value="${rec.expiry_date||''}" /></div>
      <div class="form-group"><label>QC 수입검사</label>
        <select id="e_qc_result"><option value="">선택</option>${qcOptions}</select></div>
      `}
      <div class="form-group"><label>담당자</label><input type="text" id="e_manager" value="${rec.manager||rec.inspector||''}" /></div>
      <div class="form-group"><label>공급업체</label><input type="text" id="e_supplier" value="${rec.supplier||''}" /></div>
      <div class="form-group"><label>비고</label><input type="text" id="e_notes" value="${rec.notes||''}" /></div>
    </div>
  `;
  document.getElementById('editModal').classList.add('show');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('show');
  editingId = null;
}

async function saveEdit() {
  if (!editingId) return;
  const rec = allRawData.find(r => r.id === editingId);
  const isOut = document.getElementById('e_transaction_type').value === '출고';
  const updated = {
    ...rec,
    transaction_type: document.getElementById('e_transaction_type').value,
    receive_date: document.getElementById('e_receive_date').value,
    item_name: document.getElementById('e_item_name').value,
    item_type: document.getElementById('e_item_type').value,
    carry_over: parseFloat(document.getElementById('e_carry_over').value) || 0,
    receive_qty: isOut ? (rec.receive_qty || 0) : (parseFloat(document.getElementById('e_receive_qty')?.value) || 0),
    out_qty: isOut ? (parseFloat(document.getElementById('e_out_qty')?.value) || 0) : (rec.out_qty || 0),
    used_qty: isOut ? (parseFloat(document.getElementById('e_out_qty')?.value) || 0) : (parseFloat(document.getElementById('e_used_qty')?.value) || 0),
    balance: parseFloat(document.getElementById('e_balance').value) || 0,
    unit: document.getElementById('e_unit').value,
    manager: document.getElementById('e_manager').value,
    supplier: document.getElementById('e_supplier').value,
    notes: document.getElementById('e_notes').value,
    ...(isOut ? {
      out_purpose: document.getElementById('e_out_purpose')?.value || '',
      source_lot: document.getElementById('e_source_lot')?.value || '',
    } : {
      production_date: document.getElementById('e_production_date')?.value || '',
      expiry_date: document.getElementById('e_expiry_date')?.value || '',
      qc_result: document.getElementById('e_qc_result')?.value || '',
    }),
  };
  try {
    await apiPut('raw_materials', editingId, updated);
    showToast('수정 완료!', 'success');
    closeEditModal();
    await loadRawMaterials();
  } catch (e) {
    showToast('수정 실패: ' + e.message, 'error');
  }
}

// =====================================================
// 삭제
// =====================================================
async function deleteRecord(id) {
  showConfirm('이 수불 내역을 삭제하시겠습니까?', async () => {
    try {
      const targetId = id || editingId;
      const delRec = allRawData.find(r => r.id === targetId);
      await apiDelete('raw_materials', targetId);
      if (delRec && typeof updateKpiCache === 'function') updateKpiCache('raw_materials', delRec, -1);
      showToast('삭제되었습니다.', 'success');
      closeEditModal();
      await loadRawMaterials();
    } catch (e) {
      showToast('삭제 실패: ' + e.message, 'error');
    }
  });
}
