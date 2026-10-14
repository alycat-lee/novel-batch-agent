/**
 * dsh-writer-m — Obsidian 知识库读取（本地 vault）
 *
 * 为什么这里直接读文件而不是 inject dsh-obsidian：
 * dsh-obsidian 只把 12 个 obsidian_* 工具注册给 AGENT（ctx.tools.register），
 * 不 provide 任何服务给其他插件，所以 dsh-writer-m 无法注入它。
 * 而 Obsidian 的 vault 本质就是一摞 Markdown 文件，直接按文件系统读即可。
 *
 * 安全边界：任何路径都必须先过 guardVaultPath（等价 resolveInside），
 * 越界即抛错——vault 路径来自用户配置/自动探测，不能直接拼进 fs。
 */
import { readdir, readFile, rm, stat, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, sep, basename } from 'node:path'
import { homedir } from 'node:os'
import { readTextSafe, writeAtomic } from './fsx.js'

/** 读取 vault 时跳过的目录：Obsidian 内部目录、回收站、git。 */
const EXCLUDED_DIRS = new Set(['.obsidian', '.trash', '.git'])

/** 单条笔记注入提示词时的正文上限（超出截断）。 */
const VAULT_NOTE_CHARS = 3000
/** 参考笔记整块注入提示词的上限。 */
const VAULT_MAX_CHARS = 6000

/**
 * 探测 Obsidian vault 根目录。
 * 从 obsidian.json 里找第一个 open=true 的 vault。
 * Windows 用 %APPDATA%\obsidian\obsidian.json，macOS 用 ~/Library/Application Support，
 * Linux 用 ~/.config。都找不到返回 null。
 */
