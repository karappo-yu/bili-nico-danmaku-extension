// MV3 service worker: 代理 niconico API 请求 (content script 受页面 CORS 限制,
// 扩展 background 凭 host_permissions 可跨域; 无登录匿名拉取公开弹幕)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'nico-dm:fetch') return;
  const { url, opts } = msg;
  fetch(url, opts || {})
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
      return r.json();
    })
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // 异步响应
});
