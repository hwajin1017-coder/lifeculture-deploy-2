// =====================================================
// 라이프컬처 생산관리 앱 - PWA 공통 JS
// Service Worker 등록, 설치 배너, 오프라인 감지
// =====================================================

// ==================
// Service Worker 등록
// ==================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        console.log('[PWA] Service Worker 등록 완료:', reg.scope);
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // 새 버전 감지 시 자동으로 캐시 초기화 후 페이지 새로고침
              console.log('[PWA] 새 버전 감지 - 캐시 초기화 후 자동 새로고침');
              caches.keys().then(keys => {
                return Promise.all(keys.map(key => caches.delete(key)));
              }).then(() => {
                newWorker.postMessage({ type: 'SKIP_WAITING' });
                window.location.reload();
              });
            }
          });
        });
        // 컨트롤러 변경 시 자동 새로고침 (skipWaiting 후)
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!window._swReloading) {
            window._swReloading = true;
            window.location.reload();
          }
        });
      })
      .catch(err => console.warn('[PWA] SW 등록 실패:', err));
  });
}

// ==================
// 앱 업데이트 알림
// ==================
function showUpdateToast() {
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    background:#2C5F2E;color:#fff;padding:12px 20px;border-radius:12px;
    font-size:13px;font-weight:600;z-index:9999;display:flex;align-items:center;gap:10px;
    box-shadow:0 4px 20px rgba(0,0,0,0.3);`;
  t.innerHTML = `<i class="fas fa-sync-alt"></i> 새 버전이 있습니다.
    <button onclick="location.reload()" style="background:#D4A017;border:none;color:#fff;
    padding:5px 12px;border-radius:6px;font-weight:700;cursor:pointer;margin-left:4px">업데이트</button>`;
  document.body.appendChild(t);
}

// ==================
// PWA 설치 배너
// ==================
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;

  // 이미 설치됐거나 배너 닫은 경우 스킵
  if (localStorage.getItem('pwa-install-dismissed')) return;

  const banner = document.getElementById('pwaInstallBanner');
  if (banner) {
    setTimeout(() => banner.classList.add('show'), 1500);
  }
});

function installPWA() {
  if (!deferredInstallPrompt) return;
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) banner.classList.remove('show');
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(choice => {
    if (choice.outcome === 'accepted') {
      console.log('[PWA] 설치 수락');
      showToast('앱이 설치되었습니다! 🎉', 'success');
    }
    deferredInstallPrompt = null;
  });
}

function dismissInstallBanner() {
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) banner.classList.remove('show');
  localStorage.setItem('pwa-install-dismissed', '1');
}

// 앱으로 실행 중인지 감지
window.addEventListener('appinstalled', () => {
  console.log('[PWA] 앱 설치 완료');
  deferredInstallPrompt = null;
});

// ==================
// 오프라인/온라인 감지
// ==================
function updateOnlineStatus() {
  const offBar = document.getElementById('offlineBar');
  const onBar = document.getElementById('onlineBar');
  if (navigator.onLine) {
    if (offBar) offBar.classList.remove('show');
    if (onBar) {
      onBar.classList.add('show');
      setTimeout(() => onBar.classList.remove('show'), 3000);
    }
  } else {
    if (offBar) offBar.classList.add('show');
    if (onBar) onBar.classList.remove('show');
  }
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// ==================
// 바텀 내비게이션
// ==================
function initBottomNav() {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.bottom-nav-item').forEach(item => {
    item.classList.remove('active');
    const href = item.getAttribute('href') || item.dataset.page;
    if (href && (href === path || (path === '' && href === 'index.html'))) {
      item.classList.add('active');
    }
  });
}

// 더보기 메뉴
function openMoreMenu() {
  document.getElementById('moreMenuOverlay')?.classList.add('show');
  document.getElementById('moreMenuSheet')?.classList.add('show');
}

function closeMoreMenu() {
  document.getElementById('moreMenuOverlay')?.classList.remove('show');
  document.getElementById('moreMenuSheet')?.classList.remove('show');
}

// ==================
// 스플래시 스크린
// ==================
function showSplash() {
  // 처음 방문 또는 앱 모드에서만
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                       window.navigator.standalone === true;
  const splashShown = sessionStorage.getItem('splash-shown');

  if (isStandalone && !splashShown) {
    const splash = document.getElementById('appSplash');
    if (splash) {
      splash.classList.add('show');
      sessionStorage.setItem('splash-shown', '1');
      setTimeout(() => {
        splash.style.opacity = '0';
        splash.style.transition = 'opacity 0.4s ease';
        setTimeout(() => splash.classList.remove('show'), 400);
      }, 2200);
    }
  }
}

// ==================
// 햅틱 피드백 (모바일)
// ==================
function haptic(type = 'light') {
  if ('vibrate' in navigator) {
    if (type === 'light') navigator.vibrate(30);
    else if (type === 'medium') navigator.vibrate(60);
    else if (type === 'success') navigator.vibrate([30, 50, 30]);
    else if (type === 'error') navigator.vibrate([100, 30, 100]);
  }
}

// ==================
// 모바일 FAB 클릭 → 폼 스크롤
// ==================
function scrollToForm() {
  const form = document.querySelector('.form-container');
  if (form) {
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // 첫번째 필수 입력 포커스
    setTimeout(() => {
      const first = form.querySelector('input:not([readonly]):not([disabled]), select');
      if (first) first.focus();
    }, 400);
  }
}

// ==================
// 함수 별칭 (하위 호환)
// ==================
function installPwa() { installPWA(); }
function dismissPwaBanner() { dismissInstallBanner(); }

// ==================
// 전체 초기화
// ==================
document.addEventListener('DOMContentLoaded', () => {
  showSplash();
  initBottomNav();
  updateOnlineStatus();
});
