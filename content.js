(() => {
  'use strict';

  /* ============================================================
   * NicoDanmaku for Bilibili — content script
   * 引擎: niconicomments fork (CSSRenderer), 复用 IINA 插件同款
   * 职责: 找到 B 站播放器 → 挂 overlay host → 文件载入 → rAF 同步
   * ============================================================ */

  // ---------- 状态 ----------
  let video = null;          // 当前绑定的 <video>
  let host = null;           // overlay 挂载点 (video 的父元素内)
  let canvas = null;         // 引擎渲染用的 canvas (canvas 模式, 直接可见)
  let engine = null;         // NiconiComments 实例
  let data = null;           // 已载入的弹幕数据
  let format = 'v1';         // v1 | legacy | formatted
  let rafId = 0;
  let lastVpos = -1;
  let resolveTimer = null;
  let currentFile = null;
  let loadedVideoId = null;  // 载入弹幕时的视频身份, 换视频后清除弹幕

  const settings = {
    offset: 0,       // 秒
    scale: 1.0,
    opacity: 0.85,
    dmVisible: true, // 显示 N 站弹幕 (关 = 临时隐藏, 不影响关联)
    autoMap: true,   // 自动下载 bvid↔sm 映射表中该视频对应的 nico 弹幕
    panelX: null,
    panelY: null,
  };
  const STORAGE_KEY = 'nicoDmSettings';
  const DANMAKU_KEY = 'nicoDmFiles'; // 弹幕文件记录: { [videoId]: { name, text?, offset, ts, source } }
  const NICOCACHE_KEY = 'nicoDmNicoCache'; // niconico 精选弹幕缓存: { [smId]: { title, text, ts } }
  const REMOTE_MAP_CACHE_KEY = 'nicoDmRemoteMap'; // 远程映射表缓存: { data, ts }
  const REMOTE_MAP_URLS = [
    'https://raw.githubusercontent.com/karappo-yu/bili-nico-danmaku-extension/main/mappings.json',
    'https://cdn.jsdelivr.net/gh/karappo-yu/bili-nico-danmaku-extension@main/mappings.json', // 国内可达备用
  ];
  const REMOTE_MAP_TTL = 10 * 60 * 1000; // 映射表缓存 10 分钟 (改表后快速生效)
  // source: 'handle' = 本地文件句柄 (IDB, 直接读盘, 不占 storage); 'content' = 文件内容 (storage, fallback)

  // ---------- IndexedDB: 本地文件句柄持久化 ----------
  // FileSystemFileHandle 存这里 (chrome.storage 存不了), 下次直接打开文件不用再选
  const IDB_NAME = 'nicoDm', IDB_STORE = 'handles';
  function idbOpen() {
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open(IDB_NAME, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  }
  function idbPut(key, val) {
    return idbOpen().then(db => new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    }));
  }
  function idbGet(key) {
    return idbOpen().then(db => new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const q = tx.objectStore(IDB_STORE).get(key);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => rej(q.error);
    }));
  }
  function idbDelete(key) {
    return idbOpen().then(db => new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    }));
  }

  // ---------- 工具: 数据格式探测 (同 IINA overlay/main.js) ----------
  function detectNicoFormat(arr) {
    if (Array.isArray(arr) && arr.length > 0) {
      if (arr[0].comments !== undefined && Array.isArray(arr[0].comments)) {
        const c0 = arr[0].comments[0];
        if (c0 && c0.vposMs !== undefined) return 'v1';       // nico 官方 v1 API
        if (c0 && c0.$ !== undefined) return 'xml2js';        // xml2js 风格
        return 'v1';
      }
      if (arr[0].chat !== undefined) return 'legacy';         // 老 niconicomments 格式
      if (arr[0].vpos !== undefined && arr[0].content !== undefined) return 'formatted'; // niconicome/手写
    }
    if (arr && typeof arr === 'object' && arr.packet !== undefined) return 'xml2js';
    return 'legacy';
  }

  function detectRawDanmakuType(rawStr) {
    const s = rawStr ? rawStr.trim() : '';
    if (!s) return 'bilibili-xml';
    if (s.charAt(0) === '[' || s.charAt(0) === '{') return 'nico-json';
    if (s.indexOf('<packet') !== -1) return 'nico-xml';
    return 'bilibili-xml';
  }

  function toNumericUserId(userId, userMap) {
    const numeric = Number(userId);
    if (!isNaN(numeric) && isFinite(numeric)) return numeric;
    const key = String(userId || '');
    if (userMap[key] === undefined) {
      userMap._nextId = (userMap._nextId || 0) + 1;
      userMap[key] = userMap._nextId;
    }
    return userMap[key];
  }

  function buildFormattedCanvasData(list, sourceType) {
    const userMap = {};
    const result = [];
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      result.push({
        id: i,
        no: d._no || 0,
        vpos: Math.round(d.t || 0),
        content: d.text || '',
        date: d._dateSec || 0,
        date_usec: 0,
        owner: sourceType !== 'bilibili-xml' && !!d._isOwner,
        premium: true,
        mail: Array.isArray(d._commands) ? d._commands : [],
        user_id: toNumericUserId(d._userId, userMap),
        layer: d._layer === undefined ? -1 : d._layer,
        is_my_post: false,
      });
    }
    return result;
  }

  // ---------- 播放器解析 ----------
  function isPlayerPage() {
    return /\/video\/|\/bangumi\/play\/|\/list\//.test(location.pathname);
  }

  // 视频身份: pathname (含BV/ep) + bvid/ep/p 查询参数
  // 分P (?p=2)、番剧集数 (ep)、合集视频 (bvid) 切换都会导致身份变化
  function currentVideoId() {
    const q = location.search;
    const bvid = q.match(/[?&]bvid=([^&]+)/);
    const ep = q.match(/[?&]ep=(\d+)/);
    const p = q.match(/[?&]p=(\d+)/);
    // 尾斜杠规范化: B 站导航会在 /video/BV1xx/ 与 /video/BV1xx 之间变化
    const path = location.pathname.replace(/\/+$/, '');
    // bvid 参数仅在 pathname 不含视频标识时拼接 (合集/列表页需要它区分不同视频);
    // 普通视频/番剧的 BV/ep 已在 pathname 里, 忽略 bvid 参数避免 key 随 URL 形态抖动
    const needBvid = !/\/BV|EP\d+/i.test(path);
    return path
      + (needBvid && bvid ? '|' + bvid[1] : '')
      + (ep ? '|ep' + ep[1] : '')
      + (p ? '|p' + p[1] : '');
  }

  function findVideo() {
    const root = document.querySelector('#bilibili-player') ||
                 document.querySelector('.bpx-player-container');
    if (root) {
      const v = root.querySelector('video');
      if (v) return v;
    }
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < 200 || r.height < 120) continue;
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
  }

  // ---------- overlay host ----------
  function mountHost(v) {
    const parent = v.parentElement;
    if (!parent) return;
    if (host) host.remove();
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    host = document.createElement('div');
    host.id = 'nico-dm-host';
    host.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:100;';
    parent.appendChild(host);
  }

  function unmountHost() {
    if (host) { host.remove(); host = null; }
    canvas = null;
  }

  function vposOf(v) {
    return (dmTime + settings.offset) * 100;
  }

  // ---------- 引擎生命周期 ----------
  function initEngine() {
    destroyEngine();
    if (!data || !host) return;
    canvas = document.createElement('canvas');
    canvas.id = 'nico-dm-canvas';
    canvas.width = 1920;
    canvas.height = 1080;
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    canvas.style.opacity = String(settings.opacity);
    host.appendChild(canvas);

    engine = new NiconiComments(canvas, data, {
      format: format,
      mode: 'default', // 上游原生 canvas 渲染 (上游 v0.3.1 未启用 css 模式)
      keepCA: true,
      scale: settings.scale,
      config: {
        contextStrokeColor: '#000000',
        contextStrokeInversionColor: '#ffffff',
        contextStrokeOpacity: 0.4,
        contextLineWidth: { html5: 2.8, flash: 2.8 },
        nakaCommentSpeedOffset: 0.95,
      },
    });
    bindEngineEvents(engine);

    lastVpos = -1;
    if (video) engine.drawCanvas(vposOf(), true);
    applyDmVisible(); // 按开关状态显示/隐藏 overlay (关 = 载入但暂不显示)
    setStatus('已载入 ' + countComments(data) + ' 条', true);
  }

  function destroyEngine() {
    if (engine) {
      try { engine.clear(); engine.destroy(); } catch (e) {}
      engine = null;
    }
    if (canvas) { canvas.remove(); canvas = null; }
  }

  function bindEngineEvents(inst) {
    inst.addEventListener('seekDisable', () => {});
    inst.addEventListener('seekEnable', () => {});
    inst.addEventListener('jump', (e) => {
      console.log('[nico-dm] CA jump ignored:', e && e.message, e && e.to);
    });
  }

  // ---------- 同步循环 (nico-comment-dl 式: rAF dt 累积时钟) ----------
  // 播放/seek/恢复时对锚到 video.currentTime, 中间自由运行,
  // 不做逐媒体帧校正 (媒体时钟本身有抖动, 校正反而造成微跳)
  let dmTime = 0;            // 弹幕时钟 (秒)
  let lastFrameTime = null;  // 上一帧 rAF 时间戳
  let stalled = false;

  function resyncDmTime() {
    if (!video) return;
    dmTime = video.currentTime;
    lastFrameTime = null; // 防 dt 跳变
    lastVpos = -1;        // 触发重绘
  }

  // 显示开关: 关 = 临时隐藏 overlay (关联保留), 开 = 立即恢复渲染
  function applyDmVisible() {
    if (host) host.style.display = settings.dmVisible ? '' : 'none';
    if (settings.dmVisible) {
      if (video) resyncDmTime(); // 兜底: 关闭期间时间轴可能漂移, 打开时重新锚定
      lastVpos = -1;
      if (engine && video) engine.drawCanvas(vposOf(), true);
    }
  }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (!engine || !video || !data) return;
    if (lastFrameTime === null) { lastFrameTime = now; return; }
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    if (!video.paused && !stalled) dmTime += dt * (video.playbackRate || 1);
    if (!settings.dmVisible) return; // 弹幕显示关闭: 时钟照走, 只不渲染 (打开时不错位)
    const vpos = vposOf();
    const isSeek = Math.abs(vpos - lastVpos) > 150;
    if (video.paused) {
      // 暂停: 保留最后一帧, 只在 seek 时重绘
      if (isSeek) { engine.drawCanvas(vpos, true); lastVpos = vpos; }
      return;
    }
    if (isSeek) engine.clear();
    engine.drawCanvas(vpos, isSeek);
    lastVpos = vpos;
  }

  // ---------- 文件载入 ----------
  function countComments(d) {
    if (!Array.isArray(d)) return 0;
    if (d[0] && Array.isArray(d[0].comments)) return d.reduce((n, t) => n + (t.comments ? t.comments.length : 0), 0); // v1 多 fork
    return d.length;
  }

  // 选择弹幕文件: 优先 File System Access API (拿文件句柄, 下次直接打开该文件), 否则 input[type=file]
  async function pickFile() {
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: '弹幕文件', accept: { 'application/json': ['.json'], 'text/xml': ['.xml'] } }],
          multiple: false
        });
        const file = await handle.getFile();
        await loadFile(file, handle);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 用户取消
        // 其他错误 → 回退 input
      }
    }
    fileInput.click();
  }

  let currentHandle = null; // 当前弹幕的本地文件句柄 (File System Access API)

  // 解析弹幕文本 → 引擎数据 (loadFile 与切集预加载共用)
  async function parseDanmakuText(text) {
    const type = detectRawDanmakuType(text);
    let loaded;
    if (type === 'nico-json') {
      loaded = JSON.parse(text);
      format = detectNicoFormat(loaded);
    } else {
      const list = window.parseDanmaku(text, true);
      format = 'formatted';
      loaded = buildFormattedCanvasData(list, type);
    }
    if (!Array.isArray(loaded) || loaded.length === 0) throw new Error('弹幕数据为空');
    return loaded;
  }

  // 同步 sm 输入框: 载入 nico 精选弹幕 (sm*.curated.json) 填视频号, 否则清空
  // (防止切到无关联的 P / 载入普通文件后残留上一个视频的视频号)
  function syncSmInput(name) {
    const smInput = document.getElementById('ndp-sm');
    if (!smInput) return;
    const smM = String(name || '').match(/^(sm\d+|so\d+|nm\d+)\.curated\.json$/i);
    smInput.value = smM ? smM[1].toLowerCase() : '';
    updateFetchBtn(); // 输入框变化 → 按钮「下载/重新下载」同步
  }

  async function loadFile(file, handle) {
    try {
      const text = await file.text();
      const loaded = await parseDanmakuText(text);
      data = loaded;
      currentFile = file.name;
      currentHandle = handle || null;
      loadedVideoId = currentVideoId();
      if (fileNameEl) fileNameEl.textContent = file.name;
      syncSmInput(file.name);
      // info 行按来源区分: 本地文件 → 显示文件名; nico 弹幕 (sm*.curated.json) → 由调用方显示映射/下载信息
      if (!/^(sm|so|nm)\d+\.curated\.json$/i.test(file.name)) {
        const info = document.getElementById('ndp-sm-info');
        if (info) { info.textContent = '本地文件: ' + file.name; info.className = 'ndp-nico-info'; }
      }
      await saveDanmakuRecord(loadedVideoId, file.name, text, currentHandle); // 记住关联, 刷新后自动加载
      resyncDmTime();
      if (host) initEngine();
      else if (video) { mountHost(video); initEngine(); }
      setStatus(file.name + ' · ' + countComments(data) + ' 条', true);
    } catch (e) {
      data = null;
      destroyEngine();
      setStatus('载入失败: ' + e.message, false);
    }
  }

  function clearDanmaku() {
    destroyEngine();
    data = null;
    currentFile = null;
    currentHandle = null;
    loadedVideoId = null;
    fileInput.value = '';
    fileNameEl.textContent = '未选择文件';
    syncSmInput(''); // 清除/切到无关联视频 → 输入框清空, 防残留上个视频的视频号
    setStatus('');
    // 同时清空 nico 区 info 行 (自动映射标题对/下载状态), 防残留上个视频的信息
    const nicoInfo = document.getElementById('ndp-sm-info');
    if (nicoInfo) { nicoInfo.textContent = ''; nicoInfo.className = 'ndp-nico-info'; }
    // 注意: 不删关联记录! 切集自动清除时 URL 已是新视频,
    // 若在这里删记录会误删新视频的关联 (死逻辑)。删除只发生在手动清除。
  }

  // 手动清除 = 清弹幕 + 解除当前视频的关联 (记录 + 句柄)
  function clearDanmakuAndRecord() {
    const vid = currentVideoId();
    clearDanmaku();
    removeDanmakuRecord();
    if (vid) idbDelete(vid).catch(() => {});
  }

  // 兼容旧数据: 早期版本存过带尾斜杠 / 带 bvid 参数段的 key
  // (/video/BV1xx/|p2 vs /video/BV1xx|p2; /video/BV1xx|bvidBV1xx|p2)
  function normVidKey(k) {
    const i = typeof k === 'string' ? k.indexOf('|') : -1;
    const path = (i === -1 ? String(k) : k.slice(0, i)).replace(/\/+$/, '');
    return path + (i === -1 ? '' : k.slice(i));
  }
  // 宽松归一: 尾斜杠 + 仅当 pathname 含视频标识 (BV/ep) 时剥离 bvid 参数段
  // (旧数据在 /video/BV1xx/ 页面带冗余 bvid 段 /video/BV1xx|bvidBV1xx|p2);
  // pathname 无 BV 的页面 (测试台/合集), bvid 参数是必要区分, 不能剥!
  function looseNorm(k) {
    const s = normVidKey(k);
    const i = s.indexOf('|');
    const path = i === -1 ? s : s.slice(0, i);
    if (/\/(BV|ep)/i.test(path)) {
      return s.replace(/\|bv[^|]*/i, '');
    }
    return s;
  }
  function lookupRecord(all, vid) {
    if (!all) return null;
    if (all[vid]) return all[vid];
    const vn = looseNorm(vid);
    for (const k in all) {
      if (normVidKey(k) === vid || looseNorm(k) === vn) return all[k]; // 旧数据兼容
    }
    return null;
  }
  function matchingKeys(all, vid) {
    const keys = [vid];
    const vn = looseNorm(vid);
    for (const k in all) {
      if (k !== vid && (normVidKey(k) === vid || looseNorm(k) === vn)) keys.push(k);
    }
    return keys;
  }

  // ---------- niconico 精选弹幕下载 (经 background 代理, 匿名) ----------
  function fetchViaBg(url, opts) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'nico-dm:fetch', url, opts }, (res) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (!res || !res.ok) { reject(new Error((res && res.error) || '请求失败')); return; }
          resolve(res.data);
        });
      } catch (e) { reject(e); }
    });
  }

  function parseSmInput(input) {
    const m = String(input || '').trim().match(/(?:nicovideo\.jp\/watch\/)?(sm\d+|so\d+|nm\d+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  // watch 页 json: 拿 nvComment (server/threadKey/targets) + 标题
  async function fetchNicoWatch(smId) {
    const data = await fetchViaBg('https://www.nicovideo.jp/watch/' + smId + '?responseType=json', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'X-Frontend-Id': '6', 'X-Frontend-Version': '0' },
    });
    const resp = data && data.data && data.data.response;
    const nv = resp && resp.comment && resp.comment.nvComment;
    if (!nv || !nv.server || !nv.threadKey) throw new Error('无法获取视频信息 (可能不存在或需登录)');
    const title = (resp.video && resp.video.title) || smId;
    return { nv, title };
  }

  // 精选 (curated): 不带 additionals, 每个 fork 拉最近一轮, 与网页端一致
  async function fetchCuratedThreads(nv) {
    const { server, threadKey, params } = nv;
    const threads = [];
    for (const t of params.targets) {
      const res = await fetchViaBg(server + '/v1/threads', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'User-Agent': 'Mozilla/5.0',
          'X-Frontend-Id': '6',
          'X-Frontend-Version': '0',
        },
        body: JSON.stringify({ threadKey, params: { language: params.language, targets: [t] } }),
      });
      const comments = (res.data && res.data.threads && res.data.threads[0] && res.data.threads[0].comments) || [];
      threads.push({ id: t.id, fork: t.fork, comments }); // v1 格式: fork 对象需 id/fork/comments
    }
    return threads;
  }

  function countThreadComments(threads) {
    return (threads || []).reduce((n, t) => n + (t.comments ? t.comments.length : 0), 0);
  }

  // 缓存: smId → {title, text(v1 JSON), ts}
  function readNicoCache(smId) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(NICOCACHE_KEY, (res) => {
          const all = (res && res[NICOCACHE_KEY]) || {};
          resolve(all[smId] || null);
        });
      } catch (e) { resolve(null); }
    });
  }
  function writeNicoCache(smId, rec) {
    try {
      chrome.storage.local.get(NICOCACHE_KEY, (res) => {
        const all = (res && res[NICOCACHE_KEY]) || {};
        all[smId] = rec;
        chrome.storage.local.set({ [NICOCACHE_KEY]: all });
      });
    } catch (e) {}
  }

  // 加载弹幕 (走 loadFile: 自动识别格式 + 关联当前 bvid + 记忆偏移)
  async function loadNicoComments(smId, title, threads, fromCache) {
    const text = JSON.stringify(threads);
    await loadFile(new File([text], smId + '.curated.json', { type: 'application/json' }));
    const total = countThreadComments(threads);
    // 不自动记录本地映射 (人工维护远程映射表)
    const info = document.getElementById('ndp-sm-info');
    if (info) {
      info.textContent = (fromCache ? '缓存' : '已下载') + ' · ' + title + ' · 精选 ' + total + ' 条';
      info.className = 'ndp-nico-info ndp-ok';
    }
  }

  // quiet=true: 失败灰色提示 (映射自动下载不打扰), 否则红字
  async function downloadNico(smId, force, quiet) {
    const info = document.getElementById('ndp-sm-info');
    const setInfo = (msg, cls) => { if (info) { info.textContent = msg; info.className = 'ndp-nico-info' + (cls ? ' ' + cls : ''); } };
    if (!smId) { setInfo('请输入 sm 号或视频 URL', 'ndp-err'); return; }
    try {
      setInfo('正在获取 ' + smId + ' ...', '');
      if (!force) {
        const cached = await readNicoCache(smId);
        if (cached && cached.text) {
          await loadNicoComments(smId, cached.title || smId, JSON.parse(cached.text), true);
          return;
        }
      }
      const { nv, title } = await fetchNicoWatch(smId);
      const threads = await fetchCuratedThreads(nv);
      const total = countThreadComments(threads);
      if (total === 0) throw new Error('该视频没有可用的公开弹幕');
      writeNicoCache(smId, { title, text: JSON.stringify(threads), ts: Date.now() });
      await loadNicoComments(smId, title, threads, false);
    } catch (e) {
      setInfo('失败: ' + (e && e.message || e), quiet ? '' : 'ndp-err');
    }
  }

  // ---------- 映射表 (远程共享, 人工维护) ----------
  // 当前 B 站视频的映射 key: 番剧 ep/ss 号 / 普通视频 BV(+分P) / query bvid
  function getMappingKey() {
    const path = location.pathname;
    const ep = path.match(/\/bangumi\/play\/ep(\d+)/);
    if (ep) return 'ep' + ep[1];
    const ss = path.match(/\/bangumi\/play\/ss(\d+)/); // 番剧合集首页 (URL 保持 ss 不跳转)
    if (ss) return 'ss' + ss[1];
    const p = location.search.match(/[?&]p=(\d+)/);
    const bv = path.match(/\/(BV[0-9A-Za-z]{10})\/?/);
    if (bv) return bv[1] + (p ? '|p' + p[1] : '');
    const q = location.search.match(/[?&]bvid=(BV[0-9A-Za-z]{10})/);
    if (q) return q[1] + (p ? '|p' + p[1] : '');
    return null;
  }

  // 映射表: 内置表(随扩展版本, 可信基线) + 远程增量合并, 10 分钟缓存
  async function refreshRemoteMap(force) {
    try {
      if (!force) {
        const cache = await new Promise((res) => {
          chrome.storage.local.get(REMOTE_MAP_CACHE_KEY, (r) => res((r && r[REMOTE_MAP_CACHE_KEY]) || null));
        });
        if (cache && cache.data && Date.now() - (cache.ts || 0) < REMOTE_MAP_TTL) return cache.data;
      }
      // 1. 内置表: 扩展自带 mappings.json, 随版本更新, 零网络 (可信基线)
      let builtin = null;
      try {
        const b = await fetchViaBg(chrome.runtime.getURL('mappings.json'));
        if (b && typeof b === 'object') builtin = b;
      } catch (e) {}
      // 2. 远程增量 (raw → jsDelivr), 可能滞后/被墙, 仅作补充
      let remote = null;
      for (const url of REMOTE_MAP_URLS) {
        try {
          const d = await fetchViaBg(url);
          if (d && typeof d === 'object') { remote = d; break; }
        } catch (e) { /* 换下一个源 */ }
      }
      // 3. 合并: 内置优先 (同 key 覆盖远程旧表), 远程独有新条目保留
      //    (防止 jsDelivr 缓存滞后返回旧表时把新内置表冲掉)
      let data = null;
      if (remote && typeof remote === 'object') data = Object.assign({}, remote);
      if (builtin && typeof builtin === 'object') data = Object.assign({}, data, builtin);
      if (data && typeof data === 'object') {
        chrome.storage.local.set({ [REMOTE_MAP_CACHE_KEY]: { data, ts: Date.now() } });
        return data;
      }
      return null;
    } catch (e) { return null; }
  }

  // 查表: 远程共享表 (人工维护), 命中 → 自动下载
  // 表结构: { shows: { 番名: { biliSeason, nicoSeries, eps: { key: {sm,bTitle,nTitle} } } }, videos: { key: {...} } }
  async function lookupMapping(mapKey) {
    if (!mapKey) return null;
    const table = await refreshRemoteMap(false);
    if (!table) return null;
    const shows = (table.shows && typeof table.shows === 'object') ? table.shows : {};
    for (const name in shows) {
      const eps = shows[name] && shows[name].eps;
      if (eps && eps[mapKey]) return eps[mapKey];
    }
    const videos = (table.videos && typeof table.videos === 'object') ? table.videos : {};
    if (videos[mapKey]) return videos[mapKey];
    return null;
  }

  // 映射命中 → 自动下载 (静默失败), 成功后显示标题对供用户核对
  async function autoDownloadFromMapping(m, targetVid) {
    if (targetVid && currentVideoId() !== targetVid) return; // 已切走
    try {
      await downloadNico(m.sm, false, true); // quiet: 失败不弹红字
    } catch (e) { return; }
    if (targetVid && currentVideoId() !== targetVid) return;
    const info = document.getElementById('ndp-sm-info');
    if (info) {
      info.textContent = '自动映射: 《' + (m.nTitle || m.sm) + '》';
      info.className = 'ndp-nico-info ndp-ok';
    }
  }

  // 缓存中是否已有该 sm 号 (决定按钮显示「下载」还是「重新下载」)
  function nicoCacheHas(smId) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(NICOCACHE_KEY, (res) => {
          const all = (res && res[NICOCACHE_KEY]) || {};
          resolve(!!(all[smId] && all[smId].text));
        });
      } catch (e) { resolve(false); }
    });
  }

  // 下载/刷新合并为一个动态按钮: 已下载过 → 「重新下载」, 新的 → 「下载精选弹幕」
  async function updateFetchBtn() {
    const input = document.getElementById('ndp-sm');
    const btn = document.getElementById('ndp-sm-fetch');
    if (!input || !btn) return;
    const smId = parseSmInput(input.value);
    if (!smId) { btn.textContent = '下载精选弹幕'; return; }
    btn.textContent = (await nicoCacheHas(smId)) ? '重新下载' : '下载精选弹幕';
  }

  // ---------- 弹幕文件关联记忆 ----------
  // 选择文件时记住视频号 + 偏移; 刷新后自动加载
  // handle 模式: 本地文件句柄存 IDB (直接读盘, 不占 storage); content 模式: 文件内容存 storage (fallback)
  async function saveDanmakuRecord(vid, name, text, handle) {
    if (!vid) return;
    try {
      let handleOk = false;
      if (handle) {
        try { await idbPut(vid, handle); handleOk = true; } catch (e) { handleOk = false; }
      }
      // 双保险: handle 记录也存 text — 句柄权限失效/文件移动时仍能从内容恢复
      // (unlimitedStorage 后空间无虞, 句柄读取失败才用 text)
      chrome.storage.local.get(DANMAKU_KEY, (res) => {
        const all = (res && res[DANMAKU_KEY]) || {};
        all[vid] = { name, text, offset: settings.offset, ts: Date.now(), source: handleOk ? 'handle' : 'content' };
        // 清理同视频的旧 key (尾斜杠/bvid 参数变体), 数据迁移归一
        for (const k in all) {
          if (k !== vid && (normVidKey(k) === vid || looseNorm(k) === looseNorm(vid))) delete all[k];
        }
        chrome.storage.local.set({ [DANMAKU_KEY]: all });
      });
      if (!handleOk) idbDelete(vid).catch(() => {});
    } catch (e) {}
  }

  function updateDanmakuOffset() {
    const vid = currentVideoId();
    if (!vid) return;
    try {
      chrome.storage.local.get(DANMAKU_KEY, (res) => {
        const all = (res && res[DANMAKU_KEY]) || {};
        let changed = false;
        for (const k of matchingKeys(all, vid)) {
          all[k].offset = settings.offset;
          changed = true;
        }
        if (changed) chrome.storage.local.set({ [DANMAKU_KEY]: all });
      });
    } catch (e) {}
  }

  function removeDanmakuRecord() {
    const vid = currentVideoId();
    if (!vid) return;
    try {
      chrome.storage.local.get(DANMAKU_KEY, (res) => {
        const all = (res && res[DANMAKU_KEY]) || {};
        let changed = false;
        for (const k of matchingKeys(all, vid)) {
          delete all[k];
          changed = true;
        }
        if (changed) chrome.storage.local.set({ [DANMAKU_KEY]: all });
      });
    } catch (e) {}
  }

  // 从 storage 恢复该视频的偏移量并同步滑块
  function applyStoredOffset(vid) {
    try {
      chrome.storage.local.get(DANMAKU_KEY, (res) => {
        const rec = lookupRecord(res && res[DANMAKU_KEY], vid);
        settings.offset = Number(rec && rec.offset) || 0;
        saveSettings();
        if (offsetEl) {
          offsetEl.value = String(settings.offset);
          offsetValEl.textContent = (settings.offset > 0 ? '+' : '') + settings.offset.toFixed(1) + 's';
        }
      });
    } catch (e) {}
  }

  // 刷新/切集后自动加载: 本地文件句柄 (IDB) 优先, 其次 storage 内容记录
  let autoLoading = false;
  let autoLoadingTimer = null;
  function maybeAutoLoad() {
    if (data || autoLoading) return;
    const vid = currentVideoId();
    if (!vid) return;
    autoLoading = true;
    // 超时保护: 任何异步挂起 (IDB/权限/文件读取) 都不允许永久卡死 autoLoading
    autoLoadingTimer = setTimeout(() => { autoLoading = false; }, 5000);
    const settle = () => { clearTimeout(autoLoadingTimer); autoLoading = false; };
    const fromContent = () => {
      try {
        chrome.storage.local.get(DANMAKU_KEY, (res) => {
          const rec = lookupRecord(res && res[DANMAKU_KEY], vid);
          if (!rec || !rec.text) {
            settle();
            const notifyNotFound = () => {
              // 延迟确认: B 站切 P 时 URL 可能还在渐进变化 (临时参数), 先别报未找到;
              // 期间已加载 (data) 或已切到别处 (URL 变) 就不报
              setTimeout(() => {
                if (data || currentVideoId() !== vid) return;
                setStatus('未找到该视频的关联弹幕, 请选择文件', 'err');
              }, 2000);
            };
            // 无本地关联 → 查映射表 (开关开时自动下载)
            if (!settings.autoMap) { notifyNotFound(); return; }
            const mapKey = getMappingKey();
            if (!mapKey) { notifyNotFound(); return; }
            try {
              lookupMapping(mapKey).then((m) => {
                if (!m) { notifyNotFound(); return; }
                if (data || currentVideoId() !== vid) return; // 已加载/切走
                autoDownloadFromMapping(m, vid);
              }).catch(notifyNotFound);
            } catch (e) { notifyNotFound(); }
            return;
          }
          settle();
          applyStoredOffset(vid);
          loadFile(new File([rec.text], rec.name || 'auto-danmaku.json', { type: 'application/json' }));
        });
      } catch (e) { settle(); }
    };
    try {
      idbGet(vid).then(async (handle) => {
        if (!handle) { fromContent(); return; }
        try {
          const st = await handle.requestPermission({ mode: 'read' });
          if (st !== 'granted') { fromContent(); return; }
          const f = await handle.getFile();
          settle();
          applyStoredOffset(vid);
          loadFile(f, handle); // 直接从磁盘读最新内容
        } catch (e) { fromContent(); }
      }).catch(fromContent);
    } catch (e) { settle(); }
  }

  // 切集预加载: 检测到视频身份变化后, 先异步查记录+解析新弹幕,
  // ready 后在同一时刻直接替换 (不清空状态/不留空白间隙),
  // 状态行从旧绿字直接变新绿字; 新视频无关联时才清弹幕
  let switching = false;
  function handleVideoSwitch() {
    if (!(data && loadedVideoId !== null && currentVideoId() !== loadedVideoId) || switching) return;
    const newVid = currentVideoId();
    switching = true;
    try {
      chrome.storage.local.get(DANMAKU_KEY, (res) => {
        const rec = lookupRecord(res && res[DANMAKU_KEY], newVid);
        if (!rec || !rec.text) {
          // 新视频无关联 → 清旧弹幕; 查 bvid↔sm 映射表 (开关开时自动下载)
          switching = false;
          clearDanmaku();
          const notifyNotFound = () => {
            setTimeout(() => {
              if (data || currentVideoId() !== newVid) return;
              setStatus('未找到该视频的关联弹幕, 请选择文件', 'err');
            }, 2000);
          };
          if (settings.autoMap) {
            const mapKey = getMappingKey();
            if (mapKey) {
              lookupMapping(mapKey).then((m) => {
                if (!m) { notifyNotFound(); return; }
                if (data || currentVideoId() !== newVid) return;
                autoDownloadFromMapping(m, newVid);
              }).catch(notifyNotFound);
              return;
            }
          }
          notifyNotFound();
          return;
        }
        parseDanmakuText(rec.text).then((loaded) => {
          if (currentVideoId() !== newVid || loadedVideoId === null) { switching = false; return; } // 又切走或被手动清除
          // 一次性替换: 旧弹幕引擎销毁 + 新数据就位 (同一时刻)
          destroyEngine();
          data = loaded;
          currentFile = rec.name;
          currentHandle = null;
          loadedVideoId = newVid;
          if (fileNameEl) fileNameEl.textContent = rec.name;
          syncSmInput(rec.name); // 切集后输入框跟随更新 (刷新缓存可用)
          applyStoredOffset(newVid);
          resyncDmTime();
          if (host) initEngine();
          else if (video) { mountHost(video); initEngine(); }
          setStatus(rec.name + ' · ' + countComments(data) + ' 条', true);
          switching = false;
          // info 行同步: 若是 nico 弹幕 (sm*.curated.json), 查映射表显示新集的标题对; 否则清空
          const info = document.getElementById('ndp-sm-info');
          if (/^(sm|so|nm)\d+\.curated\.json$/i.test(rec.name || '')) {
            const mapKey = getMappingKey();
            if (mapKey) {
              lookupMapping(mapKey).then((m) => {
                const el = document.getElementById('ndp-sm-info');
                if (!el) return;
                if (m) { el.textContent = '自动映射: 《' + (m.nTitle || m.sm) + '》'; el.className = 'ndp-nico-info ndp-ok'; }
                else { el.textContent = ''; el.className = 'ndp-nico-info'; }
              }).catch(() => {});
            }
          } else if (info) { info.textContent = '本地文件: ' + (rec.name || ''); info.className = 'ndp-nico-info'; }
        }).catch((e) => {
          switching = false;
          clearDanmaku();
          setStatus('载入失败: ' + e.message, false);
        });
      });
    } catch (e) { switching = false; clearDanmaku(); }
  }

  // ---------- 设置持久化 ----------
  function saveSettings() {
    try { chrome.storage.local.set({ [STORAGE_KEY]: settings }); } catch (e) {}
  }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (res) => {
          const s = res && res[STORAGE_KEY];
          if (s) {
            Object.assign(settings, s);
            // 钳制旧设置 (字号 0.5-1.0, 透明度 0.1-1)
            settings.scale = Math.min(Math.max(settings.scale, 0.5), 1.0);
            settings.opacity = Math.min(Math.max(settings.opacity, 0.1), 1);
          }
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  // ---------- UI ----------
  let panel, fileInput, fileNameEl, statusEl;
  let offsetEl, offsetValEl, scaleEl, scaleValEl, opacityEl, opacityValEl, visibleEl;

  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'nico-dm-panel';
    panel.style.display = 'none'; // 默认隐藏, 由播放器控制条按钮唤出
    panel.innerHTML = `
      <div class="ndp-head">
        <span class="ndp-title">Nico 弹幕</span>
        <button class="ndp-collapse" title="收起/展开">—</button>
      </div>
      <div class="ndp-body">
        <div class="ndp-file">
          <button class="ndp-file-btn" id="ndp-pick">📂 选择弹幕文件</button>
          <span class="ndp-file-name" id="ndp-file-name">未选择</span>
        </div>
        <div class="ndp-nico">
          <input id="ndp-sm" placeholder="niconico: sm9 或完整 URL" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" name="ndp-sm-random">
          <div class="ndp-nico-btns">
            <button class="ndp-btn" id="ndp-sm-fetch">下载精选弹幕</button>
          </div>
          <div class="ndp-nico-info" id="ndp-sm-info"></div>
        </div>
        <div class="ndp-row">
          <label class="ndp-label">偏移</label>
          <input type="range" id="ndp-offset" min="-120" max="120" step="0.5" value="0">
          <span class="ndp-val" id="ndp-offset-val">0.0s</span>
        </div>
        <div class="ndp-row">
          <label class="ndp-label">字号</label>
          <input type="range" id="ndp-scale" min="50" max="100" step="5" value="100">
          <span class="ndp-val" id="ndp-scale-val">1.0×</span>
        </div>
        <div class="ndp-row">
          <label class="ndp-label">透明度</label>
          <input type="range" id="ndp-opacity" min="10" max="100" step="5" value="85">
          <span class="ndp-val" id="ndp-opacity-val">0.85</span>
        </div>
        <div class="ndp-row ndp-row-split">
          <span class="ndp-toggle-item">
            <label class="ndp-label">显示弹幕</label>
            <input type="checkbox" id="ndp-visible" checked>
          </span>
          <span class="ndp-toggle-item">
            <label class="ndp-label">自动映射</label>
            <input type="checkbox" id="ndp-automap" checked title="打开有映射的视频时自动下载对应 nico 弹幕">
          </span>
        </div>
        <div class="ndp-actions">
          <button class="ndp-btn" id="ndp-clear">清除弹幕</button>
        </div>
        <div class="ndp-status" id="ndp-status"></div>
      </div>
    `;
    document.body.appendChild(panel);

    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,.xml';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    const $ = (id) => panel.querySelector(id);
    fileNameEl = $('#ndp-file-name');
    statusEl = $('#ndp-status');
    offsetEl = $('#ndp-offset');
    offsetValEl = $('#ndp-offset-val');
    scaleEl = $('#ndp-scale');
    scaleValEl = $('#ndp-scale-val');
    opacityEl = $('#ndp-opacity');
    opacityValEl = $('#ndp-opacity-val');

    $('#ndp-pick').addEventListener('click', pickFile);
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
    });

    offsetEl.addEventListener('input', () => {
      settings.offset = parseFloat(offsetEl.value);
      offsetValEl.textContent = (settings.offset > 0 ? '+' : '') + settings.offset.toFixed(1) + 's';
      lastVpos = -1;
      if (engine && video) { engine.clear(); engine.drawCanvas(vposOf(), true); }
      saveSettings();
      updateDanmakuOffset(); // 记住偏移, 刷新后恢复
    });
    scaleEl.addEventListener('input', () => {
      settings.scale = parseFloat(scaleEl.value) / 100;
      scaleValEl.textContent = settings.scale.toFixed(2) + '×';
      if (data) initEngine();
      saveSettings();
    });
    opacityEl.addEventListener('input', () => {
      settings.opacity = parseFloat(opacityEl.value) / 100;
      opacityValEl.textContent = settings.opacity.toFixed(2);
      if (canvas) canvas.style.opacity = String(settings.opacity);
      saveSettings();
    });
    $('#ndp-clear').addEventListener('click', clearDanmakuAndRecord);
    visibleEl = $('#ndp-visible');
    visibleEl.checked = settings.dmVisible;
    visibleEl.addEventListener('change', () => {
      settings.dmVisible = visibleEl.checked;
      applyDmVisible();
      saveSettings();
    });
    const autoMapEl = $('#ndp-automap');
    autoMapEl.checked = settings.autoMap;
    autoMapEl.addEventListener('change', () => {
      settings.autoMap = autoMapEl.checked;
      saveSettings();
    });
    const smInput = $('#ndp-sm');
    const smFetchBtn = $('#ndp-sm-fetch');
    let nicoBusy = false;
    const smInfo = () => document.getElementById('ndp-sm-info');
    smFetchBtn.addEventListener('click', () => {
      if (nicoBusy) return;
      const smId = parseSmInput(smInput.value);
      if (!smId) {
        const info = smInfo();
        if (info) { info.textContent = '请输入 sm 号或 niconico 视频 URL'; info.className = 'ndp-nico-info ndp-err'; }
        return;
      }
      nicoBusy = true;
      smFetchBtn.disabled = true;
      // 已下载过 → 强制重新下载 (刷新缓存); 新号 → 正常下载 (缓存命中直接用)
      nicoCacheHas(smId).then((has) => downloadNico(smId, has)).finally(() => {
        nicoBusy = false;
        smFetchBtn.disabled = false;
        updateFetchBtn();
      });
    });
    smInput.addEventListener('input', updateFetchBtn);
    smInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') smFetchBtn.click(); });
    updateFetchBtn();
    panel.querySelector('.ndp-collapse').addEventListener('click', () => {
      panel.classList.toggle('ndp-collapsed');
    });

    // 拖拽
    const head = panel.querySelector('.ndp-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ndp-collapse')) return;
      const rect = panel.getBoundingClientRect();
      const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
      const move = (ev) => {
        panel.style.left = (ev.clientX - dx) + 'px';
        panel.style.top = (ev.clientY - dy) + 'px';
        panel.style.right = 'auto';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const r = panel.getBoundingClientRect();
        settings.panelX = r.left; settings.panelY = r.top;
        saveSettings();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    });

    // 恢复设置
    offsetEl.value = String(settings.offset);
    offsetValEl.textContent = (settings.offset > 0 ? '+' : '') + settings.offset.toFixed(1) + 's';
    scaleEl.value = String(settings.scale * 100);
    scaleValEl.textContent = settings.scale.toFixed(2) + '×';
    opacityEl.value = String(settings.opacity * 100);
    opacityValEl.textContent = settings.opacity.toFixed(2);
    if (settings.panelX !== null) {
      panel.style.left = settings.panelX + 'px';
      panel.style.top = settings.panelY + 'px';
      panel.style.right = 'auto';
    }
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    // 三态: ok 绿 / err 红 / 不传或 undefined 中性灰 (兼容旧调用 true/false)
    let cls = 'ndp-status';
    if (kind === true || kind === 'ok') cls += ' ndp-ok';
    else if (kind === false || kind === 'err') cls += ' ndp-err';
    statusEl.className = cls;
  }

  // ---------- 视频事件 ----------
  function bindVideoEvents(v) {
    v.addEventListener('emptied', onEmptied);
    v.addEventListener('loadeddata', onLoadedData);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ratechange', onRateChange);
  }

  function unbindVideoEvents(v) {
    if (!v) return;
    v.removeEventListener('emptied', onEmptied);
    v.removeEventListener('loadeddata', onLoadedData);
    v.removeEventListener('waiting', onWaiting);
    v.removeEventListener('playing', onPlaying);
    v.removeEventListener('seeked', onSeeked);
    v.removeEventListener('ratechange', onRateChange);
  }

  function onWaiting() { stalled = true; }
  function onPlaying() { stalled = false; resyncDmTime(); }
  function onSeeked() { resyncDmTime(); }
  function onRateChange() { resyncDmTime(); }

  function onEmptied() { if (engine) engine.clear(); lastVpos = -1; }
  function onLoadedData() { resyncDmTime(); }

  // ---------- 挂载/重挂载 ----------
  function attach(v) {
    if (video === v) return;
    // 换视频了: 清掉旧弹幕, 不继续播
    const videoChanged = data && loadedVideoId !== null && currentVideoId() !== loadedVideoId;
    unbindVideoEvents(video);
    video = v;
    bindVideoEvents(v);
    resyncDmTime();
    if (videoChanged) {
      // 不在此清除: 由 resolve 的 handleVideoSwitch 预加载新弹幕后一次性替换
    }
    mountHost(v);
    if (data) initEngine();
  }

  function teardownAll() {
    unbindVideoEvents(video);
    video = null;
    destroyEngine();
    unmountHost();
  }

  // ---------- 播放器控制条按钮: 显示/隐藏菜单 ----------
  let toggleBtn = null;
  function togglePanel() {
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  }

  // 幂等 + 重建安全: 元素存在但无绑定标记 (播放器重建导致监听器丢失) 时重建
  function ensureMenuButton() {
    const container = document.querySelector('.bpx-player-container') || document.querySelector('#bilibili-player');
    if (!container) return;
    const wrap = container.querySelector('.bpx-player-control-entity') || container.querySelector('.bpx-player-control-wrap');
    // 真站按钮区: entity > bottom > bottom-right (entity 是 block 布局, 不能直接 append)
    const bar = wrap
      ? (wrap.querySelector('.bpx-player-control-bottom-right')
        || wrap.querySelector('.bpx-player-control-bottom')
        || wrap)
      : null;
    if (!bar) return;
    let btn = bar.querySelector('.ndp-toggle');
    if (btn && btn.dataset.ndpBound !== '1') { btn.remove(); btn = null; } // 无监听器的残留按钮
    if (!btn) {
      toggleBtn = document.createElement('div');
      toggleBtn.className = 'bpx-player-ctrl-btn ndp-toggle';
      toggleBtn.setAttribute('role', 'button');
      toggleBtn.setAttribute('aria-label', 'Nico弹幕');
      toggleBtn.title = 'Nico弹幕';
      toggleBtn.innerHTML = '<div class="bpx-player-ctrl-btn-icon"><span class="ndp-toggle-text">N</span></div>';
      toggleBtn.dataset.ndpBound = '1';
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        togglePanel();
      });
      // 插到全屏按钮前 (与设置/全屏一排)
      const anchor = bar.querySelector('.bpx-player-ctrl-full') || bar.querySelector('.bpx-player-ctrl-setting');
      if (anchor) bar.insertBefore(toggleBtn, anchor);
      else bar.appendChild(toggleBtn);
    }
    // 点面板外关闭 (document 级, 播放器重建不失效; 只绑一次)
    if (!document.__ndpOutsideBound) {
      document.__ndpOutsideBound = true;
      document.addEventListener('mousedown', (e) => {
        if (panel && panel.style.display !== 'none' &&
            !panel.contains(e.target) &&
            !(toggleBtn && toggleBtn.contains(e.target))) {
          panel.style.display = 'none';
        }
      });
    }
  }

  function resolve() {
    if (!isPlayerPage()) {
      teardownAll();
      if (panel) panel.style.display = 'none';
      return;
    }
    if (!panel) buildPanel();
    ensureMenuButton();
    // 视频身份变化检查: B 站切 P 常复用 video 元素 (attach 会提前 return),
    // 预加载新弹幕 ready 后一次性替换 (无清除间隙), 不等 1.5s 轮询
    if (data && loadedVideoId !== null && currentVideoId() !== loadedVideoId) {
      handleVideoSwitch();
    }
    const v = findVideo();
    if (!v) return;
    attach(v);
    maybeAutoLoad(); // 刷新/切集后自动加载该视频的弹幕
  }

  // ---------- SPA 观察 ----------
  function startObservers() {
    const mo = new MutationObserver(() => {
      if (resolveTimer) return;
      resolveTimer = setTimeout(() => {
        resolveTimer = null;
        resolve();
      }, 800);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    setInterval(() => {
      if (!isPlayerPage()) { teardownAll(); return; }
      // 同元素换源 (URL 变了但 video 元素没换) 也要处理
      if (data && loadedVideoId !== null && currentVideoId() !== loadedVideoId) {
        handleVideoSwitch(); // 预加载后一次性替换, 无清除间隙
        return;
      }
      if (!video) { resolve(); return; }
      if (!document.contains(video)) resolve();
    }, 1500);
  }

  // ---------- 启动 ----------
  async function boot() {
    await loadSettings();
    resolve(); // 仅在视频页创建面板
    startObservers();
    loop(performance.now());
    // 调试/自动化钩子: postMessage({type:'nico-dm:load', name, text}) 或 {type:'nico-dm:clear'}
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'nico-dm:load' && typeof m.text === 'string') {
        loadFile(new File([m.text], m.name || 'debug-danmaku.json', { type: 'application/json' }));
      } else if (m.type === 'nico-dm:clear') {
        clearDanmakuAndRecord();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
