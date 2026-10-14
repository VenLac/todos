/* 登录页：成功后回到原来要去的页面 */
(function () {
  const $ = (s) => document.querySelector(s);
  const raw = new URLSearchParams(location.search).get('next') || '';
  // 只允许跳回本站的页面，防止被拿来做跳转
  const next = /^[\w.-]+\.html(\?[\w=,&%.-]*)?$/.test(raw) ? raw : 'index.html';

  fetch('api/session').then((r) => r.json()).then((s) => {
    if (!s.auth || s.ok) location.replace(next);
  }).catch(() => {});

  $('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('#pw').value;
    if (!password) {
      $('#err').textContent = '先输入密码';
      return;
    }
    $('#go').disabled = true;
    $('#err').textContent = '';
    try {
      const r = await fetch('api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (r.ok) return location.replace(next);
      const { error } = await r.json().catch(() => ({}));
      $('#err').textContent = error || '登录失败';
      $('#pw').select();
    } catch {
      $('#err').textContent = '连不上服务器，检查一下网络';
    } finally {
      $('#go').disabled = false;
    }
  });
})();
