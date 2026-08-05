# bili-nico-danmaku-extension

A Chrome extension (MV3) that plays niconico danmaku directly on the Bilibili web player.

Pick a nico danmaku JSON/XML file → the comments are overlaid on the Bilibili video in niconico style, with timeline offset alignment.

[中文](README.md) | **English** | [日本語](README.ja.md)

## Screenshots

![Adachi and Shimamura · full-screen nico danmaku](png/nico-danmaku-1.png)

![DECO*27 Marshmallow · 2500 comments loaded](png/nico-danmaku-2.png)

## Installation

1. Chrome → `chrome://extensions` → enable **Developer mode**
2. Click **Load unpacked** → select this directory (the one containing `manifest.json`)
3. Open any Bilibili video/bangumi page — the **Nico Danmaku** panel appears (top-right)

## Usage

1. Click **📂 Load danmaku file** to pick a danmaku file
2. Play the video — comments sync smoothly (rAF dt accumulation clock, uniform 60 fps steps, independent of video frame rate)
3. If the Bilibili source and the original nico video timelines differ, drag the **Offset** slider to align (positive = comments earlier, negative = later)
4. Font size / opacity apply immediately; native Bilibili comments are controlled by the player's own danmaku toggle
5. **Show danmaku** toggle: temporarily hide/show nico comments (keeps the video↔file association; unlike **Clear danmaku**)

### Automatic memory

- On loading a file, the extension remembers the **video ID (bvid/ep/p) + offset**
- Local files are remembered via the **File System Access API handle** (IndexedDB): next time it opens the original file on disk directly and reads the latest content — no storage bloat; falls back to storing file content automatically when handles are unavailable
- Reopening/refreshing the same video **restores danmaku and offset automatically** — no need to pick the file again
- **Switching between episodes/P-parts loads the matching danmaku automatically** — switch from episode 1 to 2, and episode 2's comments load; switching back works the same
- Clicking **Clear danmaku** unlinks the current video (won't auto-load next time; other episodes are unaffected)

Settings (offset, font size, opacity) are stored in `chrome.storage.local` and restored on next visit.

## Supported danmaku file formats

| Format | Description |
|---|---|
| nico v1 JSON | Official nico API format, `[{fork, comments:[{vposMs, body, commands, postedAt, ...}]}]` |
| nico XML | Raw `<packet>` / `<chat>` comment XML |
| xml2js JSON | `{packet:{chat:[...]}}` |
| legacy / formatted | Old niconicomments JSON / Niconicome export |
| Bilibili XML | Bonus support, rendered in nico style |

## Architecture

- `content.js` — player detection, overlay mounting, file loading, rAF sync loop, offset/font/opacity, SPA remount (MutationObserver); panel only created on video pages (/video/, /bangumi/play/, /list/)
- `content.css` — panel UI
- `lib/bundle.js` — [niconicomments](https://github.com/xpadev-net/niconicomments) v0.3.1 bundle (includes CSSRenderer)
- `lib/input.js` — XML/JSON parsing (same as iina-plugin-danmaku-cosmos)
- `test-data/sample-nico.json` — 68-comment test data (v1 format)
- `test/harness/index.html` — local test harness: replicates the bpx player DOM + real video, verifies engine/sync/UI with the exact same files the extension uses

### Engine integration notes

- Engine: [niconicomments](https://github.com/xpadev-net/niconicomments) (xpadev-net)
- Rendering: native canvas mode (`mode: 'default'`), **WebGL2** internally (falls back to Canvas2D), 1920×1080 internal resolution, CSS-stretched to fill the host
- The overlay host (absolutely positioned, filling the video frame) contains a `<canvas>` with `width/height:100%`, `pointer-events:none`; opacity is controlled by the panel
- Comment sync: rAF dt accumulation clock (same approach as the nico-comment-dl preview) — re-anchors to `video.currentTime` on play/seek/resume, then free-runs without per-media-frame correction (media clock jitter makes per-frame correction cause micro-stutter); float vpos passed to `drawCanvas` every frame; `clear()` + redraw when seek delta > 1.5s; last frame kept while paused, redrawn only on seek
- Upstream v0.3.1's `isMode` validation only accepts `default/html5/flash` (the CSS rendering code exists in the bundle but isn't wired into validation), so canvas mode is used throughout

## Testing

```bash
cd bili-nico-danmaku-extension
# First time only: generate the test video (gitignored)
ffmpeg -y -f lavfi -i testsrc2=size=960x540:rate=30:duration=90 \
  -f lavfi -i sine=frequency=440:duration=90 \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 32 -c:a aac -b:a 96k \
  test/harness/test.mp4
node test/harness/server.js 8766   # static server with Range support (python http.server lacks it; Chrome media seeking breaks without it)
# Open http://127.0.0.1:8766/video/index.html (video/ is a symlink to the harness, mimicking the /video/ URL shape)
```

Automation hook in the harness console: `window.postMessage({type:'nico-dm:load', name:'x.json', text:JSON.stringify(SAMPLE)}, '*')`.

## Known limitations

- The comment clock re-anchors to the video on play/seek/buffer-resume; it freezes during buffering (`waiting`) and re-aligns on `playing`
- In fullscreen, the panel is outside the fullscreen element and is hidden (the danmaku itself follows the player into fullscreen normally)
- CA comments' `@jump` is ignored (no multi-video switching semantics in a browser context)
- Native Bilibili comments are not touched — use the player's own danmaku toggle
- File-handle mode (File System Access API) is Chrome-only; Firefox/Safari automatically use the "store file content" fallback