function detectVaultRoot() {
  const home = homedir()
  const candidates = []
  const appdata = process.env.APPDATA
  if (typeof appdata === 'string' && appdata !== '') candidates.push(join(appdata, 'obsidian', 'obsidian.json'))
  candidates.push(join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'))
  candidates.push(join(home, '.config', 'obsidian', 'obsidian.json'))
  for (const p of candidates) {
    let text = ''
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    if (text === '') continue
    try {
      const data = JSON.parse(text)
      const vaults = data?.vaults
      if (vaults === null || vaults === undefined) continue
      if (Array.isArray(vaults)) {
        const open = vaults.find((v) => v?.open === true)
        if (typeof open?.path === 'string' && open.path !== '') return open.path
      } else if (typeof vaults === 'object') {
        for (const key of Object.keys(vaults)) {
          const v = vaults[key]
          if (v?.open === true && typeof v.path === 'string' && v.path !== '') return v.path
        }
      }
    } catch {
      // obsidian.json 损坏/格式变化：跳过这条候选
    }
  }
  return null
}

/** 解析 vault 根：显式配置优先，否则自动探测；都失败返回 null。 */
export function resolveVaultRoot(configPath) {
  const cfg = String(configPath ?? '').trim()
  if (cfg !== '') return cfg
  return detectVaultRoot()
}

/** 列出 obsidian.json 里注册的所有 vault（id / 名称 / 路径 / open）。数组或对象形式都兼容。 */
export function listVaults() {
  const home = homedir()
  const candidates = []
  const appdata = process.env.APPDATA
  if (typeof appdata === 'string' && appdata !== '') candidates.push(join(appdata, 'obsidian', 'obsidian.json'))
  candidates.push(join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'))
  candidates.push(join(home, '.config', 'obsidian', 'obsidian.json'))
  for (const p of candidates) {
    let text = ''
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    if (text === '') continue
    try {
      const data = JSON.parse(text)
      const vaults = data?.vaults
      if (vaults === null || vaults === undefined) continue
      const out = []
      const push = (id, v) => {
        if (typeof v?.path === 'string' && v.path !== '') {
          out.push({ id: String(id ?? ''), name: basename(v.path), path: v.path, open: v.open === true })
        }
      }
      if (Array.isArray(vaults)) {
        for (const v of vaults) push(v?.id ?? '', v)
      } else if (typeof vaults === 'object') {
        for (const id of Object.keys(vaults)) push(id, vaults[id])
      }
      if (out.length > 0) return out
    } catch {
      // obsidian.json 损坏/格式变化：跳过这条候选
    }
  }
  return []
}

/** 把相对路径解析到 vault 之内，越界即抛错（等价 resolveInside，但根是 vault）。 */
export function guardVaultPath(vaultRoot, rel) {
  const base = resolve(String(vaultRoot ?? ''))
  const abs = resolve(base, String(rel ?? ''))
  const r = relative(base, abs)
  if (r !== '' && (r === '..' || r.startsWith('..' + sep) || isAbsolute(r))) {
    throw new Error('路径越界：' + abs + ' 不在 vault 根 ' + base + ' 内')
  }
  return abs
}

// ---------------------------------------------------------------------------
// 三部分目录：爆款原文（原料）/ 拆书资产（半成品）/ 作品（成品）。
// 三个子目录都可配置、缺省用默认值；全部相对 vault 根，互相不许嵌套。
// ---------------------------------------------------------------------------

export const VAULT_DIR_DEFAULTS = {
  source: 'dsh-writer-m/爆款原文',
  assets: 'dsh-writer-m/拆书资产',
  works: 'dsh-writer-m/作品',
}

/** 从配置解析三个 vault 子目录（相对 vault 根；空串回落默认值）。 */
export function vaultDirsOf(cfg) {
  const pick = (v, fallback) => {
    const s = String(v ?? '').trim()
    return s === '' ? fallback : s
  }
  return {
    source: pick(cfg?.vaultSourceDir, VAULT_DIR_DEFAULTS.source),
    assets: pick(cfg?.vaultAssetsDir, VAULT_DIR_DEFAULTS.assets),
    works: pick(cfg?.vaultWorksDir, VAULT_DIR_DEFAULTS.works),
  }
}

/** 单个目录配置是否合法：非空、相对路径、不含越界段。返回错误串或 ''。 */
function vaultDirError(label, dir) {
  const s = String(dir ?? '').trim()
  if (s === '') return label + '不能为空'
  if (isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) return label + '必须是 vault 内的相对路径：' + s
  const parts = s.split(/[\\/]+/).filter((p) => p !== '')
  if (parts.some((p) => p === '..')) return label + '不允许包含 ..：' + s
  return ''
}

/** 校验三个目录配置：各自合法 + 互不嵌套。返回错误串或 ''（合法）。 */
export function validateVaultDirs(cfg) {
  const dirs = vaultDirsOf(cfg)
  const labels = { source: '爆款原文目录', assets: '拆书资产目录', works: '作品目录' }
  for (const key of ['source', 'assets', 'works']) {
    const err = vaultDirError(labels[key], dirs[key])
    if (err !== '') return err
  }
  const norm = (s) => s.split(/[\\/]+/).filter((p) => p !== '').join('/')
  const list = ['source', 'assets', 'works'].map((k) => ({ key: k, path: norm(dirs[k]) }))
  for (let i = 0; i < list.length; i += 1) {
    for (let j = 0; j < list.length; j += 1) {
      if (i === j) continue
      const a = list[i]
      const b = list[j]
      if (a.path === b.path || a.path.startsWith(b.path + '/')) {
        return labels[a.key] + '（' + a.path + '）与' + labels[b.key] + '（' + b.path + '）互相嵌套或重复，请改成互相独立的目录'
      }
    }
  }
  return ''
}

/** 轻量解析 md 文件头部的几个 frontmatter 字段（只读前 2KB，手写解析不引 yaml）。 */
export function peekFrontmatter(text) {
  const meta = {}
  const raw = String(text ?? '').replace(/^﻿/, '')
  const m = /^---\r?\n([\s\S]{0,2048}?)\r?\n---/.exec(raw)
  if (m === null) return meta
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_一-鿿][A-Za-z0-9_一-鿿]*)\s*:\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1]
    if (['type', 'name', '状态', '作品', '来源书名', 'genre'].includes(key)) meta[key] = kv[2].trim()
  }
  return meta
}

/**
 * 列出 vault 内某目录的一层内容（子目录 + .md 文件），供工作台「书库」页浏览。
 * 返回 entries：[{ name, rel, kind: 'dir'|'file', size, mtime, meta }]，目录在前、按名称排。
 */
export async function listVaultTree(vaultRoot, relDir) {
  const base = guardVaultPath(vaultRoot, relDir)
  let items = []
  try {
    items = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const it of items) {
    if (it.name.startsWith('.') || EXCLUDED_DIRS.has(it.name)) continue
    const rel = String(relDir ?? '').replace(/\/+$/, '') + '/' + it.name
    if (it.isDirectory()) {
      out.push({ name: it.name, rel, kind: 'dir' })
      continue
    }
    if (!it.isFile() || !it.name.toLowerCase().endsWith('.md')) continue
    const abs = guardVaultPath(vaultRoot, rel)
    let size = 0
    let mtime = ''
    let meta = {}
    try {
      const st = await stat(abs)
      size = st.size
      mtime = st.mtime.toISOString()
      const head = await readTextSafe(abs)
      meta = peekFrontmatter(head.slice(0, 2200))
    } catch {
      /* 读不到的文件照列，只是没有元信息 */
    }
    out.push({ name: it.name, rel, kind: 'file', size, mtime, meta })
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
  return out
}

/** 统计目录下的 .md 文件数（浅层递归，封顶 999，只用于概览卡片）。 */
export async function countVaultFiles(vaultRoot, relDir, cap = 999) {
  const base = guardVaultPath(vaultRoot, relDir)
  let count = 0
  const walk = async (dir, depth) => {
    if (count >= cap || depth > 4) return
    let items = []
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      if (count >= cap) return
      if (it.name.startsWith('.') || EXCLUDED_DIRS.has(it.name)) continue
      if (it.isDirectory()) await walk(join(dir, it.name), depth + 1)
      else if (it.isFile() && it.name.toLowerCase().endsWith('.md')) count += 1
    }
  }
  await walk(base, 0)
  return count
}

