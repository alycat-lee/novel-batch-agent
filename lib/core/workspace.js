/**
 * dsh-writer-m — 作品状态与落盘
 *
 * 目录约定（全部在用户配置的落盘根目录之内）：
 *   <root>/.dsh-writer-m/templates/   用户模版 + 从样例提炼出来的模版
 *   <root>/.dsh-writer-m/prompts.json 用户改过的每步 prompt（覆盖内置默认）
 *   <root>/<作品名>/project.json      作品元数据与步骤状态
 *   <root>/<作品名>/steps/NN-xxx.md   各步产物
 *   <root>/<作品名>/chapters/第NNN章-章名.md
 *
 * 「有文件才算做过」：进度不靠内存，关掉重开靠磁盘重建。
 * 这一步是整个插件能长流程跑下去的前提——否则用户中途关掉浏览器就全丢了。
 */
import { readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readTextSafe,
  readJsonSafe,
  writeJson,
  writeAtomic,
  resolveInside,
  slugify,
  charCount,
  statSafe,
} from './fsx.js'
import { genreById, stepById, NOVEL_TYPES, NOVEL_TAGS } from './genres.js'
// 卷号：「## 第一卷：七天试用期」里的中文数字靠它转成 1（与章节标题同一个解析器，避免两套数字规则）
import { parseHeadingNo } from './chaptertext.js'

export const STATE_DIR = '.dsh-writer-m'
export const TEMPLATE_DIR = 'templates'
export const PROMPTS_FILE = 'prompts.json'
export const NOVEL_OPTIONS_FILE = 'novel-options.json'
export const PROJECT_FILE = 'project.json'

export function stateDirOf(root) {
  return resolveInside(root, STATE_DIR)
}

/** 作品目录。id 由用户输入经 slugify，且再过一次 resolveInside 兜底。 */
export function projectDirOf(root, id) {
  return resolveInside(root, slugify(id, 'project'))
}

