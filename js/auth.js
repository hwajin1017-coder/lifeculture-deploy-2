// =====================================================
// auth.js — 라이프컬처 이메일 로그인 & 권한 관리
// localStorage 기반 세션 + 역할별 + 사용자별 메뉴 접근제어
// =====================================================

const AUTH_KEY = 'lifeculture_auth';
const USERS_KEY = 'lifeculture_users';

// ===========================
// 전체 메뉴 목록 (권한 관리 대상)
// ===========================
const ALL_MENUS = [
  { key: 'dashboard',       label: '현황 대시보드' },
  { key: 'traceability',    label: 'Lot 역추적' },
  { key: 'materials-master',label: '원부재료 마스터' },
  { key: 'raw-materials',   label: '원료수불부' },
  { key: 'vendors',         label: '거래처 정보' },
  { key: 'vendors2',        label: '거래처정보2' },
  { key: 'roasting',        label: '로스팅' },
  { key: 'grinding',        label: '분쇄' },
  { key: 'extraction',      label: '추출' },
  { key: 'bottle-packing',  label: '제품(병) 포장' },
  { key: 'box-packing',     label: '완제품(박스) 포장' },
  { key: 'sales',           label: '온라인몰 판매' },
  { key: 'products',        label: '제품마스터정보' },
  { key: 'products2',       label: '제품마스터정보2' },
  { key: 'logistics',       label: '물류관리' },
  { key: 'logistics2',      label: '물류관리2' },
  { key: 'backup',          label: '데이터 백업/복원' }
];

// ===========================
// 역할별 기본 메뉴 접근 권한
// ===========================
const ROLE_PERMISSIONS = {
  admin: {
    label: '관리자',
    color: '#e74c3c',
    badge: '관리자',
    menus: ['dashboard', 'raw-materials', 'materials-master', 'vendors', 'vendors2', 'roasting', 'grinding', 'extraction', 'bottle-packing', 'box-packing', 'traceability', 'sales', 'products', 'products2', 'logistics', 'logistics2', 'backup', 'user-admin'],
    canEdit: true,
    canDelete: true,
    canExport: true
  },
  production: {
    label: '생산팀',
    color: '#27ae60',
    badge: '생산',
    menus: ['dashboard', 'raw-materials', 'materials-master', 'roasting', 'grinding', 'extraction', 'bottle-packing', 'box-packing', 'traceability'],
    canEdit: true,
    canDelete: false,
    canExport: false
  },
  warehouse: {
    label: '물류팀',
    color: '#2980b9',
    badge: '물류',
    menus: ['dashboard', 'raw-materials', 'materials-master', 'vendors', 'traceability', 'logistics', 'logistics2'],
    canEdit: true,
    canDelete: false,
    canExport: true
  },
  sales: {
    label: '영업팀',
    color: '#8e44ad',
    badge: '영업',
    menus: ['dashboard', 'sales', 'products', 'products2', 'vendors2', 'traceability'],
    canEdit: true,
    canDelete: false,
    canExport: true
  },
  viewer: {
    label: '조회자',
    color: '#7f8c8d',
    badge: '조회',
    menus: ['dashboard', 'traceability'],
    canEdit: false,
    canDelete: false,
    canExport: false
  }
};

// ===========================
// 기본 사용자 목록 (초기화용)
// ===========================
const DEFAULT_USERS = [
  {
    email: 'admin@lifeculture.co.kr',
    password: 'admin1234',
    name: '관리자',
    role: 'admin',
    department: '경영지원',
    active: true,
    menuPermissions: null  // null = 역할 기본값 사용
  },
  {
    email: 'production@lifeculture.co.kr',
    password: 'prod1234',
    name: '생산팀',
    role: 'production',
    department: '생산',
    active: true,
    menuPermissions: null
  },
  {
    email: 'warehouse@lifeculture.co.kr',
    password: 'ware1234',
    name: '물류팀',
    role: 'warehouse',
    department: '물류',
    active: true,
    menuPermissions: null
  },
  {
    email: 'sales@lifeculture.co.kr',
    password: 'sale1234',
    name: '영업팀',
    role: 'sales',
    department: '영업',
    active: true,
    menuPermissions: null
  },
  {
    email: 'viewer@lifeculture.co.kr',
    password: 'view1234',
    name: '조회자',
    role: 'viewer',
    department: '기타',
    active: true,
    menuPermissions: null
  }
];

