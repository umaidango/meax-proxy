// Meax ミラー用リバースプロキシ（依存ゼロ・Node 18+）。
// 固定の上流（meax.jp / api.meax.jp / media.meax.jp / ai.api.meax.jp）だけに中継する。任意のURLは開けない。
import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, ''); // 例 https://meax-proxy.onrender.com（未設定ならHostから）
const PREFIX = '/_p/';
const UPSTREAMS = { api: 'api.meax.jp', media: 'media.meax.jp', ai: 'ai.api.meax.jp' };
const MAIN = 'meax.jp';
const HOST_TO_KEY = { 'api.meax.jp': 'api', 'media.meax.jp': 'media', 'ai.api.meax.jp': 'ai' };
const TEXT_RE = /^(text\/|application\/(javascript|json|x-javascript|xml|manifest\+json|vnd\.apple\.mpegurl|x-mpegurl)|image\/svg)/i;
const DROP_REQ = new Set(['host', 'connection', 'accept-encoding', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-render-origin-server', 'rndr-id', 'cf-connecting-ip', 'true-client-ip']);
const DROP_RES = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'content-security-policy', 'content-security-policy-report-only', 'strict-transport-security', 'report-to', 'nel']);

const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function originOf(req) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

// 本文中の上流URLを、プロキシ経由のURLに書き換える
function rewriteBody(text, origin) {
  const wsOrigin = origin.replace(/^http/, 'ws');
  return text
    .replace(/(https?:)?\/\/(api|media|ai\.api)\.meax\.jp/g, (_m, _p, h) => `${origin}${PREFIX}${HOST_TO_KEY[`${h}.meax.jp`]}`)
    .replace(/wss:\/\/(api|ai\.api)\.meax\.jp/g, (_m, h) => `${wsOrigin}${PREFIX}${HOST_TO_KEY[`${h}.meax.jp`]}`)
    .replace(/https?:\/\/(www\.)?meax\.jp(?![a-z0-9.-])/g, origin);
}

function rewriteLocation(loc, origin) {
  try {
    const u = new URL(loc);
    const key = HOST_TO_KEY[u.hostname];
    if (key) return `${origin}${PREFIX}${key}${u.pathname}${u.search}${u.hash}`;
    if (u.hostname === MAIN || u.hostname === 'www.meax.jp') return `${origin}${u.pathname}${u.search}${u.hash}`;
  } catch { /* 相対パスはそのまま */ }
  return loc;
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || '';
}

function isPageRequest(req) {
  if (req.method !== 'GET' || req.url.startsWith(PREFIX)) return false;
  const dest = req.headers['sec-fetch-dest'];
  if (dest) return dest === 'document';
  return String(req.headers.accept || '').includes('text/html');
}

function checkPage(url) {
  const path = JSON.stringify(url).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meax</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141218;color:#e6e0e9;font:16px system-ui,sans-serif}</style></head>
<body><p>Meax に接続しています…</p>
<script>
(function () {
  var path = ${path}, done = false;
  function go(direct) {
    if (done) return; done = true;
    if (direct) { location.replace('https://${MAIN}' + path); return; }
    document.cookie = 'px_ok=1; max-age=20; path=/; samesite=lax';
    location.replace(path);
  }
  var img = new Image();
  img.onload = function () { go(true); };
  img.onerror = function () { go(false); };
  setTimeout(function () { go(false); }, 3000);
  img.src = 'https://${MAIN}/icon.png?c=' + Date.now();
})();
</script>
<noscript><meta http-equiv="refresh" content="0;url=/_p/go"></noscript></body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === '/_p/go') { res.writeHead(302, { location: '/', 'set-cookie': 'px_ok=1; Max-Age=20; Path=/; SameSite=Lax' }); return res.end(); }
  if (req.url === '/_p/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }

  // ページを開くたびに、見ている人のブラウザから本体（meax.jp）が開けるかを確かめる。
  // 開ければ本体へ移動、開けなければ（学校のフィルターなど）そのままプロキシで表示する。
  // 判定の結果は20秒だけクッキーに持つ（同じページの読み込み直しで無限に確かめないため）。
  if (isPageRequest(req) && !/(?:^|;\s*)px_ok=1/.test(req.headers.cookie || '')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(checkPage(req.url));
  }

  let host = MAIN;
  let path = req.url;
  if (path.startsWith(PREFIX)) {
    const rest = path.slice(PREFIX.length);
    const i = rest.indexOf('/');
    const key = i === -1 ? rest : rest.slice(0, i);
    if (!UPSTREAMS[key]) { res.writeHead(404); return res.end('not found'); }
    host = UPSTREAMS[key];
    path = i === -1 ? '/' : rest.slice(i);
  }

  const origin = originOf(req);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQ.has(k)) headers[k] = v;
  headers.host = host;
  headers['accept-encoding'] = 'identity'; // 本文を書き換えるため圧縮なしで受ける
  headers['x-forwarded-for'] = clientIp(req);
  // 上流側の Origin/Referer 検査を通す（プロキシのURLを上流のURLに戻す）
  if (headers.origin) headers.origin = `https://${MAIN}`;
  if (headers.referer) headers.referer = headers.referer.split(origin).join(`https://${MAIN}`);

  const up = https.request({ host, port: 443, method: req.method, path, headers, agent, servername: host }, (ur) => {
    const out = {};
    for (const [k, v] of Object.entries(ur.headers)) {
      if (DROP_RES.has(k)) continue;
      if (k === 'set-cookie') out[k] = v.map((c) => c.replace(/;\s*domain=[^;]*/i, ''));
      else if (k === 'location') out[k] = rewriteLocation(v, origin);
      else if (k === 'access-control-allow-origin') out[k] = origin;
      else out[k] = v;
    }
    const type = String(ur.headers['content-type'] || '');
    if (TEXT_RE.test(type) && req.method !== 'HEAD') {
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        const body = Buffer.from(rewriteBody(Buffer.concat(chunks).toString('utf8'), origin));
        out['content-length'] = body.length;
        res.writeHead(ur.statusCode, out);
        res.end(body);
      });
    } else {
      if (ur.headers['content-length']) out['content-length'] = ur.headers['content-length'];
      res.writeHead(ur.statusCode, out);
      ur.pipe(res);
    }
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('upstream error'); });
  req.on('aborted', () => up.destroy());
  req.pipe(up);
});

server.listen(PORT, () => console.log(`meax-proxy listening on :${PORT}`));
