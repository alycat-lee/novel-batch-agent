/**
 * 独立宿主的 webServer：精确路径匹配，重复注册先注销旧的。
 * 静态伺服工作台入口与拼接后的 client.js，API 前缀保持 /dsh-writer-m/api/*。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(status, {
    'content-length': buf.length,
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(buf)
}

const WORKBENCH_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>写作工作台 · novel-batch-agent</title>
  <style>
    html, body, #root { height: 100%; margin: 0; background: #0f1115; color: #e7e9ef; }
    body { display: flex; flex-direction: column; }
    #root { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="/vendor/react.production.min.js"></script>
  <script src="/vendor/react-dom.production.min.js"></script>
  <script>
    (function () {
      var React = window.React
      var ReactDOM = window.ReactDOM
      var captured = null
      window.__ModuleLoader__ = {
        load: function (entry) {
          if (!entry || typeof entry.factory !== 'function') {
            document.getElementById('root').textContent = '工作台加载失败：横幅不是 factory'
            return
          }
          var mod = entry.factory(function (name) {
            if (name === 'react') return React
            throw new Error('独立宿主不提供模块：' + name)
          })
          var ctx = {
            layout: { selectPanel: function () {} },
            slots: {
              inject: function (_name, fn) { if (typeof fn === 'function') fn() },
              register: function (spec, Component) {
                if (spec && (spec.key === 'writer-m' || spec.name === 'main')) captured = Component
                return function () {}
              }
            }
          }
          if (mod && typeof mod.apply === 'function') mod.apply(ctx)
          var node = document.getElementById('root')
          if (typeof captured !== 'function') {
            node.textContent = '工作台加载失败：没有拿到 WriterPanel'
            return
          }
          var close = function () {}
          if (ReactDOM.createRoot) ReactDOM.createRoot(node).render(React.createElement(captured, { close: close }))
          else ReactDOM.render(React.createElement(captured, { close: close }), node)
        }
      }
    })()
  </script>
  <script src="/client.js"></script>
</body>
</html>
`

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed', { 'content-type': 'text/plain; charset=utf-8' })
    return
  }
  if (pathname === '/' || pathname === '/index.html') {
    send(res, 200, WORKBENCH_HTML, { 'content-type': 'text/html; charset=utf-8' })
    return
  }
  let rel = null
  if (pathname === '/client.js') rel = join(PACKAGE_DIR, 'lib', 'client.js')
  else if (pathname === '/vendor/react.production.min.js') rel = join(PACKAGE_DIR, 'server', 'vendor', 'react.production.min.js')
  else if (pathname === '/vendor/react-dom.production.min.js') rel = join(PACKAGE_DIR, 'server', 'vendor', 'react-dom.production.min.js')
  if (rel === null || existsSync(rel) === false) {
    send(res, 404, 'Not Found', { 'content-type': 'text/plain; charset=utf-8' })
    return
  }
  const buf = await readFile(rel)
  const type = MIME[extname(rel)] ?? 'application/octet-stream'
  send(res, 200, buf, { 'content-type': type, 'cache-control': pathname === '/client.js' ? 'no-store' : 'public, max-age=86400' })
}

export function createWebServer() {
  const routes = new Map()
  const server = createServer((req, res) => {
    // 关掉 keep-alive：lib/core/body.js 会听 req.close，keep-alive 复用套接字时
    // 上一请求的 close 可能误伤下一请求，表现为偶发 ECONNRESET。
    res.setHeader('Connection', 'close')
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      pathname = '/'
    }
    const handler = routes.get(pathname)
    if (typeof handler === 'function') {
      try {
        handler(req, res)
      } catch (error) {
        if (!res.writableEnded) {
          send(res, 500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
            'content-type': 'application/json; charset=utf-8',
          })
        }
      }
      return
    }
    serveStatic(req, res, pathname).catch((error) => {
      if (!res.writableEnded) {
        send(res, 500, String(error?.message ?? error), { 'content-type': 'text/plain; charset=utf-8' })
      }
    })
  })

  return {
    server,
    register({ kind, path, handler }) {
      if (kind !== 'exact') throw new Error('独立宿主只支持 kind=exact 的路由')
      const p = String(path ?? '')
      if (p === '' || typeof handler !== 'function') throw new Error('register 需要 path 与 handler')
      routes.set(p, handler)
      return () => {
        if (routes.get(p) === handler) routes.delete(p)
      }
    },
    listen(host, port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.removeListener('error', reject)
          resolve(server)
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

export function listenAddr() {
  const port = Number.parseInt(String(process.env.PORT ?? '8787'), 10)
  return { host: '127.0.0.1', port: Number.isInteger(port) && port > 0 ? port : 8787 }
}
