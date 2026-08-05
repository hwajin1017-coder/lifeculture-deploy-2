// =====================================================
// 제품 정보 관리 JS — Genspark Table API 사용
// =====================================================
let allProducts = [];
let filteredProducts = [];
let currentPage = 1;
let pageSize = 15;
let editingId = null;
let _prevProductName = ''; // 수정 전 제품명 (연동 갱신용)
let _prevProductCode = ''; // 수정 전 제품코드 (연동 갱신용)

document.addEventListener('DOMContentLoaded', () => {
  loadProducts();

  // 검색/필터
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.addEventListener('input', filterProducts);
  const filterCategory = document.getElementById('filterCategory');
  if (filterCategory) filterCategory.addEventListener('change', filterProducts);

  // 신규 등록 버튼
  const addBtn = document.getElementById('addProductBtn');
  if (addBtn) addBtn.addEventListener('click', openNewModal);

  // 모달 닫기
  const closeBtn = document.getElementById('modalCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  const cancelBtn = document.getElementById('modalCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  // 폼 제출
  const form = document.getElementById('productForm');
  if (form) form.addEventListener('submit', handleSubmit);

  // 모달 배경 클릭 시 닫기
  const modal = document.getElementById('productModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  // 페이지당 개수 변경
  const pageSizeSelect = document.getElementById('pageSizeSelect');
  if (pageSizeSelect) pageSizeSelect.addEventListener('change', () => {
    pageSize = parseInt(pageSizeSelect.value);
    currentPage = 1;
    renderTable();
  });

  // 더보기 메뉴
  setupMoreMenu2();
});

// ===========================
// 더보기 메뉴 (products 전용)
// ===========================
function setupMoreMenu2() {
  const btn = document.getElementById('moreMenuBtn');
  const overlay = document.getElementById('moreMenuOverlay');
  const sheet = document.getElementById('moreMenuSheet');
  const closeBtn = document.getElementById('moreMenuClose');
  const exportBtn = document.getElementById('exportBtn');
  const deleteAllBtn = document.getElementById('deleteAllBtn');

  if (btn && overlay && sheet) {
    btn.addEventListener('click', () => {
      overlay.style.display = 'block';
      sheet.style.display = 'block';
      setTimeout(() => { overlay.classList.add('show'); sheet.classList.add('show'); }, 10);
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', closeMoreMenu2);
  }
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeMoreMenu2();
    });
  }
  if (exportBtn) exportBtn.addEventListener('click', exportData);
  if (deleteAllBtn) deleteAllBtn.addEventListener('click', deleteAllData);
}
function closeMoreMenu2() {
  const overlay = document.getElementById('moreMenuOverlay');
  const sheet = document.getElementById('moreMenuSheet');
  if (overlay) { overlay.classList.remove('show'); setTimeout(() => { overlay.style.display = ''; }, 300); }
  if (sheet) { sheet.classList.remove('show'); setTimeout(() => { sheet.style.display = ''; }, 300); }
}

// ===========================
// 데이터 로드
// ===========================
async function loadProducts() {
  try {
    const data = await apiGetAll('products');
    allProducts = data.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    filteredProducts = [...allProducts];
    // 브라우저 자동완성 등으로 값이 남아있을 경우 초기화
    const si = document.getElementById('searchInput');
    if (si) si.value = '';
    const fc = document.getElementById('filterCategory');
    if (fc) fc.value = '';
    renderTable();
    renderKpi();
  } catch (e) {
    console.error('[products] 로드 실패:', e);
    const tb = document.getElementById('productsTableBody');
    if (tb) tb.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:#999"><i class="fas fa-exclamation-circle"></i> 데이터 로드 실패: ${e.message}</td></tr>`;
  }
}

// ===========================
// KPI
// ===========================
function renderKpi() {
  const total = allProducts.length;
  const own = allProducts.filter(p => p.product_type === '자체생산').length;
  const oem = allProducts.filter(p => p.product_type === 'OEM').length;
  const imp = allProducts.filter(p => p.product_type === '수입제품').length;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('totalProducts', total);
  set('ownProduction', own);
  set('oemProduction', oem);
  set('importedProducts', imp);
}

// ===========================
// 필터링
// ===========================
function filterProducts() {
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const cat = document.getElementById('filterCategory')?.value || '';
  filteredProducts = allProducts.filter(p => {
    const matchQ = !q ||
      (p.product_name || '').toLowerCase().includes(q) ||
      (p.product_code || '').toLowerCase().includes(q);
    const matchCat = !cat || p.product_type === cat;
    return matchQ && matchCat;
  });
  currentPage = 1;
  renderTable();
}

// ===========================
// 서류 상태 뱃지
// ===========================
function docStatusBadge(docs) {
  if (!docs) return '<span style="color:#999">-</span>';
  try {
    const d = typeof docs === 'string' ? JSON.parse(docs) : docs;
    const items = Object.values(d);
    const completed = items.filter(v => v && v.status === '등록완료').length;
    const needed = items.filter(v => v && v.status === '갱신필요').length;
    if (needed > 0) return `<span class="badge badge-danger">${needed}건 갱신필요</span>`;
    if (completed === items.length && items.length > 0) return `<span class="badge badge-success">완료</span>`;
    return `<span class="badge badge-warning">${completed}/${items.length}</span>`;
  } catch {
    return '<span style="color:#999">-</span>';
  }
}

// ===========================
// 테이블 렌더링
// ===========================
function renderTable() {
  const tbody = document.getElementById('productsTableBody');
  if (!tbody) return;

  const total = filteredProducts.length;
  const totalPages = pageSize >= 9999 ? 1 : Math.ceil(total / pageSize);
  if (currentPage > totalPages) currentPage = Math.max(1, totalPages);

  const start = (currentPage - 1) * (pageSize >= 9999 ? total : pageSize);
  const end = pageSize >= 9999 ? total : start + pageSize;
  const pageData = filteredProducts.slice(start, end);

  // 건수 표시
  const countEl = document.getElementById('tableCount');
  if (countEl) {
    if (total === allProducts.length) {
      countEl.textContent = `전체 ${total}건`;
    } else {
      countEl.textContent = `검색 ${total}건 / 전체 ${allProducts.length}건`;
    }
  }

  if (!pageData.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:#999"><i class="fas fa-inbox" style="font-size:32px;margin-bottom:12px;display:block"></i>제품 정보가 없습니다.</td></tr>`;
  } else {
    const typeColors = { '자체생산': 'badge-success', 'OEM': 'badge-info', '수입제품': 'badge-warning', '농산물': 'badge-primary', '기타': 'badge-secondary' };
    tbody.innerHTML = pageData.map(p => {
      const typeCls = typeColors[p.product_type] || 'badge-secondary';
      let shelfLifeText = '-';
      if (p.shelf_life_date) {
        const d = new Date(p.shelf_life_date);
        if (!isNaN(d.getTime())) {
          shelfLifeText = `${d.getFullYear()}년 ${(d.getMonth()+1).toString().padStart(2, '0')}월 ${d.getDate().toString().padStart(2, '0')}일까지`;
        }
      }
      return `<tr>
        <td><strong>${p.product_code || '-'}</strong></td>
        <td>
          <strong>${p.product_name || '-'}</strong>
          ${p.specification ? `<br><small style="color:#888">${p.specification}</small>` : ''}
        </td>
        <td><span class="badge ${typeCls}">${p.product_type || '-'}</span></td>
        <td>${p.category || '-'}</td>
        <td>${p.storage_condition || '-'}</td>
        <td>${docStatusBadge(p.documents)}</td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="openEditModal('${p.id}')"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');
  }

  // 페이지네이션 UI 렌더링
  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const wrap = document.getElementById('paginationWrap');
  if (!wrap) return;
  if (totalPages <= 1) { wrap.innerHTML = ''; return; }

  const btnStyle = (active) => `style="padding:5px 10px;border:1px solid ${active ? 'var(--primary)' : 'var(--border)'};border-radius:6px;background:${active ? 'var(--primary)' : '#fff'};color:${active ? '#fff' : '#333'};cursor:pointer;font-size:13px;min-width:32px"`;

  let html = '';
  // 이전 버튼
  html += `<button ${btnStyle(false)} onclick="goPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled style="opacity:0.4;cursor:default"' : ''}>&laquo;</button>`;

  // 페이지 번호 (5개씩 표시)
  let startP = Math.max(1, currentPage - 2);
  let endP = Math.min(totalPages, startP + 4);
  if (endP - startP < 4) startP = Math.max(1, endP - 4);

  if (startP > 1) html += `<button ${btnStyle(false)} onclick="goPage(1)">1</button>${startP > 2 ? '<span style="padding:0 4px;color:#999">...</span>' : ''}`;

  for (let i = startP; i <= endP; i++) {
    html += `<button ${btnStyle(i === currentPage)} onclick="goPage(${i})">${i}</button>`;
  }

  if (endP < totalPages) html += `${endP < totalPages - 1 ? '<span style="padding:0 4px;color:#999">...</span>' : ''}<button ${btnStyle(false)} onclick="goPage(${totalPages})">${totalPages}</button>`;

  // 다음 버튼
  html += `<button ${btnStyle(false)} onclick="goPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled style="opacity:0.4;cursor:default"' : ''}>&raquo;</button>`;

  wrap.innerHTML = html;
}

function goPage(page) {
  const total = filteredProducts.length;
  const totalPages = pageSize >= 9999 ? 1 : Math.ceil(total / pageSize);
  if (page < 1 || page > totalPages) return;
  currentPage = page;
  renderTable();
  // 테이블 상단으로 스크롤
  const tableEl = document.getElementById('productsTable');
  if (tableEl) tableEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ===========================
// SKU 제품코드 자동생성 (엑셀 규칙 기반)
// 구조: [생산코드]-[창고코드]-[제품약어]-[규격코드]-[연번3자리]
// ===========================
function handleProductTypeChange(type) {
  generateSkuCode();
}


async function generateSkuCode() {
  const typeMap = {
    '자체생산': 'OWN',
    'OEM': 'OEM',
    '수입제품': 'IMP',
    '농산물': 'IMP',
    '기타': 'ETC'
  };
  const type = (document.getElementById('productType')?.value || '');
  const prodCode = typeMap[type] || '';
  const warehouseCode = document.getElementById('warehouseCode')?.value || 'RM';

  // 제품약어: 콤보박스 직접입력 값 사용
  const abbrev = (document.getElementById('productAbbrev')?.value || '').trim().toUpperCase();

  // 규격코드: 콤보박스 직접입력 값 사용
  const spec = (document.getElementById('specCode')?.value || '').trim().toUpperCase();

  if (!prodCode || !abbrev || !spec) {
    // 필수값 미입력 시 코드 비움 (수동입력 가능하도록 유지)
    return;
  }

  // 연번: 같은 제품약어로 등록된 제품 수 + 1
  let seq = '001';
  try {
    const data = await apiGetAll('products');
    const sameAbbrev = data.filter(p => {
      const code = p.product_code || '';
      const parts = code.split('-');
      return parts.length >= 3 && parts[2] === abbrev;
    });
    seq = String(sameAbbrev.length + 1).padStart(3, '0');
  } catch (e) {
    seq = '001';
  }

  const generated = `${prodCode}-${warehouseCode}-${abbrev}-${spec}-${seq}`;
  const codeEl = document.getElementById('productCode');
  if (codeEl) codeEl.value = generated;
}

// ===========================
// 신규 등록 모달 열기
// ===========================
async function openNewModal() {
  editingId = null;
  const form = document.getElementById('productForm');
  if (form) form.reset();

  document.querySelectorAll('.document-status').forEach(el => {
    if (el.tagName === 'SELECT') el.value = '미등록';
    else el.value = '';
  });
  document.querySelectorAll('.document-date').forEach(el => el.value = '');

  const titleEl = document.getElementById('modalTitle');
  if (titleEl) titleEl.textContent = '신규 제품 등록';

  const codeEl = document.getElementById('productCode');
  if (codeEl) codeEl.value = '';

  // SKU 필드 초기화
  const abbrevIn = document.getElementById('productAbbrev');
  if (abbrevIn) abbrevIn.value = '';
  const specIn = document.getElementById('specCode');
  if (specIn) specIn.value = '';
  const whCode = document.getElementById('warehouseCode');
  if (whCode) whCode.value = 'RM';

  const modal = document.getElementById('productModal');
  if (modal) modal.classList.add('show');
}

// ===========================
// 수정 모달 열기
// ===========================
function openEditModal(id) {
  const p = allProducts.find(r => r.id === id);
  if (!p) return;
  editingId = id;
  _prevProductName = p.product_name || '';
  _prevProductCode = p.product_code || '';

  const form = document.getElementById('productForm');
  if (form) form.reset();

  const fields = {
    productCode: p.product_code,
    productName: p.product_name,
    productType: p.product_type,
    category: p.category,
    specification: p.specification,
    unit: p.unit,
    barcode: p.barcode,
    shelfLifeDate: p.shelf_life_date,
    storageCondition: p.storage_condition,
    manufacturer: p.manufacturer,
    remarks: p.remarks,
    bizRegNo: p.biz_reg_no,
    bankAccount: p.bank_account,
    contactPerson: p.contact_person,
    contactPhone: p.contact_phone,
    personalEmail: p.personal_email,
    taxEmail: p.tax_email,
    lotAbbrev: p.lot_abbrev,
    qtyPerBox: p.qty_per_box || '',
    boxesPerPallet: p.boxes_per_pallet || '',
  };
  Object.entries(fields).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
  });

  // SKU 콤보박스 값 복원: Firestore 저장값 우선, 없으면 제품코드에서 파싱
  const abbrevEl = document.getElementById('productAbbrev');
  const specEl = document.getElementById('specCode');
  const whEl = document.getElementById('warehouseCode');
  if (p.product_abbrev && abbrevEl) {
    abbrevEl.value = p.product_abbrev;
  } else if (p.product_code) {
    const parts = p.product_code.split('-');
    if (parts.length >= 4) {
      if (abbrevEl) abbrevEl.value = parts[2] || '';
      if (whEl) whEl.value = parts[1] || 'RM';
    }
  }
  if (p.spec_code && specEl) {
    specEl.value = p.spec_code;
  } else if (p.product_code) {
    const parts = p.product_code.split('-');
    if (parts.length >= 5 && specEl) specEl.value = parts[3] || '';
  }
  if (whEl && p.product_code && !whEl.value) {
    const parts = p.product_code.split('-');
    if (parts.length >= 2) whEl.value = parts[1] || 'RM';
  }

  if (p.documents) {
    try {
      const docs = typeof p.documents === 'string' ? JSON.parse(p.documents) : p.documents;
      Object.entries(docs).forEach(([docName, info]) => {
        const statusEl = document.querySelector(`.document-status[data-doc="${docName}"]`);
        if (statusEl && info) statusEl.value = info.status || '미등록';
        const dateEl = document.querySelector(`.document-date[data-doc="${docName}"]`);
        if (dateEl && info) dateEl.value = info.date || '';
      });
    } catch (e) { /* 무시 */ }
  }

  const titleEl = document.getElementById('modalTitle');
  if (titleEl) titleEl.textContent = '제품 정보 수정';

  const modal = document.getElementById('productModal');
  if (modal) modal.classList.add('show');
}

// ===========================
// 모달 닫기
// ===========================
function closeModal() {
  const modal = document.getElementById('productModal');
  if (modal) modal.classList.remove('show');
  editingId = null;
}

// ===========================
// 서류 데이터 수집
// ===========================
function collectDocuments() {
  const docs = {};
  document.querySelectorAll('.document-status[data-doc]').forEach(el => {
    const docName = el.getAttribute('data-doc');
    const dateEl = document.querySelector(`.document-date[data-doc="${docName}"]`);
    docs[docName] = {
      status: el.value || '미등록',
      date: dateEl?.value || ''
    };
  });
  return JSON.stringify(docs);
}

// ===========================
// 폼 제출
// ===========================
async function handleSubmit(e) {
  e.preventDefault();
  
  const docsJson = collectDocuments();
  const data = {
    product_code: document.getElementById('productCode').value,
    product_name: document.getElementById('productName').value,
    product_type: document.getElementById('productType').value,
    category: document.getElementById('category').value,
    specification: document.getElementById('specification').value,
    unit: document.getElementById('unit').value,
    barcode: document.getElementById('barcode').value,
    shelf_life_date: document.getElementById('shelfLifeDate')?.value || '',
    storage_condition: document.getElementById('storageCondition').value,
    manufacturer: document.getElementById('manufacturer').value,
    remarks: document.getElementById('remarks').value,
    biz_reg_no: document.getElementById('bizRegNo').value,
    bank_account: document.getElementById('bankAccount').value,
    contact_person: document.getElementById('contact_person')?.value || document.getElementById('contactPerson')?.value || '',
    contact_phone: document.getElementById('contact_phone')?.value || document.getElementById('contactPhone')?.value || '',
    personal_email: document.getElementById('personal_email')?.value || document.getElementById('personalEmail')?.value || '',
    tax_email: document.getElementById('tax_email')?.value || document.getElementById('taxEmail')?.value || '',
    lot_abbrev: document.getElementById('lotAbbrev')?.value || '',
    product_abbrev: (document.getElementById('productAbbrev')?.value || '').trim().toUpperCase(),
    spec_code: (document.getElementById('specCode')?.value || '').trim().toUpperCase(),
    qty_per_box: parseInt(document.getElementById('qtyPerBox')?.value) || 0,
    boxes_per_pallet: parseInt(document.getElementById('boxesPerPallet')?.value) || 0,
    documents: docsJson,
    updated_at: Date.now()
  };

  if (!data.product_name) { showToast('제품명을 입력하세요.', 'warning'); return; }

  const submitBtn = document.querySelector('#productForm button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...'; }

  try {
    if (editingId) {
      await apiPut('products', editingId, data);
      showToast('제품 정보가 수정되었습니다.');

      // ── 연동 갱신: 제품명 변경 시 관련 콜렉션 자동 갱신 ──
      const pNameChanged = _prevProductName && _prevProductName !== data.product_name;
      const pCodeChanged = _prevProductCode && _prevProductCode !== data.product_code;
      if (pNameChanged || pCodeChanged) {
        const collectionsToSync = [
          { col: 'roasting_log',       field: 'product_name' },
          { col: 'grinding_log',       field: 'product_name' },
          { col: 'extraction_log',     field: 'product_name' },
          { col: 'bottle_packing_log', field: 'product_name' },
          { col: 'box_packing_log',    field: 'product_name' },
          { col: 'logistics',          field: 'product_name' },
          { col: 'wh_inbound',         field: 'item_name' },
          { col: 'wh_outbound',        field: 'item_name' },
          { col: 'lg2_inbound',        field: 'item_name' },
          { col: 'lg2_outbound',       field: 'item_name' },
          { col: 'lg2_audit',          field: 'item_name' },
          { col: 'sales',              field: 'product_name' },
        ];
        let totalUpdated = 0;
        for (const { col, field } of collectionsToSync) {
          try {
            const rows = await apiGetAll(col);
            const toSync = rows.filter(r => pNameChanged && r[field] === _prevProductName);
            for (const r of toSync) {
              await apiPatch(col, r.id, { [field]: data.product_name });
            }
            totalUpdated += toSync.length;
          } catch(e) {
            console.warn(`[products] ${col} 연동 갱신 실패:`, e);
          }
        }
        if (totalUpdated > 0) {
          showToast(`연관 데이터 ${totalUpdated}건 자동 갱신됨`, 'info');
        }
      }
      _prevProductName = '';
      _prevProductCode = '';
    } else {
      data.created_at = Date.now();
      await apiPost('products', data);
      showToast('신규 제품이 등록되었습니다.');
    }
    closeModal();
    loadProducts();

    // ── 연동 갱신 ──
    // 1. warehouse-mgmt.js 제품마스터 캐시 무효화 (출고 폼 자동완성/박스환산 즉시 반영)
    if (typeof _whProductMasterCache !== 'undefined') {
      window._whProductMasterCache = null;
    }
    // 2. 물류현황 재로드 (제품명/유형 변경 즉시 반영)
    if (typeof loadLogisticsData === 'function') {
      loadLogisticsData();
    }
    // 3. 입고 자동완성 제품리스트 재로드
    if (typeof whLoadProductMaster === 'function') {
      window._whProductMasterCache = null;
      whLoadProductMaster();
    }
  } catch (e) {
    console.error('[products] 저장 실패:', e);
    showToast('저장에 실패했습니다: ' + e.message, 'danger');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '저장하기'; }
  }
}

// ===========================
// 데이터 삭제
// ===========================
async function deleteProduct(id) {
  if (!confirm('정말 삭제하시겠습니까?\n\n※ 이 제품과 연관된 물류관리2 입고/출고/실사 데이터도 함께 삭제됩니다.')) return;
  try {
    // 삭제할 제품명 먼저 확인
    const target = allProducts.find(p => p.id === id);
    const targetName = target ? target.product_name : null;

    // 1. 제품마스터 삭제
    await apiDelete('products', id);

    // 2. 연동 컬렉션에서 해당 제품명 레코드 삭제
    if (targetName) {
      const linkedCols = [
        { col: 'lg2_inbound',        field: 'item_name' },
        { col: 'lg2_outbound',       field: 'item_name' },
        { col: 'lg2_audit',          field: 'item_name' },
        { col: 'wh_inbound',         field: 'item_name' },
        { col: 'wh_outbound',        field: 'item_name' },
      ];
      let deletedCount = 0;
      for (const { col, field } of linkedCols) {
        try {
          const rows = await apiGetAll(col);
          const toDelete = rows.filter(r => r[field] === targetName);
          for (const r of toDelete) {
            await apiDelete(col, r.id);
            deletedCount++;
          }
        } catch(e) {
          console.warn(`[deleteProduct] ${col} 연동 삭제 실패:`, e);
        }
      }
      if (deletedCount > 0) {
        showToast(`삭제 완료 (연관 데이터 ${deletedCount}건 함께 삭제)`);
      } else {
        showToast('삭제되었습니다.');
      }
    } else {
      showToast('삭제되었습니다.');
    }
    loadProducts();
  } catch (e) {
    showToast('삭제 실패: ' + e.message, 'danger');
  }
}

// ===========================
// 엑셀 내보내기
// ===========================
function exportData() {
  if (!filteredProducts.length) { showToast('내보낼 데이터가 없습니다.', 'warning'); return; }
  // 실제 엑셀 라이브러리 연동 필요 (여기서는 간단히 CSV/JSON 시뮬레이션)
  console.log('Exporting...', filteredProducts);
  showToast('엑셀 파일 준비 중...');
  closeMoreMenu2();
}

// ===========================
// 전체 데이터 삭제
// ===========================
async function deleteAllData() {
  if (!confirm('모든 제품 정보를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
  try {
    for (const p of allProducts) {
      await apiDelete('products', p.id);
    }
    showToast('모든 데이터가 삭제되었습니다.');
    loadProducts();
    closeMoreMenu2();
  } catch (e) {
    showToast('삭제 중 오류 발생: ' + e.message, 'danger');
  }
}
