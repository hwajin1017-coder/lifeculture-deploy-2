// 분쇄 생산일지 JS
let allData = [];
let filteredData = [];
let currentPage = 1;
const pageSize = 15;
let roastLotData = [];
let editingId = null;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('f_work_date').value = today();
  initLotNo();
  loadData();
  document.getElementById('grindForm').addEventListener('submit', handleSubmit);
  // 작업일자 변경 시 Lot No 자동 갱신
  document.getElementById('f_work_date').addEventListener('change', () => initLotNo());
});

async function initLotNo() {
  const workDate = document.getElementById('f_work_date')?.value || today();
  const lot = await generateLotNo('GRD', workDate);
  document.getElementById('lotDisplay').textContent = lot;
  document.getElementById('lotDisplay').dataset.lot = lot;
}

function calcYield() {
  const input = parseFloat(document.getElementById('f_input_qty').value)||0;
  const ground = parseFloat(document.getElementById('f_ground_qty').value)||0;
  if (input > 0) {
    document.getElementById('f_loss_qty').value = (input - ground).toFixed(2);
    document.getElementById('f_yield_rate').value = ((ground/input)*100).toFixed(1);
  }
}

async function openLotPicker() {
  const res = await apiGet('roasting_log', { limit: 100 });
  roastLotData = (res.data||[]).sort((a,b) => b.created_at - a.created_at);
  filterLotPicker();
  document.getElementById('lotPickerModal').classList.add('show');
}

