// MV3 service worker: 代理 niconico API 请求 (content script 受页面 CORS 限制,
// 扩展 background 凭 host_permissions 可跨域)。
// 若浏览器已登录 niconico, 自动读取 user_session cookie 附加到请求,
// 可下载需要登录的弹幕 (付费/登录限定); 未登录则匿名拉取公开弹幕。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'nico-dm:fetch') return;
  (async () => {
    const opts = msg.opts || {};
    if (msg.useSession !== false) {
      try {
        const c = await chrome.cookies.get({ url: 'https://www.nicovideo.jp/', name: 'user_session' });
        if (c && c.value) {
          opts.headers = Object.assign({}, opts.headers, { Cookie: 'user_session=' + c.value });
        }
      } catch (e) { /* 无 cookies 权限/读取失败 → 匿名 */ }
    }
    const r = await fetch(msg.url, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
    return r.json();
  })().then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: String(e && e.message || e) })
  );
  return true; // 异步响应
});
