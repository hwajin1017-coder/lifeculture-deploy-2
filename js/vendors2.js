// =====================================================
// 영업팀 거래처정보2 관리 JS — Firebase sales_vendors 컬렉션 사용
// =====================================================
let allVendors = [];
let filteredVendors = [];
let currentPage = 1;
const pageSize = 15;
let editingId = null;

document.addEventListener('DOMContentLoaded', () => {
  generateVendorCode();
  loadVendors();

  const form = document.getElementById('vendorForm');
  if (form) form.addEventListener('submit', handleSubmit);

  // 검색 및 필터 이벤트
  const search = document.getElementById('searchInput');
  if (search) search.addEventListener('input', filterTable);
  const typeF = document.getElementById('typeFilter');
  if (typeF) typeF.addEventListener('change', filterTable);
});

// ===========================
// 거래처 코드 자동 생성
// ===========================
async function generateVendorCode() {
  const display = document.getElementById('codeDisplay');
  if (!display) return;
  try {
    const res = await apiGetAll('sales_vendors');
    const dateStr = today().replace(/-/g, '').slice(0, 8);
    const todayCodes = res.filter(v =>
      v.vendor_code && v.vendor_code.startsWith(`VND-${dateStr}`)
    );
    const seq = String(todayCodes.length + 1).padStart(3, '0');
    display.textContent = `VND-${dateStr}-${seq}`;
  } catch (e) {
    const rand = String(Math.floor(Math.random() * 999) + 1).padStart(3, '0');
    const dateStr = today().replace(/-/g, '').slice(0, 8);
    display.textContent = `VND-${dateStr}-${rand}`;
  }
}

// ===========================
// 데이터 로드
// ===========================
async function loadVendors() {
  try {
    const res = await apiGetAll('sales_vendors');
    allVendors = res.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    filteredVendors = [...allVendors];
    renderTable();
    renderKpi();
  } catch (e) {
    console.error('[vendors2] 로드 실패:', e);
    const tb = document.getElementById('vendorTableBody');
    if (tb) tb.innerHTML = `<tr><td colspan="13" class="empty-msg"><i class="fas fa-exclamation-circle"></i> 데이터 로드 실패: ${e.message}</td></tr>`;
  }
}

// ===========================
// KPI 렌더링
// ===========================
function renderKpi() {
  const total = allVendors.length;
  const suppliers = allVendors.filter(v => v.vendor_type === '공급업체').length;
  const retailers = allVendors.filter(v => v.vendor_type === '판매거래처').length;
  const oem = allVendors.filter(v => v.vendor_type === 'OEM업체').length;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('kpiTotal', total);
  set('kpiSupplier', suppliers);
  set('kpiRetailer', retailers);
  set('kpiOem', oem);
}

// ===========================
// 필터링
// ===========================
function filterTable() {
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const type = document.getElementById('typeFilter')?.value || '';
  filteredVendors = allVendors.filter(v => {
    const matchQ = !q ||
      (v.vendor_name || '').toLowerCase().includes(q) ||
      (v.vendor_code || '').toLowerCase().includes(q) ||
      (v.contact_person || '').toLowerCase().includes(q) ||
      (v.registration_no || '').toLowerCase().includes(q);
    const matchType = !type || v.vendor_type === type;
    return matchQ && matchType;
  });
  currentPage = 1;
  renderTable();
}

