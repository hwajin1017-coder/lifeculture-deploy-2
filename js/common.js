// ===========================
// 공통 유틸리티 함수
// ===========================

// 날짜 포맷 (YYYY-MM-DD)
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 오늘 날짜
function today() {
  return formatDate(new Date());
}

// 날짜 한국어 포맷
function formatDateKR(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일`;
}

// 숫자 포맷 (천 단위 콤마)
function numFormat(n, decimals = 2) {
  if (n === null || n === undefined || n === '') return '-';
  const num = parseFloat(n);
  if (isNaN(num)) return '-';
  return num.toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

// ===========================
// Lot 번호 자동 생성
// ===========================
// prefix: 'RST'|'GRD'|'EXT'|'BTL'|'BOX'|'RM' 등
// workDate: 'YYYY-MM-DD' 형식 (없으면 오늘)
function getLotDateYYMMDD(workDate) {
  const value = String(workDate || '').trim();
  const digits = value.replace(/[^0-9]/g, '');
  if (/^20\d{6}$/.test(digits)) return digits.slice(2);
  if (/^\d{6}$/.test(digits)) return digits;
  const d = new Date(value || Date.now());
  if (Number.isNaN(d.getTime())) throw new Error('유효하지 않은 작업일자입니다.');
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeProcessLotNo(lotNo) {
  const value = String(lotNo || '').trim();
  const match = value.match(/^(RST|ROAST|GRD|GRIND|EXT|BTL|BOX)-(20\d{6}|\d{6})-(\d+)$/i);
  if (!match) return value;
  const prefixMap = { ROAST: 'RST', GRIND: 'GRD' };
  const prefix = prefixMap[match[1].toUpperCase()] || match[1].toUpperCase();
  const dateStr = match[2].slice(-6);
  return `${prefix}-${dateStr}-${String(parseInt(match[3], 10) || 1).padStart(2, '0')}`;
}

function getLotNoSequence(lotNo) {
  const match = String(lotNo || '').match(/-(\d+)$/);
  return match ? (parseInt(match[1], 10) || 0) : 0;
}

function compareProductionLotsDescending(a, b) {
  const dateA = String(a?.work_date || '').replace(/[^0-9]/g, '');
  const dateB = String(b?.work_date || '').replace(/[^0-9]/g, '');
  if (dateB !== dateA) return dateB.localeCompare(dateA);
  const seqDiff = getLotNoSequence(b?.lot_no) - getLotNoSequence(a?.lot_no);
  if (seqDiff) return seqDiff;
  const timeA = a?.createdAt?.toMillis?.() || a?.createdAt?.seconds || a?.created_at || 0;
  const timeB = b?.createdAt?.toMillis?.() || b?.createdAt?.seconds || b?.created_at || 0;
  return timeB - timeA;
}

async function generateLotNo(prefix, workDate) {
  const prefixMap = { ROAST: 'RST', GRIND: 'GRD' };
  const normalizedPrefix = prefixMap[String(prefix || '').toUpperCase()] || String(prefix || '').toUpperCase();
  const dateStr = getLotDateYYMMDD(workDate);
  const tableMap = {
    RM: 'raw_materials', IM: 'raw_materials', OM: 'raw_materials',
    RST: 'roasting_log', GRD: 'grinding_log', EXT: 'extraction_log',
    BTL: 'bottle_packing_log', BOX: 'box_packing_log',
  };
  const tableName = tableMap[normalizedPrefix];
  if (!tableName || typeof apiGetAll !== 'function') throw new Error('Lot No 생성 서비스를 준비할 수 없습니다.');

  const rows = await apiGetAll(tableName);
  const lotPattern = new RegExp(`^${normalizedPrefix}-(?:${dateStr}|20${dateStr})-(\\d+)$`, 'i');
  const maxSequence = rows.reduce((max, row) => {
    const normalizedLot = normalizeProcessLotNo(row.lot_no);
    const match = normalizedLot.match(lotPattern);
    return match ? Math.max(max, parseInt(match[1], 10) || 0) : max;
  }, 0);
  return `${normalizedPrefix}-${dateStr}-${String(maxSequence + 1).padStart(2, '0')}`;
}

// 공정별 Lot 번호 생성 (공정코드-날짜-순번)
async function generateProcessLotNo(processCode, workDate) {
  return await generateLotNo(processCode, workDate);
}

// ===========================
// 원료수불부 전용 Lot 생성
// ===========================
async function generateRawLotNo(transactionType) {
  return await generateLotNo('RM');
}

// ===========================
// 사이드바 HTML 생성 (권한 적용)
// ===========================
function getSidebarHTML(activePage = '') {
  const user = (typeof getCurrentUser === 'function') ? getCurrentUser() : null;

  // 사용자별 허용 메뉴 계산 (auth.js의 getUserAllowedMenus 활용)
  let allowedMenus;
  if (user && typeof getUserAllowedMenus === 'function') {
    allowedMenus = getUserAllowedMenus(user);
  } else if (user && typeof ROLE_PERMISSIONS !== 'undefined') {
    const perms = ROLE_PERMISSIONS[user.role];
    allowedMenus = perms ? perms.menus : ['dashboard', 'traceability'];
  } else {
    allowedMenus = ['dashboard', 'raw-materials', 'materials-master', 'vendors', 'roasting', 'grinding', 'extraction', 'bottle-packing', 'box-packing', 'traceability', 'sales', 'products', 'logistics', 'backup'];
  }

  const roleColors = { admin:'#e74c3c', production:'#27ae60', warehouse:'#2980b9', sales:'#8e44ad', viewer:'#7f8c8d' };
  const roleLabels = { admin:'관리자', production:'생산팀', warehouse:'물류팀', sales:'영업팀', viewer:'조회자' };

  const navGroups = [
    {
      category: '홈',
      items: [
        { label: '현황 대시보드', href: 'index.html', icon: 'fa-tachometer-alt', menu: 'dashboard' }
      ]
    },
    {
      category: '물류팀',
      items: [
        { label: '원부재료 마스터', href: 'materials-master.html', icon: 'fa-cubes', menu: 'materials-master' },
        { label: '원료수불부 (자체생산)', href: 'raw-materials.html', icon: 'fa-box-open', menu: 'raw-materials' },
        { label: '거래처 정보', href: 'vendors.html', icon: 'fa-handshake', menu: 'vendors' },
        { label: '물류관리 (수입/OEM/자체)', href: 'logistics.html', icon: 'fa-truck', menu: 'logistics' },
        { label: '물류관리2 (일반/저온창고)', href: 'logistics2.html', icon: 'fa-warehouse', menu: 'logistics2' }
      ]
    },
    {
      category: '생산팀',
      items: [
        { label: '로스팅', href: 'roasting.html', icon: 'fa-fire', menu: 'roasting' },
        { label: '분쇄', href: 'grinding.html', icon: 'fa-cog', menu: 'grinding' },
        { label: '추출', href: 'extraction.html', icon: 'fa-tint', menu: 'extraction' },
        { label: '제품(병) 포장', href: 'bottle-packing.html', icon: 'fa-wine-bottle', menu: 'bottle-packing' },
        { label: '완제품(박스) 포장', href: 'box-packing.html', icon: 'fa-boxes', menu: 'box-packing' }
      ]
    },
    {
      category: '영업팀',
      items: [
        { label: '제품마스터정보', href: 'products.html', icon: 'fa-tag', menu: 'products' },
        { label: '제품마스터정보2', href: 'products2.html', icon: 'fa-tags', menu: 'products2' },
        { label: '온라인몰 판매', href: 'sales.html', icon: 'fa-shopping-cart', menu: 'sales' }
      ]
    },
    {
      category: '품질관리팀',
      items: [
        { label: 'Lot 역추적', href: 'traceability.html', icon: 'fa-search', menu: 'traceability' }
      ]
    },
    {
      category: '시스템',
      items: [
        { label: '데이터 백업/복원', href: 'backup.html', icon: 'fa-database', menu: 'backup', style: 'color:#e67e22' },
        { label: '사용자 관리', href: 'user-admin.html', icon: 'fa-users-cog', menu: 'user-admin', adminOnly: true }
      ]
    }
  ];

  // 쓰기 가능 메뉴 목록 계산 (배지 표시용)
  let writableMenus = [];
  if (user) {
    if (user.role === 'admin') {
      writableMenus = null; // null = 관리자 (배지 없음)
    } else if (typeof getUserWritableMenus === 'function') {
      writableMenus = getUserWritableMenus(user);
    } else {
      const rp = typeof ROLE_PERMISSIONS !== 'undefined' ? ROLE_PERMISSIONS[user.role] : null;
      writableMenus = (rp && rp.canEdit) ? (rp.menus || []) : [];
    }
  }

  let html = '';
  navGroups.forEach(group => {
    const visibleItems = group.items.filter(item => {
      if (item.adminOnly && (!user || user.role !== 'admin')) return false;
      return allowedMenus.includes(item.menu);
    });
    if (!visibleItems.length) return;
    html += `<div class="nav-section"><span class="nav-section-title">${group.category}</span>`;
    visibleItems.forEach(item => {
      const isActive = (item.href === activePage || activePage === item.menu) ? 'active' : '';
      const styleAttr = item.style ? ` style="${item.style}"` : '';
      // 권한 배지 (관리자는 표시 안 함)
      let permBadge = '';
      if (user && writableMenus !== null) {
        const canWrite = writableMenus.includes(item.menu);
        if (canWrite) {
          permBadge = `<span style="margin-left:auto;font-size:9px;padding:1px 5px;border-radius:6px;background:rgba(39,174,96,0.25);color:#2ecc71;border:1px solid rgba(46,204,113,0.4);white-space:nowrap;flex-shrink:0">읽기+쓰기</span>`;
        } else {
          permBadge = `<span style="margin-left:auto;font-size:9px;padding:1px 5px;border-radius:6px;background:rgba(231,76,60,0.2);color:#e74c3c;border:1px solid rgba(231,76,60,0.35);white-space:nowrap;flex-shrink:0">읽기전용</span>`;
        }
      }
      html += `<a href="${item.href}" class="nav-item ${isActive}"${styleAttr} style="display:flex;align-items:center;gap:6px"><i class="fas ${item.icon}"></i><span style="flex:1">${item.label}</span>${permBadge}</a>`;
    });
    html += '</div>';
  });

  // 사용자 정보 하단
  if (user) {
    const color = roleColors[user.role] || '#7f8c8d';
    const roleLabel = roleLabels[user.role] || user.role;
    html += `
      <div class="sidebar-user-info" style="padding:16px;border-top:1px solid rgba(255,255,255,0.1);margin-top:auto">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:36px;height:36px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:15px;flex-shrink:0">${user.name.charAt(0)}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${user.name}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${user.email}</div>
            <span style="display:inline-block;background:${color};color:#fff;font-size:10px;padding:1px 6px;border-radius:8px;margin-top:2px">${roleLabel}</span>
          </div>
          <button onclick="logout()" style="background:none;border:none;color:rgba(255,255,255,0.6);cursor:pointer;padding:4px;font-size:14px" title="로그아웃"><i class="fas fa-sign-out-alt"></i></button>
        </div>
      </div>
    `;
  }

  return html;
}

// 사이드바 초기화
function setupSidebar() {
  const sidebarToggle = document.getElementById('sidebarToggle');
  const menuToggle = document.getElementById('menuToggle');
  const sidebar = document.getElementById('sidebar');

  function toggleSidebar() {
    if (sidebar) sidebar.classList.toggle('open');
  }
  if (sidebarToggle) sidebarToggle.onclick = toggleSidebar;
  if (menuToggle) menuToggle.onclick = toggleSidebar;

  document.addEventListener('click', (e) => {
    if (sidebar && sidebar.classList.contains('open') &&
        !sidebar.contains(e.target) && e.target !== menuToggle) {
      sidebar.classList.remove('open');
    }
  });
}

// ===========================
// 페이지 공통 초기화 (인증 포함)
// ===========================
function initPageWithAuth(menuKey) {
  // 인증 확인
  if (typeof requireAuth === 'function') {
    const user = requireAuth(menuKey);
    if (!user) return null;
  }

  // 날짜 표시
  initDateDisplay();

  // 사이드바 구성
  const currentPath = window.location.pathname.split('/').pop() || 'index.html';
  const sidebarNav = document.getElementById('sidebarNav');
  if (sidebarNav) {
    sidebarNav.innerHTML = getSidebarHTML(currentPath);
  }
  const sidebar = document.getElementById('sidebar');
  if (sidebar && !document.getElementById('sidebarNav')) {
    // 구형 사이드바 방식
  }
  setupSidebar();

  // 사용자 헤더 렌더링
  if (typeof renderUserHeader === 'function') renderUserHeader();

  return typeof getCurrentUser === 'function' ? getCurrentUser() : null;
}

// ===========================
// 토스트 알림
// ===========================
function showToast(message, type = 'success') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i class="fas ${icons[type] || icons.info} toast-icon"></i>
    <span class="toast-msg">${message}</span>
    <button class="toast-close" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
  `;
  container.appendChild(toast);
  setTimeout(() => { if (toast.parentElement) toast.remove(); }, 3500);
}

