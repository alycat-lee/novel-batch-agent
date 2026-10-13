/**
 * 客户端半区契约自检。
 *
 * 不依赖浏览器，也不依赖 dsh：伪造一个 `window.__ModuleLoader__` 和一个最小 react，
 * 按页面真实的加载方式把 lib/client.js 跑一遍，然后检查：
 *   1. 横幅格式正确（向加载器登记包名 + factory）；
 *   2. require 的说明符都在平台模块表里（这里只允许 react）；
 *   3. 导出的 name / inject / apply 齐备，且 apply 能对三个插槽各注册一次。
 *
 * 这三条正好覆盖「仓外客户端插件加载失败」的全部已知原因，所以它是装上前
 * 唯一能给出的实证，而不是「看起来对」。
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = dirname(here)
const file = join(pkgDir, 'lib', 'client.js')
const code = await readFile(file, 'utf8')

const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const problems = []
const required = []

const reactStub = {
  createElement: () => ({}),
  Fragment: Symbol('Fragment'),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
}

const loaded = new Map()
let registeredId = null
let factory = null

globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      if (entry === null || typeof entry !== 'object') {
        problems.push('加载器收到非对象 entry')
        return
      }
      registeredId = entry.id
      factory = entry.factory
    },
  },
}
// Node 25 的 navigator / location 是只读 getter，直接赋值会抛 TypeError，用 defineProperty 覆盖。
for (const [key, value] of [
  ['navigator', { clipboard: { writeText: async () => {} } }],
  ['location', { origin: 'http://127.0.0.1:19387' }],
]) {
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  } catch {
    // 覆盖不了就跳过：这两个全局只影响运行期行为，不影响契约检查
  }
}

await import('file://' + file.replace(/\\/g, '/'))

if (registeredId === null) problems.push('横幅没有调用 window.__ModuleLoader__.load')
else if (registeredId !== 'dsh-writer-m') problems.push(`登记的包名是 ${registeredId}，期望 dsh-writer-m`)

if (typeof factory !== 'function') {
  problems.push('factory 不是函数')
} else {
  const require = (specifier) => {
    required.push(specifier)
    if (!PLATFORM_MODULES.has(specifier)) {
      problems.push(`require('${specifier}') 不在平台模块表里，浏览器会抛错`)
      return {}
    }
    if (specifier === 'react') return reactStub
    return {}
  }
  const exports_ = factory(require)

  if (exports_ === null || typeof exports_ !== 'object') problems.push('factory 没有返回 exports')
  else {
    if (exports_.name !== 'dsh-writer-m') problems.push(`exports.name = ${String(exports_.name)}，期望 dsh-writer-m`)
    if (!Array.isArray(exports_.inject) || !exports_.inject.includes('slots') || !exports_.inject.includes('layout')) problems.push('exports.inject 必须包含 slots')
    if (typeof exports_.apply !== 'function') problems.push('exports.apply 不是函数')
    else {
      const registrations = []
      const injections = []
      const ctx = {
        slots: {
          inject: (name, fn) => {
            injections.push(name)
            fn()
            return () => {}
          },
          register: (definition) => {
            registrations.push(definition)
            return () => {}
          },
        },
        layout: { selectPanel: () => {} },
        effect: (fn) => {
          const off = fn()
          if (typeof off === 'function') off()
        },
      }
      try {
        exports_.apply(ctx)
      } catch (error) {
        problems.push('apply 抛错：' + (error instanceof Error ? error.message : String(error)))
      }
      const want = ['main', 'sidebar.panellist', 'sidebar.right.tab.document.actions']
      for (const slot of want) {
        if (!injections.includes(slot)) problems.push(`没有 inject ${slot}`)
        const hit = registrations.find((r) => r.name === slot)
        if (hit === undefined) problems.push(`没有 register ${slot}`)
        else if (slot === 'main') {
          if (typeof hit.key !== 'string' || hit.key === '') problems.push(`${slot} 缺少 key`)
        } else if (typeof hit.id !== 'string' || hit.id === '') problems.push(`${slot} 缺少 id`)
      }
    }
  }
}

console.log('client bundle:', file)
console.log('registered id:', registeredId)
console.log('require():', [...new Set(required)].join(', '))
if (problems.length === 0) {
  console.log('OK — 横幅格式、require 白名单、exports 与三个插槽注册全部通过')
  process.exit(0)
}
console.log('FAIL:')
for (const p of problems) console.log('  - ' + p)
process.exit(1)
