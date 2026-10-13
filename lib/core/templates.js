/**
 * dsh-writer-m — 结构模版库（「根据模版或样例模仿写作」的载体）
 *
 * 明确边界：**这里模仿的是结构，不是文风**。
 * 模版只描述骨架（有哪几节、每节干什么）、篇幅与硬约束，不携带任何样例原文。
 * 理由不是省事——长文任务里把样例原文反复塞进上下文，两轮就把预算吃满；
 * 而且「语气迁移」和「结构模仿」是两种互不兼容的需求，混在一起两头都做不好。
 *
 * 模版文件格式：Markdown + 头部 frontmatter 块（用 --- 分隔，手写解析，不引 yaml 依赖）。
 *   ---
 *   id: xhs-ganhuo
 *   name: 小红书·干货清单型
 *   genre: xiaohongshu
 *   sections:
 *     - 钩子｜一句话制造好奇或共鸣
 *   constraints:
 *     - 全文 300-600 字
 *   ---
 *   （正文可写使用说明，会被忽略或当作备注）
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readTextSafe, writeAtomic, slugify, resolveInside } from './fsx.js'

/** 内置模版随包发布在 templates/ 下；用户模版落在 <root>/.dsh-writer-m/templates/。 */
export const TEMPLATE_DIR_NAME = 'templates'
export const STATE_DIR_NAME = '.dsh-writer-m'

/**
 * 解析模版文件。手写而非引 yaml：格式被我们限定成「顶层 key + 短横线数组」，
 * 引一个 yaml 依赖只为解析这十几行不划算，而且多一个 peer 就多一处版本坑。
 * @param {string} text 模版文件全文
 * @param {{id?: string, source?: string, path?: string}} fallback 解析失败时的兜底元信息
 */
export function parseTemplate(text, fallback = {}) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '')
  const meta = {
    id: fallback.id ?? 'unnamed',
    name: fallback.id ?? '未命名模版',
    genre: '',
    sections: [],
    constraints: [],
    note: '',
    source: fallback.source ?? 'user',
    path: fallback.path ?? '',
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (match === null) {
    // 没有 frontmatter 也接受：整篇当备注，用户至少能看到内容
    meta.note = raw.trim()
    return meta
  }
  const body = raw.slice(match[0].length)
  meta.note = body.trim()
  let currentList = null
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '') continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null && currentList !== null) {
      meta[currentList].push(item[1].trim())
      continue
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1]
    const value = kv[2].trim()
    if (key === 'sections' || key === 'constraints') {
      currentList = key
      if (value !== '') meta[key].push(value)
      continue
    }
    currentList = null
    if (key === 'id' || key === 'name' || key === 'genre') meta[key] = value
  }
  if (meta.name === fallback.id) meta.name = meta.id
  return meta
}

/** 把模版渲染成注入提示词的文本块。没套模版时返回空串，让提示词自然退化。 */
export function renderTemplateBlock(template) {
  if (template === null || template === undefined) return ''
  const lines = [`【必须遵循的结构模版：${template.name}】`]
  if (template.sections.length > 0) {
    lines.push('骨架（按此顺序分节，每节用二级标题）：')
    template.sections.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
  }
  if (template.constraints.length > 0) {
    lines.push('硬约束：')
    template.constraints.forEach((c) => lines.push(`- ${c}`))
  }
  lines.push('除上述骨架与约束外，不要引入模版之外的段落结构。')
  return '\n' + lines.join('\n') + '\n'
}

/** 列出内置 + 用户模版。内置目录由调用方传入（包内 templates/）。 */
export async function listTemplates({ builtinDir, root }) {
  const out = []
  const seen = new Set()
  const read = async (dir, source) => {
    let names = []
    try {
      names = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
        .map((e) => e.name)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      const meta = parseTemplate(await readTextSafe(path), {
        id: name.replace(/\.md$/i, ''),
        source,
        path,
      })
      if (seen.has(meta.id)) continue
      seen.add(meta.id)
      out.push(meta)
    }
  }
  if (typeof builtinDir === 'string' && builtinDir !== '') await read(builtinDir, 'builtin')
  if (typeof root === 'string' && root !== '') {
    await read(resolveInside(root, STATE_DIR_NAME, TEMPLATE_DIR_NAME), 'user')
  }
  return out.sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'builtin' ? -1 : 1))
}

export async function loadTemplate({ builtinDir, root, id }) {
  const all = await listTemplates({ builtinDir, root })
  return all.find((t) => t.id === id) ?? null
}

/** 保存用户模版（含「从样例提炼出来的模版」）。 */
export async function saveTemplate({ root, template, text }) {
  const id = slugify(template.id ?? template.name, 'template')
  const path = resolveInside(root, STATE_DIR_NAME, TEMPLATE_DIR_NAME, `${id}.md`)
  const lines = ['---', `id: ${id}`, `name: ${template.name ?? id}`]
  if (template.genre) lines.push(`genre: ${template.genre}`)
  lines.push('sections:')
  for (const s of template.sections ?? []) lines.push(`  - ${s}`)
  lines.push('constraints:')
  for (const c of template.constraints ?? []) lines.push(`  - ${c}`)
  lines.push('---', '', text ?? template.note ?? '')
  await writeAtomic(path, lines.join('\n') + '\n')
  return { id, path }
}

/** 提炼样例结构的提示词：这是「样例 → 模版」那一步的唯一输入契约。 */
export function sampleAnalysisPrompts({ sample, genreLabel, extra }) {
  const system =
    '你是内容结构分析师。你的任务是**只提取结构，不提取措辞**。\n' +
    '你输出的是可复用的骨架：有哪几节、每节承担什么功能、篇幅与硬约束是什么。\n' +
    '你绝不复制样例里的原句、比喻、专有名词、金句——那些是内容，不是结构。'
  const user =
    `分析下面这篇${genreLabel}样例的结构，输出一个可复用的结构模版。\n\n` +
    `【样例】\n${sample}\n\n` +
    `${extra === undefined || extra === null || extra === '' ? '' : `【额外要求】\n${extra}\n\n`}` +
    '【输出格式，严格照此】\n' +
    '---\n' +
    'id: （英文小写短横线）\n' +
    'name: （中文模版名）\n' +
    'genre: （novel / wechat / xiaohongshu）\n' +
    'sections:\n' +
    '  - 节名｜这一节要完成的动作\n' +
    'constraints:\n' +
    '  - 一条可判定的硬约束（字数、段长、条数、emoji 数量等）\n' +
    '---\n' +
    '（模版说明：两三句，讲清这套骨架适合什么选题；不要引用样例原文）\n\n' +
    '【自查】输出前确认：sections 里没有出现样例的任何原句或专有名词；constraints 每一条都能被机械判定（字数、条数、段落数），不能是「要生动」这种主观词。'
  return { system, user }
}
