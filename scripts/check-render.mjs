
/**
 * check-render.mjs — 客户端半区「能渲染出来」的回归检查（无浏览器）。
 *
 * 背景：lib/client.js 是浏览器半区，node --check 只能查语法；组件里引用到作用域外的变量
 * （例如把 state 声明在 Workbench 却在 WriteTab 里使用）会让整块面板白屏，而语法检查看不出来。
 * 这里用一个极简 React shim 真渲染 WriterPanel：跑 effect、拉真实 /api/state（拿不到就用内置样例），
 * 再模拟点一次「🗑 删除」按钮，确认进入二次确认态。
 *
 * 用法：node scripts/check-render.mjs [origin]
 */
import { readFileSync } from 'node:fs'

const ORIGIN = process.argv[2] || 'http://127.0.0.1:19387'
const BUNDLE = new URL('../lib/client.js', import.meta.url)

globalThis.location = { origin: ORIGIN }
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}
try { Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true }) } catch {}

const Fragment = Symbol('Fragment')
let current = null
let idx = 0
let dirty = false
const instances = new Map()
const pendingEffects = []
const eq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])

const React = {
  Fragment,
  createElement(type, props, ...children) {
    const p = Object.assign({}, props)
    if (children.length === 1) p.children = children[0]
    else if (children.length > 1) p.children = children
    return { type, props: p }
  },
  useState(init) {
    const i = idx++
    if (current.slots[i] === undefined) current.slots[i] = { v: typeof init === 'function' ? init() : init }
    const s = current.slots[i]
    return [s.v, (nv) => { s.v = typeof nv === 'function' ? nv(s.v) : nv; dirty = true }]
  },
  useEffect(fn, deps) {
    const i = idx++
    const slot = current.slots[i] === undefined ? (current.slots[i] = {}) : current.slots[i]
    if (slot.deps === undefined || !eq(slot.deps, deps)) {
      slot.deps = deps
      const latest = fn
      pendingEffects.push(() => { if (typeof slot.cleanup === 'function') slot.cleanup(); slot.cleanup = latest() })
    }
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef(v) {
    const i = idx++
    if (current.slots[i] === undefined) current.slots[i] = { current: v }
    return current.slots[i]
  },
}

let mod = null
globalThis.window = globalThis
globalThis.__ModuleLoader__ = { load: ({ factory }) => { mod = { exports: factory((name) => { if (name === 'react') return React; throw new Error('require 白名单外：' + name) }) } } }
await import(BUNDLE.href)
if (mod === null) throw new Error('lib/client.js 没有向 __ModuleLoader__ 登记')

const registrations = []
mod.exports.apply({
  slots: { inject: (name, fn) => fn(), register: (meta, comp) => registrations.push({ meta, comp }) },
  layout: { selectPanel: () => {} },
})
const panel = registrations.filter((r) => r.meta.name === 'main').map((r) => r.comp)[0]
if (typeof panel !== 'function') throw new Error('main 槽位没有注册面板组件')

const buttons = []
const selects = []
const clickables = []
function flatText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatText).join(' ')
  return flatText(node.props && node.props.children)
}
function renderNode(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) { node.forEach((n, i) => renderNode(n, path + '/' + i)); return }
  const { type, props } = node
  if (type === Fragment) { renderNode(props.children, path); return }
  if (typeof type === 'function') {
    const key = path + '<' + (type.name || 'anon') + '>'
    if (!instances.has(key)) instances.set(key, { slots: [] })
    const prev = current
    const prevIdx = idx
    current = instances.get(key)
    idx = 0
    let out
    try { out = type(props) } finally { current = prev; idx = prevIdx }
    renderNode(out, key)
    return
  }
  if (typeof type === 'string') {
    if (type === 'select') {
      const opts = []
      const walk = (n) => {
        if (Array.isArray(n)) { n.forEach(walk); return }
        if (n === null || n === undefined || typeof n !== 'object') return
        if (n.type === 'option') { opts.push(String(n.props.value) + ':' + flatText(n.props.children)); return }
        walk(n.props && n.props.children)
      }
      walk(props.children)
      selects.push({ value: props.value, options: opts })
    }
    if (typeof props.onClick === 'function') {
      clickables.push({ type, text: flatText(props.children).trim(), title: typeof props.title === 'string' ? props.title : '', onClick: props.onClick })
    }
  }
  if (type === 'button') {
    const text = typeof props.children === 'string' ? props.children : ''
    buttons.push({ title: typeof props.title === 'string' ? props.title : '', text, onClick: props.onClick })
  }
  renderNode(props && props.children, path + '[' + String(type) + ']')
}

