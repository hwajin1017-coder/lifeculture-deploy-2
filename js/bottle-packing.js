// 병 포장일지 JS
let allData = [];
let filteredData = [];
let currentPage = 1;
const pageSize = 15;
let extractLotData = [];

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('f_work_date').value = today();
  // 유통기한 기본값: 오늘 + 18개월
  const exp = new Date();
  exp.setMonth(exp.getMonth() + 18);
  document.getElementById('f_expiry_date').value = formatDate(exp);
  initLotNo();
  loadData();
  document.getElementById('bottleForm').addEventListener('submit', handleSubmit);
  // 작업일자 변경 시 Lot No 자동 갱신
  document.getElementById('f_work_date').addEventListener('change', () => initLotNo());
});

async function initLotNo() {
  const workDate = document.getElementById('f_work_date')?.value || today();
  const lot = await generateLotNo('BTL', workDate);
  document.getElementById('lotDisplay').textContent = lot;
  document.getElementById('lotDisplay').dataset.lot = lot;
}

function calcBottleCount() {
  const fillL = parseFloat(document.getElementById('f_fill_qty').value)||0;
  const volumeMl = parseFloat(document.getElementById('f_fill_volume').value)||0;
  if (fillL > 0 && volumeMl > 0) {
    const theory = Math.floor((fillL * 1000) / volumeMl);
    document.getElementById('f_theory_count').value = theory;
    if (!document.getElementById('f_bottle_count').value) {
      document.getElementById('f_bottle_count').value = theory;
    }
    calcActual();
  }
}

function calcActual() {
  const total = parseInt(document.getElementById('f_bottle_count').value)||0;
  const defect = parseInt(document.getElementById('f_defect_count').value)||0;
  document.getElementById('f_actual_qty').value = total - defect;
}

async function openLotPicker() {
  const res = await apiGet('extraction_log', { limit: 100 });
  extractLotData = (res.data||[]).sort((a,b) => b.created_at - a.created_at);
  filterLotPicker();
  document.getElementById('lotPickerModal').classList.add('show');
}