/** 读取 vault 内文本（限长），供书库页预览。 */
export async function readVaultText(vaultRoot, rel, maxChars = 4000) {
  const abs = guardVaultPath(vaultRoot, rel)
  const text = await readTextSafe(abs)
  return String(text).slice(0, Math.max(200, Number(maxChars) || 4000))
}

/**
 * 初始化书库目录：把三个树（原文/资产/作品）与资产树的标准子目录一次性建齐。
 * 已存在的目录不动；返回每棵树是「新建」还是「已存在」，前端如实展示。
 */
export async function ensureVaultDirs(vaultRoot, dirs) {
  const plan = [
    { key: 'source', rel: dirs.source },
    { key: 'assets', rel: dirs.assets },
    { key: 'assets', rel: dirs.assets + '/拆书库' },
    { key: 'assets', rel: dirs.assets + '/风格' },
    { key: 'assets', rel: dirs.assets + '/模版' },
    { key: 'works', rel: dirs.works },
  ]
  const created = []
  const existed = []
  for (const item of plan) {
    const abs = guardVaultPath(vaultRoot, item.rel)
    try {
      await stat(abs)
      if (existed.includes(item.rel) === false) existed.push(item.rel)
    } catch {
      await mkdir(abs, { recursive: true })
      created.push(item.rel)
    }
  }
  return { created, existed }
}

/** 把内容写进 vault（用于把生成的小说/模版镜像到 Obsidian 知识库）。相对路径过 guardVaultPath 越界校验。 */
export async function writeVaultFile(vaultRoot, rel, text) {
  const path = guardVaultPath(vaultRoot, rel)
  await writeAtomic(path, text)
  return path
}

/**
 * 删除 vault 内的一个镜像文件/目录（删作品时顺带清理镜像，避免 Obsidian 里留孤儿目录）。
 * 相对路径同样过 guardVaultPath；并拒绝把 vault 根目录本身当作删除目标。
 */
export async function removeVaultDir(vaultRoot, rel) {
  const base = resolve(String(vaultRoot ?? ''))
  const path = guardVaultPath(vaultRoot, rel)
  if (path === base) throw new Error('拒绝删除 vault 根目录：' + base)
  await rm(path, { recursive: true, force: true })
  return path
}

/**
 * 删除 vault 内的单个文件（不存在则静默）。用于「还原内置提示词」清掉库里那篇笔记，
 * 否则笔记还在、读回来依旧覆盖内置，用户会以为「还原没生效」。
 */
export async function removeVaultFile(vaultRoot, rel) {
  const base = resolve(String(vaultRoot ?? ''))
  const path = guardVaultPath(vaultRoot, rel)
  if (path === base) throw new Error('拒绝删除 vault 根目录：' + base)
  await rm(path, { force: true })
  return path
}

/** 解析笔记 frontmatter（简化：title 单独取，其余键原样进 frontmatter 对象）。 */
function parseNoteFrontmatter(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (match === null) return { title: '', frontmatter: {}, content: raw }
  const fm = {}
  let currentList = null
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '') continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null) {
      if (currentList === null) continue
      if (!Array.isArray(fm[currentList])) fm[currentList] = fm[currentList] === undefined ? [] : [fm[currentList]]
      fm[currentList].push(item[1].trim())
      continue
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1]
    const value = kv[2].trim()
    if (value === '') {
      fm[key] = []
      currentList = key
    } else if (Array.isArray(fm[key])) {
      fm[key].push(value)
      currentList = key
    } else {
      fm[key] = value
      currentList = key
    }
  }
  return { title: typeof fm.title === 'string' ? fm.title : '', frontmatter: fm, content: raw.slice(match[0].length) }
}

/**
 * 列出 vault 里所有 .md 笔记（递归，跳过隐藏目录），返回相对路径 + 标题。
 * opts.exclude：要跳过的相对路径前缀（如 'dsh-writer-m/提示词'）——插件自己的库目录
 * 不该混进「参考笔记」列表，否则用户选参考素材时会看到一堆提示词/画像笔记。
 */
