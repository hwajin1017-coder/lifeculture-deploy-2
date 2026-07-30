// =====================================================
// 원부재료 마스터 관리 JS
// 자재코드: 자재명 약어 기반 자동 생성 (예: 브라질 세하도 NY2 생두 → BSN)
// =====================================================
let allMaterials = [];
let filteredMaterials = [];
let currentPage = 1;
const pageSize = 15;
let editingId = null;
let _codeManuallyEdited = false; // 사용자가 직접 수정했는지 여부

document.addEventListener('DOMContentLoaded', () => {
  loadMaterials();
  const form = document.getElementById('materialsForm');
  if (form) form.addEventListener('submit', handleSubmit);
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.addEventListener('input', filterTable);
  const typeFilter = document.getElementById('typeFilter');
  if (typeFilter) typeFilter.addEventListener('change', filterTable);
});

// ===================================================
// 자재코드 자동 생성 (약어 기반)
// 규칙: 자재명의 단어들에서 첫 알파벳/영문 이니셜 추출
// 예) 브라질 세하도 NY2 생두 → B(Brazil) + S(Serado) + N(NY2) = BSN
// 예) 콜롬비아 안티오키아 수프리모 → C + A + S = CAS
// 예) 케냐 몸바사 AB → K + M + A = KMA
// ===================================================
function generateCodeFromName(name) {
  if (!name || !name.trim()) return '';

  // 한글 → 영문 이니셜 매핑 (주요 원산지/지역/등급)
  const koToEn = {
    // 원산지
    '브라질': 'B', '콜롬비아': 'C', '에티오피아': 'E', '케냐': 'K',
    '과테말라': 'G', '코스타리카': 'R', '파나마': 'P', '온두라스': 'H',
    '인도네시아': 'I', '탄자니아': 'T', '르완다': 'W', '예멘': 'Y',
    '페루': 'U', '볼리비아': 'V', '멕시코': 'X', '자메이카': 'J',
    '하와이': 'Z', '중국': 'Q', '인도': 'D', '베트남': 'N',
    // 지역/농장
    '세하도': 'S', '안티오키아': 'A', '몸바사': 'M', '예가체프': 'Y',
    '시다마': 'I', '구지': 'U', '하라': 'H', '리무': 'L',
    '나리뇨': 'N', '우일라': 'O', '카우카': 'K', '타라주': 'T',
    '포포얀': 'P', '부에나비스타': 'V', '게이샤': 'G', '보케테': 'B',
    '수마트라': 'S', '만델링': 'M', '토라자': 'T', '자바': 'J',
    '아루샤': 'A', '킬리만자로': 'K', '르완다': 'R',
    // 등급/품종
    '수프리모': 'S', '엑셀소': 'X', '스크린': 'C',
    '내추럴': 'N', '워시드': 'W', '허니': 'H', '펄프드': 'P',
    '아라비카': 'A', '로부스타': 'R',
    // 자재구분
    '생두': '', '원두': '', '부재료': '', '포장재': '', '소모품': '',
  };

  const words = name.trim().split(/[\s\-_\/]+/);
  let code = '';

  for (const word of words) {
    if (!word) continue;
    // 한글 단어 → 매핑 테이블 우선
    if (koToEn[word] !== undefined) {
      if (koToEn[word]) code += koToEn[word];
      continue;
    }
    // 영문/숫자 혼합 단어 → 첫 알파벳 문자 추출
    const firstAlpha = word.match(/[A-Za-z]/);
    if (firstAlpha) {
      code += firstAlpha[0].toUpperCase();
      continue;
    }
    // 순수 한글 → 첫 글자 초성 영문 변환
    const firstChar = word[0];
    if (firstChar) {
      const chosungMap = {
        'ㄱ': 'G', 'ㄴ': 'N', 'ㄷ': 'D', 'ㄹ': 'R', 'ㅁ': 'M',
        'ㅂ': 'B', 'ㅅ': 'S', 'ㅇ': 'A', 'ㅈ': 'J', 'ㅊ': 'C',
        'ㅋ': 'K', 'ㅌ': 'T', 'ㅍ': 'P', 'ㅎ': 'H'
      };
      const code1 = firstChar.charCodeAt(0);
      if (code1 >= 0xAC00 && code1 <= 0xD7A3) {
        const chosungIdx = Math.floor((code1 - 0xAC00) / 588);
        const chosungList = ['G','K','N','D','T','R','M','B','P','S','','J','C','K','T','P','H'];
        const ch = chosungList[chosungIdx];
        if (ch) code += ch;
      }
    }
  }

  // 최소 2자, 최대 4자로 제한
  if (code.length < 2) code = code.padEnd(2, 'X');
  if (code.length > 4) code = code.slice(0, 4);
  return code.toUpperCase();
}