// ===========================
// 엑셀 다운로드
// ===========================
function exportVendorsExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('엑셀 모듈을 불러오지 못했습니다. 잠시 후 다시 시도하세요.', 'error');
    return;
  }
  if (!allVendors.length) {
    showToast('다운로드할 등록 거래처가 없습니다.', 'warning');
    return;
  }

  const rows = allVendors.map(v => ({
    '거래처코드': v.vendor_code || '',
    '거래처명': v.vendor_name || '',
    '거래구분': v.vendor_type || '',
    '거래상태': v.trade_status || '',
    '사업자등록번호': v.registration_no || '',
    '대표자명': v.representative || '',
    '업태': v.business_type || '',
    '종목': v.business_category || '',
    '주소': v.address || '',
    '담당자명': v.contact_person || '',
    '연락처': v.contact_phone || '',
    '이메일': v.contact_email || '',
    '거래시작일': v.trade_start_date || '',
    '은행명': v.bank_name || '',
    '계좌번호': v.bank_account || '',
    '예금주': v.account_holder || '',
    '사업자등록증 파일': v.doc_registration_file || '',
    '사업자등록증 등록일': v.doc_registration_date || '',
    '사업자등록증 상태': v.doc_registration_status || '',
    '통장사본 파일': v.doc_bank_file || '',
    '통장사본 등록일': v.doc_bank_date || '',
    '통장사본 상태': v.doc_bank_status || '',
    '기타서류 파일': v.doc_other_file || '',
    '기타서류 등록일': v.doc_other_date || '',
    '기타서류 상태': v.doc_other_status || '',
    '비고': v.notes || '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 22 }, { wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 18 },
    { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 40 }, { wch: 14 },
    { wch: 18 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 24 },
    { wch: 14 }, { wch: 26 }, { wch: 16 }, { wch: 14 }, { wch: 26 },
    { wch: 16 }, { wch: 14 }, { wch: 26 }, { wch: 16 }, { wch: 14 }, { wch: 40 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '거래처정보2');
  const fileDate = (typeof today === 'function' ? today() : new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  XLSX.writeFile(wb, `거래처정보2_${fileDate}.xlsx`);
  showToast(`✅ 등록 거래처 ${rows.length}건을 엑셀로 다운로드했습니다.`, 'success');
}

// ===========================
// 테이블 렌더링
// ===========================
function renderTable() {
  const tbody = document.getElementById('vendorTableBody');
  if (!tbody) return;
  const start = (currentPage - 1) * pageSize;
  const pageData = filteredVendors.slice(start, start + pageSize);

  if (!pageData.length) {
    tbody.innerHTML = `<tr><td colspan="13"><div class="empty-msg"><i class="fas fa-inbox"></i> 등록된 거래처가 없습니다.</div></td></tr>`;
  } else {
    tbody.innerHTML = pageData.map(v => {
      const statusMap = { '거래중': 'badge-success', '신규': 'badge-info', '거래중지': 'badge-danger' };
      const typeMap = { '공급업체': 'badge-info', '판매거래처': 'badge-warning', 'OEM업체': 'badge-success', '기타': 'badge-secondary' };
      const statusCls = statusMap[v.trade_status] || 'badge-secondary';
      const typeCls = typeMap[v.vendor_type] || 'badge-secondary';
      return `<tr>
        <td><strong>${v.vendor_code || '-'}</strong></td>
        <td><strong>${v.vendor_name || '-'}</strong></td>
        <td><span class="badge ${typeCls}">${v.vendor_type || '-'}</span></td>
        <td>${v.registration_no || '-'}</td>
        <td>${v.representative || '-'}</td>
        <td>${v.contact_person || '-'}</td>
        <td>${v.contact_phone || '-'}</td>
        <td>${v.contact_email || '-'}</td>
        <td>${v.bank_name || '-'}</td>
        <td>${v.bank_account || '-'}</td>
        <td><span class="badge ${statusCls}">${v.trade_status || '-'}</span></td>
        <td>${v.trade_start_date || '-'}</td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="openEditModal('${v.id}')"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm" onclick="deleteVendor('${v.id}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');
  }

  const countEl = document.getElementById('tableCount');
  if (countEl) countEl.textContent = `전체 ${filteredVendors.length}건`;
  renderPagination();
}

// ===========================
// 페이지네이션
// ===========================
function renderPagination() {
  const totalPages = Math.ceil(filteredVendors.length / pageSize);
  const pg = document.getElementById('pagination');
  if (!pg) return;
  if (totalPages <= 1) { pg.innerHTML = ''; return; }
  let html = '';
  if (currentPage > 1) html += `<button class="page-btn" onclick="changePage(${currentPage - 1})"><i class="fas fa-chevron-left"></i></button>`;
  for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
    html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
  }
  if (currentPage < totalPages) html += `<button class="page-btn" onclick="changePage(${currentPage + 1})"><i class="fas fa-chevron-right"></i></button>`;
  pg.innerHTML = html;
}
function changePage(p) { currentPage = p; renderTable(); }

// ===========================
// 폼 데이터 수집
// ===========================
function getFormData() {
  const code = document.getElementById('codeDisplay')?.textContent || '';
  return {
    vendor_code: code,
    vendor_name: document.getElementById('f_vendor_name')?.value || '',
    vendor_type: document.getElementById('f_vendor_type')?.value || '',
    trade_status: document.getElementById('f_trade_status')?.value || '거래중',
    registration_no: document.getElementById('f_registration_no')?.value || '',
    representative: document.getElementById('f_representative')?.value || '',
    business_type: document.getElementById('f_business_type')?.value || '',
    business_category: document.getElementById('f_business_category')?.value || '',
    address: document.getElementById('f_address')?.value || '',
    contact_person: document.getElementById('f_contact_person')?.value || '',
    contact_phone: document.getElementById('f_contact_phone')?.value || '',
    contact_email: document.getElementById('f_contact_email')?.value || '',
    trade_start_date: document.getElementById('f_trade_start_date')?.value || '',
    bank_name: document.getElementById('f_bank_name')?.value || '',
    bank_account: document.getElementById('f_bank_account')?.value || '',
    account_holder: document.getElementById('f_account_holder')?.value || '',
    doc_registration_file: document.getElementById('f_doc_registration_file')?.value || '',
    doc_registration_date: document.getElementById('f_doc_registration_date')?.value || '',
    doc_registration_status: document.getElementById('f_doc_registration_status')?.value || '',
    doc_bank_file: document.getElementById('f_doc_bank_file')?.value || '',
    doc_bank_date: document.getElementById('f_doc_bank_date')?.value || '',
    doc_bank_status: document.getElementById('f_doc_bank_status')?.value || '',
    doc_other_file: document.getElementById('f_doc_other_file')?.value || '',
    doc_other_date: document.getElementById('f_doc_other_date')?.value || '',
    doc_other_status: document.getElementById('f_doc_other_status')?.value || '',
    notes: document.getElementById('f_notes')?.value || '',
  };
}

// ===========================
// 폼 초기화
// ===========================
function resetForm() {
  const form = document.getElementById('vendorForm');
  if (form) form.reset();
  editingId = null;
  const btn = document.getElementById('vendorSubmitBtn');
  if (btn) btn.innerHTML = '<i class="fas fa-save"></i> 저장';
  generateVendorCode();
  showToast('폼이 초기화되었습니다.', 'info');
}

// ===========================
// 제품마스터정보2 협력사 정보 동기화
// ===========================
function vendorSyncKey(value) {
  return String(value || '').trim().toLowerCase();
}

async function syncVendorToProducts2(vendor, previousVendor) {
  const currentCode = vendorSyncKey(vendor.vendor_code);
  const currentName = vendorSyncKey(vendor.vendor_name);
  const previousCode = vendorSyncKey(previousVendor && previousVendor.vendor_code);
  const previousName = vendorSyncKey(previousVendor && previousVendor.vendor_name);
  const codeKeys = new Set([currentCode, previousCode].filter(Boolean));
  const nameKeys = new Set([currentName, previousName].filter(Boolean));
  if (!codeKeys.size && !nameKeys.size) return 0;

  const products = await apiGetAll('products2');
  // 코드·명칭은 기준값으로 동기화하고, 주소·담당자·연락처는 입력된 값이 있을 때만 갱신합니다.
  // 빈 값으로 기존 제품마스터의 협력사 상세정보가 지워지는 것을 방지합니다.
  const syncData = {
    supplier_code: vendor.vendor_code || '',
    supplier_name: vendor.vendor_name || ''
  };
  if (String(vendor.address || '').trim()) syncData.supplier_addr = vendor.address;
  if (String(vendor.contact_person || '').trim()) syncData.supplier_contact = vendor.contact_person;
  if (String(vendor.contact_phone || '').trim()) syncData.supplier_phone = vendor.contact_phone;
  const targets = (products || []).filter(function(product) {
    const productCode = vendorSyncKey(product.supplier_code);
    const productName = vendorSyncKey(product.supplier_name);
    return (productCode && codeKeys.has(productCode)) || (productName && nameKeys.has(productName));
  });

  for (const product of targets) {
    await apiPatch('products2', product.id, syncData);
  }
  return targets.length;
}

// ===========================
// 폼 제출 처리
// ===========================
async function handleSubmit(e) {
  e.preventDefault();
  const data = getFormData();
  const btn = document.getElementById('vendorSubmitBtn') || document.querySelector('#vendorForm button[type="submit"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...'; }
  try {
    const previousVendor = editingId ? allVendors.find(function(v) { return v.id === editingId; }) : null;
    let actionMessage = '';
    if (editingId) {
      await apiPut('sales_vendors', editingId, data);
      actionMessage = '거래처 정보가 수정되었습니다.';
      editingId = null;
    } else {
      await apiPost('sales_vendors', data);
      actionMessage = '거래처가 등록되었습니다.';
    }

    let syncCount = 0;
    try {
      syncCount = await syncVendorToProducts2(data, previousVendor);
    } catch (syncError) {
      console.error('[vendors2] 제품마스터정보2 동기화 실패:', syncError);
      showToast('거래처는 저장되었지만 제품마스터정보2 동기화에 실패했습니다: ' + syncError.message, 'warning');
    }
    showToast(actionMessage + (syncCount ? ` 제품마스터정보2 ${syncCount}건을 동기화했습니다.` : ''), 'success');
    resetForm();
    await loadVendors();
  } catch (err) {
    showToast('저장 실패: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = editingId ? '<i class="fas fa-save"></i> 수정 저장' : '<i class="fas fa-save"></i> 저장';
    }
  }
}

// ===========================
// 수정 모달 열기
// ===========================
function openEditModal(id) {
  const v = allVendors.find(r => r.id === id);
  if (!v) return;
  editingId = id;

  // 폼에 값 채우기
  const fields = ['vendor_name', 'vendor_type', 'trade_status', 'registration_no', 'representative',
    'business_type', 'business_category', 'address', 'contact_person', 'contact_phone',
    'contact_email', 'trade_start_date', 'bank_name', 'bank_account', 'account_holder',
    'doc_registration_file', 'doc_registration_date', 'doc_registration_status',
    'doc_bank_file', 'doc_bank_date', 'doc_bank_status',
    'doc_other_file', 'doc_other_date', 'doc_other_status', 'notes'];

  fields.forEach(key => {
    const el = document.getElementById('f_' + key);
    if (el) el.value = v[key] || '';
  });

  // 코드 표시
  const codeDisplay = document.getElementById('codeDisplay');
  if (codeDisplay) codeDisplay.textContent = v.vendor_code || '';

  // 폼으로 스크롤
  const formSection = document.querySelector('.form-container');
  if (formSection) formSection.scrollIntoView({ behavior: 'smooth' });

  const btn = document.getElementById('vendorSubmitBtn') || document.querySelector('#vendorForm button[type="submit"]');
  if (btn) btn.innerHTML = '<i class="fas fa-save"></i> 수정 저장';
  showToast('수정 모드: 내용 변경 후 저장하세요.', 'info');
}

// ===========================
// 삭제
// ===========================
async function deleteVendor(id) {
  showConfirm('이 거래처를 삭제하시겠습니까?<br><small style="color:#e74c3c">삭제 후 복구할 수 없습니다.</small>', async () => {
    try {
      await apiDelete('sales_vendors', id);
      showToast('삭제되었습니다.', 'success');
      if (editingId === id) resetForm();
      await loadVendors();
    } catch (e) {
      showToast('삭제 실패: ' + e.message, 'error');
    }
  });
}

// 하위 호환 (수정 모달 닫기)
function closeEditModal() {
  resetForm();
}
function saveEdit() { /* not used */ }
function deleteRecord() {
  if (editingId) deleteVendor(editingId);
}
