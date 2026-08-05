// 测试用静态服务器: 支持 Range 请求 (python http.server 不支持, 会导致 Chrome 媒体 seek 异常)
// 用法: node server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const port = Number(process.argv[2] || 8766);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  // 番剧路径模拟: /bangumi/play/ep* 或 ss* → 测试台 (映射 key = ep/ss 号)
  if (/^\/bangumi\/play\/(ep|ss)\d+/.test(urlPath)) urlPath = '/video/index.html';
  const p = path.join(root, urlPath);
  fs.stat(p, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const type = MIME[path.extname(p)] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416); res.end(); return; }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(p, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': st.size,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(p).pipe(res);
    }
  });
}).listen(port, '127.0.0.1', () => console.log(`Range server: http://127.0.0.1:${port}`));