// 중복 체크 후 최종 자재코드 확정
async function resolveUniqueCode(baseCode, excludeId = null) {
  if (!baseCode) {
    // 폴백: MAT-YYYYMMDD-NNN
    const data = await apiGetAll('materials_master');
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '').slice(2);
    const existing = data.filter(m => m.material_code && m.material_code.startsWith(`MAT-${dateStr}`));
    return `MAT-${dateStr}-${String(existing.length + 1).padStart(3, '0')}`;
  }
  const data = await apiGetAll('materials_master');
  const usedCodes = data
    .filter(m => m.id !== excludeId)
    .map(m => m.material_code || '');

  if (!usedCodes.includes(baseCode)) return baseCode;
  // 중복 시 숫자 순번 부여 (BSN → BSN2 → BSN3 ...)
  for (let i = 2; i <= 99; i++) {
    const candidate = `${baseCode}${i}`;
    if (!usedCodes.includes(candidate)) return candidate;
  }
  return `${baseCode}-${Date.now()}`;
}

// 자재명 입력 시 자동 코드 제안
let _codeDebounceTimer = null;
async function onMaterialNameInput() {
  if (_codeManuallyEdited) return; // 사용자가 직접 수정 중이면 건드리지 않음
  const nameEl = document.getElementById('f_material_name');
  const display = document.getElementById('codeDisplay');
  if (!nameEl || !display) return;

  const name = nameEl.value.trim();
  if (!name) {
    display.textContent = '자재명 입력 시 자동 생성';
    display.style.color = '#aaa';
    return;
  }

  display.textContent = '생성 중...';
  display.style.color = '#aaa';

  clearTimeout(_codeDebounceTimer);
  _codeDebounceTimer = setTimeout(async () => {
    const baseCode = generateCodeFromName(name);
    try {
      const finalCode = await resolveUniqueCode(baseCode, editingId);
      display.textContent = finalCode;
      display.style.color = '';
    } catch (e) {
      display.textContent = baseCode || 'MAT-???';
      display.style.color = '';
    }
  }, 400);
}

// 자재코드 직접 수정 토글
function toggleCodeEdit() {
  const display = document.getElementById('codeDisplay');
  const input = document.getElementById('codeInput');
  const btn = document.getElementById('codeEditBtn');
  if (!display || !input || !btn) return;

  const isEditing = input.style.display !== 'none';
  if (isEditing) {
    // 완료: input 값을 display에 반영
    const val = input.value.trim().toUpperCase();
    if (val) {
      display.textContent = val;
      _codeManuallyEdited = true;
    }
    display.style.display = '';
    input.style.display = 'none';
    btn.style.display = 'none';
  } else {
    // 편집 시작
    input.value = display.textContent;
    display.style.display = 'none';
    input.style.display = '';
    btn.style.display = '';
    input.focus();
    input.select();
  }
}

// ===========================
// 데이터 로드
// ===========================
async function loadMaterials() {
  try {
    const data = await apiGetAll('materials_master');
    allMaterials = data.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    filteredMaterials = [...allMaterials];
    renderTable();
    renderKpi();
  } catch (e) {
    console.error('[materials-master] 로드 실패:', e);
    const tb = document.getElementById('materialsTableBody');
    if (tb) tb.innerHTML = `<tr><td colspan="13" class="empty-msg"><i class="fas fa-exclamation-circle"></i> 데이터 로드 실패: ${e.message}</td></tr>`;
  }
}

// ===========================
// KPI 렌더링
// ===========================
function renderKpi() {
  const total = allMaterials.length;
  const coffee = allMaterials.filter(m => m.material_type === '생두').length;
  const sub = allMaterials.filter(m => ['부재료', '포장재', '소모품'].includes(m.material_type)).length;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('kpiTotal', total);
  set('kpiCoffee', coffee);
  set('kpiSubMat', sub);
  set('kpiStockLow', 0);
}

