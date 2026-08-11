// =====================================================
// 로스팅 생산일지 JS (v2 개선판)
// - 공정 Lot No: RST-YYMMDD-01부터 자동생성
// - 블랜딩 생두 Lot 최대 3가지 선택
// - 기기 사전점검 체크리스트
// - A4 출력 기능
// - 수정/삭제 모달
// =====================================================

let allData = [];
let filteredData = [];
let currentPage = 1;
const pageSize = 15;
let rawLotData = [];
let currentPickerSlot = 1; // 현재 선택 중인 생두 슬롯 (1/2/3)
let editingId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const today = new Date().toISOString().split('T')[0];
  const dateEl = document.getElementById('f_work_date');
  if (dateEl) dateEl.value = today;

  await initLotNo();
  await loadData();

  const form = document.getElementById('roastForm');
  if (form) form.addEventListener('submit', handleSubmit);

  // 작업일자 변경 시 Lot No 자동 갱신
  if (dateEl) dateEl.addEventListener('change', () => initLotNo());
});

// =====================================================
// Lot No 자동생성: RST-YYMMDD-01
// =====================================================
async function initLotNo() {
  const workDate = document.getElementById('f_work_date')?.value || new Date().toISOString().split('T')[0];
  const lot = await generateProcessLotNo('RST', workDate);
  const display = document.getElementById('lotDisplay');
  if (display) { display.textContent = lot; display.dataset.lot = lot; }
}

async function generateProcessLotNo(prefix, workDate) {
  try {
    const d = workDate ? new Date(workDate) : new Date();
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateStr = `${yy}${mm}${dd}`;
    const tableMap = { RST: 'roasting_log', GRD: 'grinding_log', EXT: 'extraction_log', BTL: 'bottle_packing_log', BOX: 'box_packing_log' };
    const table = tableMap[prefix] || 'roasting_log';
    const data = await apiGetAll(table);
    const existing = data.filter(r => r.lot_no && r.lot_no.startsWith(`${prefix}-${dateStr}`));
    const seq = String(existing.length + 1).padStart(2, '0');
    return `${prefix}-${dateStr}-${seq}`;
  } catch(e) {
    const d = workDate ? new Date(workDate) : new Date();
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `RST-${yy}${mm}${dd}-01`;
  }
}

// 원료수불부 출고 Lot No 생성 (로스팅 자동 출고용)
// 형식: [자재코드]-[YYMMDD]-OUT-[순번] 또는 OUT-[YYMMDD]-[순번] (자재코드 없을 때)
async function generateRawOutLotNo(sourceLotNo, workDate) {
  try {
    const d = workDate ? new Date(workDate) : new Date();
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateStr = `${yy}${mm}${dd}`;
    // source_lot에서 자재코드 추출 (예: BSN-260615-01 → BSN)
    const itemCode = sourceLotNo ? sourceLotNo.split('-')[0] : '';
    const prefix = itemCode ? `${itemCode}-OUT-${dateStr}` : `OUT-${dateStr}`;
    const data = await apiGetAll('raw_materials');
    const existing = data.filter(r => r.lot_no && r.lot_no.startsWith(prefix));
    const seq = String(existing.length + 1).padStart(2, '0');
    return `${prefix}-${seq}`;
  } catch(e) {
    const d = workDate ? new Date(workDate) : new Date();
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `OUT-${yy}${mm}${dd}-01`;
  }
}

// =====================================================
// 블랜딩 토글
// =====================================================
function toggleBlending() {
  const val = document.getElementById('f_is_blending')?.value;
  const b2 = document.getElementById('blending2');
  const b3 = document.getElementById('blending3');
  if (val === '블랜딩') {
    if (b2) b2.style.display = '';
    if (b3) b3.style.display = '';
  } else {
    if (b2) b2.style.display = 'none';
    if (b3) b3.style.display = 'none';
    // 2,3 초기화
    ['2','3'].forEach(n => {
      const lotEl = document.getElementById(`f_raw_lot_${n}`);
      const nameEl = document.getElementById(`f_raw_name_${n}`);
      const qtyEl = document.getElementById(`f_raw_qty_${n}`);
      if (lotEl) lotEl.value = '';
      if (nameEl) nameEl.value = '';
      if (qtyEl) qtyEl.value = '';
    });
    calcTotalInput();
  }
}

// =====================================================
// 총 투입량 자동계산
// =====================================================
function calcTotalInput() {
  const q1 = parseFloat(document.getElementById('f_raw_qty_1')?.value) || 0;
  const q2 = parseFloat(document.getElementById('f_raw_qty_2')?.value) || 0;
  const q3 = parseFloat(document.getElementById('f_raw_qty_3')?.value) || 0;
  const total = q1 + q2 + q3;
  const totalEl = document.getElementById('f_raw_qty_total');
  if (totalEl) totalEl.value = total.toFixed(2);
  calcYield();
}

