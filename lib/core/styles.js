/**
 * dsh-writer-m — 风格画像库（「学习其他小说风格」的载体）
 *
 * 与结构模版（templates.js）的分工：
 * - 结构模版描述「骨架」：有哪几节、每节干什么、篇幅与硬约束；
 * - 风格画像描述「文风规律」：叙事视角、句子节奏、对话风格、描写密度、
 *   情绪调性、章节节奏、爽点节奏，外加用于按标签匹配的风格标签。
 *
 * 边界（taste-calibration 铁律）：**只存规律，不存原文**。
 * 用户粘样例小说 → 模型蒸馏出抽象风格画像，画像里绝不出现样例的
 * 原句、比喻、专有名词、金句。理由同结构模版：长文里反复塞原文会把
 * 上下文预算吃满，而且会把别人的内容带进新作品。
 *
 * 风格文件格式：Markdown + frontmatter（--- 分隔，手写解析，不引 yaml）。
 *   ---
 *   id: xianxia-qingsong
 *   name: 仙侠·轻松搞笑
 *   genre: novel
 *   tags:
 *     - 轻松搞笑
 *     - 扮猪吃老虎
 *   pov: 第三人称限知，跟随主角
 *   rhythm: 短句为主，动作句打点
 *   dialogue: 口语化、带插科打诨
 *   description: 低密度，环境只给关键意象
 *   tone: 轻松明快、暗藏爽感
 *   chapterRhythm: 开头抛钩子，中段升级冲突，结尾留悬念
 *   beatRhythm: 每 2-3 章一次打脸 / 逆袭爽点
 *   ---
 *   （正文可写使用说明，会被忽略或当作备注）
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readTextSafe, writeAtomic, slugify, resolveInside } from './fsx.js'
import { STATE_DIR_NAME } from './templates.js'

/** 风格画像落盘目录：<root>/.dsh-writer-m/styles/。 */
export const STYLE_DIR_NAME = 'styles'

/** 风格画像的七个维度：解析、渲染、蒸馏提示词、客户端编辑共用同一份真源。 */
export const STYLE_DIMENSIONS = [
  { id: 'pov', label: '叙事视角' },
  { id: 'rhythm', label: '句子节奏' },
  { id: 'dialogue', label: '对话风格' },
  { id: 'description', label: '描写密度' },
  { id: 'tone', label: '情绪调性' },
  { id: 'chapterRhythm', label: '章节节奏' },
  { id: 'beatRhythm', label: '爽点节奏' },
]
const DIM_IDS = new Set(STYLE_DIMENSIONS.map((d) => d.id))

/**
 * 步骤分类（三类步骤的注入形态不同）。步骤 id 在三种文体里全局唯一，故可直接按 id 判类：
 * - 写正文：小说 chapter、公众号/小红书 body —— 全文七维 + 「严格遵循」指令语；
 * - 润色改写：小说 polish、小红书 deai —— 全文七维 + 「保持」指令语；
 * - 规划：小说的定位/大纲/人物/卷大纲/章节大纲 + 短文的选题/开头/结构/标题/标签
 *   —— 注入七维「文风基调（规划参考）」，只要求与其相容，不要求照此写正文。
 */
const WRITING_STEPS = new Set(['chapter', 'body'])
const POLISH_STEPS = new Set(['polish', 'deai'])
const PLANNING_STEPS = new Set([
  'positioning', 'outline', 'characters', 'volume-outline', 'chapter-outline',
  'topic', 'hook', 'structure', 'title', 'tags',
])

/**
 * 解析风格文件。手写而非引 yaml：格式被限定成「顶层 key + tags 短横线数组 + 七个标量维度」。
 * @param {string} text 风格文件全文
 * @param {{id?: string, source?: string, path?: string}} fallback 解析失败时的兜底元信息
 */