export async function listProjects(root) {
  let names = []
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const dir = join(root, name)
    const meta = await readJsonSafe(join(dir, PROJECT_FILE), null)
    if (meta === null) continue
    const info = await statSafe(dir)
    out.push({
      id: name,
      name: meta.name ?? name,
      genre: meta.genre ?? 'novel',
      genreLabel: genreById(meta.genre).label,
      theme: meta.theme ?? '',
      // 风格/模版绑定：客户端作品列表要显示「这篇挂了哪份画像」，否则用户看不见绑定关系
      styleId: meta.styleId ?? '',
      templateId: meta.templateId ?? '',
      updatedAt: info === null ? '' : new Date(info.mtimeMs).toISOString(),
      done: Array.isArray(meta.done) ? meta.done : [],
    })
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export async function readProject(root, id) {
  const dir = projectDirOf(root, id)
  const meta = await readJsonSafe(join(dir, PROJECT_FILE), null)
  return meta === null ? null : { dir, meta }
}

export async function writeProject(root, id, meta) {
  await writeJson(join(projectDirOf(root, id), PROJECT_FILE), meta)
}

/**
 * 新建（或补全）一个作品。
 *
 * 两条都是踩过的坑：
 * 1. **同名不覆盖产物**：用户点「新建」时如果名字撞了，期望的绝不是把旧稿清空；
 *    所以已有产物一律保留，只更新元数据。
 * 2. **未提供的字段保留旧值**：再次提交同名作品时，调用方往往只改了题材，
 *    其余字段是空串。若用空串覆盖，用户会发现自己填过的受众/调性莫名其妙没了。
 *    规则：非空新值 → 采纳；空值 → 保留旧值；都没有 → 默认值。
 */
export async function ensureProject(root, input) {
  const stamp = (() => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  })()
  const nameRaw = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : '未命名-' + stamp
  const id = slugify(nameRaw, 'untitled')
  const g = genreById(input.genre)
  const genre = g.id
  const existing = (await readProject(root, id))?.meta ?? null
  const keep = (next, prev, fallback = '') => {
    const n = typeof next === 'string' ? next.trim() : ''
    if (n !== '') return n
    const p = typeof prev === 'string' ? prev.trim() : ''
    return p !== '' ? p : fallback
  }
  // 目标字数优先级：明确填写 > 沿用旧值 > 类型默认值。
  // 类型标记 requireWords 时不留默认——「用户自定义字数」意味着不能偷偷塞一个 3000 兜底。
  let words = 0
  if (Number.isFinite(input.words) && input.words > 0) {
    words = Math.round(input.words)
  } else if (Number.isFinite(existing?.words) && existing.words > 0) {
    words = existing.words
  } else if (g.requireWords !== true) {
    words = g.defaultWords
  }
  if (words <= 0) {
    throw new Error(`「${g.label}」需要填写${g.wordsLabel}（必填，不留默认值）`)
  }
  // 单章目标字数夹进合理区间：误把全书总字数填进来（用户 m02810：300000）时不留隐患
  if (g.id === 'novel' && words > 0) words = clampChapterWords(words)
  // 小说定位字段：频道/类型/总长度/标签/候选数量。只在小说项目上用，
  // 未提供时保留旧值；候选数量默认 3，钳制在 1-6 避免一次让模型吐十几个候选。
  const channel = keep(input.channel, existing?.channel, 'male')
  const type = keep(input.type, existing?.type)
  const totalWords = Number.isFinite(input.totalWords) && input.totalWords > 0
    ? Math.round(input.totalWords)
    : (Number.isFinite(existing?.totalWords) && existing.totalWords > 0 ? existing.totalWords : 0)
  const tags = Array.isArray(input.tags) && input.tags.length > 0
    ? input.tags.map((t) => String(t).trim()).filter((t) => t !== '')
    : (Array.isArray(existing?.tags) ? existing.tags : [])
  const count = Number.isFinite(input.count) && input.count > 0
    ? Math.min(Math.max(Math.round(input.count), 1), 6)
    : (Number.isFinite(existing?.count) && existing.count > 0 ? existing.count : 3)
  // 自定义类型/标签沉淀进预设：非内置值在下一次新建时直接可选。
  const customTypes = type !== '' && !NOVEL_TYPES.includes(type) ? [type] : []
  const customTags = tags.filter((t) => !NOVEL_TAGS.includes(t))
  if (customTypes.length > 0 || customTags.length > 0) {
    await rememberNovelOptions(root, { types: customTypes, tags: customTags })
  }
  const vaultNotes = Array.isArray(input.vaultNotes) && input.vaultNotes.length > 0
    ? input.vaultNotes.map((p) => String(p).trim()).filter((p) => p !== '')
    : (Array.isArray(existing?.vaultNotes) ? existing.vaultNotes : [])
  const meta = {
    name: keep(input.name, existing?.name, id),
    genre,
    theme: keep(input.theme, existing?.theme),
    audience: keep(input.audience, existing?.audience),
    tone: keep(input.tone, existing?.tone),
    templateId: keep(input.templateId, existing?.templateId),
    styleId: keep(input.styleId, existing?.styleId),
    vaultNotes,
    channel,
    type,
    totalWords,
    tags,
    count,
    words,
    done: Array.isArray(existing?.done) ? existing.done : [],
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await writeProject(root, id, meta)
  return { id, meta }
}

/**
 * 只改「风格画像绑定」这一个字段。
 *
 * 不走 ensureProject：那条路会补齐题材/字数等默认值（genre 缺省 novel），
 * 给已有公众号/小红书作品改风格时会把题材悄悄改回小说。
 */
export async function setProjectStyle(root, id, styleId) {
  const found = await readProject(root, id)
  if (found === null) return null
  const meta = {
    ...found.meta,
    styleId: typeof styleId === 'string' ? styleId.trim() : '',
    updatedAt: new Date().toISOString(),
  }
  await writeProject(root, id, meta)
  return { id, meta }
}

/** 单章目标字数的合理区间：低于 300 写不成一章，高于 2 万本地模型永远写不到（只会空转续写）。 */
export const CHAPTER_WORDS_MIN = 300
export const CHAPTER_WORDS_MAX = 20000

/** 把「单章目标字数」夹进合理区间（小说专用；公众号/小红书的 words 是全文目标，不夹）。 */
export function clampChapterWords(n) {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.max(Math.round(n), CHAPTER_WORDS_MIN), CHAPTER_WORDS_MAX)
}

