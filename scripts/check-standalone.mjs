/**
 * 独立宿主验收：MOCK_LLM 下拉起 server/main.js，验证
 *   1. POST /api/state 200 且含 genres
 *   2. batch/create 一本 targetChapters=3 跑到 done，磁盘产物齐全
 *   3. 中途 kill 重启后 resume，已落盘步不重写
 *   4. POST config 改 maxTokens 落盘，重启仍在
 *   5. GET / 工作台入口可返回，并能拉到 state 首屏字段
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)))
const fails = []
const ok = (label, cond) => {
  if (cond === true) console.log('  ok   ' + label)
  else {
    console.log('  FAIL ' + label)
    fails.push(label)
  }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function hashText(s) {
  return createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex')
}

async function api(origin, path, body) {
  const res = await fetch(origin + '/dsh-writer-m/api/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  let data = {}
  try { data = await res.json() } catch { data = {} }
  return { status: res.status, data }
}

function startServer({ root, port, delayMs = 0, extraEnv = {} }) {
  const env = {
    ...process.env,
    MOCK_LLM: '1',
    WRITER_ROOT: root,
    PORT: String(port),
    MOCK_LLM_DELAY_MS: String(delayMs),
    ...extraEnv,
  }
  const child = spawn(process.execPath, [join(pkgDir, 'server', 'main.js')], {
    cwd: pkgDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let out = ''
  let exitInfo = null
  child.stdout.on('data', (b) => { out += b.toString('utf8') })
  child.stderr.on('data', (b) => { out += b.toString('utf8') })
  child.on('exit', (code, signal) => { exitInfo = { code, signal } })
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('启动超时\n' + out.slice(-2000))), 20000)
    const onData = () => {
      if (/工作台/.test(out) || /listening/i.test(out)) {
        clearTimeout(t)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(t)
      reject(new Error('进程提前退出 ' + code + '\n' + out.slice(-2000)))
    })
  })
  return {
    child,
    ready,
    output: () => out,
    exited: () => exitInfo,
    async stop() {
      if (child.exitCode !== null || child.killed) return
      child.kill()
      await new Promise((r) => {
        const t = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* win */ }
          r()
        }, 3000)
        child.once('exit', () => { clearTimeout(t); r() })
      })
    },
  }
}

async function waitReady(origin, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await api(origin, 'state', {})
      if (r.status === 200) return r
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('API 一直没起来：' + origin)
}

async function pollDone(origin, id, ms = 120000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const r = await api(origin, 'batch/status', { id })
    const t = r.data?.task
    if (t && (t.status === 'done' || t.status === 'failed')) return t
    await new Promise((x) => setTimeout(x, 300))
  }
  const last = await api(origin, 'batch/status', { id })
  throw new Error('等待 done 超时：' + JSON.stringify(last.data))
}

