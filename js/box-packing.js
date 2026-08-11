// 완제품(박스) 포장일지 JS
let allData = [];
let filteredData = [];
let currentPage = 1;
const pageSize = 15;
let bottleLotData = [];

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('f_work_date').value = today();
  initLotNo();
  loadData();
  document.getElementById('boxForm').addEventListener('submit', handleSubmit);
  // 작업일자 변경 시 Lot No 자동 갱신
  document.getElementById('f_work_date').addEventListener('change', () => initLotNo());
});

async function initLotNo() {
  const workDate = document.getElementById('f_work_date')?.value || today();
  const lot = await generateLotNo('BOX', workDate);
  document.getElementById('lotDisplay').textContent = lot;
  document.getElementById('lotDisplay').dataset.lot = lot;
}

function calcBoxCount() {
  const perBox = parseInt(document.getElementById('f_qty_per_box').value)||0;
  const boxes = parseInt(document.getElementById('f_box_count').value)||0;
  if (perBox > 0 && boxes > 0) calcTotal();
}

function calcTotal() {
  const perBox = parseInt(document.getElementById('f_qty_per_box').value)||0;
  const boxes = parseInt(document.getElementById('f_box_count').value)||0;
  document.getElementById('f_total_bottle_count').value = perBox * boxes;
}

async function openLotPicker() {
  const res = await apiGet('bottle_packing_log', { limit: 100 });
  bottleLotData = (res.data||[]).sort((a,b) => b.created_at - a.created_at);
  filterLotPicker();
  document.getElementById('lotPickerModal').classList.add('show');
}

function filterLotPicker() {
  const q = (document.getElementById('lotPickerSearch').value||'').toLowerCase();
  const data = bottleLotData.filter(r => !q || (r.lot_no||'').toLowerCase().includes(q) || (r.product_name||'').toLowerCase().includes(q));
  document.getElementById('lotPickerBody').innerHTML = data.length ? data.map(r => `
    <tr>
      <td><span class="badge badge-lot">${r.lot_no||'-'}</span></td>
      <td>${r.work_date||'-'}</td>
      <td>${r.product_name||'-'}</td>
      <td>${numFormat(r.actual_qty,0)} ea</td>
      <td>${r.expiry_date||'-'}</td>
      <td><button class="btn btn-primary btn-sm" onclick="selectLot('${r.lot_no}','${(r.product_name||'').replace(/'/g,"\\'")}','${r.actual_qty||0}')">선택</button></td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="empty-msg">병 포장 이력 없음</td></tr>';
}

function selectLot(lotNo, productName, actualQty) {
  document.getElementById('f_bottle_lot_no').value = lotNo;
  document.getElementById('f_product_linked').value = productName;
  if (!document.getElementById('f_product_name').value) {
    document.getElementById('f_product_name').value = productName;
  }
  // 박스당 입수 기본값 제안
  const perBox = document.getElementById('f_qty_per_box').value;
  if (perBox && actualQty) {
    const boxes = Math.floor(parseInt(actualQty) / parseInt(perBox));
    document.getElementById('f_box_count').value = boxes;
    calcTotal();
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
    bottle_lot_no: document.getElementById('f_bottle_lot_no').value,
    qty_per_box: parseInt(document.getElementById('f_qty_per_box').value)||0,
    box_count: parseInt(document.getElementById('f_box_count').value)||0,
    defect_box_count: parseInt(document.getElementById('f_defect_box_count').value)||0,
    total_bottle_count: parseInt(document.getElementById('f_total_bottle_count').value)||0,
    pack_start_time: document.getElementById('f_pack_start_time').value,
    pack_end_time: document.getElementById('f_pack_end_time').value,
    storage_location: document.getElementById('f_storage_location').value,
    customer: document.getElementById('f_customer').value,
    scheduled_ship_date: document.getElementById('f_scheduled_ship_date').value,
    actual_ship_date: document.getElementById('f_actual_ship_date').value,
    shipped_box_count: parseInt(document.getElementById('f_shipped_box_count').value)||0,
    quality_result: document.getElementById('f_quality_result').value,
    notes: document.getElementById('f_notes').value,
  };

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...';

  try {
    await apiPost('box_packing_log', record);
    showToast(`✅ 박스 포장 등록 완료! Lot: ${lot}`, 'success');
    // KPI 집계 캐시 업데이트 (백그라운드)
    if (typeof updateKpiCache === 'function') updateKpiCache('box_packing_log', record, +1);
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
  document.getElementById('boxForm').reset();
  document.getElementById('f_work_date').value = today();
  document.getElementById('f_quality_result').value = '적합';
}

async function loadData() {
  try {
    const res = await apiGet('box_packing_log', { limit: 100 });
    allData = (res.data||[]).sort((a,b) => {
      const da = a.work_date||''; const db2 = b.work_date||'';
      if (db2 > da) return 1; if (db2 < da) return -1;
      return (b.created_at||0) - (a.created_at||0);
    });
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
    !q || (r.lot_no||'').toLowerCase().includes(q) || (r.product_name||'').toLowerCase().includes(q) ||
    (r.bottle_lot_no||'').toLowerCase().includes(q) || (r.customer||'').toLowerCase().includes(q)
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
        <td><span class="badge" style="background:#e8f8f5;color:#1abc9c;cursor:pointer" onclick="goToTrace('${r.bottle_lot_no||''}')">${r.bottle_lot_no||'-'}</span></td>
        <td>${numFormat(r.qty_per_box,0)}</td>
        <td><strong>${numFormat(r.box_count,0)}</strong></td>
        <td>${numFormat(r.total_bottle_count,0)}</td>
        <td>${r.storage_location||'-'}</td>
        <td>${r.customer||'-'}</td>
        <td>${r.actual_ship_date || r.scheduled_ship_date || '-'}</td>
        <td>${r.shipped_box_count ? numFormat(r.shipped_box_count,0)+' box' : '-'}</td>
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
  showConfirm('이 박스 포장 기록을 삭제하시겠습니까?', async () => {
    try {
      const delRec = allData.find(r => r.id === id);
      await apiDelete('box_packing_log', id);
      if (delRec && typeof updateKpiCache === 'function') updateKpiCache('box_packing_log', delRec, -1);
      showToast('삭제 완료!','success'); await loadData(); }
    catch(e){ showToast('삭제 실패: '+e.message,'error'); }
  });
}