// ===========================
// 확인 모달
// ===========================
function showConfirm(message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay show';
  overlay.innerHTML = `
    <div class="modal-dialog" style="max-width:420px">
      <div class="modal-header"><h3><i class="fas fa-question-circle" style="color:var(--warning)"></i> 확인</h3></div>
      <div class="modal-body"><p style="margin:0;font-size:15px">${message}</p></div>
      <div class="modal-footer" style="display:flex;gap:10px;justify-content:flex-end;padding:16px">
        <button class="btn btn-secondary" id="confirmNo">취소</button>
        <button class="btn btn-danger" id="confirmYes">삭제</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#confirmNo').onclick = () => overlay.remove();
  overlay.querySelector('#confirmYes').onclick = () => { onConfirm(); overlay.remove(); };
}

// ===========================
// 품질 뱃지
// ===========================
function qualityBadge(v) {
  if (!v) return '-';
  const map = { '적합': 'badge-success', '부적합': 'badge-danger', '재작업': 'badge-warning', '보류': 'badge-warning', '합격': 'badge-success', '불합격': 'badge-danger', '특채': 'badge-warning' };
  return `<span class="badge ${map[v] || 'badge-info'}">${v}</span>`;
}

// ===========================
// 네비게이션 활성화
// ===========================
function setActiveNav() {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
    const href = item.getAttribute('href');
    if (href === path || (path === '' && href === 'index.html')) {
      item.classList.add('active');
    }
  });
}

// ===========================
// 날짜 표시
// ===========================
function initDateDisplay() {
  const now = new Date();
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const str = `${now.getFullYear()}년 ${now.getMonth()+1}월 ${now.getDate()}일 (${days[now.getDay()]})`;
  const el = document.getElementById('topbarDate');
  if (el) el.textContent = str;
  const el2 = document.getElementById('currentDate');
  if (el2) el2.textContent = str;
}

// ===========================
// 모바일 사이드바 토글 (구형 호환)
// ===========================
function initSidebarToggle() {
  setupSidebar();
}

// ===========================
// 페이지 로드 시 공통 초기화 (구형 호환)
// ===========================
function initPage() {
  initDateDisplay();
  setActiveNav();
  setupSidebar();
}

// ===========================
// Lot 링크 클릭 → 역추적
// ===========================
function goToTrace(lotNo) {
  window.location.href = `traceability.html?lot=${encodeURIComponent(lotNo)}`;
}

// ===========================
// 엑셀 내보내기 공통 함수
// ===========================
function exportToExcel(data, filename, headers) {
  if (!data || !data.length) { showToast('내보낼 데이터가 없습니다.', 'warning'); return; }
  const headerRow = headers.map(h => h.label).join('\t');
  const rows = data.map(row => headers.map(h => {
    const val = row[h.key] || '';
    return String(val).replace(/\t/g, ' ');
  }).join('\t'));
  const content = [headerRow, ...rows].join('\n');
  const bom = '\uFEFF';
  const blob = new Blob([bom + content], { type: 'text/tab-separated-values;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename + '_' + today().replace(/-/g,'') + '.xls';
  a.click();
  URL.revokeObjectURL(url);
  showToast('엑셀 파일이 다운로드되었습니다.', 'success');
}

// ===========================
// 인쇄 (A4)
// ===========================
function printPage() {
  window.print();
}

// ===========================
// 재고 공유 데이터 스토어 (InventoryStore)
// logistics.js ↔ warehouse-mgmt.js 간 데이터 공유
// CustomEvent 기반으로 파일 간 타이밍 의존성 제거
// ===========================
window.InventoryStore = (function() {
  var _data = {
    logistics: [],
    wh_inbound: [],
    wh_outbound: [],
    wh_stocktake: []
  };
  var _listeners = {};

  function on(event, fn) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
  }

  function off(event, fn) {
    if (!_listeners[event]) return;
    _listeners[event] = _listeners[event].filter(function(f) { return f !== fn; });
  }

  function emit(event, detail) {
    (_listeners[event] || []).forEach(function(fn) {
      try { fn(detail); } catch(e) { console.warn('[InventoryStore] 이벤트 핸들러 오류:', e); }
    });
    // DOM CustomEvent도 함께 발행 (다른 모듈에서 addEventListener 사용 가능)
    try {
      document.dispatchEvent(new CustomEvent('inventory:' + event, { detail: detail }));
    } catch(e) {}
  }

  function set(key, value) {
    _data[key] = value || [];
    emit('updated', { key: key, data: _data[key] });
  }

  function get(key) {
    return _data[key] || [];
  }

  function setAll(obj) {
    Object.keys(obj).forEach(function(k) { _data[k] = obj[k] || []; });
    emit('updated', { key: 'all', data: _data });
  }

  return { on: on, off: off, emit: emit, set: set, get: get, setAll: setAll };
})();


// ===========================
// KPI 집계 캐시 (kpi_summary 컬렉션)
// 데이터 등록/삭제 시 호출하여 월별 집계를 누적 업데이트
// 문서 ID 형식: {type}_{YYYY-MM}  예) roasting_2025-07
// 필드 구조:
//   roasting_log  → { roasted_qty_total, count }
//   extraction_log → { extract_qty_total, count }
//   box_packing_log → { box_count_total, count }
//   raw_materials  → { in_count }  (입고 건수)
// ===========================

/**
 * KPI 집계 캐시 증분 업데이트
 * @param {string} type  - 'roasting_log' | 'extraction_log' | 'box_packing_log' | 'raw_materials'
 * @param {object} record - 저장된 레코드 원본
 * @param {number} sign  - +1 (등록) 또는 -1 (삭제)
 */
async function updateKpiCache(type, record, sign) {
  try {
    const db = getFirestore();
    // 날짜 필드 추출 (컬렉션마다 다름)
    const dateStr = record.work_date || record.receive_date || record.sale_date || '';
    if (!dateStr || dateStr.length < 7) return; // 날짜 없으면 스킵
    const month = dateStr.substring(0, 7); // YYYY-MM
    const docId = type + '_' + month;
    const ref = db.collection('kpi_summary').doc(docId);

    // 증분값 계산
    const increment = firebase.firestore.FieldValue.increment;
    const delta = {};

    if (type === 'roasting_log') {
      delta.roasted_qty_total = increment((parseFloat(record.roasted_qty) || 0) * sign);
      delta.count = increment(1 * sign);
    } else if (type === 'extraction_log') {
      delta.extract_qty_total = increment((parseFloat(record.extract_qty) || 0) * sign);
      delta.count = increment(1 * sign);
    } else if (type === 'box_packing_log') {
      delta.box_count_total = increment((parseInt(record.box_count) || 0) * sign);
      delta.count = increment(1 * sign);
    } else if (type === 'raw_materials' && record.transaction_type === '입고') {
      delta.in_count = increment(1 * sign);
    } else {
      return; // 해당 없는 타입은 스킵
    }

    // 문서가 없으면 자동 생성(set with merge), 있으면 증분 업데이트
    delta.type = type;
    delta.month = month;
    delta.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await ref.set(delta, { merge: true });
  } catch (e) {
    // 캐시 업데이트 실패는 조용히 처리 (원본 저장은 이미 완료됨)
    console.warn('[KPI Cache] 집계 업데이트 실패 (무시됨):', e.message);
  }
}

/**
 * 특정 월의 KPI 집계 캐시 조회
 * @param {string} type  - 컬렉션명
 * @param {string} month - 'YYYY-MM'
 * @returns {object|null}
 */
async function getKpiCache(type, month) {
  try {
    const db = getFirestore();
    const docId = type + '_' + month;
    const doc = await db.collection('kpi_summary').doc(docId).get();
    return doc.exists ? doc.data() : null;
  } catch (e) {
    console.warn('[KPI Cache] 조회 실패:', e.message);
    return null;
  }
}

/**
 * 전체 데이터를 재집계하여 kpi_summary를 재구축 (관리자 전용 복구 함수)
 * 대시보드에서 직접 호출하지 않으며, 데이터 불일치 발생 시 수동 실행
 */
async function rebuildKpiCache() {
  try {
    showToast('KPI 캐시 재구축 중... 잠시 기다려 주세요.', 'info');
    const [roastAll, extAll, boxAll, rawAll] = await Promise.all([
      apiGetAll('roasting_log'),
      apiGetAll('extraction_log'),
      apiGetAll('box_packing_log'),
      apiGetAll('raw_materials'),
    ]);

    const summary = {}; // { docId: { ...fields } }

    const ensure = (docId, type, month) => {
      if (!summary[docId]) summary[docId] = { type, month };
    };

    roastAll.forEach(r => {
      const month = (r.work_date || '').substring(0, 7);
      if (!month) return;
      const id = 'roasting_log_' + month;
      ensure(id, 'roasting_log', month);
      summary[id].roasted_qty_total = (summary[id].roasted_qty_total || 0) + (parseFloat(r.roasted_qty) || 0);
      summary[id].count = (summary[id].count || 0) + 1;
    });

    extAll.forEach(r => {
      const month = (r.work_date || '').substring(0, 7);
      if (!month) return;
      const id = 'extraction_log_' + month;
      ensure(id, 'extraction_log', month);
      summary[id].extract_qty_total = (summary[id].extract_qty_total || 0) + (parseFloat(r.extract_qty) || 0);
      summary[id].count = (summary[id].count || 0) + 1;
    });

    boxAll.forEach(r => {
      const month = (r.work_date || '').substring(0, 7);
      if (!month) return;
      const id = 'box_packing_log_' + month;
      ensure(id, 'box_packing_log', month);
      summary[id].box_count_total = (summary[id].box_count_total || 0) + (parseInt(r.box_count) || 0);
      summary[id].count = (summary[id].count || 0) + 1;
    });

    rawAll.forEach(r => {
      if (r.transaction_type !== '입고') return;
      const month = (r.receive_date || '').substring(0, 7);
      if (!month) return;
      const id = 'raw_materials_' + month;
      ensure(id, 'raw_materials', month);
      summary[id].in_count = (summary[id].in_count || 0) + 1;
    });

    // Firestore에 일괄 저장
    const db = getFirestore();
    const entries = Object.entries(summary);
    const CHUNK = 400;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const batch = db.batch();
      entries.slice(i, i + CHUNK).forEach(([docId, data]) => {
        data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        batch.set(db.collection('kpi_summary').doc(docId), data);
      });
      await batch.commit();
    }
    showToast('KPI 캐시 재구축 완료! (' + entries.length + '개 월별 집계)', 'success');
  } catch (e) {
    showToast('KPI 캐시 재구축 실패: ' + e.message, 'error');
  }
}

// ===========================
// 생산 탭 제품명 드롭다운 선택 공통 함수
// ===========================
function toggleProductDropdown(inputId, dropdownId) {
  var dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;
  var isVisible = dropdown.style.display !== 'none';
  // 다른 드롭다운 모두 닫기
  document.querySelectorAll('[id^="productDropdown_"]').forEach(function(el) {
    el.style.display = 'none';
  });
  dropdown.style.display = isVisible ? 'none' : 'block';
}

function selectProductName(name, inputId, dropdownId, triggerAutoDetect) {
  var input = document.getElementById(inputId);
  if (input) {
    input.value = name;
    // 로스팅 탭 블렌딩 자동 감지 연동
    if (triggerAutoDetect && typeof autoDetectBlending === 'function') {
      autoDetectBlending(name);
    }
  }
  var dropdown = document.getElementById(dropdownId);
  if (dropdown) dropdown.style.display = 'none';
}

// 외부 클릭 시 제품명 드롭다운 닫기
document.addEventListener('click', function(e) {
  var id = e.target.id || '';
  if (!id.startsWith('f_product_name')) {
    document.querySelectorAll('[id^="productDropdown_"]').forEach(function(el) {
      el.style.display = 'none';
    });
  }
});
