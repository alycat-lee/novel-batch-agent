/**
 * dsh-writer-m — Obsidian 库（小说提示词 / 风格画像）
 *
 * 把 vault 当**可编辑的库**用，而不是单向镜像的垃圾桶：
 *   <vault>/dsh-writer-m/提示词/<genre>-<step>.md   每步提示词（system / user 两段）
 *   <vault>/dsh-writer-m/风格画像/<id>.md           七维风格画像（与本地 styles 同格式）
 *
 * 读回来时 vault 侧**优先于**本地（本地 prompts.json 覆盖、本地 styles 目录），
 * 于是「在 Obsidian 里改一下提示词/画像」立刻对下一次生成生效，不需要再点导入。
 *
 * 解析约定（写出去和读回来共用，见 renderPromptNote / parsePromptNote）：
 * frontmatter 带 genre / step 两个键；正文里 `## system` 与 `## user` 两个二级标题
 * 各带一段文本。任何解析不出这两段的笔记都会被忽略（用户可以在同一目录放说明笔记）。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseStyle } from './styles.js'

/** vault 里属于本插件的根目录名（与 index.js 的 VAULT_MIRROR_DIR 保持一致）。 */
export const VAULT_LIB_DIR = 'dsh-writer-m'
export const VAULT_LIB_PROMPTS = '提示词'
export const VAULT_LIB_STYLES = '风格画像'

/** 提示词笔记的相对路径（用 / 拼，vault 是跨平台的相对路径语义）。 */
export function promptNoteRel(genreId, stepId) {
  return VAULT_LIB_DIR + '/' + VAULT_LIB_PROMPTS + '/' + String(genreId) + '-' + String(stepId) + '.md'
}

/** 风格画像笔记的相对路径。 */
export function styleNoteRel(id) {
  return VAULT_LIB_DIR + '/' + VAULT_LIB_STYLES + '/' + String(id) + '.md'
}

const SECTION_RE = /^##\s*(system|user)\b[^\n]*$/gim

/** 按 `## system` / `## user` 切段；同名单标记出现多次时内容按顺序拼接。 */
function splitPromptSections(body) {
  const text = String(body ?? '')
  const marks = []
  SECTION_RE.lastIndex = 0
  let m = SECTION_RE.exec(text)
  while (m !== null) {
    marks.push({ label: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length })
    m = SECTION_RE.exec(text)
  }
  const out = {}
  if (marks.length === 0) return out
  for (let i = 0; i < marks.length; i += 1) {
    const cur = marks[i]
    const stop = i + 1 < marks.length ? marks[i + 1].start : text.length
    const chunk = text.slice(cur.end, stop)
    out[cur.label] = out[cur.label] === undefined ? chunk : out[cur.label] + '\n' + chunk
  }
  return out
}

/**
 * 解析一份提示词笔记。解析不出（没有 frontmatter 的 genre/step，或没有 system/user 段）时返回 null。
 * @returns {{genreId: string, stepId: string, system: string, user: string} | null}
 */
export function parsePromptNote(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '')
  const head = {}
  let body = raw
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (fm !== null) {
    body = raw.slice(fm[0].length)
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
      if (kv === null) continue
      head[kv[1].toLowerCase()] = kv[2].trim()
    }
  }
  const genreId = String(head.genre ?? '').trim()
  const stepId = String(head.step ?? '').trim()
  if (genreId === '' || stepId === '') return null
  const sec = splitPromptSections(body)
  if (sec.system === undefined && sec.user === undefined) return null
  return {
    genreId,
    stepId,
    system: sec.system === undefined ? '' : sec.system.trim(),
    user: sec.user === undefined ? '' : sec.user.trim(),
  }
}

/** 渲染一份提示词笔记（带自解释的使用说明，用户直接改正文即可）。 */
export function renderPromptNote(input) {
  const genreId = String(input?.genreId ?? '')
  const stepId = String(input?.stepId ?? '')
  const stepNo = input?.stepNo === undefined || input?.stepNo === null ? '' : String(input.stepNo) + '. '
  const label = String(input?.label ?? '') === '' ? genreId + ':' + stepId : String(input.label)
  const goal = String(input?.goal ?? '')
  const system = String(input?.system ?? '').trim()
  const user = String(input?.user ?? '').trim()
  const lines = [
    '---',
    'id: ' + genreId + ':' + stepId,
    'genre: ' + genreId,
    'step: ' + stepId,
    '---',
    '',
    '# ' + stepNo + label + ' · 提示词',
    '',
    '> 这是 dsh-writer-m 的提示词笔记：**Obsidian 里的这份笔记优先级最高**——',
    '> 直接改下面的段落就能覆盖插件内置提示词，下一次生成立刻生效，不需要导入。',
    '> 想恢复内置版本：在插件里点这一步的「还原内置」，插件会删掉这篇笔记。',
    goal === '' ? '' : '> 这一步的目标：' + goal,
    '',
    '## system',
    '',
    system,
    '',
    '## user',
    '',
    user,
    '',
  ]
  return lines.filter((l, i) => !(l === '' && lines[i - 1] === '')).join('\n')
}

/** 读 vault 里的提示词库：{'<genre>:<step>': {system, user, path}}，坏笔记进 errors。 */
export async function readPromptLibrary(vaultRoot) {
  const notes = {}
  const errors = []
  if (typeof vaultRoot !== 'string' || vaultRoot === '') return { notes, errors }
  const dir = join(vaultRoot, VAULT_LIB_DIR, VAULT_LIB_PROMPTS)
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { notes, errors }
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue
    const rel = VAULT_LIB_DIR + '/' + VAULT_LIB_PROMPTS + '/' + e.name
    let text = ''
    try {
      text = await readFile(join(dir, e.name), 'utf8')
    } catch {
      continue
    }
    const parsed = parsePromptNote(text)
    if (parsed === null) {
      errors.push(rel)
      continue
    }
    notes[parsed.genreId + ':' + parsed.stepId] = { system: parsed.system, user: parsed.user, path: rel }
  }
  return { notes, errors }
}

/** 读 vault 里的风格画像库：与本地 styles 同结构（parseStyle 的产物），source 标成 vault。 */
export async function readStyleLibrary(vaultRoot) {
  const out = []
  if (typeof vaultRoot !== 'string' || vaultRoot === '') return out
  const dir = join(vaultRoot, VAULT_LIB_DIR, VAULT_LIB_STYLES)
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue
    const id = e.name.replace(/\.md$/i, '')
    const rel = VAULT_LIB_DIR + '/' + VAULT_LIB_STYLES + '/' + e.name
    let text = ''
    try {
      text = await readFile(join(dir, e.name), 'utf8')
    } catch {
      continue
    }
    if (text.trim() === '') continue
    out.push(parseStyle(text, { id, source: 'vault', path: rel }))
  }
  return out
}
