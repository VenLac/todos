/* 离线可用：页面和静态资源"网络优先，失败再用缓存"。
   联网时总是拿最新版本（部署后不会卡在旧页面）；断网时仍能打开，改动由 store.js 暂存、联网后同步。
   /api/ 请求不经过缓存。 */
const CACHE = 'todos-shell-v1';
const SHELL = ['./', 'index.html', 'board.html', 'login.html', 'css/style.css', 'js/store.js', 'js/calendar.js', 'js/board.js', 'js/login.js', 'icons/icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        // 只缓存正常的页面/资源；被重定向到登录页的不缓存
        if (res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy)); // 去掉 ?d=… 免得缓存越存越多
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
  );
});