// ===========================
// 사용자 목록 초기화
// ===========================
function initUsers() {
  if (!localStorage.getItem(USERS_KEY)) {
    localStorage.setItem(USERS_KEY, JSON.stringify(DEFAULT_USERS));
  }
}

// ===========================
// 사용자별 실제 허용 메뉴 목록 계산
// menuPermissions: { 'menu-key': 'none'|'read'|'write' }
// null이면 역할 기본값 사용
// ===========================
function getUserAllowedMenus(user) {
  if (!user) return [];
  // 관리자는 항상 전체 메뉴
  if (user.role === 'admin') {
    return ROLE_PERMISSIONS.admin.menus;
  }
  const rolePerms = ROLE_PERMISSIONS[user.role];
  const baseMenus = rolePerms ? rolePerms.menus : ['dashboard', 'traceability'];

  // 사용자별 커스텀 권한이 없으면 역할 기본값 반환
  const mp = user.menuPermissions;
  if (!mp || Object.keys(mp).length === 0) return baseMenus;

  // 커스텀 권한 적용: 역할 기본 메뉴 + 관리자가 추가 부여한 메뉴
  const allowed = new Set(baseMenus);
  ALL_MENUS.forEach(m => {
    const perm = mp[m.key];
    if (perm === 'read' || perm === 'write') {
      allowed.add(m.key);
    } else if (perm === 'none') {
      // 역할 기본에 있어도 명시적으로 none이면 제거
      allowed.delete(m.key);
    }
  });
  return Array.from(allowed);
}

// ===========================
// 사용자별 쓰기 가능 메뉴 목록 계산
// ===========================
function getUserWritableMenus(user) {
  if (!user) return [];
  if (user.role === 'admin') return ROLE_PERMISSIONS.admin.menus;
  const rolePerms = ROLE_PERMISSIONS[user.role];
  const mp = user.menuPermissions;

  // 역할 기본 쓰기 가능 메뉴 (canEdit=true인 역할의 기본 메뉴)
  const baseWritable = (rolePerms && rolePerms.canEdit) ? (rolePerms.menus || []) : [];

  if (!mp || Object.keys(mp).length === 0) return baseWritable;

  const writable = new Set(baseWritable);
  ALL_MENUS.forEach(m => {
    const perm = mp[m.key];
    if (perm === 'write') {
      writable.add(m.key);
    } else if (perm === 'read' || perm === 'none') {
      writable.delete(m.key);
    }
  });
  return Array.from(writable);
}

// ===========================
// 로그인
// ===========================
function login(email, password) {
  initUsers();
  const users = JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password && u.active);
  if (!user) return { success: false, message: '이메일 또는 비밀번호가 올바르지 않습니다.' };
  const session = {
    email: user.email,
    name: user.name,
    role: user.role,
    department: user.department,
    menuPermissions: user.menuPermissions || null,
    loginAt: new Date().toISOString()
  };
  localStorage.setItem(AUTH_KEY, JSON.stringify(session));
  return { success: true, user: session };
}

// ===========================
// 로그아웃
// ===========================
function logout() {
  localStorage.removeItem(AUTH_KEY);
  window.location.href = 'login.html';
}

// ===========================
// 현재 로그인 사용자 조회
// ===========================
function getCurrentUser() {
  const data = localStorage.getItem(AUTH_KEY);
  if (!data) return null;
  try { return JSON.parse(data); } catch(e) { return null; }
}

// ===========================
// 인증 확인 (각 페이지 상단에서 호출)
// ===========================
function requireAuth(requiredMenu) {
  const user = getCurrentUser();
  if (!user) {
    window.location.href = 'login.html';
    return null;
  }
  const perms = ROLE_PERMISSIONS[user.role];
  if (!perms) {
    logout();
    return null;
  }
  if (requiredMenu) {
    // user-admin은 관리자 전용
    if (requiredMenu === 'user-admin' && user.role !== 'admin') {
      // 모바일 PWA 호환: alert → showToast
      if (typeof showToast === 'function') showToast('관리자만 접근 가능합니다.', 'error');
      else alert('관리자만 접근 가능합니다.');
      setTimeout(function(){ window.location.href = 'index.html'; }, 1200);
      return null;
    }
    const allowed = getUserAllowedMenus(user);
    if (!allowed.includes(requiredMenu)) {
      // 모바일 PWA 호환: alert → showToast
      if (typeof showToast === 'function') showToast('이 페이지에 대한 접근 권한이 없습니다.', 'error');
      else alert('이 페이지에 대한 접근 권한이 없습니다.');
      setTimeout(function(){ window.location.href = 'index.html'; }, 1200);
      return null;
    }
  }
  return user;
}

