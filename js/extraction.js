// 추출 생산일지 JS
let allData = [];
let filteredData = [];
let currentPage = 1;
const pageSize = 15;
let grindLotData = [];

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('f_work_date').value = today();
  initLotNo();
  loadData();
  document.getElementById('extractForm').addEventListener('submit', handleSubmit);
  // 작업일자 변경 시 Lot No 자동 갱신
  document.getElementById('f_work_date').addEventListener('change', () => initLotNo());
});

async function initLotNo() {
  const workDate = document.getElementById('f_work_date')?.value || today();
  const lot = await generateLotNo('EXT', workDate);
  document.getElementById('lotDisplay').textContent = lot;
  document.getElementById('lotDisplay').dataset.lot = lot;
}

function calcYield() {
  const water = parseFloat(document.getElementById('f_water_input_qty').value)||0;
  const extract = parseFloat(document.getElementById('f_extract_qty').value)||0;
  if (water > 0) {
    document.getElementById('f_loss_qty').value = (water - extract).toFixed(2);
    document.getElementById('f_yield_rate').value = ((extract/water)*100).toFixed(1);
  }
  calcRatio();
}

function calcRatio() {
  const coffee = parseFloat(document.getElementById('f_coffee_input_qty').value)||0;
  const water = parseFloat(document.getElementById('f_water_input_qty').value)||0;
  if (coffee > 0 && water > 0) {
    const ratio = water / coffee;
    document.getElementById('f_ratio').value = `1:${ratio.toFixed(1)}`;
  }
}

function calcDuration() {
  const start = document.getElementById('f_extract_start_time').value;
  const end = document.getElementById('f_extract_end_time').value;
  if (start && end) {
    const diff = (new Date(end) - new Date(start)) / (1000*3600);
    if (diff > 0) document.getElementById('f_extract_duration').value = diff.toFixed(1);
  }
}

async function openLotPicker() {
  const res = await apiGet('grinding_log', { limit: 100 });
  grindLotData = (res.data||[]).sort((a,b) => b.created_at - a.created_at);
  filterLotPicker();
  document.getElementById('lotPickerModal').classList.add('show');
}

function filterLotPicker() {
  const q = (document.getElementById('lotPickerSearch').value||'').toLowerCase();
  const data = grindLotData.filter(r => !q || (r.lot_no||'').toLowerCase().includes(q) || (r.product_name||'').toLowerCase().includes(q));
  document.getElementById('lotPickerBody').innerHTML = data.length ? data.map(r => `
    <tr>
      <td><span class="badge badge-lot">${r.lot_no||'-'}</span></td>
      <td>${r.work_date||'-'}</td>
      <td>${r.product_name||'-'}</td>
      <td>${numFormat(r.ground_qty,2)} kg</td>
      <td>${r.grind_size||'-'}</td>
      <td><button class="btn btn-primary btn-sm" onclick="selectLot('${r.lot_no}','${(r.product_name||'').replace(/'/g,"\\'")}')">선택</button></td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="empty-msg">분쇄 이력 없음</td></tr>';
}

function selectLot(lotNo, productName) {
  document.getElementById('f_grind_lot_no').value = lotNo;
  document.getElementById('f_product_linked').value = productName;
  if (!document.getElementById('f_product_name').value) {
    document.getElementById('f_product_name').value = productName;
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
    grind_lot_no: document.getElementById('f_grind_lot_no').value,
    coffee_input_qty: parseFloat(document.getElementById('f_coffee_input_qty').value)||0,
    water_input_qty: parseFloat(document.getElementById('f_water_input_qty').value)||0,
    extract_qty: parseFloat(document.getElementById('f_extract_qty').value)||0,
    loss_qty: parseFloat(document.getElementById('f_loss_qty').value)||0,
    yield_rate: parseFloat(document.getElementById('f_yield_rate').value)||0,
    extract_start_time: document.getElementById('f_extract_start_time').value,
    extract_end_time: document.getElementById('f_extract_end_time').value,
    extract_duration: parseFloat(document.getElementById('f_extract_duration').value)||0,
    extract_temp: parseFloat(document.getElementById('f_extract_temp').value)||0,
    brix: parseFloat(document.getElementById('f_brix').value)||0,
    extract_equipment: document.getElementById('f_extract_equipment').value,
    quality_result: document.getElementById('f_quality_result').value,
    notes: document.getElementById('f_notes').value,
  };

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...';

  try {
    await apiPost('extraction_log', record);
    showToast(`✅ 추출 등록 완료! Lot: ${lot}`, 'success');
    // KPI 집계 캐시 업데이트 (백그라운드)
    if (typeof updateKpiCache === 'function') updateKpiCache('extraction_log', record, +1);
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
  document.getElementById('extractForm').reset();
  document.getElementById('f_work_date').value = today();
  document.getElementById('f_quality_result').value = '적합';
}

async function loadData() {
  try {
    const res = await apiGet('extraction_log', { limit: 100 });
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
    !q || (r.lot_no||'').toLowerCase().includes(q) || (r.product_name||'').toLowerCase().includes(q) || (r.grind_lot_no||'').toLowerCase().includes(q)
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
        <td><span class="badge" style="background:#f0f4ff;color:#6c5ce7;cursor:pointer" onclick="goToTrace('${r.grind_lot_no||''}')">${r.grind_lot_no||'-'}</span></td>
        <td>${numFormat(r.coffee_input_qty,2)}</td>
        <td>${numFormat(r.water_input_qty,2)}</td>
        <td>${numFormat(r.extract_qty,2)}</td>
        <td>${r.yield_rate ? r.yield_rate+'%' : '-'}</td>
        <td>${r.extract_duration ? r.extract_duration+'h' : '-'}</td>
        <td>${r.brix ? r.brix+'°' : '-'}</td>
        <td>${r.extract_temp ? r.extract_temp+'℃' : '-'}</td>
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
  if (total<=1){pg.innerHTML='';return;}
  let html='';
  if(currentPage>1) html+=`<button class="page-btn" onclick="changePage(${currentPage-1})"><i class="fas fa-chevron-left"></i></button>`;
  for(let i=Math.max(1,currentPage-2);i<=Math.min(total,currentPage+2);i++) html+=`<button class="page-btn ${i===currentPage?'active':''}" onclick="changePage(${i})">${i}</button>`;
  if(currentPage<total) html+=`<button class="page-btn" onclick="changePage(${currentPage+1})"><i class="fas fa-chevron-right"></i></button>`;
  pg.innerHTML=html;
}
function changePage(p){currentPage=p;renderTable();}

async function deleteRow(id) {
  showConfirm('이 추출 생산 기록을 삭제하시겠습니까?', async () => {
    try {
      const delRec = allData.find(r => r.id === id);
      await apiDelete('extraction_log', id);
      if (delRec && typeof updateKpiCache === 'function') updateKpiCache('extraction_log', delRec, -1);
      showToast('삭제 완료!','success'); await loadData(); }
    catch(e){ showToast('삭제 실패: '+e.message,'error'); }
  });
}