export function parseStyle(text, fallback = {}) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '')
  const meta = {
    id: fallback.id ?? 'unnamed',
    name: fallback.id ?? '未命名风格',
    genre: '',
    tags: [],
    pov: '',
    rhythm: '',
    dialogue: '',
    description: '',
    tone: '',
    chapterRhythm: '',
    beatRhythm: '',
    note: '',
    source: fallback.source ?? 'user',
    path: fallback.path ?? '',
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (match === null) {
    // 没有 frontmatter 也接受：整篇当备注
    meta.note = raw.trim()
    return meta
  }
  meta.note = raw.slice(match[0].length).trim()
  let currentList = null
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '') continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null && currentList === 'tags') {
      meta.tags.push(item[1].trim())
      continue
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1]
    const value = kv[2].trim()
    if (key === 'tags') {
      currentList = 'tags'
      if (value !== '') meta.tags.push(value)
      continue
    }
    currentList = null
    if (key === 'id' || key === 'name' || key === 'genre') meta[key] = value
    else if (DIM_IDS.has(key)) meta[key] = value
  }
  if (meta.name === fallback.id) meta.name = meta.id
  return meta
}

/**
 * 把风格画像渲染成注入提示词的文本块，**按步骤感知**：
 * - 写正文步（chapter/body）：注入完整七维画像，要求严格照此写作；
 * - 润色步（polish/deai）：注入完整七维画像，要求润色时保持此风格；
 * - 规划步（小说五步 + 短文选题/开头/结构/标题/标签）：注入「文风基调（规划参考）」——
 *   七维都给出（否则大纲层看不到视角/节奏等约束，用户会以为画像没生效），
 *   但措辞明确「只做规划、不要照抄文风」，不带强制写作指令语。
 * 没套风格时返回空串，让提示词自然退化。
 */
export function renderStyleBlock(style, stepId) {
  if (style === null || style === undefined) return ''
  const step = String(stepId ?? '')
  const name = style.name ?? style.id ?? '未命名风格'
  if (WRITING_STEPS.has(step) || POLISH_STEPS.has(step)) {
    const verb = WRITING_STEPS.has(step) ? '严格遵循以下风格画像写作' : '润色须保持此风格画像'
    const lines = ['【' + verb + '：' + name + '】']
    for (const d of STYLE_DIMENSIONS) lines.push('- ' + d.label + '：' + (style[d.id] ?? '未限定'))
    // 画像的「短句 / 一句一事 / 描写密度低 / 独立行直插」是**统计出来的文风规律**，
    // 小模型（本地 9B 等）会把它字面执行成「逐句换行、一句一段」（用户 m02059 报障）。
    // 在注入层补一条优先于画像的断行铁律，所有风格画像一次性受益。
    lines.push('【断行铁律（优先于上面的画像）】画像里的「短句 / 一句一事 / 独立行直插 / 描写密度低」说的是**句子长度与信息颗粒**，不是段落长度：正文按自然段组织（一段 2-4 句，长短交错）；只有系统与面板提示、对话轮换、关键动作或关键转折才另起一行。**禁止逐句换行、禁止一句一段**——全篇单句成段每 500 字不超过 1 处。')
    return '\n' + lines.join('\n') + '\n'
  }
  if (PLANNING_STEPS.has(step)) {
    const lines = [
      '【文风基调（规划参考）：' + name + '】',
      '这一步只做规划、不写正文：下面的文风规律不用照抄进规划文本，但设定、人物、大纲与细纲要与它相容（不要出现与之一冲突的设定）。正文阶段会再注入同一份画像的完整版。',
    ]
    for (const d of STYLE_DIMENSIONS) lines.push('- ' + d.label + '：' + (style[d.id] ?? '未限定'))
    return '\n' + lines.join('\n') + '\n'
  }
  return ''
}