// ===========================
// 권한 확인
// ===========================
function hasPermission(action) {
  const user = getCurrentUser();
  if (!user) return false;
  const perms = ROLE_PERMISSIONS[user.role];
  if (!perms) return false;
  return perms[action] === true;
}

// ===========================
// 특정 메뉴에 대한 쓰기 권한 확인
// ===========================
function canWriteMenu(menuKey) {
  const user = getCurrentUser();
  if (!user) return false;
  if (user.role === 'admin') return true;
  const writable = getUserWritableMenus(user);
  return writable.includes(menuKey);
}

// ===========================
// 사용자 정보 헤더에 표시
// ===========================
function renderUserHeader() {
  const user = getCurrentUser();
  if (!user) return;
  const perms = ROLE_PERMISSIONS[user.role] || {};
  // 사이드바 하단 사용자 정보
  const userInfoEl = document.getElementById('userInfo');
  if (userInfoEl) {
    userInfoEl.innerHTML = `
      <div class="user-info-wrap">
        <div class="user-avatar" style="background:${perms.color || '#7f8c8d'}">${user.name.charAt(0)}</div>
        <div class="user-details">
          <div class="user-name">${user.name}</div>
          <div class="user-email">${user.email}</div>
          <div class="user-role-badge" style="background:${perms.color || '#7f8c8d'}">${perms.badge || user.role}</div>
        </div>
        <button class="logout-btn" onclick="logout()" title="로그아웃"><i class="fas fa-sign-out-alt"></i></button>
      </div>
    `;
  }
  // 상단 바 사용자 표시
  const topUserEl = document.getElementById('topUserName');
  if (topUserEl) topUserEl.textContent = user.name;
  const topRoleEl = document.getElementById('topUserRole');
  if (topRoleEl) {
    topRoleEl.textContent = perms.badge || user.role;
    topRoleEl.style.background = perms.color || '#7f8c8d';
  }
  // 권한에 따른 메뉴 표시/숨김
  applyMenuPermissions(user);
  // 편집 불가 시 폼 비활성화
  if (!perms.canEdit && (!user.menuPermissions || Object.values(user.menuPermissions).every(v => v !== 'write'))) {
    disableEditForms();
  }
}

// ===========================
// 메뉴 권한 적용
// ===========================
function applyMenuPermissions(user) {
  if (!user) return;
  const allowed = getUserAllowedMenus(user);
  // data-menu 속성으로 메뉴 항목 제어
  document.querySelectorAll('[data-menu]').forEach(el => {
    const menu = el.getAttribute('data-menu');
    if (menu && !allowed.includes(menu)) {
      el.style.display = 'none';
    }
  });
}

// ===========================
// 편집 폼 비활성화 (viewer 역할 등)
// ===========================
function disableEditForms() {
  const forms = document.querySelectorAll('form');
  forms.forEach(form => {
    form.querySelectorAll('input, select, textarea, button[type="submit"]').forEach(el => {
      el.disabled = true;
    });
  });
  // 추가/수정/삭제 버튼 숨김
  document.querySelectorAll('.btn-add, .btn-edit, .btn-delete, #addBtn, #saveBtn').forEach(el => {
    el.style.display = 'none';
  });
}

// ===========================
// 사용자 관리 (관리자 전용)
// ===========================
function getAllUsers() {
  initUsers();
  return JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
}

function saveUser(userData) {
  const users = getAllUsers();
  const idx = users.findIndex(u => u.email.toLowerCase() === userData.email.toLowerCase());
  if (idx >= 0) {
    users[idx] = { ...users[idx], ...userData };
  } else {
    users.push(userData);
  }
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function deleteUser(email) {
  const users = getAllUsers().filter(u => u.email.toLowerCase() !== email.toLowerCase());
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function changePassword(email, oldPassword, newPassword) {
  const users = getAllUsers();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return { success: false, message: '사용자를 찾을 수 없습니다.' };
  if (user.password !== oldPassword) return { success: false, message: '현재 비밀번호가 올바르지 않습니다.' };
  user.password = newPassword;
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
  return { success: true };
}

// 초기화
initUsers();
