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
    panelX: null,
    panelY: null,
  };
  const STORAGE_KEY = 'nicoDmSettings';
  const DANMAKU_KEY = 'nicoDmFiles'; // 弹幕文件记录: { [videoId]: { name, text?, offset, ts, source } }
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
    return location.pathname
      + (bvid ? '|' + bvid[1] : '')
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

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (!engine || !video || !data) return;
    if (lastFrameTime === null) { lastFrameTime = now; return; }
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    if (!video.paused && !stalled) dmTime += dt * (video.playbackRate || 1);
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
    if (d[0] && Array.isArray(d[0].comments)) return d[0].comments.length;
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

  async function loadFile(file, handle) {
    try {
      const text = await file.text();
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
      data = loaded;
      currentFile = file.name;
      currentHandle = handle || null;
      loadedVideoId = currentVideoId();
      if (fileNameEl) fileNameEl.textContent = file.name;
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
    const vid = currentVideoId();
    destroyEngine();
    data = null;
    currentFile = null;
    currentHandle = null;
    loadedVideoId = null;
    fileInput.value = '';
    fileNameEl.textContent = '未选择文件';
    setStatus('');
    removeDanmakuRecord(); // 清除 = 解除关联
    if (vid) idbDelete(vid).catch(() => {}); // 文件句柄一起删
  }

  // ---------- 弹幕文件关联记忆 ----------
  // 选择文件时记住视频号 + 偏移; 刷新后自动加载
  // handle 模式: 本地文件句柄存 IDB (直接读盘, 不占 storage); content 模式: 文件内容存 storage (fallback)
  async function saveDanmakuRecord(vid, name, text, handle) {
    if (!vid) return;
    try {
      if (handle) {
        try { await idbPut(vid, handle); } catch (e) { handle = null; } // IDB 存句柄失败 → 降级内容模式
      }
      if (handle) {
        chrome.storage.local.get(DANMAKU_KEY, (res) => {
          const all = (res && res[DANMAKU_KEY]) || {};
          all[vid] = { name, offset: settings.offset, ts: Date.now(), source: 'handle' };
          chrome.storage.local.set({ [DANMAKU_KEY]: all });
        });
      } else {
        chrome.storage.local.get(DANMAKU_KEY, (res) => {
          const all = (res && res[DANMAKU_KEY]) || {};
          all[vid] = { name, text, offset: settings.offset, ts: Date.now(), source: 'content' };
          chrome.storage.local.set({ [DANMAKU_KEY]: all });
        });
        idbDelete(vid).catch(() => {});
      }
    } catch (e) {}
  }

  function updateDanmakuOffset() {
    const vid = currentVideoId();
    if (!vid) return;
    try {
      chrome.storage.local.get(DANMAKU_KEY, (res) => {
        const all = (res && res[DANMAKU_KEY]) || {};
        if (all[vid]) {
          all[vid].offset = settings.offset;
          chrome.storage.local.set({ [DANMAKU_KEY]: all });
        }
      });
    } catch (e) {}
  }

  function removeDanmakuRecord() {
    const vid = currentVideoId();
    if (!vid) return;
    try {
      chrome.storage.local.get(DANMAKU_KEY, (res) => {
        const all = (res && res[DANMAKU_KEY]) || {};
        if (all[vid]) {
          delete all[vid];
          chrome.storage.local.set({ [DANMAKU_KEY]: all });
        }
      });
    } catch (e) {}
  }

  // 从 storage 恢复该视频的偏移量并同步滑块
  function applyStoredOffset(vid) {
    try {
      chrome.storage.local.get(DANMAKU_KEY, (res) => {
        const rec = res && res[DANMAKU_KEY] && res[DANMAKU_KEY][vid];
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
  function maybeAutoLoad() {
    if (data || autoLoading) return;
    const vid = currentVideoId();
    if (!vid) return;
    autoLoading = true;
    const fromContent = () => {
      try {
        chrome.storage.local.get(DANMAKU_KEY, (res) => {
          const rec = res && res[DANMAKU_KEY] && res[DANMAKU_KEY][vid];
          autoLoading = false;
          if (!rec || !rec.text) return;
          applyStoredOffset(vid);
          loadFile(new File([rec.text], rec.name || 'auto-danmaku.json', { type: 'application/json' }));
        });
      } catch (e) { autoLoading = false; }
    };
    try {
      idbGet(vid).then(async (handle) => {
        if (!handle) { fromContent(); return; }
        try {
          const st = await handle.requestPermission({ mode: 'read' });
          if (st !== 'granted') { fromContent(); return; }
          const f = await handle.getFile();
          autoLoading = false;
          applyStoredOffset(vid);
          loadFile(f, handle); // 直接从磁盘读最新内容
        } catch (e) { fromContent(); }
      }).catch(fromContent);
    } catch (e) { autoLoading = false; }
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
  let offsetEl, offsetValEl, scaleEl, scaleValEl, opacityEl, opacityValEl;

  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'nico-dm-panel';
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
    $('#ndp-clear').addEventListener('click', clearDanmaku);
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

  function setStatus(msg, ok) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'ndp-status' + (ok ? ' ndp-ok' : msg ? ' ndp-err' : '');
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
      clearDanmaku();
      setStatus('视频已切换, 弹幕已清除');
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

  function resolve() {
    if (!isPlayerPage()) {
      teardownAll();
      if (panel) panel.style.display = 'none';
      return;
    }
    if (!panel) buildPanel();
    else panel.style.display = '';
    const v = findVideo();
    if (!v) return;
    attach(v);
    maybeAutoLoad(); // 刷新后自动加载该视频上次的弹幕文件
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
      // 同元素换源 (URL 变了但 video 元素没换) 也要清弹幕
      if (data && loadedVideoId !== null && currentVideoId() !== loadedVideoId) {
        clearDanmaku();
        setStatus('视频已切换, 弹幕已清除');
        maybeAutoLoad(); // 切集后自动加载新视频的弹幕 (SPA 下 video 元素复用, resolve 可能不触发)
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
        clearDanmaku();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