export async function listVaultNotes(vaultRoot, opts = {}) {
  const out = []
  if (typeof vaultRoot !== 'string' || vaultRoot === '') return out
  const dir = opts.dir !== undefined && opts.dir !== '' ? guardVaultPath(vaultRoot, opts.dir) : resolve(vaultRoot)
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 500
  const excludes = (Array.isArray(opts.exclude) ? opts.exclude : [])
    .map((p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter((p) => p !== '')
  const excluded = (rel) => excludes.some((ex) => rel === ex || rel.startsWith(ex + '/'))
  async function walk(cur, relBase) {
    if (out.length >= limit) return
    let entries = []
    try {
      entries = await readdir(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= limit) return
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name) || e.name.startsWith('.')) continue
        const relDir = relBase === '' ? e.name : relBase + '/' + e.name
        if (excluded(relDir)) continue
        await walk(join(cur, e.name), relDir)
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const rel = relBase === '' ? e.name : relBase + '/' + e.name
        if (excluded(rel)) continue
        out.push({ path: rel, title: e.name.replace(/\.md$/i, '') })
      }
    }
  }
  await walk(dir, '')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** 读一条笔记，返回 frontmatter + 正文（存在与否用 exists 标记，坏路径不抛）。 */
export async function readVaultNote(vaultRoot, rel) {
  const relStr = String(rel ?? '').trim()
  if (relStr === '') return { path: '', title: '', frontmatter: {}, content: '', exists: false }
  const path = guardVaultPath(vaultRoot, relStr)
  const text = await readTextSafe(path)
  if (text === '') return { path: relStr, title: '', frontmatter: {}, content: '', exists: false }
  const parsed = parseNoteFrontmatter(text)
  const title = parsed.title !== '' ? parsed.title : relStr.replace(/\.md$/i, '')
  return { path: relStr, title, frontmatter: parsed.frontmatter, content: parsed.content, exists: true }
}

/** 按关键词搜笔记（标题 + 正文，大小写不敏感），返回带片段的结果。 */
export async function searchVaultNotes(vaultRoot, query, opts = {}) {
  const q = String(query ?? '').trim().toLowerCase()
  const out = []
  if (q === '' || typeof vaultRoot !== 'string' || vaultRoot === '') return out
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50
  const scanLimit = Number.isInteger(opts.scanLimit) && opts.scanLimit > 0 ? opts.scanLimit : 1000
  const notes = await listVaultNotes(vaultRoot, { limit: scanLimit, exclude: opts.exclude })
  for (const n of notes) {
    if (out.length >= limit) break
    if (n.title.toLowerCase().includes(q)) {
      out.push({ path: n.path, title: n.title, snippet: '' })
      continue
    }
    let text = ''
    try {
      text = await readFile(guardVaultPath(vaultRoot, n.path), 'utf8')
    } catch {
      continue
    }
    const idx = text.toLowerCase().indexOf(q)
    if (idx === -1) continue
    const start = Math.max(0, idx - 60)
    const snippet = (start > 0 ? '…' : '') + text.slice(start, idx + 120).replace(/\s+/g, ' ').trim()
    out.push({ path: n.path, title: n.title, snippet })
  }
  return out
}

/** 把选中的笔记路径解析成可注入的笔记对象（单条坏路径不阻断整体）。 */
export async function resolveVaultNotes(vaultRoot, paths) {
  const list = Array.isArray(paths) ? paths : []
  const out = []
  for (const p of list) {
    const rel = String(p ?? '').trim()
    if (rel === '') continue
    try {
      const n = await readVaultNote(vaultRoot, rel)
      if (n.exists) out.push(n)
    } catch {
      // 单条笔记读不到（已删/改名/越界）不阻断整次生成
    }
  }
  return out
}

/** 把笔记列表渲染成注入提示词的文本块，有界裁剪。 */
export function renderVaultBlock(notes, maxChars = VAULT_MAX_CHARS) {
  const list = Array.isArray(notes) ? notes : []
  if (list.length === 0) return ''
  const cap = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : VAULT_MAX_CHARS
  const blocks = []
  let total = 0
  for (const n of list) {
    const title = String(n?.title ?? n?.path ?? '未命名笔记')
    const body = String(n?.content ?? '').trim()
    if (body === '') continue
    const header = '## ' + title + '\n'
    const remain = cap - total - header.length
    if (remain <= 40) break
    const chunk = body.slice(0, Math.min(remain, VAULT_NOTE_CHARS))
    const clipped = chunk.length < body.length ? chunk + '\n…（笔记较长，已截断）' : chunk
    blocks.push(header + clipped)
    total += header.length + clipped.length
  }
  if (blocks.length === 0) return ''
  return '\n【参考笔记（来自 Obsidian 知识库）】\n' + blocks.join('\n\n') + '\n'
}