// =====================================================
// 제품명 입력 시 블랜딩 자동 감지
// 스페셜 더치커피 등 블랜딩 필요 제품 자동 전환
// =====================================================
function autoDetectBlending(productName) {
  const name = (productName || '').toLowerCase();
  const blendingKeywords = ['스페셜 더치', '스페셜더치', 'special dutch', '블랜딩', 'blending', '블렌드'];
  const isBlending = blendingKeywords.some(k => name.includes(k.toLowerCase()));
  const blendingSelect = document.getElementById('f_is_blending');
  if (blendingSelect) {
    const currentVal = blendingSelect.value;
    if (isBlending && currentVal !== '블랜딩') {
      blendingSelect.value = '블랜딩';
      toggleBlending();
      showToast('프로덕트명에 따라 블랜딩 모드로 자동 전환되었습니다.', 'info');
    }
  }
}

// =====================================================
// 완료량 계산
// =====================================================
function calcYield() {
  const totalIn = parseFloat(document.getElementById('f_raw_qty_total')?.value) || 0;
  const roasted = parseFloat(document.getElementById('f_roasted_qty')?.value) || 0;
  if (totalIn > 0) {
    const loss = totalIn - roasted;
    const rate = (roasted / totalIn) * 100;
    const lossEl = document.getElementById('f_loss_qty');
    const rateEl = document.getElementById('f_yield_rate');
    if (lossEl) lossEl.value = loss.toFixed(2);
    if (rateEl) rateEl.value = rate.toFixed(1);
  }
}

// =====================================================
// 생두 Lot 선택 모달
// =====================================================
async function openRawLotPicker(slot) {
  currentPickerSlot = slot || 1;
  try {
    document.getElementById('rawLotModal').classList.add('show');
    document.getElementById('rawLotTableBody').innerHTML = '<tr><td colspan="7" class="empty-msg"><i class="fas fa-spinner fa-spin"></i> 생두 재고 로딩 중...</td></tr>';

    const allRows = await apiGetAll('raw_materials');

    // 생두 입고 Lot만 필터 (item_type: 생두 또는 원두)
    const inRows = allRows.filter(r =>
      r.transaction_type === '입고' &&
      (r.item_type === '생두' || r.item_type === '원두' || !r.item_type)
    );

    // 출고 레코드에서 사용량 집계 (source_lot 또는 reference_lot 기준)
    const outRows = allRows.filter(r => r.transaction_type === '출고');
    const usedMap = {}; // { inLotNo: usedQty }
    outRows.forEach(r => {
      // source_lot 우선 (원료수불부 직접 출고)
      const src = r.source_lot || '';
      if (src) {
        usedMap[src] = (usedMap[src] || 0) + parseFloat(r.out_qty || r.receive_qty || r.used_qty || 0);
      }
      // reference_lot (로스팅 자동 출고 등)
      const ref = r.reference_lot || '';
      if (ref && !src) {
        usedMap[ref] = (usedMap[ref] || 0) + parseFloat(r.out_qty || r.used_qty || r.receive_qty || 0);
      }
      // fifo_consumed JSON (구 형식 호환)
      if (r.fifo_consumed) {
        try {
          const fc = JSON.parse(r.fifo_consumed);
          Object.entries(fc).forEach(([lotNo, qty]) => {
            usedMap[lotNo] = (usedMap[lotNo] || 0) + parseFloat(qty || 0);
          });
        } catch(e) {}
      }
    });

    // 잔량 계산
    rawLotData = inRows.map(inRow => {
      const used = usedMap[inRow.lot_no] || 0;
      const remaining = Math.max(0, parseFloat(inRow.receive_qty || 0) - used);
      return { ...inRow, remaining };
    }).filter(r => r.remaining > 0);

    filterRawLots();
  } catch(e) {
    showToast('생두 재고 로드 실패: ' + e.message, 'error');
    document.getElementById('rawLotModal').classList.remove('show');
  }
}