/** 列出用户风格画像（风格只落在用户目录，不随包发内置风格）。 */
export async function listStyles({ root }) {
  const out = []
  if (typeof root !== 'string' || root === '') return out
  const dir = resolveInside(root, STATE_DIR_NAME, STYLE_DIR_NAME)
  let names = []
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
  } catch {
    return out
  }
  const seen = new Set()
  for (const name of names) {
    const path = join(dir, name)
    const meta = parseStyle(await readTextSafe(path), { id: name.replace(/\.md$/i, ''), source: 'user', path })
    if (seen.has(meta.id)) continue
    seen.add(meta.id)
    out.push(meta)
  }
  return out.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
}

export async function loadStyle({ root, id }) {
  const all = await listStyles({ root })
  return all.find((s) => s.id === id) ?? null
}

/** 保存用户风格画像（含「从样例蒸馏出来的风格画像」）。 */
export async function saveStyle({ root, style, text }) {
  const id = slugify(style.id ?? style.name, 'style')
  const path = resolveInside(root, STATE_DIR_NAME, STYLE_DIR_NAME, id + '.md')
  const lines = ['---', 'id: ' + id, 'name: ' + (style.name ?? id)]
  if (style.genre) lines.push('genre: ' + style.genre)
  lines.push('tags:')
  for (const t of style.tags ?? []) lines.push('  - ' + t)
  for (const d of STYLE_DIMENSIONS) lines.push(d.id + ': ' + (style[d.id] ?? ''))
  lines.push('---', '', text ?? style.note ?? '')
  await writeAtomic(path, lines.join('\n') + '\n')
  return { id, path }
}

/** 蒸馏样例风格的提示词：这是「样例 → 风格画像」那一步的唯一输入契约。 */
export function sampleStylePrompts({ sample, genreLabel, extra }) {
  const dimLines = STYLE_DIMENSIONS.map((d) => d.id + ': （' + d.label + '）').join('\n')
  const system =
    '你是小说风格分析师。你的任务是**提炼抽象的、可复用的风格规律**，而不是复制原文。\n' +
    '你输出的是「风格画像」：叙事视角、句子节奏、对话风格、描写密度、情绪调性、章节节奏、爽点节奏，' +
    '外加几个用于按标签匹配的短风格标签。\n' +
    '你绝不复制样例里的原句、比喻、专有名词、金句——那些是内容，不是风格。'
  const extraText = extra === undefined || extra === null || extra === '' ? '' : '【额外要求】\n' + extra + '\n\n'
  const user =
    '分析下面这篇' + genreLabel + '样例的风格，输出一个可复用的风格画像。\n\n' +
    '【样例】\n' + sample + '\n\n' +
    extraText +
    '【输出格式，严格照此】\n' +
    '---\n' +
    'id: （英文小写短横线）\n' +
    'name: （中文风格名）\n' +
    'genre: novel\n' +
    'tags:\n' +
    '  - 风格标签一\n' +
    '  - 风格标签二\n' +
    dimLines + '\n' +
    '---\n' +
    '（风格画像说明：两三句，讲清这套风格适合什么题材与读者；不要引用样例原文）\n\n' +
    '【自查】输出前确认：每个维度写的都是可迁移的规律（如「短句、动词打点」），' +
    '不是样例里的具体句子；tags 是短标签，便于按标签匹配风格。'
  return { system, user }
}

/**
 * 大文件采样与「分段蒸馏 → 合并」提示词。
 * 几 M 的整本小说不能（也不该）整本喂给模型：风格是统计规律，
 * 均匀采样开篇、中段、结尾即可覆盖全书写法差异。
 */
export const STYLE_CHUNK_CHARS = 6000
export const STYLE_MAX_CHUNKS = 6

/**
 * 从长文本里策略采样若干代表性片段：首段 + 均匀铺满全书 + 结尾段。
 * @param {string} text
 * @param {{chunkChars?: number, maxChunks?: number}} opts
 * @returns {{label: string, start: number, text: string}[]}
 */