function filterLotPicker() {
  const q = (document.getElementById('lotPickerSearch').value||'').toLowerCase();
  const data = roastLotData.filter(r => !q || (r.lot_no||'').toLowerCase().includes(q) || (r.product_name||'').toLowerCase().includes(q));
  document.getElementById('lotPickerBody').innerHTML = data.length ? data.map(r => `
    <tr>
      <td><span class="badge badge-lot">${r.lot_no||'-'}</span></td>
      <td>${r.work_date||'-'}</td>
      <td>${r.product_name||'-'}</td>
      <td>${numFormat(r.roasted_qty,2)} kg</td>
      <td>${qualityBadge(r.quality_result)}</td>
      <td><button class="btn btn-primary btn-sm" onclick="selectLot('${r.lot_no}','${(r.product_name||'').replace(/'/g,"\\'")}')">선택</button></td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="empty-msg">로스팅 이력 없음</td></tr>';
}

function selectLot(lotNo, productName) {
  document.getElementById('f_roast_lot_no').value = lotNo;
  document.getElementById('f_product_name_linked').value = productName;
  if (!document.getElementById('f_product_name').value) {
    document.getElementById('f_product_name').value = productName;
  }
  closeLotPicker();
}

function closeLotPicker() {
  document.getElementById('lotPickerModal').classList.remove('show');
}

async function handleSubmit(e) {
  e.preventDefault();
  const lot = document.getElementById('lotDisplay').dataset.lot || document.getElementById('lotDisplay').textContent;
  const record = {
    lot_no: lot,
    work_date: document.getElementById('f_work_date').value,
    product_name: document.getElementById('f_product_name').value,
    worker: document.getElementById('f_worker').value,
    checker: document.getElementById('f_checker').value,
    roast_lot_no: document.getElementById('f_roast_lot_no').value,
    input_qty: parseFloat(document.getElementById('f_input_qty').value)||0,
    ground_qty: parseFloat(document.getElementById('f_ground_qty').value)||0,
    loss_qty: parseFloat(document.getElementById('f_loss_qty').value)||0,
    yield_rate: parseFloat(document.getElementById('f_yield_rate').value)||0,
    start_time: document.getElementById('f_start_time').value,
    end_time: document.getElementById('f_end_time').value,
    grind_size: document.getElementById('f_grind_size').value,
    grinder_machine: document.getElementById('f_grinder_machine').value,
    quality_result: document.getElementById('f_quality_result').value,
    notes: document.getElementById('f_notes').value,
  };

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...';

  try {
    await apiPost('grinding_log', record);
    showToast(`✅ 분쇄 등록 완료! Lot: ${lot}`, 'success');
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
  document.getElementById('grindForm').reset();
  document.getElementById('f_work_date').value = today();
  document.getElementById('f_quality_result').value = '적합';
}

async function loadData() {
  try {
    const res = await apiGet('grinding_log', { limit: 100 });
    allData = (res.data||[]).sort((a,b) => {
      const da = a.work_date||''; const db2 = b.work_date||'';
      if (db2 > da) return 1; if (db2 < da) return -1;
      return (b.created_at||0) - (a.created_at||0);
    });
    filteredData = [...allData];
    currentPage = 1;
    renderTable();
  } catch (e) {
    document.getElementById('tableBody').innerHTML = `<tr><td colspan="12" class="empty-msg">로드 실패</td></tr>`;
  }
}

function filterTable() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  filteredData = allData.filter(r =>
    !q || (r.lot_no||'').toLowerCase().includes(q) || (r.product_name||'').toLowerCase().includes(q) || (r.roast_lot_no||'').toLowerCase().includes(q)
  );
  currentPage = 1;
  renderTable();
}

function renderTable() {
  const tbody = document.getElementById('tableBody');
  const start = (currentPage-1)*pageSize;
  const pageData = filteredData.slice(start, start+pageSize);
  if (!pageData.length) {
    tbody.innerHTML = `<tr><td colspan="12"><div class="empty-msg"><i class="fas fa-inbox"></i>등록된 내역 없음</div></td></tr>`;
  } else {
    tbody.innerHTML = pageData.map(r => `
      <tr>
        <td><span class="badge badge-lot" style="cursor:pointer" onclick="goToTrace('${r.lot_no||''}')">${r.lot_no||'-'}</span></td>
        <td>${r.work_date||'-'}</td>
        <td><strong>${r.product_name||'-'}</strong></td>
        <td><span class="badge" style="background:#fff0ec;color:#e17055;cursor:pointer" onclick="goToTrace('${r.roast_lot_no||''}')">${r.roast_lot_no||'-'}</span></td>
        <td>${numFormat(r.input_qty,2)}</td>
        <td>${numFormat(r.ground_qty,2)}</td>
        <td>${numFormat(r.loss_qty,2)}</td>
        <td>${r.yield_rate ? r.yield_rate+'%' : '-'}</td>
        <td>${r.grind_size||'-'}</td>
        <td>${r.worker||'-'}</td>
        <td>${qualityBadge(r.quality_result)}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" style="background:#f0f4ff;color:#6c5ce7;border:1px solid #d0d8ff;margin-right:4px" onclick="openEditModal('${r.id}')"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm" onclick="deleteRow('${r.id}')"><i class="fas fa-trash"></i></button>
        </td>
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
  if (currentPage>1) html+=`<button class="page-btn" onclick="changePage(${currentPage-1})"><i class="fas fa-chevron-left"></i></button>`;
  for(let i=Math.max(1,currentPage-2);i<=Math.min(total,currentPage+2);i++) html+=`<button class="page-btn ${i===currentPage?'active':''}" onclick="changePage(${i})">${i}</button>`;
  if(currentPage<total) html+=`<button class="page-btn" onclick="changePage(${currentPage+1})"><i class="fas fa-chevron-right"></i></button>`;
  pg.innerHTML=html;
}
function changePage(p){currentPage=p;renderTable();}

function openEditModal(id) {
  editingId = id;
  const rec = allData.find(r => r.id === id);
  if (!rec) return;
  document.getElementById('editModalBody').innerHTML = `
    <div class="form-grid form-grid-2" style="gap:12px">
      <div class="form-group"><label>작업일자</label><input type="date" id="e_work_date" value="${rec.work_date||''}" class="form-control" /></div>
      <div class="form-group"><label>제품명</label><input type="text" id="e_product_name" value="${(rec.product_name||'').replace(/"/g,'&quot;')}" class="form-control" /></div>
      <div class="form-group"><label>로스팅 Lot No</label><input type="text" id="e_roast_lot_no" value="${rec.roast_lot_no||''}" class="form-control" /></div>
      <div class="form-group"><label>작업자</label><input type="text" id="e_worker" value="${(rec.worker||'').replace(/"/g,'&quot;')}" class="form-control" /></div>
      <div class="form-group"><label>투입량 (kg)</label><input type="number" id="e_input_qty" value="${rec.input_qty||0}" step="0.01" class="form-control" /></div>
      <div class="form-group"><label>분쇄량 (kg)</label><input type="number" id="e_ground_qty" value="${rec.ground_qty||0}" step="0.01" class="form-control" /></div>
      <div class="form-group"><label>분쇄도</label><input type="text" id="e_grind_size" value="${rec.grind_size||''}" class="form-control" /></div>
      <div class="form-group"><label>분쇄 장비</label><input type="text" id="e_grinder_machine" value="${(rec.grinder_machine||'').replace(/"/g,'&quot;')}" class="form-control" /></div>
      <div class="form-group"><label>품질판정</label><select id="e_quality_result" class="form-control"><option ${rec.quality_result==='적합'?'selected':''}>적합</option><option ${rec.quality_result==='부적합'?'selected':''}>부적합</option><option ${rec.quality_result==='재작업'?'selected':''}>재작업</option></select></div>
      <div class="form-group"><label>비고</label><input type="text" id="e_notes" value="${(rec.notes||'').replace(/"/g,'&quot;')}" class="form-control" /></div>
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
  const updated = {
    work_date: document.getElementById('e_work_date').value,
    product_name: document.getElementById('e_product_name').value,
    roast_lot_no: document.getElementById('e_roast_lot_no').value,
    worker: document.getElementById('e_worker').value,
    input_qty: parseFloat(document.getElementById('e_input_qty').value)||0,
    ground_qty: parseFloat(document.getElementById('e_ground_qty').value)||0,
    loss_qty: (parseFloat(document.getElementById('e_input_qty').value)||0) - (parseFloat(document.getElementById('e_ground_qty').value)||0),
    yield_rate: (parseFloat(document.getElementById('e_input_qty').value)||0) > 0 ? (((parseFloat(document.getElementById('e_ground_qty').value)||0) / (parseFloat(document.getElementById('e_input_qty').value)||0)) * 100).toFixed(1) : 0,
    grind_size: document.getElementById('e_grind_size').value,
    grinder_machine: document.getElementById('e_grinder_machine').value,
    quality_result: document.getElementById('e_quality_result').value,
    notes: document.getElementById('e_notes').value,
  };
  try {
    await apiPatch('grinding_log', editingId, updated);
    showToast('수정 완료!', 'success');
    closeEditModal();
    await loadData();
  } catch(e) {
    showToast('수정 실패: ' + e.message, 'error');
  }
}

async function deleteRow(id) {
  showConfirm('이 분쇄 생산 기록을 삭제하시겠습니까?', async () => {
    try { await apiDelete('grinding_log', id); showToast('삭제 완료!','success'); await loadData(); }
    catch(e){ showToast('삭제 실패: '+e.message,'error'); }
  });
}