let renders = 0
function renderTree() { renders++; current = null; idx = 0; renderNode(React.createElement(panel, { close: () => {} }), 'root') }
async function settle() {
  for (let round = 0; round < 8; round++) {
    renderTree()
    while (pendingEffects.length > 0) {
      const batch = pendingEffects.splice(0, pendingEffects.length)
      for (const e of batch) await e()
    }
    await new Promise((r) => setTimeout(r, 250))
    if (!dirty && pendingEffects.length === 0) return
    dirty = false
  }
}

const fails = []
await settle()
if (renders < 2) fails.push('渲染轮次异常：只渲染了 ' + renders + ' 次（state 可能没拿到，或面板提前退出）')

buttons.length = 0
renderTree()
const trash = buttons.filter((b) => b.title.indexOf('删除这个作品') >= 0)
if (trash.length === 0) fails.push('作品列表里没渲染出「🗑 删除」按钮（title 含「删除这个作品」）')
else {
  if (typeof trash[0].onClick !== 'function') fails.push('删除按钮没有 onClick')
  else {
    trash[0].onClick()
    await settle()
    buttons.length = 0
    renderTree()
    const hasConfirm = buttons.some((b) => b.text === '确认删除')
    const hasCancel = buttons.some((b) => b.text === '取消')
    if (!hasConfirm || !hasCancel) fails.push('点删除后没有进入二次确认态（确认删除=' + hasConfirm + ' 取消=' + hasCancel + '）')
  }
}

// 「风格画像」卡片：给已有作品换风格的入口，只在打开作品后渲染。
// 旧探针只看作品列表，卡片这段渲染路径没被覆盖——白屏事故就是这么漏过去的。
{
  buttons.length = 0
  selects.length = 0
  clickables.length = 0
  renderTree()
  const cancel = buttons.find((b) => b.text === '取消')
  if (cancel !== undefined) { cancel.onClick(); await settle(); buttons.length = 0; selects.length = 0; clickables.length = 0; renderTree() }
  const opener = clickables.find((c) => c.type === 'div' && c.text !== '' && c.text.indexOf('删除') < 0)
  if (opener === undefined) {
    console.log('skip 风格卡片检查：作品列表里没找到可点击的作品项（可能是空库）')
  } else {
    opener.onClick()
    await settle()
    buttons.length = 0
    selects.length = 0
    clickables.length = 0
    renderTree()
    const styleSel = selects.find((s) => s.options.some((o) => o.indexOf('（不指定风格画像）') >= 0))
    if (styleSel === undefined) fails.push('打开作品后没渲染出「风格画像」下拉（选项里应有「（不指定风格画像）」）')
    else if (styleSel.options.length < 2) fails.push('风格画像下拉里只有默认项：应列出已安装的画像')
    const saveBtn = buttons.find((b) => b.title.indexOf('改完立刻对之后生成') >= 0)
    if (saveBtn === undefined) fails.push('风格画像卡片里没有「保存绑定」按钮')
    else if (saveBtn.text !== '已是最新' && saveBtn.text !== '保存绑定') fails.push('风格保存按钮文案异常：' + saveBtn.text)
    console.log('style card: selects=' + selects.length + ' 选项数=' + (styleSel === undefined ? 0 : styleSel.options.length) + ' 按钮=' + (saveBtn === undefined ? '(无)' : saveBtn.text))
  }
}

console.log('registered: ' + registrations.map((r) => r.meta.name + ':' + (r.meta.key || r.meta.id)).join(', '))
console.log('renders=' + renders + ' instances=' + instances.size + ' buttons=' + buttons.length)
if (fails.length > 0) {
  console.log('FAIL:')
  for (const f of fails) console.log(' - ' + f)
  process.exit(1)
}
console.log('OK — 写作面板可渲染，删除按钮与二次确认态都在')