export function sampleExcerpts(text, opts = {}) {
  const chunkChars = Number.isInteger(opts.chunkChars) && opts.chunkChars > 0 ? opts.chunkChars : STYLE_CHUNK_CHARS
  const maxChunks = Number.isInteger(opts.maxChunks) && opts.maxChunks > 0 ? opts.maxChunks : STYLE_MAX_CHUNKS
  const s = String(text ?? '').replace(/\s+$/, '')
  const total = s.length
  if (total <= chunkChars) return [{ label: '全文', start: 0, text: s }]
  const k = Math.max(1, Math.min(maxChunks, Math.round(total / chunkChars)))
  if (k === 1) return [{ label: '全文', start: 0, text: s.slice(0, chunkChars) }]
  const out = []
  for (let i = 0; i < k; i++) {
    const start = Math.round((i * (total - chunkChars)) / (k - 1))
    const label = i === 0 ? '开篇' : i === k - 1 ? '结尾' : '进度 ' + Math.round((start / total) * 100) + '%'
    out.push({ label, start, text: s.slice(start, start + chunkChars) })
  }
  return out
}

/** 单段（片段）风格观察提示词：大文件「分段蒸馏 → 合并」的第一步。 */
export function sampleStyleExcerptPrompts({ excerpt, label, genreLabel }) {
  const dimLines = STYLE_DIMENSIONS.map((d) => d.id + ': （' + d.label + '）').join('\n')
  const system =
    '你是小说风格分析师，正在分块分析一部长篇小说。我只给你全书的一个片段，你只对**这一段**下结论，不要推断全书。\n' +
    '你提炼的是可迁移的文风规律（叙事视角、句子节奏、对话风格、描写密度、情绪调性、章节节奏、爽点节奏），' +
    '绝不复制片段里的原句、比喻、专有名词。'
  const user =
    '这是' + genreLabel + '小说里【' + label + '】的一个片段。\n\n' +
    '【片段】\n' + excerpt + '\n\n' +
    '【输出】只写这一段的观察，每行一个维度，格式「id: 值」；某维度在这一段看不出就写「未见」。不要输出 frontmatter，不要写任何其它话。\n' +
    dimLines
  return { system, user }
}

/** 合并各片段观察成全书统一风格画像：大文件「分段蒸馏 → 合并」的第二步。 */
export function mergeStylePrompts({ partials, genreLabel, extra }) {
  const dimLines = STYLE_DIMENSIONS.map((d) => d.id + ': （' + d.label + '）').join('\n')
  const system =
    '你是小说风格分析师。你的任务是**综合各片段的观察，提炼出全书统一的、抽象可复用的风格规律**，而不是复制原文。\n' +
    '你输出「风格画像」：叙事视角、句子节奏、对话风格、描写密度、情绪调性、章节节奏、爽点节奏，外加几个短风格标签。\n' +
    '你绝不复制样例里的原句、比喻、专有名词、金句——那些是内容，不是风格。'
  const blocks = (partials ?? []).map((p, i) => '【片段 ' + (i + 1) + '：' + (p.label ?? '') + '】\n' + String(p.text ?? '')).join('\n\n')
  const extraText = extra === undefined || extra === null || extra === '' ? '' : '【额外要求】\n' + extra + '\n\n'
  const user =
    '下面是同一本' + genreLabel + '小说不同位置的片段风格观察，请综合成一份**全书统一**的风格画像。\n\n' +
    blocks + '\n\n' +
    extraText +
    '【综合原则】贯穿全书的规律才写进画像；只在个别片段出现的写法要么降级为「可选项」，要么省略。\n\n' +
    '【输出格式，严格照此】\n' +
    '---\n' +
    'id: （英文小写短横线）\n' +
    'name: （中文风格名）\n' +
    'genre: novel\n' +
    'tags:\n' +
    '  - 风格标签一\n' +
    '  - 风格标签二\n' +
    dimLines + '\n' +
    '---\n' +
    '（风格画像说明：两三句，讲清这套风格适合什么题材与读者；不要引用样例原文）\n\n' +
    '【自查】输出前确认：每个维度写的都是可迁移的规律（如「短句、动词打点」），' +
    '不是样例里的具体句子；tags 是短标签，便于按标签匹配风格。'
  return { system, user }
}