/**
 * 改作品的「篇幅」字段（用户 m02810）：新建时把 300000 填进了「单章目标字数」，
 * 之后没有任何入口能改回来，单章生成永远提示「未达目标 300000 字」。
 */
export async function setProjectWords(root, id, input) {
  const found = await readProject(root, id)
  if (found === null) return null
  const meta = { ...found.meta }
  const g = genreById(meta.genre)
  if (Number.isFinite(input?.words) && input.words > 0) {
    meta.words = g.id === 'novel' ? clampChapterWords(input.words) : Math.round(input.words)
  }
  if (Number.isFinite(input?.totalWords)) {
    meta.totalWords = input.totalWords > 0 ? Math.round(input.totalWords) : 0
  }
  meta.updatedAt = new Date().toISOString()
  await writeProject(root, id, meta)
  return { id, meta }
}
/** 步骤产物路径；chapter 步与 chapter-outline 步由调用方给文件名。 */
export function artifactPath(step, fileName) {
  if (step.artifact === 'chapters') {
    const suffix = step.suffix ?? ''
    return join('chapters', suffix === '' ? fileName : chapterVariantName(fileName, suffix))
  }
  if (step.artifact === 'chapter-outlines') return join('chapter-outlines', fileName)
  return step.artifact
}

/**
 * 逐步骤状态：是否已有产物、产物字数、最近改动时间。
 * 「有文件才算做过」的判定就在这里，客户端只读这个结果。
 */
export async function stepsStatus(dir, genreId) {
  const genre = genreById(genreId)
  const out = []
  for (const step of genre.steps) {
    if (step.artifact === 'chapters') {
      const files = await listChapterFiles(dir, step.suffix ?? '')
      out.push({ id: step.id, no: step.no, label: step.label, goal: step.goal, done: files.length > 0, chapters: files.length, files })
      continue
    }
    if (step.artifact === 'chapter-outlines') {
      const chaptersDir = join(dir, step.artifact)
      let files = []
      try {
        files = (await readdir(chaptersDir, { withFileTypes: true }))
          .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
          .map((e) => e.name)
      } catch {
        files = []
      }
      out.push({ id: step.id, no: step.no, label: step.label, goal: step.goal, done: files.length > 0, chapters: files.length, files: files.sort() })
      continue
    }
    const path = join(dir, step.artifact)
    const info = await statSafe(path)
    const text = info === null ? '' : await readTextSafe(path)
    out.push({
      id: step.id,
      no: step.no,
      label: step.label,
      goal: step.goal,
      done: info !== null && text.trim() !== '',
      chars: charCount(text),
      updatedAt: info === null ? '' : new Date(info.mtimeMs).toISOString(),
    })
  }
  return out
}

/**
 * 拼前序上下文：只取**已完成**的步骤产物，总量有界。
 * 为什么要有界：长篇写到第 20 章时，如果把前面所有产物都塞进去，
 * 上下文会被自己的草稿吃满，然后模型开始丢设定——这正是长文写作最常见的翻车方式。
 */
/** 章节版本文件名：chapterVariantName('第001章.md', '润色') → '第001章-润色.md'。 */
export function chapterVariantName(base, suffix) {
  const stem = String(base ?? '').replace(/\.md$/i, '')
  if (stem === '') return ''
  return suffix === '' ? stem + '.md' : stem + '-' + suffix + '.md'
}

/**
 * 列出作品 chapters/ 目录下已落盘章节文件名（按文件名排序，只取 .md）。
 * suffix 为空时只列「原始正文」（排除 *-润色.md / 历史 *-去AI.md）；
 * suffix 非空时只列该后缀的版本文件（如 '润色' → 只取 *-润色.md）。
 */
