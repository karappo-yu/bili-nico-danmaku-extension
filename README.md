# bili-nico-danmaku-extension

在 B 站网页播放器上直接播放 niconico 弹幕的 Chrome 扩展(MV3)。

选一个 nico 弹幕 JSON/XML 文件 → 弹幕以 niconico 风格叠加到 B 站视频上,支持时间轴偏移对齐。

## 安装

1. Chrome → `chrome://extensions` → 打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选择本目录(含 `manifest.json` 的这一层)
3. 打开任意 B 站视频/番剧页,右上角出现「Nico 弹幕」面板

## 使用

1. 点「📂 选择弹幕文件」载入弹幕文件
2. 播放视频,弹幕随 `video.currentTime` 同步
3. B 站源与 nico 原视频时间轴不一致时,拖「偏移」滑块对齐(正=弹幕提前,负=延后)
4. 「隐藏B站弹幕」默认开启;字号/透明度即时生效

设置(偏移、字号、透明度、面板位置)存 `chrome.storage.local`,下次自动恢复。

## 支持的弹幕文件格式

| 格式 | 说明 |
|---|---|
| nico v1 JSON | nico 官方 API 格式,`[{fork, comments:[{vposMs, body, commands, postedAt, ...}]}]` |
| nico XML | `<packet>` / `<chat>` 原始弹幕 XML |
| xml2js JSON | `{packet:{chat:[...]}}` |
| legacy / formatted | 老 niconicomments JSON / Niconicome 导出 |
| B站 XML | 附带支持,渲染成 nico 风格 |

## 架构

- `content.js` — 播放器解析、overlay 挂载、文件载入、rAF 同步循环、偏移/字号/透明度、SPA 重挂载(MutationObserver);仅在视频页(/video/、/bangumi/play/、/list/)创建面板
- `content.css` — 面板 UI + 隐藏 B 站原生弹幕规则
- `lib/bundle.js` — niconicomments v0.3.1 上游原版 bundle(来自 nico-comment-dl/vendor/niconicomments,含 CSSRenderer),零修改复用
- `lib/input.js` — XML/JSON 解析(同 iina-plugin-danmaku-cosmos)
- `test-data/sample-nico.json` — 68 条 v1 格式测试弹幕
- `test/harness/index.html` — 本地测试台:复刻 bpx 播放器 DOM + 真视频,直接用扩展同款文件验证引擎/同步/UI

### 引擎集成要点

- 渲染模式:上游原生 canvas 模式(`mode: 'default'`),引擎内部用 **WebGL2**(失败自动回退 Canvas2D),1920×1080 内部分辨率,CSS 拉伸铺满 host
- overlay host(绝对定位填满视频框)里放一个 `<canvas>`,CSS `width/height:100%` 拉伸,`pointer-events:none`,透明度由面板控制
- 弹幕同步:`vpos = floor((video.currentTime + offset) * 100)`,rAF 循环驱动 `drawCanvas`;seek 差 >1.5s 时 `clear()` 重绘;暂停时保留最后一帧,仅 seek 时重绘
- 上游 v0.3.1 的 `isMode` 校验只接受 `default/html5/flash`(CSS 渲染模式代码在 bundle 里但没接入校验),故统一用 canvas 模式

## 测试

```bash
cd bili-nico-danmaku-extension
# 首次需要生成测试视频 (gitignore, 不入库)
ffmpeg -y -f lavfi -i testsrc2=size=960x540:rate=30:duration=90 \
  -f lavfi -i sine=frequency=440:duration=90 \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 32 -c:a aac -b:a 96k \
  test/harness/test.mp4
python3 -m http.server 8765
# 打开 http://127.0.0.1:8765/video/index.html (video/ 是指向测试台的符号链接,模拟 /video/ URL 形态)
```

测试台控制台自动化注入:`window.postMessage({type:'nico-dm:load', name:'x.json', text:JSON.stringify(SAMPLE)}, '*')`。

## 已知限制

- B 站原生弹幕隐藏靠 CSS 选择器(`.bpx-player-dm` 等),B 站改版后若失效需更新 `content.css`
- 全屏时面板在 fullscreen 元素外会被隐藏(弹幕本身跟随播放器正常全屏)
- CA 弹幕的 `@jump` 跳转忽略(浏览器端无多视频切换语义)