function filterLotPicker() {
  const q = (document.getElementById('lotPickerSearch').value||'').toLowerCase();
  const data = extractLotData.filter(r => !q || (r.lot_no||'').toLowerCase().includes(q) || (r.product_name||'').toLowerCase().includes(q));
  document.getElementById('lotPickerBody').innerHTML = data.length ? data.map(r => `
    <tr>
      <td><span class="badge badge-lot">${r.lot_no||'-'}</span></td>
      <td>${r.work_date||'-'}</td>
      <td>${r.product_name||'-'}</td>
      <td>${numFormat(r.extract_qty,2)} L</td>
      <td>${r.brix ? r.brix+'°' : '-'}</td>
      <td><button class="btn btn-primary btn-sm" onclick="selectLot('${r.lot_no}','${(r.product_name||'').replace(/'/g,"\\'")}','${r.extract_qty||0}')">선택</button></td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="empty-msg">추출 이력 없음</td></tr>';
}

function selectLot(lotNo, productName, extractQty) {
  document.getElementById('f_extract_lot_no').value = lotNo;
  if (!document.getElementById('f_product_name').value) {
    document.getElementById('f_product_name').value = productName;
  }
  if (!document.getElementById('f_fill_qty').value) {
    document.getElementById('f_fill_qty').value = extractQty;
    calcBottleCount();
  }
  closeLotPicker();
}

function closeLotPicker() { document.getElementById('lotPickerModal').classList.remove('show'); }

async function handleSubmit(e) {
  e.preventDefault();
  const lot = document.getElementById('lotDisplay').dataset.lot || document.getElementById('lotDisplay').textContent;
  const record = {
    lot_no: lot,
    work_date: document.getElementById('f_work_date').value,
    product_name: document.getElementById('f_product_name').value,
    worker: document.getElementById('f_worker').value,
    checker: document.getElementById('f_checker').value,
    extract_lot_no: document.getElementById('f_extract_lot_no').value,
    bottle_lot_no: document.getElementById('f_bottle_lot_no').value,
    cap_lot_no: document.getElementById('f_cap_lot_no').value,
    fill_qty: parseFloat(document.getElementById('f_fill_qty').value)||0,
    fill_volume: parseFloat(document.getElementById('f_fill_volume').value)||0,
    bottle_count: parseInt(document.getElementById('f_bottle_count').value)||0,
    defect_count: parseInt(document.getElementById('f_defect_count').value)||0,
    actual_qty: parseInt(document.getElementById('f_actual_qty').value)||0,
    pack_start_time: document.getElementById('f_pack_start_time').value,
    pack_end_time: document.getElementById('f_pack_end_time').value,
    expiry_date: document.getElementById('f_expiry_date').value,
    label_applied: document.getElementById('f_label_applied').value === 'true',
    quality_result: document.getElementById('f_quality_result').value,
    notes: document.getElementById('f_notes').value,
  };

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...';

  try {
    await apiPost('bottle_packing_log', record);
    showToast(`✅ 병 포장 등록 완료! Lot: ${lot}`, 'success');
    resetForm();
    await loadData();
    await initLotNo();
  } catch (err) {
    showToast('저장 실패: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fas fa-save"></i> 등록';
  }
}

function resetForm() {
  document.getElementById('bottleForm').reset();
  document.getElementById('f_work_date').value = today();
  document.getElementById('f_quality_result').value = '적합';
  document.getElementById('f_label_applied').value = 'true';
  const exp = new Date(); exp.setMonth(exp.getMonth()+18);
  document.getElementById('f_expiry_date').value = formatDate(exp);
}

async function loadData() {
  try {
    const res = await apiGet('bottle_packing_log', { limit: 100 });
    allData = (res.data||[]).sort((a,b) => b.created_at - a.created_at);
    filteredData = [...allData];
    currentPage = 1;
    renderTable();
  } catch (e) {
    document.getElementById('tableBody').innerHTML = `<tr><td colspan="14" class="empty-msg">로드 실패</td></tr>`;
  }
}

function filterTable() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  filteredData = allData.filter(r =>
    !q || (r.lot_no||'').toLowerCase().includes(q) || (r.product_name||'').toLowerCase().includes(q) || (r.extract_lot_no||'').toLowerCase().includes(q)
  );
  currentPage = 1;
  renderTable();
}

function renderTable() {
  const tbody = document.getElementById('tableBody');
  const start = (currentPage-1)*pageSize;
  const pageData = filteredData.slice(start, start+pageSize);
  if (!pageData.length) {
    tbody.innerHTML = `<tr><td colspan="14"><div class="empty-msg"><i class="fas fa-inbox"></i>등록된 내역 없음</div></td></tr>`;
  } else {
    tbody.innerHTML = pageData.map(r => `
      <tr>
        <td><span class="badge badge-lot" style="cursor:pointer" onclick="goToTrace('${r.lot_no||''}')">${r.lot_no||'-'}</span></td>
        <td>${r.work_date||'-'}</td>
        <td><strong>${r.product_name||'-'}</strong></td>
        <td><span class="badge" style="background:#e8f4fd;color:var(--info);cursor:pointer" onclick="goToTrace('${r.extract_lot_no||''}')">${r.extract_lot_no||'-'}</span></td>
        <td>${numFormat(r.fill_qty,2)}</td>
        <td>${r.fill_volume ? r.fill_volume+'mL' : '-'}</td>
        <td>${numFormat(r.bottle_count,0)}</td>
        <td>${r.defect_count > 0 ? `<span class="badge badge-danger">${r.defect_count}</span>` : '0'}</td>
        <td><strong>${numFormat(r.actual_qty,0)}</strong></td>
        <td>${r.expiry_date||'-'}</td>
        <td>${r.label_applied ? '<span class="badge badge-success">완료</span>' : '<span class="badge badge-warning">미부착</span>'}</td>
        <td>${r.worker||'-'}</td>
        <td>${qualityBadge(r.quality_result)}</td>
        <td><button class="btn btn-danger btn-sm" onclick="deleteRow('${r.id}')"><i class="fas fa-trash"></i></button></td>
      </tr>
    `).join('');
  }
  document.getElementById('tableCount').textContent = `전체 ${filteredData.length}건`;
  renderPagination();
}

function renderPagination() {
  const total = Math.ceil(filteredData.length/pageSize);
  const pg = document.getElementById('pagination');
  if(total<=1){pg.innerHTML='';return;}
  let html='';
  if(currentPage>1) html+=`<button class="page-btn" onclick="changePage(${currentPage-1})"><i class="fas fa-chevron-left"></i></button>`;
  for(let i=Math.max(1,currentPage-2);i<=Math.min(total,currentPage+2);i++) html+=`<button class="page-btn ${i===currentPage?'active':''}" onclick="changePage(${i})">${i}</button>`;
  if(currentPage<total) html+=`<button class="page-btn" onclick="changePage(${currentPage+1})"><i class="fas fa-chevron-right"></i></button>`;
  pg.innerHTML=html;
}
function changePage(p){currentPage=p;renderTable();}

async function deleteRow(id) {
  showConfirm('이 병 포장 기록을 삭제하시겠습니까?', async () => {
    try { await apiDelete('bottle_packing_log', id); showToast('삭제 완료!','success'); await loadData(); }
    catch(e){ showToast('삭제 실패: '+e.message,'error'); }
  });
}
