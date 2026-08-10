// ================================================
// 라이프컬처 생산관리 앱 - Service Worker v3.9
// 오프라인 캐싱 및 PWA 지원
// 개선: products2/logistics2 추가, 캐시 자동 초기화
// ================================================
const CACHE_NAME = 'lifeculture-mes-v3.9';

// JS/CSS 파일: 항상 네트워크 우선 (배포 후 즉시 최신 버전 반영)
const NETWORK_FIRST_PATTERNS = [
  /\.js(\?.*)?$/,
  /\.css(\?.*)?$/,
  /sw\.js$/
];

// 이미지/폰트: 캐시 우선 (변경 빈도 낮음)
const CACHE_FIRST_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|ico|webp)(\?.*)?$/,
  /\.(woff|woff2|ttf|eot)(\?.*)?$/,
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /cdnjs\.cloudflare\.com/,
  /kit\.fontawesome\.com/
];

const STATIC_ASSETS = [
  './login.html',
  './index.html',
  './user-admin.html',
  './warehouse.html',
  './raw-materials.html',
  './roasting.html',
  './grinding.html',
  './extraction.html',
  './bottle-packing.html',
  './box-packing.html',
  './traceability.html',
  './install-guide.html',
  './backup.html',
  './vendors.html',
  './materials-master.html',
  './products.html',
  './sales.html',
  './logistics.html',
  './logistics2.html',
  './products2.html',
  './css/style.css',
  './css/production.css',
  './css/traceability.css',
  './css/mobile.css',
  './js/auth.js',
  './js/common.js',
  './js/warehouse.js',
  './js/dashboard.js',
  './js/raw-materials.js',
  './js/roasting.js',
  './js/grinding.js',
  './js/extraction.js',
  './js/bottle-packing.js',
  './js/box-packing.js',
  './js/traceability.js',
  './js/pwa.js',
  './js/db.js',
  './js/vendors.js',
  './js/materials-master.js',
  './js/products.js',
  './js/sales.js',
  './js/logistics.js',
  './js/logistics2.js',
  './js/products2.js',
  './js/warehouse-mgmt.js',
  './images/icon-192-v2.png',
  './images/icon-512-v2.png'
];

// 설치: 정적 자산 캐싱
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[SW] 캐싱 중... v3.9');
      const results = await Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(new Request(url, { cache: 'reload' }))
            .catch(err => console.warn(`[SW] 캐싱 실패: ${url}`, err))
        )
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      console.log(`[SW] 캐싱 완료: ${succeeded}/${STATIC_ASSETS.length}`);
    }).then(() => {
      console.log('[SW] 설치 완료 v3.9');
      self.skipWaiting();
    })
  );
});

// 활성화: 구버전 캐시 삭제
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] 구버전 캐시 삭제:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      console.log('[SW] 활성화 완료 v3.9');
      return self.clients.claim();
    })
  );
});

// 패치 전략 결정
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const reqUrl = event.request.url;

  // Firebase/Firestore API: 항상 네트워크 (캐시 금지)
  if (url.hostname.includes('firestore') ||
      url.hostname.includes('firebase') ||
      url.hostname.includes('googleapis.com') && url.pathname.includes('/v1/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ data: [], total: 0, error: 'offline' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // JS/CSS 파일: 네트워크 우선 → 캐시 폴백 (항상 최신 버전 보장)
  if (NETWORK_FIRST_PATTERNS.some(p => p.test(reqUrl))) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response && response.status === 200 && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      }).catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        return new Response('', { status: 408, statusText: 'Offline' });
      })
    );
    return;
  }

  // 이미지/폰트/외부 CDN: 캐시 우선 → 네트워크 폴백
  if (CACHE_FIRST_PATTERNS.some(p => p.test(reqUrl)) || url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return response;
        }).catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  // HTML 문서 및 기타: 네트워크 우선 → 캐시 폴백
  event.respondWith(
    fetch(event.request).then(response => {
      if (response && response.status === 200 && event.request.method === 'GET') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.destination === 'document') {
        return caches.match('./login.html') || caches.match('./index.html');
      }
      return new Response('', { status: 408, statusText: 'Request timeout' });
    })
  );
});

// 푸시 알림
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const options = {
    body: data.body || '새로운 알림이 있습니다.',
    icon: './images/icon-512-v2.png',
    badge: './images/icon-192-v2.png',
    vibrate: [100, 50, 100],
    data: { url: data.url || './index.html' },
    actions: [
      { action: 'open', title: '열기' },
      { action: 'dismiss', title: '닫기' }
    ]
  };
  event.waitUntil(
    self.registration.showNotification(data.title || '라이프컬처', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const targetUrl = event.notification.data?.url || './index.html';
      for (const client of clientList) {
        if (client.url.includes(targetUrl.replace('./', '')) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// 백그라운드 동기화 (미래 확장용)
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-production-data') {
    console.log('[SW] 백그라운드 동기화:', event.tag);
  }
});