export async function listChapterFiles(dir, suffix = '') {
  try {
    const all = (await readdir(join(dir, 'chapters'), { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
    const filtered = suffix === ''
      ? all.filter((n) => !/-润色\.md$/i.test(n) && !/-去AI\.md$/i.test(n))
      : all.filter((n) => n.toLowerCase().endsWith('-' + suffix + '.md'))
    return filtered.sort()
  } catch {
    return []
  }
}

/**
 * 卷标题：只认「第 N 卷」或「卷 N」（阿拉伯/全角/中文数字都认）。
 * 用两个择一分支而不是「第 可选」：否则「## 三卷本结构」这类以数字开头的普通小节也会被当成卷。
 */
const VOLUME_HEAD_RE = /^(?:第[ \t]*([0-9０-９零〇一二三四五六七八九十百千两]+)[ \t]*卷|卷[ \t]*([0-9０-９零〇一二三四五六七八九十百千两]+))(?![章节])/

/**
 * 解析卷大纲（steps/04-卷大纲.md）里按 ## 分块的卷，返回 [{ no, key, title, body }]。
 *
 * 只把「第 N 卷」这类标题当卷：模型经常在卷前面写一节「## 总体判断」、后面写
 * 「## 全书人物设定表 / ## 各卷递进 / ## 一、每章出场人物清单」等其它二级标题。
 * 早先的实现把每个 ## 都按位置编号成卷，于是真卷整体错位——用户报告的下拉里
 * 「第1卷」是总体判断、「第2卷」才是真正的第一卷，章节全局编号也跟着错（m01614）。
 * 兜底：整篇找不到「第 N 卷」标题时才退回「所有 ## 都是卷」（兼容旧格式）。
 * 卷体的取到范围始终以**下一个 ##**为界（含非卷小节），不会把人物设定表吞进最后一卷。
 */
export async function listVolumes(dir) {
  const text = (await readTextSafe(join(dir, 'steps/04-卷大纲.md'))).trim()
  if (text === '') return []
  const heads = []
  // 卷标题的层级不固定：老稿用「## 第1卷 …」，新稿用「# 卷一：荒墟启幕·凡躯破劫」（H1）+「## 本卷目标」子节。
  // 早先只扫 ## ⇒ 新稿把「## 本卷目标/主要事件/预计章数/情绪走向」当成了 13 个卷（用户 m02536 报「卷名错误」）。
  const re = /^(#{1,3})[ \t]+(.+)$/gm
  let m
  while ((m = re.exec(text)) !== null) heads.push({ level: m[1].length, title: m[2].trim(), at: m.index })
  if (heads.length === 0) return []
  const numbered = heads.filter((h) => VOLUME_HEAD_RE.test(h.title))
  // 找不到卷标题时退回旧行为：把最外层标题（层级最小的那一档）都当卷
  const topLevel = Math.min(...heads.map((h) => h.level))
  const picked = numbered.length > 0 ? numbered : heads.filter((h) => h.level === topLevel)
  const blocks = []
  for (let i = 0; i < picked.length; i++) {
    const cur = picked[i]
    // 卷体止于**下一个同级或更高级**标题：H1 卷里的 ## 小节必须留在卷内
    const next = heads.find((h) => h.at > cur.at && h.level <= cur.level)
    const end = next === undefined ? text.length : next.at
    const raw = VOLUME_HEAD_RE.exec(cur.title)
    const parsed = raw === null ? null : parseHeadingNo(raw[1] ?? raw[2])
    const no = parsed !== null && parsed > 0 ? parsed : i + 1
    blocks.push({
      no,
      key: '第' + no + '卷',
      title: cur.title,
      body: text.slice(cur.at, end).trim(),
    })
  }
  return blocks
}

/** 备份某个产物到 .bak（覆盖上一次备份），返回备份路径。用于润色写回前的保护。 */
export async function backupArtifact(dir, relPath) {
  const src = resolveInside(dir, relPath)
  const text = await readTextSafe(src)
  const dst = resolveInside(dir, relPath + '.bak')
  // 只有一层 .bak 时，连续两次覆盖就把最早的版本永久冲掉了（2026-10-07 作品定位稿丢失事故）。
  // 所以在覆盖 .bak 之前，先把里面还留着的「上一版」另存一份带时间戳的副本。
  const prev = await readTextSafe(dst)
  if (String(prev).trim() !== '' && String(prev) !== String(text)) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
    await writeAtomic(resolveInside(dir, relPath + '.bak-' + stamp), prev)
  }
  await writeAtomic(dst, text)
  return dst
}

/** 把已确认的润色稿（第NNN章-润色.md）覆盖回原章（第NNN章.md），原稿备份 .bak 后删除润色稿；返回已定稿章节列表。 */
export async function finalizePolished(root, id, only = []) {
  const dir = projectDirOf(root, id)
  const polished = await listChapterFiles(dir, '润色')
  const targets = only.length > 0 ? polished.filter((f) => only.includes(f)) : polished
  const finalized = []
  for (const pf of targets) {
    const base = pf.replace(/-润色\.md$/i, '.md')
    if (base === pf || !/\.md$/i.test(base)) continue
    const text = await readTextSafe(resolveInside(dir, 'chapters/' + pf))
    if (String(text).trim() === '') continue
    await backupArtifact(dir, 'chapters/' + base)
    await writeArtifact(root, id, 'chapters/' + base, text)
    await rm(resolveInside(dir, 'chapters/' + pf), { force: true })
    finalized.push(base)
  }
  return { finalized, count: finalized.length }
}

/** 逐句核对：原文里 ≥8 字的句子，有多少在改稿里逐字存活（ratio 0~1）。 */
export function sentenceSurvival(original, revised) {
  const sentences = String(original ?? '')
    .split(/[。！？!?；;…\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
  if (sentences.length === 0) return { kept: 0, total: 0, ratio: 1 }
  const hay = String(revised ?? '')
  let kept = 0
  for (const s of sentences) if (hay.includes(s)) kept++
  return { kept, total: sentences.length, ratio: kept / sentences.length }
}

export async function buildContext(dir, genreId, stepId, { maxChars = 12000, chapter = '' } = {}) {
  const genre = genreById(genreId)
  const index = genre.steps.findIndex((s) => s.id === stepId)
  const step = index < 0 ? null : genre.steps[index]

  // 小说润色：待处理的是某章正文，正文落在 chapters/ 里（不在前序 steps/ 产物里），
  // 单独取目标章节，否则 {{context}} 里只有书名大纲、没有要润色的正文。
  const hasChapters = genre.steps.some((s) => s.artifact === 'chapters')
  if (step !== null && step.id === 'polish' && hasChapters) {
    // 润色读「原始正文」；未指定章节时回退最新一章。
    const rawFiles = await listChapterFiles(dir)
    const base = chapter !== '' && rawFiles.includes(chapter) ? chapter : (rawFiles[rawFiles.length - 1] ?? '')
    if (base === '') return ''
    const text = (await readTextSafe(join(dir, 'chapters', base))).trim()
    return text.slice(0, maxChars)
  }

  const prior = index < 0 ? genre.steps : genre.steps.slice(0, index)
  // 卷大纲及之后的主线续写，最依赖「大纲 + 人物描述」；把它们排到预算最前，
  // 避免被较长的「作品定位」草稿挤掉（字数上限下保住基础设定主线）。
  const pinned = ['outline', 'characters']
  const ordered = prior.filter((s) => pinned.includes(s.id)).concat(prior.filter((s) => !pinned.includes(s.id)))
  const parts = []
  let budget = maxChars
  for (const step of ordered) {
    if (step.artifact === 'chapters' || step.artifact === 'chapter-outlines') continue
    const text = (await readTextSafe(join(dir, step.artifact))).trim()
    if (text === '') continue
    const slice = text.slice(0, budget)
    parts.push(`## ${step.label}\n${slice}`)
    budget -= slice.length
    if (budget <= 0) break
  }
  return parts.join('\n\n')
}

/**
 * 「已有设定」：给排在最前面的步骤（作品定位）看**后序**已经写下的产物。
 *
 * 为什么需要：{{context}} 只带**前序**步骤（buildContext 用 steps.slice(0, index)），
 * 而作品定位是第一步 ⇒ 重新生成时完全看不到已经存在的 02-大纲 / 03-人物 / 04-卷大纲 /
 * 章节大纲 / 正文，只能凭空编一个新故事（实测事故：把「陈默 · 昆仑坊市」重新生成成了
 * 「许安 · 仙界地产系统」，下游全部设定与正文对不上）。
 * 越基础的设定越先给（大纲/人物），避免被卷大纲、章节大纲（体积大）挤掉。
 */
export async function buildExistingContext(dir, genreId, stepId, { maxChars = 10000 } = {}) {
  const genre = genreById(genreId)
  const index = genre.steps.findIndex((s) => s.id === stepId)
  if (index < 0) return ''
  const later = genre.steps.slice(index + 1)
  const pinned = ['outline', 'characters']
  const ordered = later.filter((s) => pinned.includes(s.id)).concat(later.filter((s) => !pinned.includes(s.id)))
  const parts = []
  let budget = maxChars
  const push = (label, text) => {
    const body = String(text ?? '').trim()
    if (body === '' || budget <= 0) return
    const slice = body.slice(0, budget)
    parts.push('## ' + label + '\n' + slice)
    budget -= slice.length
  }
  for (const step of ordered) {
    if (step.artifact === 'chapters') {
      // 正文太长：只列已落盘的章节名与首行（那是章标题），让模型知道故事写到哪
      const files = await listChapterFiles(dir, step.suffix ?? '')
      const lines = []
      for (const name of files) {
        const first = String(await readTextSafe(join(dir, 'chapters', name)))
          .split('\n').find((l) => l.trim() !== '') ?? ''
        lines.push('- ' + name.replace(/\.md$/i, '') + (String(first).trim() === '' ? '' : '：' + String(first).trim()))
        if (lines.join('\n').length >= 1500) break
      }
      push(step.label + '（只列已写章节的标题）', lines.join('\n'))
      continue
    }
    if (step.artifact === 'chapter-outlines') {
      // 章节大纲按卷拆文件，逐卷只取小节标题（细纲全量太大）
      const blocks = []
      try {
        const names = (await readdir(join(dir, step.artifact), { withFileTypes: true }))
          .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
          .map((e) => e.name)
          .sort()
        for (const name of names) {
          const text = String(await readTextSafe(join(dir, step.artifact, name))).trim()
          if (text === '') continue
          const heads = text.split('\n').filter((l) => /^#{1,6}[ \t]*\S/.test(l)).slice(0, 12).join('\n')
          blocks.push('### ' + name.replace(/\.md$/i, '') + '\n' + heads)
        }
      } catch {
        blocks.length = 0
      }
      push(step.label + '（只列卷内章节标题）', blocks.join('\n'))
      continue
    }
    const text = await readTextSafe(join(dir, step.artifact))
    push(step.label, text)
  }
  return parts.join('\n\n')
}

/** 读某步已有产物（客户端用来回填编辑框）。 */
export async function readArtifact(dir, genreId, stepId, fileName) {
  const step = stepById(genreId, stepId)
  if (step === null) return ''
  return await readTextSafe(join(dir, artifactPath(step, fileName ?? 'untitled.md')))
}

export async function writeArtifact(root, id, relPath, text) {
  const dir = projectDirOf(root, id)
  const path = resolveInside(dir, relPath)
  await writeAtomic(path, text)
  // 只刷新 updatedAt，让「最近改动的作品」排序跟着实际写作走
  const meta = (await readProject(root, id))?.meta ?? null
  if (meta !== null) {
    meta.updatedAt = new Date().toISOString()
    await writeProject(root, id, meta)
  }
  return path
}

/** 读任意产物（相对作品目录），同样过越界校验。 */
export async function readProjectFile(root, id, relPath) {
  const path = resolveInside(projectDirOf(root, id), relPath)
  return { path, text: await readTextSafe(path), exists: (await statSafe(path)) !== null }
}

export async function removeProject(root, id) {
  const dir = projectDirOf(root, id)
  await rm(dir, { recursive: true, force: true })
  return dir
}

/** 把作品改名为所选书名：目录一起改，meta.name 同步；同名目录已存在则拒绝。 */
export async function renameProject(root, id, newName) {
  const name = String(newName ?? '').trim()
  if (name === '') throw new Error('书名不能为空')
  const found = await readProject(root, id)
  if (found === null) throw new Error(`作品不存在：${id}`)
  const newId = slugify(name, 'project')
  const meta = { ...found.meta, name, updatedAt: new Date().toISOString() }
  if (newId === id) {
    await writeProject(root, id, meta)
    return { id, meta, renamed: false }
  }
  const newDir = projectDirOf(root, newId)
  if ((await statSafe(newDir)) !== null) throw new Error(`已存在同名作品：${newId}`)
  await rename(projectDirOf(root, id), newDir)
  await writeProject(root, newId, meta)
  return { id: newId, meta, renamed: true }
}

/** 选用作品定位候选：改名为所选书名，并把定位产物裁剪为仅保留所选候选（未选候选删除）。 */
export async function adoptPositioning(root, id, name, keepText) {
  const found = await readProject(root, id)
  if (found === null) throw new Error(`作品不存在：${id}`)
  const step = stepById(found.meta.genre, 'positioning')
  if (step === null) throw new Error('该类型没有「作品定位」步，无法选用候选')
  const keep = String(keepText ?? '').trim()
  if (keep === '') throw new Error('没有可保留的候选内容')
  const renamed = await renameProject(root, id, name)
  await writeArtifact(root, renamed.id, step.artifact, keep + '\n')
  return { ...renamed, dir: projectDirOf(root, renamed.id) }
}

/** 每步 prompt 的用户覆盖：{"novel:outline": {system, user}}，只存改过的。 */
export async function readPromptOverrides(root) {
  return await readJsonSafe(join(stateDirOf(root), PROMPTS_FILE), {})
}

export async function writePromptOverride(root, key, patch) {
  const path = join(stateDirOf(root), PROMPTS_FILE)
  const current = await readJsonSafe(path, {})
  if (patch === null) delete current[key]
  else current[key] = { ...(current[key] ?? {}), ...patch }
  await writeJson(path, current)
  return current
}

/** 用户自定义的小说类型/标签（沉淀进预设）。存 .dsh-writer-m/novel-options.json。 */
export async function readNovelOptions(root) {
  const cur = await readJsonSafe(join(stateDirOf(root), NOVEL_OPTIONS_FILE), {})
  const norm = (arr) => Array.isArray(arr) ? arr.map((t) => String(t).trim()).filter((t) => t !== '') : []
  return { types: norm(cur.types), tags: norm(cur.tags) }
}

export async function rememberNovelOptions(root, { types = [], tags = [] } = {}) {
  const path = join(stateDirOf(root), NOVEL_OPTIONS_FILE)
  const cur = await readNovelOptions(root)
  const merge = (base, add) => {
    const seen = new Set(base)
    for (const t of add) {
      const s = typeof t === 'string' ? t.trim() : ''
      if (s !== '') seen.add(s)
    }
    return Array.from(seen)
  }
  const next = { types: merge(cur.types, types), tags: merge(cur.tags, tags) }
  await writeJson(path, next)
  return next
}

/** 预设 = 内置 + 用户自定义（内置在前，去重）。 */
export async function mergedNovelOptions(root) {
  const custom = await readNovelOptions(root)
  return {
    types: Array.from(new Set([...NOVEL_TYPES, ...custom.types])),
    tags: Array.from(new Set([...NOVEL_TAGS, ...custom.tags])),
  }
}