function filterRawLots() {
  const q = (document.getElementById('rawLotSearch')?.value || '').toLowerCase();
  const data = rawLotData.filter(r =>
    !q ||
    (r.item_name || '').toLowerCase().includes(q) ||
    (r.lot_no || '').toLowerCase().includes(q)
  );

  const tbody = document.getElementById('rawLotTableBody');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-msg"><i class="fas fa-inbox"></i> 재고가 있는 생두 Lot이 없습니다</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(r => {
    const remainPct = r.receive_qty > 0 ? Math.round((r.remaining / r.receive_qty) * 100) : 0;
    const barColor = remainPct > 50 ? '#27ae60' : remainPct > 20 ? '#f39c12' : '#e74c3c';
    const safeLot = (r.lot_no||'').replace(/'/g, "\\'");
    const safeName = (r.item_name||'').replace(/'/g, "\\'");
    const safeRemain = r.remaining;
    const safeUnit = (r.unit||'').replace(/'/g, "\\'");
    return `<tr style="cursor:pointer" onclick="selectRawLot('${safeLot}','${safeName}',${safeRemain},'${safeUnit}')">
      <td style="overflow:hidden">
        <span style="display:inline-block;background:#eafaf1;color:#27ae60;border:1px solid #a9dfbf;font-size:10px;padding:2px 6px;border-radius:4px;font-family:monospace;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.lot_no}</span>
      </td>
      <td style="font-weight:600;min-width:160px">${r.item_name || '-'}</td>
      <td style="font-size:12px;white-space:nowrap">${r.receive_date || '-'}</td>
      <td style="font-size:12px;white-space:nowrap">${r.expiry_date || '-'}</td>
      <td style="text-align:right">
        <strong style="color:${barColor}">${numFormat(r.remaining, 2)}</strong>
        <small style="color:#999"> / ${numFormat(r.receive_qty, 2)}</small>
        <div style="background:#eee;border-radius:4px;height:5px;margin-top:3px;overflow:hidden">
          <div style="background:${barColor};width:${remainPct}%;height:5px;border-radius:4px"></div>
        </div>
      </td>
      <td style="text-align:center">${r.unit || '-'}</td>
      <td><button class="btn btn-primary btn-sm" style="white-space:nowrap;font-size:11px;padding:4px 8px" onclick="event.stopPropagation();selectRawLot('${safeLot}','${safeName}',${safeRemain},'${safeUnit}')"><i class="fas fa-check"></i></button></td>
    </tr>`;
  }).join('');
}

function selectRawLot(lotNo, itemName, remaining, unit) {
  const n = currentPickerSlot;
  const lotEl = document.getElementById(`f_raw_lot_${n}`);
  const nameEl = document.getElementById(`f_raw_name_${n}`);
  const remainEl = document.getElementById(`f_raw_remain_${n}`);
  if (lotEl) lotEl.value = lotNo;
  if (nameEl) nameEl.value = itemName;
  if (remainEl) remainEl.textContent = `${numFormat(remaining, 2)} ${unit}`;
  closeRawLotModal();
  showToast(`✅ 생두 ${n}: ${itemName} (${lotNo}) 선택`, 'success');
}

function closeRawLotModal() {
  document.getElementById('rawLotModal').classList.remove('show');
}

// =====================================================
// 기기 체크리스트 수집
// =====================================================
function getChecklistData() {
  const checks = ['machine_clean','temp_sensor','drum_rotation','cooling_tray','chaff_collector','gas_pressure','exhaust_fan','safety_device'];
  const result = {};
  checks.forEach(c => {
    const el = document.getElementById(`chk_${c}`);
    result[c] = el ? el.checked : false;
  });
  return JSON.stringify(result);
}

function setChecklistData(jsonStr) {
  if (!jsonStr) return;
  try {
    const data = JSON.parse(jsonStr);
    Object.entries(data).forEach(([k, v]) => {
      const el = document.getElementById(`chk_${k}`);
      if (el) el.checked = v;
    });
  } catch(e) {}
}

// =====================================================
// 폼 제출
// =====================================================
async function handleSubmit(e) {
  e.preventDefault();
  const lot = document.getElementById('lotDisplay')?.dataset?.lot || document.getElementById('lotDisplay')?.textContent || '';
  const workDate = document.getElementById('f_work_date')?.value || '';
  const isBlending = document.getElementById('f_is_blending')?.value === '블랜딩';

  const record = {
    lot_no: lot,
    work_date: workDate,
    product_name: document.getElementById('f_product_name')?.value || '',
    worker: document.getElementById('f_worker')?.value || '',
    checker: document.getElementById('f_checker')?.value || '',
    is_blending: isBlending ? '블랜딩' : '단일',
    // 생두 Lot 1
    raw_lot_1: document.getElementById('f_raw_lot_1')?.value || '',
    raw_name_1: document.getElementById('f_raw_name_1')?.value || '',
    raw_qty_1: parseFloat(document.getElementById('f_raw_qty_1')?.value) || 0,
    // 생두 Lot 2
    raw_lot_2: isBlending ? (document.getElementById('f_raw_lot_2')?.value || '') : '',
    raw_name_2: isBlending ? (document.getElementById('f_raw_name_2')?.value || '') : '',
    raw_qty_2: isBlending ? (parseFloat(document.getElementById('f_raw_qty_2')?.value) || 0) : 0,
    // 생두 Lot 3
    raw_lot_3: isBlending ? (document.getElementById('f_raw_lot_3')?.value || '') : '',
    raw_name_3: isBlending ? (document.getElementById('f_raw_name_3')?.value || '') : '',
    raw_qty_3: isBlending ? (parseFloat(document.getElementById('f_raw_qty_3')?.value) || 0) : 0,
    // 투입/생산
    raw_qty_total: parseFloat(document.getElementById('f_raw_qty_total')?.value) || 0,
    roasted_qty: parseFloat(document.getElementById('f_roasted_qty')?.value) || 0,
    loss_qty: parseFloat(document.getElementById('f_loss_qty')?.value) || 0,
    yield_rate: parseFloat(document.getElementById('f_yield_rate')?.value) || 0,
    // 작업조건
    roast_start_time: document.getElementById('f_roast_start_time')?.value || '',
    roast_end_time: document.getElementById('f_roast_end_time')?.value || '',
    roast_temp: parseFloat(document.getElementById('f_roast_temp')?.value) || 0,
    roast_level: document.getElementById('f_roast_level')?.value || '',
    roasting_machine: document.getElementById('f_roasting_machine')?.value || '',
    quality_result: document.getElementById('f_quality_result')?.value || '적합',
    checklist: getChecklistData(),
    notes: document.getElementById('f_notes')?.value || '',
  };

  if (!record.product_name) { showToast('제품명을 입력하세요.', 'warning'); return; }
  if (!record.raw_lot_1) { showToast('생두 Lot 1을 선택하세요.', 'warning'); return; }
  if (!record.raw_qty_1) { showToast('생두 1 투입량을 입력하세요.', 'warning'); return; }
  if (!record.roasted_qty) { showToast('로스팅 완료량을 입력하세요.', 'warning'); return; }

  const btn = document.querySelector('#roastForm button[type="submit"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...'; }

  try {
    await apiPost('roasting_log', record);

    // 원료수불부 출고 자동 기록 (각 생두 Lot별)
    // source_lot: 입고 Lot No, reference_lot: 로스팅 Lot No
    const slots = [
      { lot: record.raw_lot_1, name: record.raw_name_1, qty: record.raw_qty_1 },
      { lot: record.raw_lot_2, name: record.raw_name_2, qty: record.raw_qty_2 },
      { lot: record.raw_lot_3, name: record.raw_name_3, qty: record.raw_qty_3 },
    ].filter(s => s.lot && s.qty > 0);

    for (const slot of slots) {
      // 입고 Lot에서 자재코드 추출 (BSN-260615-01 → BSN)
      const itemCodeFromLot = slot.lot.split('-')[0] || '';
      const outLot = await generateRawOutLotNo(slot.lot, workDate);
      await apiPost('raw_materials', {
        lot_no: outLot,
        transaction_type: '출고',
        receive_date: workDate,
        item_code: itemCodeFromLot,
        item_name: slot.name,
        item_type: '생두',
        out_qty: slot.qty,        // out_qty 필드 사용 (재고 차감 기준)
        used_qty: slot.qty,       // 호환성 유지
        receive_qty: 0,
        balance: 0,
        source_lot: slot.lot,     // 입고 Lot No (재고 차감 연동)
        reference_lot: lot,       // 로스팅 Lot No
        out_purpose: '로스팅 투입',
        notes: `로스팅 투입 (${lot})`,
        qc_result: '합격',
        manager: record.worker,
      });
    }

    showToast(`✅ 로스팅 등록 완료! Lot: ${lot}`, 'success');
    // KPI 집계 캐시 업데이트 (백그라운드)
    if (typeof updateKpiCache === 'function') updateKpiCache('roasting_log', record, +1);
    resetForm();
    await loadData();
    await initLotNo();
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
  const form = document.getElementById('roastForm');
  if (form) form.reset();
  const today = new Date().toISOString().split('T')[0];
  const dateEl = document.getElementById('f_work_date');
  if (dateEl) dateEl.value = today;
  const qEl = document.getElementById('f_quality_result');
  if (qEl) qEl.value = '적합';
  // 블랜딩 초기화
  const b2 = document.getElementById('blending2');
  const b3 = document.getElementById('blending3');
  if (b2) b2.style.display = 'none';
  if (b3) b3.style.display = 'none';
  ['1','2','3'].forEach(n => {
    const r = document.getElementById(`f_raw_remain_${n}`);
    if (r) r.textContent = '-';
  });
}

// =====================================================
// 데이터 로드
// =====================================================
async function loadData() {
  try {
    const data = await apiGetAll('roasting_log');
    allData = data.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    filteredData = [...allData];
    currentPage = 1;
    renderTable();
  } catch (e) {
    const tb = document.getElementById('tableBody');
    if (tb) tb.innerHTML = `<tr><td colspan="14" class="empty-msg">로드 실패: ${e.message}</td></tr>`;
  }
}

// =====================================================
// 필터
// =====================================================
function filterTable() {
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase();
  filteredData = allData.filter(r =>
    !q ||
    (r.lot_no || '').toLowerCase().includes(q) ||
    (r.product_name || '').toLowerCase().includes(q) ||
    (r.raw_lot_1 || '').toLowerCase().includes(q) ||
    (r.raw_name_1 || '').toLowerCase().includes(q)
  );
  currentPage = 1;
  renderTable();
}

// =====================================================
// 테이블 렌더링
// =====================================================
function renderTable() {
  const tbody = document.getElementById('tableBody');
  if (!tbody) return;
  const start = (currentPage - 1) * pageSize;
  const pageData = filteredData.slice(start, start + pageSize);

  if (!pageData.length) {
    tbody.innerHTML = `<tr><td colspan="14"><div class="empty-msg"><i class="fas fa-inbox"></i> 등록된 내역이 없습니다.</div></td></tr>`;
  } else {
    tbody.innerHTML = pageData.map(r => {
      const blendingBadge = r.is_blending === '블랜딩'
        ? '<span style="font-size:10px;background:#ffc107;color:#333;border-radius:4px;padding:1px 5px;margin-left:4px">블랜딩</span>'
        : '';
      const lot2Html = r.raw_lot_2 ? `<span class="badge" style="background:#e8f4fd;color:#3498db;font-size:10px">${r.raw_lot_2}</span>` : '-';
      const lot3Html = r.raw_lot_3 ? `<span class="badge" style="background:#f0e6ff;color:#6f42c1;font-size:10px">${r.raw_lot_3}</span>` : '-';
      return `<tr>
        <td><span class="badge badge-lot" style="cursor:pointer;background:#fff0ec;color:#e17055;border:1px solid #f5cba7" onclick="goToTrace('${r.lot_no||''}')">${r.lot_no||'-'}</span></td>
        <td>${r.work_date||'-'}</td>
        <td><strong>${r.product_name||'-'}</strong>${blendingBadge}</td>
        <td><span class="badge" style="background:#eafaf1;color:#27ae60;font-size:11px;cursor:pointer" onclick="goToTrace('${r.raw_lot_1||''}')">${r.raw_lot_1||'-'}</span><br><small style="color:#888">${r.raw_name_1||''}</small></td>
        <td>${lot2Html}</td>
        <td>${lot3Html}</td>
        <td style="text-align:right">${numFormat(r.raw_qty_total || r.raw_qty_1, 2)}</td>
        <td style="text-align:right">${numFormat(r.roasted_qty, 2)}</td>
        <td style="text-align:right">${r.yield_rate ? r.yield_rate + '%' : '-'}</td>
        <td>${r.roast_temp ? r.roast_temp + '℃' : '-'}</td>
        <td>${r.roast_level||'-'}</td>
        <td>${r.worker||'-'}</td>
        <td>${qualityBadge(r.quality_result)}</td>
        <td>
          <button class="edit-row-btn" onclick="openEditModal('${r.id}')"><i class="fas fa-edit"></i></button>
          <button class="edit-row-btn" style="color:#e74c3c;border-color:#e74c3c" onclick="deleteRow('${r.id}')"><i class="fas fa-trash"></i></button>
          <button class="edit-row-btn" style="color:#3498db;border-color:#3498db" onclick="printRecord('${r.id}')"><i class="fas fa-print"></i></button>
        </td>
      </tr>`;
    }).join('');
  }

  const countEl = document.getElementById('tableCount');
  if (countEl) countEl.textContent = `전체 ${filteredData.length}건`;
  renderPagination();
}

// =====================================================
// 페이지네이션
// =====================================================
function renderPagination() {
  const total = Math.ceil(filteredData.length / pageSize);
  const pg = document.getElementById('pagination');
  if (!pg) return;
  if (total <= 1) { pg.innerHTML = ''; return; }
  let html = '';
  if (currentPage > 1) html += `<button class="page-btn" onclick="changePage(${currentPage-1})"><i class="fas fa-chevron-left"></i></button>`;
  for (let i = Math.max(1, currentPage-2); i <= Math.min(total, currentPage+2); i++) {
    html += `<button class="page-btn ${i===currentPage?'active':''}" onclick="changePage(${i})">${i}</button>`;
  }
  if (currentPage < total) html += `<button class="page-btn" onclick="changePage(${currentPage+1})"><i class="fas fa-chevron-right"></i></button>`;
  pg.innerHTML = html;
}
function changePage(p) { currentPage = p; renderTable(); }

// =====================================================
// A4 출력 (현재 폼 기준)
// =====================================================
function printCurrentForm() {
  window.print();
}

// 특정 기록 A4 출력 (모바일: 모달 미리보기 / 데스크탑: 기존 window.open)
function printRecord(id) {
  const rec = allData.find(r => r.id === id);
  if (!rec) return;

  const isMobile = window.innerWidth <= 768;

  // 데스크탑: 기존 window.open 방식 유지
  let printWin;
  if (!isMobile) {
    printWin = window.open('', '_blank');
  } else {
    // 모바일: 모달 컨테이너 생성
    const modalId = 'rstPrintModal';
    let existing = document.getElementById(modalId);
    if (existing) existing.remove();
    const modalEl = document.createElement('div');
    modalEl.id = modalId;
    modalEl.className = 'modal-overlay show';
    document.body.appendChild(modalEl);
    printWin = { document: { write: function(html) {
      modalEl.innerHTML = '<div class="modal-dialog" style="max-width:720px">' +
        '<div class="modal-header"><h3><i class="fas fa-print"></i> 로스팅 생산일지 미리보기</h3>' +
        '<button class="modal-close" onclick="document.getElementById(\'' + modalId + '\').remove()"><i class="fas fa-times"></i></button></div>' +
        '<div class="modal-body" style="padding:0">' +
        '<div style="padding:20px;background:#fff;overflow-x:auto">' + html + '</div>' +
        '<div style="display:flex;gap:8px;padding:12px 16px;border-top:1px solid #eee">' +
        '<button onclick="window.print()" style="flex:1;padding:10px;background:#e17055;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:700"><i class="fas fa-print"></i> 인쇄</button>' +
        '<button onclick="document.getElementById(\'' + modalId + '\').remove()" style="flex:1;padding:10px;background:#f8f9fa;color:#555;border:1px solid #ddd;border-radius:8px;cursor:pointer">닫기</button>' +
        '</div></div></div>';
    }, close: function() {} } };
  }
  const checklistHtml = rec.checklist ? (() => {
    try {
      const data = JSON.parse(rec.checklist);
      const labels = {
        machine_clean: '로스터 청결 상태',
        temp_sensor: '온도 센서 정상',
        drum_rotation: '드럼 회전 정상',
        cooling_tray: '쿨링 트레이 점검',
        chaff_collector: '채프 수거함 비우기',
        gas_pressure: '가스 압력 확인',
        exhaust_fan: '배기 팬 작동',
        safety_device: '안전장치 점검',
      };
      return Object.entries(data).map(([k, v]) =>
        `<td style="border:1px solid #ddd;padding:6px;text-align:center">${labels[k]||k}: <strong style="color:${v?'#27ae60':'#e74c3c'}">${v?'✅':'❌'}</strong></td>`
      ).join('');
    } catch(e) { return ''; }
  })() : '';

  printWin.document.write(`<!DOCTYPE html><html lang="ko"><head>
    <meta charset="UTF-8"/>
    <title>로스팅 생산일지 - ${rec.lot_no}</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap" rel="stylesheet"/>
    <style>
      body { font-family: 'Noto Sans KR', sans-serif; font-size: 11px; margin: 0; padding: 20px; color: #333; }
      @page { size: A4; margin: 15mm; }
      h1 { font-size: 16px; text-align: center; border-bottom: 2px solid #e17055; padding-bottom: 8px; margin-bottom: 16px; }
      .header-info { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 11px; color: #666; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
      th { background: #f5f5f5; font-weight: 700; padding: 7px 10px; border: 1px solid #ddd; text-align: left; font-size: 11px; }
      td { padding: 7px 10px; border: 1px solid #ddd; font-size: 11px; }
      .section-title { font-size: 12px; font-weight: 700; color: #e17055; margin: 12px 0 6px; border-left: 3px solid #e17055; padding-left: 8px; }
      .lot-badge { display: inline-block; background: #fff0ec; color: #e17055; border: 1px solid #f5cba7; border-radius: 4px; padding: 2px 8px; font-weight: 700; }
      .sign-area { display: flex; gap: 20px; margin-top: 20px; }
      .sign-box { flex: 1; border: 1px solid #ddd; border-radius: 6px; padding: 10px; text-align: center; }
      .sign-box .label { font-size: 10px; color: #888; margin-bottom: 20px; }
      .sign-box .name { font-weight: 700; }
    </style>
  </head><body>
    <h1>🔥 로스팅 생산일지</h1>
    <div class="header-info">
      <span>출력일시: ${new Date().toLocaleString('ko-KR')}</span>
      <span>라이프컬처 (LifeCulture Co.)</span>
    </div>
    <div class="section-title">기본 정보</div>
    <table>
      <tr><th>Lot No</th><td><span class="lot-badge">${rec.lot_no||'-'}</span></td><th>작업일자</th><td>${rec.work_date||'-'}</td></tr>
      <tr><th>제품명</th><td>${rec.product_name||'-'}</td><th>블랜딩 여부</th><td>${rec.is_blending||'단일'}</td></tr>
      <tr><th>작업자</th><td>${rec.worker||'-'}</td><th>확인자</th><td>${rec.checker||'-'}</td></tr>
      <tr><th>로스팅 기계</th><td>${rec.roasting_machine||'-'}</td><th>품질판정</th><td><strong>${rec.quality_result||'-'}</strong></td></tr>
    </table>
    <div class="section-title">생두 투입 정보</div>
    <table>
      <tr><th>구분</th><th>생두 Lot No</th><th>생두명</th><th>투입량 (kg)</th></tr>
      <tr><td>생두 1</td><td>${rec.raw_lot_1||'-'}</td><td>${rec.raw_name_1||'-'}</td><td style="text-align:right">${numFormat(rec.raw_qty_1,2)}</td></tr>
      ${rec.raw_lot_2 ? `<tr><td>생두 2</td><td>${rec.raw_lot_2}</td><td>${rec.raw_name_2||'-'}</td><td style="text-align:right">${numFormat(rec.raw_qty_2,2)}</td></tr>` : ''}
      ${rec.raw_lot_3 ? `<tr><td>생두 3</td><td>${rec.raw_lot_3}</td><td>${rec.raw_name_3||'-'}</td><td style="text-align:right">${numFormat(rec.raw_qty_3,2)}</td></tr>` : ''}
      <tr><th colspan="3">총 투입량</th><td style="text-align:right;font-weight:700">${numFormat(rec.raw_qty_total||rec.raw_qty_1,2)} kg</td></tr>
    </table>
    <div class="section-title">생산 결과</div>
    <table>
      <tr><th>로스팅 완료량</th><td>${numFormat(rec.roasted_qty,2)} kg</td><th>손실량</th><td>${numFormat(rec.loss_qty,2)} kg</td></tr>
      <tr><th>수율</th><td>${rec.yield_rate||0}%</td><th>로스팅 레벨</th><td>${rec.roast_level||'-'}</td></tr>
      <tr><th>시작시간</th><td>${rec.roast_start_time||'-'}</td><th>종료시간</th><td>${rec.roast_end_time||'-'}</td></tr>
      <tr><th>로스팅 온도</th><td colspan="3">${rec.roast_temp ? rec.roast_temp + '℃' : '-'}</td></tr>
    </table>
    ${checklistHtml ? `<div class="section-title">기기 사전점검</div><table><tr>${checklistHtml}</tr></table>` : ''}
    ${rec.notes ? `<div class="section-title">비고</div><table><tr><td>${rec.notes}</td></tr></table>` : ''}
    <div class="sign-area">
      <div class="sign-box"><div class="label">작업자</div><div class="name">${rec.worker||''}</div></div>
      <div class="sign-box"><div class="label">확인자</div><div class="name">${rec.checker||''}</div></div>
      <div class="sign-box"><div class="label">품질담당</div><div class="name"></div></div>
    </div>
    <script>window.onload = function(){ window.print(); }<\/script>
  </body></html>`);
  printWin.document.close();
}

// =====================================================
// 엑셀 다운로드
// =====================================================
function exportExcel() {
  const headers = ['Lot No', '작업일자', '제품명', '블랜딩', '생두Lot1', '생두명1', '투입1', '생두Lot2', '생두명2', '투입2', '생두Lot3', '생두명3', '투입3', '총투입', '완료량', '손실량', '수율', '온도', '레벨', '작업자', '확인자', '품질', '비고'];
  const rows = filteredData.map(r => [
    r.lot_no||'', r.work_date||'', r.product_name||'', r.is_blending||'단일',
    r.raw_lot_1||'', r.raw_name_1||'', r.raw_qty_1||0,
    r.raw_lot_2||'', r.raw_name_2||'', r.raw_qty_2||0,
    r.raw_lot_3||'', r.raw_name_3||'', r.raw_qty_3||0,
    r.raw_qty_total||r.raw_qty_1||0, r.roasted_qty||0, r.loss_qty||0, r.yield_rate||0,
    r.roast_temp||0, r.roast_level||'', r.worker||'', r.checker||'', r.quality_result||'', r.notes||''
  ]);
  const csv = [headers, ...rows].map(row => row.map(c => `"${c}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `로스팅생산일지_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('엑셀 다운로드 완료!', 'success');
}

// =====================================================
// 수정 모달
// =====================================================
async function openEditModal(id) {
  editingId = id;
  const rec = allData.find(r => r.id === id);
  if (!rec) return;

  document.getElementById('editModalBody').innerHTML = `
    <div class="form-grid form-grid-2">
      <div class="form-group"><label>작업일자</label><input type="date" id="e_work_date" value="${rec.work_date||''}" /></div>
      <div class="form-group"><label>제품명</label><input type="text" id="e_product_name" value="${rec.product_name||''}" /></div>
      <div class="form-group"><label>작업자</label><input type="text" id="e_worker" value="${rec.worker||''}" /></div>
      <div class="form-group"><label>확인자</label><input type="text" id="e_checker" value="${rec.checker||''}" /></div>
      <div class="form-group"><label>로스팅 완료량 (kg)</label><input type="number" id="e_roasted_qty" value="${rec.roasted_qty||0}" step="0.01" /></div>
      <div class="form-group"><label>수율 (%)</label><input type="number" id="e_yield_rate" value="${rec.yield_rate||0}" step="0.1" /></div>
      <div class="form-group"><label>로스팅 온도 (℃)</label><input type="number" id="e_roast_temp" value="${rec.roast_temp||0}" step="0.1" /></div>
      <div class="form-group"><label>로스팅 레벨</label>
        <select id="e_roast_level">
          ${['','Light','Medium Light','Medium','Medium Dark','Dark'].map(l => `<option ${rec.roast_level===l?'selected':''}>${l}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>품질판정</label>
        <select id="e_quality_result">
          ${['적합','부적합','재작업'].map(q => `<option ${rec.quality_result===q?'selected':''}>${q}</option>`).join('')}
        </select></div>
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
  const rec = allData.find(r => r.id === editingId);
  const updated = {
    ...rec,
    work_date: document.getElementById('e_work_date').value,
    product_name: document.getElementById('e_product_name').value,
    worker: document.getElementById('e_worker').value,
    checker: document.getElementById('e_checker').value,
    roasted_qty: parseFloat(document.getElementById('e_roasted_qty').value) || 0,
    yield_rate: parseFloat(document.getElementById('e_yield_rate').value) || 0,
    roast_temp: parseFloat(document.getElementById('e_roast_temp').value) || 0,
    roast_level: document.getElementById('e_roast_level').value,
    quality_result: document.getElementById('e_quality_result').value,
    notes: document.getElementById('e_notes').value,
  };
  try {
    await apiPut('roasting_log', editingId, updated);
    showToast('수정 완료!', 'success');
    closeEditModal();
    await loadData();
  } catch(e) {
    showToast('수정 실패: ' + e.message, 'error');
  }
}

// =====================================================
// 삭제
// =====================================================
async function deleteRow(id) {
  showConfirm('이 로스팅 기록을 삭제하시겠습니까?\n(로스팅 시 자동 생성된 원료수불부 출고 기록도 함께 삭제됩니다)', async () => {
    try {
      const targetId = id || editingId;
      // 삭제 전 lot_no 확보 (원료수불부 연동 삭제에 필요)
      const record = allData.find(r => r.id === targetId);
      const roastLotNo = record ? record.lot_no : '';
      await apiDelete('roasting_log', targetId);
      // 원료수불부에서 이 로스팅 lot에 의해 자동 생성된 출고 기록 삭제
      // (notes 필드에 '로스팅 투입 (lot_no)' 형식으로 저장됨)
      if (roastLotNo) {
        try {
          const rawAll = await apiGetAll('raw_materials');
          const autoOuts = rawAll.filter(r =>
            r.transaction_type === '출고' &&
            (r.notes || '').includes('로스팅 투입') &&
            (r.notes || '').includes(roastLotNo)
          );
          for (const out of autoOuts) {
            if (out.id) await apiDelete('raw_materials', out.id);
          }
        } catch(re) {
          console.warn('원료수불부 연동 삭제 실패:', re);
        }
      }
      // KPI 집계 캐시 업데이트 (삭제 시 차감)
      if (record && typeof updateKpiCache === 'function') updateKpiCache('roasting_log', record, -1);
      showToast('삭제 완료!', 'success');
      closeEditModal();
      await loadData();
    } catch (e) {
      showToast('삭제 실패: ' + e.message, 'error');
    }
  });
}

function deleteRecord() { deleteRow(editingId); }

// =====================================================
// 역추적 이동
// =====================================================
function goToTrace(lotNo) {
  if (lotNo) location.href = `traceability.html?lot=${encodeURIComponent(lotNo)}`;
}

// =====================================================
// 헬퍼
// =====================================================
function numFormat(v, d = 0) {
  const n = parseFloat(v);
  if (isNaN(n)) return '-';
  return n.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