// ===========================
// 필터링
// ===========================
function filterTable() {
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const type = document.getElementById('typeFilter')?.value || '';
  filteredMaterials = allMaterials.filter(m => {
    const matchQ = !q ||
      (m.material_name || '').toLowerCase().includes(q) ||
      (m.material_code || '').toLowerCase().includes(q) ||
      (m.supplier || '').toLowerCase().includes(q);
    const matchType = !type || m.material_type === type;
    return matchQ && matchType;
  });
  currentPage = 1;
  renderTable();
}

// ===========================
// 테이블 렌더링
// ===========================
function renderTable() {
  const tbody = document.getElementById('materialsTableBody');
  if (!tbody) return;
  const start = (currentPage - 1) * pageSize;
  const pageData = filteredMaterials.slice(start, start + pageSize);

  if (!pageData.length) {
    tbody.innerHTML = `<tr><td colspan="13"><div class="empty-msg"><i class="fas fa-inbox"></i> 등록된 자재가 없습니다.</div></td></tr>`;
  } else {
    const typeColors = {
      '생두': 'badge-warning',
      '부재료': 'badge-info',
      '포장재': 'badge-success',
      '소모품': 'badge-secondary',
      '기타': 'badge-secondary'
    };
    tbody.innerHTML = pageData.map(m => {
      const typeCls = typeColors[m.material_type] || 'badge-secondary';
      return `<tr>
        <td><strong style="font-family:monospace;color:#2C5F2E">${m.material_code || '-'}</strong></td>
        <td><strong>${m.material_name || '-'}</strong></td>
        <td><span class="badge ${typeCls}">${m.material_type || '-'}</span></td>
        <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.specification || '-'}</td>
        <td>${m.unit || '-'}</td>
        <td>${m.standard_price ? numFormat(m.standard_price, 0) + '원' : '-'}</td>
        <td>${m.min_stock ? numFormat(m.min_stock) + (m.unit || '') : '-'}</td>
        <td>${m.supplier || '-'}</td>
        <td>${m.storage_condition || '-'}</td>
        <td>${m.shelf_life_days ? m.shelf_life_days + '일' : '-'}</td>
        <td>${m.origin_country || '-'}</td>
        <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.notes || '-'}</td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="openEditModal('${m.id}')"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm" onclick="deleteMaterial('${m.id}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');
  }

  const countEl = document.getElementById('tableCount');
  if (countEl) countEl.textContent = `전체 ${filteredMaterials.length}건`;
  renderPagination();
}

// ===========================
// 페이지네이션
// ===========================
function renderPagination() {
  const totalPages = Math.ceil(filteredMaterials.length / pageSize);
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
  // codeInput이 보이면 그 값 사용, 아니면 codeDisplay 텍스트 사용
  const inputEl = document.getElementById('codeInput');
  const displayEl = document.getElementById('codeDisplay');
  let code = '';
  if (inputEl && inputEl.style.display !== 'none') {
    code = inputEl.value.trim().toUpperCase();
  } else {
    code = displayEl?.textContent?.trim() || '';
  }
  return {
    material_code: code,
    material_name: document.getElementById('f_material_name')?.value || '',
    material_type: document.getElementById('f_material_type')?.value || '',
    unit: document.getElementById('f_unit')?.value || '',
    origin_country: document.getElementById('f_origin_country')?.value || '',
    specification: document.getElementById('f_specification')?.value || '',
    standard_price: parseFloat(document.getElementById('f_standard_price')?.value) || 0,
    min_stock: parseFloat(document.getElementById('f_min_stock')?.value) || 0,
    supplier: document.getElementById('f_supplier')?.value || '',
    storage_condition: document.getElementById('f_storage_condition')?.value || '',
    shelf_life_days: parseInt(document.getElementById('f_shelf_life_days')?.value) || 0,
    notes: document.getElementById('f_notes')?.value || '',
  };
}

// ===========================
// 폼 초기화
// ===========================
function resetForm() {
  const form = document.getElementById('materialsForm');
  if (form) form.reset();
  editingId = null;
  _codeManuallyEdited = false;

  // 코드 표시 초기화
  const display = document.getElementById('codeDisplay');
  const input = document.getElementById('codeInput');
  const btn = document.getElementById('codeEditBtn');
  if (display) { display.textContent = '자재명 입력 시 자동 생성'; display.style.color = '#aaa'; display.style.display = ''; }
  if (input) { input.value = ''; input.style.display = 'none'; }
  if (btn) btn.style.display = 'none';

  const submitBtn = document.querySelector('#materialsForm button[type="submit"]');
  if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-save"></i> 등록';
  showToast('폼이 초기화되었습니다.', 'info');
}

// ===========================
// 폼 제출
// ===========================
async function handleSubmit(e) {
  e.preventDefault();
  const data = getFormData();
  if (!data.material_name) { showToast('자재명을 입력하세요.', 'warning'); return; }
  if (!data.material_type) { showToast('자재구분을 선택하세요.', 'warning'); return; }
  if (!data.material_code || data.material_code === '자재명 입력 시 자동 생성') {
    showToast('자재코드가 생성되지 않았습니다. 자재명을 입력하세요.', 'warning'); return;
  }

  // 중복 코드 체크 (수정 시 자기 자신 제외)
  const allData = await apiGetAll('materials_master');
  const duplicate = allData.find(m => m.material_code === data.material_code && m.id !== editingId);
  if (duplicate) {
    showToast(`자재코드 "${data.material_code}"가 이미 사용 중입니다. 코드를 수정해주세요.`, 'warning');
    return;
  }

  const btn = document.querySelector('#materialsForm button[type="submit"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...'; }
  try {
    if (editingId) {
      await apiPut('materials_master', editingId, data);
      showToast(`✅ [${data.material_code}] ${data.material_name} 수정 완료`, 'success');
      editingId = null;
    } else {
      await apiPost('materials_master', data);
      showToast(`✅ [${data.material_code}] ${data.material_name} 등록 완료`, 'success');
    }
    resetForm();
    await loadMaterials();
  } catch (err) {
    showToast('저장 실패: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-save"></i> 등록';
    }
  }
}

// ===========================
// 수정 모달 (인라인 수정)
// ===========================
function openEditModal(id) {
  const m = allMaterials.find(r => r.id === id);
  if (!m) return;
  editingId = id;
  _codeManuallyEdited = true; // 수정 시에는 기존 코드 유지

  const fields = ['material_name', 'material_type', 'unit', 'origin_country',
    'specification', 'standard_price', 'min_stock', 'supplier', 'storage_condition',
    'shelf_life_days', 'notes'];
  fields.forEach(key => {
    const el = document.getElementById('f_' + key);
    if (el) el.value = m[key] || '';
  });

  // 코드 표시
  const display = document.getElementById('codeDisplay');
  const input = document.getElementById('codeInput');
  const btn = document.getElementById('codeEditBtn');
  if (display) { display.textContent = m.material_code || ''; display.style.color = ''; display.style.display = ''; }
  if (input) input.style.display = 'none';
  if (btn) btn.style.display = 'none';

  const formSection = document.querySelector('.form-container');
  if (formSection) formSection.scrollIntoView({ behavior: 'smooth' });

  const submitBtn = document.querySelector('#materialsForm button[type="submit"]');
  if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-save"></i> 수정 저장';
  showToast('수정 모드: 내용 변경 후 저장하세요.', 'info');
}

function closeEditModal() { resetForm(); }
function saveEdit() { /* not used */ }
function onTypeChange() { /* 자재구분 변경 시 추가 처리 필요 시 사용 */ }

// ===========================
// 삭제
// ===========================
async function deleteMaterial(id) {
  showConfirm('이 자재를 삭제하시겠습니까?<br><small style="color:#e74c3c">삭제 후 복구할 수 없습니다.</small>', async () => {
    try {
      await apiDelete('materials_master', id);
      showToast('삭제되었습니다.', 'success');
      if (editingId === id) resetForm();
      await loadMaterials();
    } catch (e) {
      showToast('삭제 실패: ' + e.message, 'error');
    }
  });
}

function deleteRecord() {
  if (editingId) deleteMaterial(editingId);
}
