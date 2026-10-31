// supervisor/web-server.js
const http = require('http');
const url = require('url');
const { superviseOnce, superviseLoop } = require('./index');
const { readBookState } = require('./state-reader');

// ---------- 日志缓冲（供前端轮询） ----------
const logBuffer = [];
let logId = 0;
function pushLog(msg) {
  logBuffer.push({ id: ++logId, time: new Date().toLocaleTimeString(), msg: String(msg) });
  if (logBuffer.length > 800) logBuffer.shift();
}

// 拦截 console.log / console.error，让页面能看到
const _log = console.log;
const _err = console.error;
console.log = (...args) => {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  pushLog(msg); _log(...args);
};
console.error = (...args) => {
  const msg = '[ERROR] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  pushLog(msg); _err(...args);
};

// ---------- 读取请求体 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------- 路由处理 ----------
async function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // 首页：返回控制台 HTML
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
    return;
  }

  // 读取状态
  if (req.method === 'GET' && pathname === '/api/state') {
    const bookDir = parsed.query.bookDir;
    if (!bookDir) return sendJson(res, 400, { error: '缺少 bookDir 参数' });
    try {
      const state = readBookState(bookDir);
      return sendJson(res, 200, { ok: true, state });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 执行一步
  if (req.method === 'POST' && pathname === '/api/step') {
    const body = await readBody(req);
    if (!body.bookDir) return sendJson(res, 400, { error: '缺少 bookDir' });
    try {
      const result = await superviseOnce(body.bookDir, body.options || { genre: 'novel', channel: 'male' });
      return sendJson(res, 200, { ok: true, result });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 循环执行
  if (req.method === 'POST' && pathname === '/api/loop') {
    const body = await readBody(req);
    if (!body.bookDir) return sendJson(res, 400, { error: '缺少 bookDir' });
    try {
      const result = await superviseLoop(
        body.bookDir,
        body.options || { genre: 'novel', channel: 'male' },
        body.maxRounds || 20
      );
      return sendJson(res, 200, { ok: true, result });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 轮询日志
  if (req.method === 'GET' && pathname === '/api/logs') {
    const since = parseInt(parsed.query.since || '0', 10);
    const items = logBuffer.filter(x => x.id > since);
    return sendJson(res, 200, { items, lastId: logId });
  }

  sendJson(res, 404, { error: 'Not found' });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- 页面 HTML ----------
const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>Novel Supervisor 控制台</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: #0f1419; color: #d5dbe0; }
  header { background: #1a2332; padding: 14px 20px; border-bottom: 1px solid #2a3544; }
  header h1 { margin: 0; font-size: 18px; color: #7dd3fc; }
  header p { margin: 4px 0 0; font-size: 12px; color: #7a8896; }
  .container { display: flex; height: calc(100vh - 72px); }
  .left { width: 40%; padding: 16px; border-right: 1px solid #2a3544; overflow-y: auto; }
  .right { width: 60%; padding: 16px; display: flex; flex-direction: column; }
  label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; margin-top: 12px; }
  input[type=text], input[type=number] { width: 100%; padding: 8px 10px; background: #1a2332; border: 1px solid #2a3544; color: #e2e8f0; border-radius: 6px; font-size: 13px; }
  .btns { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
  button { padding: 8px 14px; border: none; border-radius: 6px; font-size: 13px; cursor: pointer; font-weight: 500; }
  button.primary { background: #0ea5e9; color: white; }
  button.primary:hover { background: #38bdf8; }
  button.primary:disabled { background: #334155; cursor: not-allowed; }
  button.ghost { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; }
  button.ghost:hover { background: #273548; }
  .status-box { margin-top: 14px; background: #0a0f16; border: 1px solid #1e293b; border-radius: 8px; padding: 12px; font-family: "Consolas", monospace; font-size: 12px; white-space: pre-wrap; max-height: 260px; overflow: auto; color: #a5b4c8; }
  .log-title { font-size: 13px; color: #94a3b8; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
  .log-area { flex: 1; background: #0a0f16; border: 1px solid #1e293b; border-radius: 8px; padding: 12px; overflow-y: auto; font-family: "Consolas", monospace; font-size: 12px; line-height: 1.6; }
  .log-line { white-space: pre-wrap; word-break: break-all; border-bottom: 1px solid #111a24; padding: 2px 0; }
  .log-line .t { color: #475569; margin-right: 8px; }
  .log-line.err { color: #f87171; }
  .log-line.ok { color: #4ade80; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; background: #1e293b; color: #94a3b8; }
</style>
</head>
<body>
<header>
  <h1>🧠 Novel Supervisor 控制台</h1>
  <p>旁路监督 · 按作品状态推进 · 不影响原有服务</p>
</header>
<div class="container">
  <div class="left">
    <label>书目录（绝对路径）</label>
    <input type="text" id="bookDir" placeholder="例如 D:\\Novels\\我的书名" />
    <div class="btns">
      <button class="ghost" id="btnState">读取状态</button>
      <button class="primary" id="btnStep">执行一步</button>
      <button class="primary" id="btnLoop">循环执行</button>
    </div>
    <label style="margin-top:18px">最大轮数（循环执行用）</label>
    <input type="number" id="maxRounds" value="20" min="1" max="200" />
    <label style="margin-top:18px">当前状态 <span class="badge" id="stateBadge">未读取</span></label>
    <div class="status-box" id="stateBox">点击"读取状态"查看</div>
  </div>
  <div class="right">
    <div class="log-title">
      <span>运行日志</span>
      <button class="ghost" id="btnClear" style="padding:4px 10px;font-size:12px">清空日志</button>
    </div>
    <div class="log-area" id="logArea"></div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id);
let lastLogId = 0;
let polling = null;

function appendLog(item) {
  const div = document.createElement('div');
  div.className = 'log-line' + (item.msg.startsWith('[ERROR]') ? ' err' : '');
  div.innerHTML = '<span class="t">' + item.time + '</span>' + escapeHtml(item.msg);
  const area = $('logArea');
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function pollLogs() {
  try {
    const r = await fetch('/api/logs?since=' + lastLogId);
    const data = await r.json();
    (data.items || []).forEach(item => { appendLog(item); lastLogId = item.id; });
  } catch (e) {}
}

$('btnState').onclick = async () => {
  const bookDir = $('bookDir').value.trim();
  if (!bookDir) return alert('请先填写书目录');
  $('stateBox').textContent = '读取中...';
  try {
    const r = await fetch('/api/state?bookDir=' + encodeURIComponent(bookDir));
    const data = await r.json();
    if (data.ok) {
      $('stateBox').textContent = JSON.stringify(data.state, null, 2);
      $('stateBadge').textContent = '已读取';
    } else {
      $('stateBox').textContent = '读取失败: ' + data.error;
    }
  } catch (e) {
    $('stateBox').textContent = '读取失败: ' + e.message;
  }
};

async function runAction(url, btn) {
  const bookDir = $('bookDir').value.trim();
  if (!bookDir) return alert('请先填写书目录');
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '执行中...';
  if (!polling) polling = setInterval(pollLogs, 1000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookDir, maxRounds: parseInt($('maxRounds').value, 10) || 20 })
    });
    const data = await r.json();
    await pollLogs();
    if (!data.ok) {
      appendLog({ time: new Date().toLocaleTimeString(), msg: '[ERROR] ' + (data.error || '未知错误') });
    }
  } catch (e) {
    appendLog({ time: new Date().toLocaleTimeString(), msg: '[ERROR] 请求失败: ' + e.message });
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

$('btnStep').onclick = () => runAction('/api/step', $('btnStep'));
$('btnLoop').onclick = () => runAction('/api/loop', $('btnLoop'));
$('btnClear').onclick = () => { $('logArea').innerHTML = ''; };

// 页面启动时就开始轮询日志
polling = setInterval(pollLogs, 1000);
</script>
</body>
</html>`;

// ---------- 启动服务 ----------
const PORT = process.env.SUPERVISOR_PORT || 3001;
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    sendJson(res, 500, { error: e.message });
  });
});
server.listen(PORT, () => {
  _log('========================================');
  _log('Supervisor 控制台已启动');
  _log('请在浏览器打开: http://localhost:' + PORT);
  _log('（这个服务独立运行，不影响你的原有服务）');
  _log('========================================');
});