async function fileExists(p) {
  try {
    const st = await stat(p)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
console.log('== 构建客户端 ==')
{
  const built = spawnSync(process.execPath, [join(pkgDir, 'scripts', 'build-client.mjs')], { cwd: pkgDir, encoding: 'utf8' })
  ok('build-client 退出 0', built.status === 0)
  if (built.status !== 0) console.log(built.stdout + built.stderr)
}

const root = await mkdtemp(join(tmpdir(), 'nba-stand-'))
const port = await freePort()
const origin = 'http://127.0.0.1:' + port
let srv = startServer({ root, port, delayMs: 0 })

try {
  await srv.ready
  await waitReady(origin)

  console.log('== 1. state ==')
  const st = await api(origin, 'state', {})
  ok('POST state 返回 200', st.status === 200)
  ok('state 含 genres', Array.isArray(st.data.genres) && st.data.genres.some((g) => g.id === 'novel'))
  ok('小说 7 步', (st.data.genres.find((g) => g.id === 'novel')?.steps ?? []).length === 7)

  console.log('== 2. batch 一本三章 ==')
  const created = await api(origin, 'batch/create', {
    books: [{
      bookName: '验收长夜',
      channel: 'male',
      idea: '坊市杂役逆袭',
      targetChapters: 3,
      chapterChars: 400,
    }],
  })
  ok('batch/create 200', created.status === 200 && created.data.count === 1)
  const taskId = created.data.tasks[0].id
  const done = await pollDone(origin, taskId)
  ok('任务 status=done', done.status === 'done')
  const bookDir = join(root, '验收长夜')
  const stepFiles = ['01-作品定位.md', '02-大纲.md', '03-人物.md', '04-卷大纲.md']
  for (const f of stepFiles) {
    ok('存在 steps/' + f, await fileExists(join(bookDir, 'steps', f)))
  }
  let outlines = []
  try { outlines = (await readdir(join(bookDir, 'chapter-outlines'))).filter((n) => n.endsWith('.md')) } catch { outlines = [] }
  ok('存在 chapter-outlines', outlines.length > 0)
  for (const n of [1, 2, 3]) {
    const name = '第' + String(n).padStart(3, '0') + '章.md'
    ok('存在 chapters/' + name, await fileExists(join(bookDir, 'chapters', name)))
  }
  const proj = JSON.parse(await readFile(join(bookDir, 'project.json'), 'utf8'))
  ok('project.json 书名/类型一致', proj.name === '验收长夜' && proj.genre === 'novel')
  ok('project.json 单章字数一致', Number(proj.words) === 400)

  console.log('== 5. config 落盘 ==')
  let cfgPost = null
  let lastErr = null
  for (let i = 0; i < 5; i += 1) {
    try {
      cfgPost = await api(origin, 'config', { patch: { maxTokens: 3210 } })
      lastErr = null
      break
    } catch (error) {
      lastErr = error
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  if (cfgPost === null) throw lastErr ?? new Error('POST config 失败' + (srv.exited() ? ' 服务已退出 ' + JSON.stringify(srv.exited()) : '') + '\n' + srv.output().slice(-1500))
  ok('POST config persisted', cfgPost.status === 200 && cfgPost.data.persisted === true)
  const cfgDisk = JSON.parse(await readFile(join(root, '.agent-config.json'), 'utf8'))
  ok('.agent-config.json maxTokens=3210', cfgDisk.maxTokens === 3210)
  await srv.stop()
  srv = startServer({ root, port, delayMs: 0 })
  await srv.ready
  await waitReady(origin)
  const st2 = await api(origin, 'state', {})
  ok('重启后 maxTokens 仍为 3210', st2.data?.config?.maxTokens === 3210)

  console.log('== 4. check-render（对着本机工作台） ==')
  const rendered = spawnSync(process.execPath, [join(pkgDir, 'scripts', 'check-render.mjs'), origin], {
    cwd: pkgDir,
    encoding: 'utf8',
    timeout: 30000,
  })
  process.stdout.write(rendered.stdout || '')
  if (rendered.stderr) process.stderr.write(rendered.stderr)
  ok('check-render 退出 0', rendered.status === 0)

  console.log('== 6. 工作台入口 ==')
  await new Promise((r) => setTimeout(r, 200))
  const home = await fetch(origin + '/', { headers: { connection: 'close' } })
  const html = await home.text()
  ok('GET / 200', home.status === 200)
  ok('入口含 root 与 ModuleLoader', html.includes('id="root"') && html.includes('__ModuleLoader__'))
  const client = await fetch(origin + '/client.js')
  ok('GET /client.js 200', client.status === 200)
  const body = await client.text()
  ok('client.js 登记 dsh-writer-m', body.includes("id: 'dsh-writer-m'") || body.includes('id: "dsh-writer-m"'))
  ok('state 首屏含 templates/styles/projects', Array.isArray(st2.data.templates) && Array.isArray(st2.data.styles) && Array.isArray(st2.data.projects))

  await srv.stop()
} catch (error) {
  fails.push('主流程抛错：' + (error instanceof Error ? error.message : String(error)))
  console.log('  FAIL 主流程', error)
  console.log('  server output:\n' + srv.output().slice(-2000))
  console.log('  server exit:', srv.exited())
  try { await srv.stop() } catch { /* 已停 */ }
}

console.log('== 3. kill 重启续跑 ==')
const root2 = await mkdtemp(join(tmpdir(), 'nba-kill-'))
const port2 = await freePort()
const origin2 = 'http://127.0.0.1:' + port2
let srv2 = startServer({ root: root2, port: port2, delayMs: 250 })
try {
  await srv2.ready
  await waitReady(origin2)
  const created = await api(origin2, 'batch/create', {
    books: [{
      bookName: '断点续跑',
      channel: 'male',
      idea: '杀进程再接着写',
      targetChapters: 3,
      chapterChars: 400,
    }],
  })
  const taskId = created.data.tasks[0].id
  const bookDir = join(root2, '断点续跑')
  const first = join(bookDir, 'steps', '01-作品定位.md')
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    if (await fileExists(first)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  ok('kill 前已有 steps/01', await fileExists(first))
  const before = await readFile(first, 'utf8')
  const beforeHash = hashText(before)
  await srv2.stop()
  srv2 = startServer({ root: root2, port: port2, delayMs: 0 })
  await srv2.ready
  await waitReady(origin2)
  const resumed = await api(origin2, 'batch/resume', { id: taskId })
  ok('resume 被接受', resumed.status === 200)
  const done = await pollDone(origin2, taskId, 180000)
  ok('续跑后 status=done', done.status === 'done')
  const after = await readFile(first, 'utf8')
  ok('已落盘的 01 步未被重写', hashText(after) === beforeHash)
  ok('续跑后三章都在',
    (await fileExists(join(bookDir, 'chapters', '第001章.md'))) &&
    (await fileExists(join(bookDir, 'chapters', '第002章.md'))) &&
    (await fileExists(join(bookDir, 'chapters', '第003章.md')))
  )
  await srv2.stop()
} catch (error) {
  fails.push('续跑抛错：' + (error instanceof Error ? error.message : String(error)))
  console.log('  FAIL 续跑', error)
  try { await srv2.stop() } catch { /* 已停 */ }
} finally {
  await rm(root2, { recursive: true, force: true }).catch(() => {})
}

await rm(root, { recursive: true, force: true }).catch(() => {})

console.log('')
if (fails.length === 0) {
  console.log('独立宿主验收全部通过。')
  process.exit(0)
}
console.log('失败 ' + fails.length + ' 项：')
for (const f of fails) console.log('  - ' + f)
process.exit(1)
