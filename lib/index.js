/**
 * dsh-writer-m — 宿主半区
 *
 * 职责边界（与客户端半区严格分工）：
 * - 一切**文件系统**动作在这里：读模版、写产物、建作品目录、路径越界校验；
 * - 一切**模型调用**在这里：模型路由与流式收取在宿主侧，浏览器只发一个 POST；
 * - 一切**数据真源**在这里：写作类型 / 步骤链 / 每步提示词 / 模版库都是宿主侧模块，
 *   客户端只渲染宿主返回的结果，不自己存一份步骤定义——否则两边必然漂移。
 *
 * 对外只暴露一条回环 HTTP API：/dsh-writer-m/api/*（webServer.register）。
 * 之所以走 HTTP 而不是让浏览器直接读写文件：浏览器没有 fs，而 dsh 的
 * 工作区 RPC 只覆盖工作区内的文件，覆盖不了用户配置的任意落盘根目录。
 *
 * 版权：alycat-lee/dsh-writer-m（MIT）。独立宿主 novel-batch-agent 复用本文件，
 * 只允许抽函数与追加路由，不改原有步骤生成行为。
 *
 * 兼容性写法说明：
 * - 不 import `@deepseek-ai/dsh-llm`，自己拼 GenerateOptions（见 core/llm.js）；
 * - `@deepseek-ai/schemastery` 用顶层 await + try/catch 惰性取，取不到就不导出 Config，
 *   插件其余能力照常（设置卡只是锦上添花，不是运行前提）；
 * - 服务用 `ctx.inject` 等，而不是同步 `ctx.get`——实机踩过 apply 早于服务挂载的坑。
 */
import { fileURLToPath } from 'node:url'
import { join, dirname, basename, resolve } from 'node:path'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

import {
  GENRES,
  genreById,
  stepById,
  renderPrompt,
  DEAI_DIMENSIONS,
  NOVEL_CHANNELS,
  stepTargetChars,
} from './core/genres.js'
import {
  TEMPLATE_DIR_NAME,
  STATE_DIR_NAME,
  listTemplates,
  loadTemplate,
  saveTemplate,
  renderTemplateBlock,
  sampleAnalysisPrompts,
} from './core/templates.js'
import { STYLE_DIR_NAME, listStyles, loadStyle, saveStyle, parseStyle, renderStyleBlock, sampleStylePrompts, sampleExcerpts, sampleStyleExcerptPrompts, mergeStylePrompts, STYLE_CHUNK_CHARS, STYLE_MAX_CHUNKS } from './core/styles.js'
import { resolveVaultRoot, listVaults, listVaultNotes, readVaultNote, searchVaultNotes, resolveVaultNotes, renderVaultBlock, writeVaultFile, guardVaultPath, removeVaultDir, removeVaultFile } from './core/vault.js'
import { readPromptLibrary, readStyleLibrary, renderPromptNote, promptNoteRel, styleNoteRel } from './core/vaultlib.js'
import * as WS from './core/workspace.js'
import {
  normalizeChapterText,
  normalizeChapterFileText,
} from './core/chaptertext.js'
import { resolveInside, readTextSafe, writeAtomic, writeBinary, readBinary, removeFileSafe, charCount, clip } from './core/fsx.js'
import { resolveRoute, callModel, finishWarning, joinContinuation, LLM_DEFAULTS } from './core/llm.js'
import { readJsonBody, JSON_BODY_LIMIT, COVER_BODY_LIMIT } from './core/body.js'
import { fanqieTagCatalog, fanqieListingBlock, fanqieListingFormat, fanqieTagPayload, fanqieListingReports, formatFanqieListing, hasCandidateHeadings, splitCandidateBlocks, extractListingSection, titlePrompts, parseTitleCandidates, cleanTitle, replaceTitleLines, FANQIE_TITLE_MAX } from './core/fanqie-tags.js'
import * as BATCH from './core/batch.js'

export const name = 'dsh-writer-m'

const NS = 'dsh-writer-m'
const API_PREFIX = '/dsh-writer-m/api/'
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const BUILTIN_TEMPLATE_DIR = join(PACKAGE_DIR, 'templates')

const DEFAULT_ROOT = join(homedir(), 'Documents', 'dsh-writer-m')

/** 单次注入提示词的上下文上限：需容下大纲+人物小传+卷大纲（人物小传在卷大纲末尾，太小会被截断）。 */
const CONTEXT_MAX_CHARS = 20000
// 「已有设定」（给作品定位步看下游已写内容）的字符上限：比前序上下文小一点，
// 它只是防止「另起新故事」的骨架（大纲/人物/卷大纲/章节标题），不需要全文。
const EXISTING_MAX_CHARS = 10000
const SAMPLE_MAX_CHARS = 20000

/** 镜像到 Obsidian vault 的目录布局（vault 内相对路径前缀）。 */
const VAULT_MIRROR_DIR = 'dsh-writer-m'
const VAULT_MIRROR_WORKS = '作品'
const VAULT_MIRROR_TEMPLATES = '模版'
const VAULT_MIRROR_STYLES = '风格画像'
const VAULT_MIRROR_PROMPTS = '提示词'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 配置默认值。即使没有 schemastery，这份对象也是唯一真源。 */
export const CONFIG_DEFAULTS = {
  /** 落盘根目录：所有作品目录都在它之内 */
  root: DEFAULT_ROOT,
  /** 关闭后 API 一律 503，用于临时停用而不卸载 */
  enabled: true,
  /** 留空则用 dsh 当前默认模型 */
  provider: '',
  model: '',
  /** 单次生成的最大输出 token：小说一章 3000 字中文约需 4500+，默认给足 */
  maxTokens: LLM_DEFAULTS.maxTokens,
  /** Obsidian 知识库（vault）根目录；留空则自动探测 */
  vaultPath: '',
  /** 番茄发布：Python 解释器（留空用 PATH 上的 python） */
  publishPython: '',
  /** 番茄发布器脚本（留空用插件自带 scripts/fanqie_publish.py） */
  publishScript: '',
  /** 番茄后台登录态目录（Playwright 持久化 profile）；留空则发布不可用 */
  publishProfile: '',
  /** 番茄站点书名（留空则用作品名匹配同名书目） */
  publishBookName: '',
  /** 番茄登录态脚本（探活/扫码/保活/恢复）；留空用插件自带 scripts/fanqie_login.py */
  publishLoginScript: '',
}

/** 有 schemastery 就导出 schema（设置页可渲染），没有就导出 undefined。 */
const schemastery = await import('@deepseek-ai/schemastery').then((m) => m.default ?? m).catch(() => null)
export const Config =
  schemastery === null || typeof schemastery.object !== 'function'
    ? undefined
    : schemastery.object({
        root: schemastery.string().default(CONFIG_DEFAULTS.root),
        enabled: schemastery.boolean().default(CONFIG_DEFAULTS.enabled),
        provider: schemastery.string().default(CONFIG_DEFAULTS.provider),
        model: schemastery.string().default(CONFIG_DEFAULTS.model),
        maxTokens: schemastery.number().default(CONFIG_DEFAULTS.maxTokens),
        vaultPath: schemastery.string().default(CONFIG_DEFAULTS.vaultPath),
        publishPython: schemastery.string().default(CONFIG_DEFAULTS.publishPython),
        publishScript: schemastery.string().default(CONFIG_DEFAULTS.publishScript),
        publishProfile: schemastery.string().default(CONFIG_DEFAULTS.publishProfile),
        publishBookName: schemastery.string().default(CONFIG_DEFAULTS.publishBookName),
        publishLoginScript: schemastery.string().default(CONFIG_DEFAULTS.publishLoginScript),
      })

/** 合并默认值与插件行配置，并把 root 归一化（空值回落到默认）。 */
function normalizedConfig(config) {
  const merged = { ...CONFIG_DEFAULTS, ...(config ?? {}) }
  merged.root = String(merged.root ?? '').trim() === '' ? CONFIG_DEFAULTS.root : String(merged.root)
  merged.maxTokens = Number.isInteger(merged.maxTokens) && merged.maxTokens > 0 ? merged.maxTokens : CONFIG_DEFAULTS.maxTokens
  merged.vaultPath = String(merged.vaultPath ?? '').trim()
  for (const key of ['publishPython', 'publishScript', 'publishProfile', 'publishBookName', 'publishLoginScript']) {
    merged[key] = String(merged[key] ?? '').trim()
  }
  return merged
}

/**
 * 把生成内容镜像写进 Obsidian vault（「也存一份到 vault」；无 vault 时静默跳过，失败不阻断主写盘）。
 */
async function mirrorToVault(vaultPath, text, rel) {
  const vaultRoot = resolveVaultRoot(vaultPath)
  if (vaultRoot === null || vaultRoot === '') return null
  try {
    return await writeVaultFile(vaultRoot, rel, text)
  } catch {
    return null
  }
}

/** 把二进制内容镜像写进 Obsidian vault（封面图片；无 vault 静默跳过，失败不阻断主写盘）。 */
async function mirrorToVaultBinary(vaultPath, buffer, rel) {
  const vaultRoot = resolveVaultRoot(vaultPath)
  if (vaultRoot === null || vaultRoot === '') return null
  try {
    return await writeBinary(guardVaultPath(vaultRoot, rel), buffer)
  } catch {
    return null
  }
}

/** 删掉一份 vault 镜像目录（删作品时调用；无 vault / 越界 / 失败都静默跳过，不阻断主删除）。 */
async function removeMirrorDir(vaultPath, rel) {
  const vaultRoot = resolveVaultRoot(vaultPath)
  if (vaultRoot === null || vaultRoot === '') return false
  try {
    await removeVaultDir(vaultRoot, rel)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 服务就绪
// ---------------------------------------------------------------------------

/**
 * 等一批服务就绪；超时返回 null 而不是永远挂着。
 * headless profile 没有 webServer 时，本插件就该安静地什么都不做。
 */
async function awaitServices(ctx, names, timeoutMs) {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      ctx.inject(names, (ready) => finish(ready ?? ctx))
    } catch {
      finish(null)
    }
    setTimeout(() => finish(null), timeoutMs).unref?.()
  })
}

/** 只服务本机浏览器：作品目录不该被暴露到网络上。 */
function isLoopback(req) {
  const addr = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '').toLowerCase()
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost'
}

// ---------------------------------------------------------------------------
// Obsidian 库（提示词 / 风格画像）：vault 侧优先
// ---------------------------------------------------------------------------

/** vault 里属于本插件的库目录（这两个目录不出现在「参考笔记」候选里）。 */
const VAULT_LIB_EXCLUDES = [
  VAULT_MIRROR_DIR + '/' + VAULT_MIRROR_PROMPTS,
  VAULT_MIRROR_DIR + '/' + VAULT_MIRROR_STYLES,
]

/**
 * 读 Obsidian 库（提示词笔记 + 风格画像）。没配 vault / 读不到时返回空库，绝不阻断生成。
 * 返回值里的 prompts 是 {'<genre>:<step>': {system,user,path}}，styles 是 parseStyle 产物数组。
 */
async function readVaultLibrary(vaultPath) {
  const vaultRoot = resolveVaultRoot(vaultPath)
  if (vaultRoot === null || vaultRoot === '') return { root: '', prompts: {}, promptErrors: [], styles: [] }
  try {
    const [prompts, styles] = await Promise.all([readPromptLibrary(vaultRoot), readStyleLibrary(vaultRoot)])
    return { root: vaultRoot, prompts: prompts.notes, promptErrors: prompts.errors, styles }
  } catch {
    return { root: vaultRoot, prompts: {}, promptErrors: [], styles: [] }
  }
}

/** 本地 styles 目录 + vault 风格画像（同 id 时 vault 覆盖本地，用户在 Obsidian 改的版本生效）。 */
async function listStylesAll(root, lib) {
  const local = await listStyles({ root })
  const vs = lib === undefined || lib === null ? [] : lib.styles
  if (vs.length === 0) return local
  const byId = new Map(local.map((s) => [s.id, s]))
  for (const s of vs) byId.set(s.id, s)
  return Array.from(byId.values())
}

/** 取一份风格画像：vault 优先，其次本地 styles 目录；都没有返回 null。 */
async function loadStyleAny(root, id, lib) {
  if (id === '') return null
  const vs = lib === undefined || lib === null ? [] : lib.styles
  const hit = vs.find((s) => s.id === id)
  if (hit !== undefined) return hit
  return await loadStyle({ root, id })
}

/** 生效提示词覆盖 = 本地 prompts.json + vault 提示词笔记（同 key 时 vault 覆盖本地）。 */
async function readAllOverrides(root, lib) {
  const local = await WS.readPromptOverrides(root)
  const fromVault = lib === undefined || lib === null ? {} : lib.prompts
  if (Object.keys(fromVault).length === 0) return local
  return { ...local, ...fromVault }
}

/** vault 提示词笔记覆盖了哪些 key（客户端据此标「来自 Obsidian」）。 */
function vaultPromptKeys(lib) {
  return new Set(Object.keys(lib === undefined || lib === null ? {} : lib.prompts))
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

/**
 * 取某一步的**生效**提示词：内置默认 + 用户覆盖（按字段）。
 * 用户覆盖为空串时视为「显式清空」，不做静默回落——否则用户删掉一段
 * 却发现它还在，会以为是 bug。
 */
function effectivePrompt(overrides, genreId, step) {
  const key = `${genreId}:${step.id}`
  const ov = overrides[key] ?? {}
  return {
    key,
    system: typeof ov.system === 'string' ? ov.system : step.system,
    user: typeof ov.user === 'string' ? ov.user : step.user,
    overridden: typeof ov.system === 'string' || typeof ov.user === 'string',
  }
}

/**
 * 占位符兜底：用户改过的提示词（覆盖版）可能没有 {{style}} / {{vault}} / {{fanqieTags}} / {{existing}}
 * 占位符，此时直接 renderPrompt 会把风格画像 / 参考笔记 / 番茄上架信息 / 已有设定**静默丢掉**
 * （表现就是「画像没生效」「上架信息那一节不见了」，或最糟的「重新生成定位时把故事写成了另一本」）。
 * 缺占位符时把对应块挂到末尾：风格画像挂 system（写作约束），参考笔记/上架信息/已有设定挂 user（本次任务要求）。
 */
function applyMissingBlocks(prompts, system, user, blocks) {
  const has = (ph) => String(prompts.system ?? '').includes(ph) || String(prompts.user ?? '').includes(ph)
  const out = { system, user, styleAppended: false, vaultAppended: false, fanqieAppended: false, existingAppended: false }
  if (blocks.styleBlock !== '' && !has('{{style}}')) { out.system = system + blocks.styleBlock; out.styleAppended = true }
  if (blocks.vaultBlock !== '' && !has('{{vault}}')) { out.user = user + blocks.vaultBlock; out.vaultAppended = true }
  const existingBlock = String(blocks.existingBlock ?? '')
  if (existingBlock !== '' && !has('{{existing}}')) { out.user = out.user + existingBlock; out.existingAppended = true }
  const fanqieBlock = String(blocks.fanqieBlock ?? '')
  if (fanqieBlock !== '' && !has('{{fanqieTags}}')) { out.user = out.user + fanqieBlock; out.fanqieAppended = true }
  return out
}

/**
 * 「已有设定」块（进 {{existing}} 的兜底文本）：只在作品定位步、且确实读到了下游产物时非空。
 * 语义是**硬约束**而不是参考：重新生成定位不得改名换设定、不得另起故事。
 */
function existingBlockOf(existing) {
  const body = String(existing ?? '').trim()
  if (body === '') return ''
  return (
    '\n【已有设定（这部作品已经写下的部分，必须保持一致）】\n' +
    body + '\n' +
    '（以上内容已经落盘并在用：新生成的候选必须沿用同一批人物姓名与身份、地名/阵营、金手指与主线走向，' +
    '只允许在它们的基础上细化与补齐；一个字段都不能改名换设定，更不要另起新故事。' +
    '若你写的定位与上面冲突，一律以上面的已有设定为准。）\n'
  )
}

/** 候选标题用的中文序数（最多 6 个候选）。 */
const CANDIDATE_NUM = ['一', '二', '三', '四', '五', '六']

/**
 * 作品定位步的「只写第 N 个候选」指令（用户 m02336：一次让模型写多个候选 + 多轮续写会把结构写散，
 * 出现「（未识别出书名）」与上架信息缺失）。改成**每个候选单独一次调用**，结构由宿主按节固定，
 * 续写只在这个候选内部发生，解析器就永远能认出书名与 8 行上架标签。
 */
function positioningOneUser(baseUser, index, total) {
  const cn = CANDIDATE_NUM[index - 1] ?? String(index)
  return baseUser + [
    '',
    `【本次只输出第 ${index} 个候选（这一部作品共 ${total} 个候选）】`,
    `- 标题必须写成「## 候选${cn}」，只写这一个候选：不要写其它候选，不要解释、不要总结、不要复述要求；`,
    '- 必须完整包含四节，顺序与小标题固定：',
    '  ### 一、作品定位（其中必须有「- 书名：…」一行，书名不超过 15 字）',
    '  ### 二、主角人设（其中必须有「- 主角人名：…」一行，人名不超过 5 字）',
    '  ### 三、重要配角（每人一行「人名 | 年纪 | 描述」，2-4 人）',
    '  ### 四、上架信息（8 行字段：- 阅读标签·主分类 / ·主题 / ·角色 / ·情节，- 内容标签·情节 / ·情感 / ·人设 / ·世界观，最后一行「- 作品简介：…」50~500 字）',
    '- 四节缺一不可；标签只能用上面官方清单里的名字，作品简介必须写满 50 字以上。',
    `- 这是第 ${index} 个候选：设定、主角与卖点要与另外几个候选有明显差异。`,
  ].join('\n')
}

/** 人物步最多分几段（每人一段）；再多就只写前面这几个主要人物。 */
const CHARACTER_MAX_PARTS = 8
/** 人物步每段的目标字数（单个人物档案 / 关系简表）。 */
const CHARACTER_PART_CHARS = 700

/** 章节大纲一次请求的时间预算（毫秒）：超了就先把已写的给用户，再点「继续补齐」接着写。 */
const CHAPTER_OUTLINE_BUDGET_MS = 8 * 60 * 1000

/** 人物步第一步：只要名单（一行一个人名），用来决定后面分几段。 */
function charactersRosterUser(baseUser, max) {
  return baseUser + [
    '',
    '【本次只输出人物名单】',
    `- 先只列「主要出场人物」名单（含主角），最多 ${max} 人，按重要性排序；`,
    '- 每行格式固定：- 人名 | 身份 | 一句话定位',
    '- 只输出这个名单，**不要写人物档案**、不要写关系表、不要解释。',
  ].join('\n')
}

/** 人物步第二步：只写第 index 个人物的档案。 */
function characterOneUser(baseUser, name, index, total) {
  return baseUser + [
    '',
    `【本次只输出第 ${index} 个人物档案（共 ${total} 人）】`,
    `- 只写「## ${name}」这一节，不要写别人、不要写关系表、不要解释；`,
    '- 节内按这几行写全：- 身份 / - 外貌与气质 / - 性格与说话方式 / - 他想要什么（欲望） / - 他怕什么 / - 秘密 / - 与主角的关系 / - 成长弧线；',
    '- 每行都要写具体内容，不要留空、不要写「同上」。',
  ].join('\n')
}

/** 人物步第三步：只写人物关系简表。 */
function charactersRelationsUser(baseUser, names) {
  return baseUser + [
    '',
    '【本次只输出人物关系简表】',
    '- 用一个表格：| 人物A | 关系 | 人物B | 张力/伏笔 |；',
    `- 只覆盖这几位主要人物：${names.join('、')}；`,
    '- 只输出这张表，不要重复人物档案、不要解释。',
  ].join('\n')
}

/** 从名单输出里抠人名：认「- 人名 | 身份 | …」这种行，去重、限长。 */
function parseCharacterNames(text) {
  const out = []
  const seen = new Set()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const m = /^[-*·•]?\s*\**\s*([^|｜:：]{1,12}?)\s*\**\s*[|｜]/.exec(line)
    if (m === null) continue
    const name = m[1].trim().replace(/^[-*·•\s]+/, '')
    if (name === '' || name.length > 12 || seen.has(name)) continue
    if (/^(人物|姓名|名字|角色)$/.test(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** 从卷大纲文本里取「预计章数」（用户 m02587：章节大纲只写了 6 章）。支持「15-20 章」「约 20 章」「第 15~20 章」。 */
function expectedChaptersOf(volumeText) {
  const s = String(volumeText ?? '')
  const block = /预计章数[\s\S]{0,80}?(\d{1,3})\s*(?:[-–~—至到]\s*(\d{1,3})\s*)?章/.exec(s)
  if (block !== null) {
    const lo = Number(block[1])
    const hi = block[2] === undefined ? NaN : Number(block[2])
    const n = Number.isFinite(lo) && lo > 0 ? lo : (Number.isFinite(hi) && hi > 0 ? hi : 0)
    if (n > 0) return Math.max(1, Math.min(60, Math.floor(n)))
  }
  const any = /(?:本卷|这一卷)[^\n]{0,20}?(\d{1,3})\s*章/.exec(s)
  if (any !== null) return Math.max(1, Math.min(60, Math.floor(Number(any[1]))))
  return 0
}

/** 数细纲里已经写了多少章（「### 第 N 章 …」，N 支持中文数字）。 */
function countOutlineChapters(text) {
  const re = /^#{2,4}[ \t]*第[ \t]*([0-9０-９零〇一二三四五六七八九十百千两]+)[ \t]*章/gm
  const hits = String(text ?? '').match(re)
  return hits === null ? 0 : hits.length
}

/**
 * 章节大纲收尾整理（用户 m02656：生成到第 18 章就断了）：
 * ① 丢掉末尾被截断的半截条目（只有「### 第 N 章 …」标题、没有一行 `- 字段`）；
 * ② 按出现顺序把章号重排成 1..K——模型补写时常跳号（实测缺第 7 章）。
 */
function tidyChapterOutline(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const headRe = /^#{2,4}[ \t]*第[ \t]*[0-9０-９零〇一二三四五六七八九十百千两]+[ \t]*章/
  const idxs = []
  for (let i = 0; i < lines.length; i += 1) {
    if (headRe.test(lines[i].trim())) idxs.push(i)
  }
  if (idxs.length === 0) return { text: String(text ?? ''), dropped: 0, renumbered: false }
  const complete = (k) => {
    const from = idxs[k] + 1
    const to = k + 1 < idxs.length ? idxs[k + 1] : lines.length
    for (let j = from; j < to; j += 1) {
      if (/^[ \t]*[-*·•][ \t]*/.test(lines[j])) return true
    }
    return false
  }
  let dropped = 0
  // 末尾若是半截块（有标题没内容）就丢掉；一路往前丢，直到最后一块是完整的
  let keep = idxs.length
  while (keep > 0 && !complete(keep - 1)) { keep -= 1; dropped += 1 }
  if (keep === 0) return { text: '', dropped, renumbered: false }
  const endLine = keep < idxs.length ? idxs[keep] : lines.length
  const head = lines.slice(0, idxs[0])
  const out = head.slice()
  let renumbered = false
  for (let k = 0; k < keep; k += 1) {
    const from = idxs[k]
    const to = k + 1 < keep ? idxs[k + 1] : endLine
    const rest = lines[from].trim().replace(headRe, '').trim()
    const want = '### 第 ' + (k + 1) + ' 章' + (rest === '' ? '' : ' ' + rest)
    if (lines[from].trim() !== want) renumbered = true
    out.push(want)
    for (let j = from + 1; j < to; j += 1) out.push(lines[j])
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped, renumbered }
}

/** 章节大纲的「补写第 from~to 章」指令：本地模型一次写不满一卷时，按区间一段段补。 */
function chapterOutlineAskUser(baseUser, from, to, tail) {
  return baseUser + [
    '',
    `【本次只补写第 ${from} 章到第 ${to} 章（共 ${to - from + 1} 章）】`,
    `- 紧接上面已经写过的细纲往下写：从「### 第 ${from} 章 章名」写到「### 第 ${to} 章 章名」，一章都不能少、不能跳号；`,
    '- 每章格式与上面完全一致：### 第 N 章 章名 + 场景 / 冲突 / 出场人物 / 本章推进的剧情点 / 结尾钩子 / 目标字数；',
    '- 不要重复已写过的章节，不要重新开头，不要解释；**不要写正文**（不要写对白、不要写成段叙述）。',
    '',
    '【已写细纲的结尾（只用来定位断点，不要重复它）】',
    tail,
  ].join('\n')
}

/** 各步的「续写禁区」（用户 m02480：章节大纲后面又冒出正文）。只放最容易被小模型越界的那几步。 */
const STEP_SCOPE_BANS = {
  'novel:positioning': '只写候选的四节（作品定位 / 主角人设 / 重要配角 / 上架信息），不要写章节正文、不要写对话或场景描写。',
  'novel:outline': '只写一句话故事、核心冲突、世界观要点、主线三幕、情绪节奏、结局走向；不要写章节正文，不要写具体对白或场景。',
  'novel:characters': '只写人物档案与关系简表；不要写剧情正文，不要写对白场面。',
  'novel:volume-outline': '只写每卷的卷名 / 本卷目标 / 主要事件 / 新登场人物 / 卷末钩子 / 预计章数 / 情绪走向；不要写章节正文。',
  'novel:chapter-outline': '只写「### 第 N 章 章名」+ 4-6 行「- 场景 / - 冲突 / - 出场人物 / - 本章推进的剧情点 / - 结尾钩子」；**绝对不要写正文**——不要写对白、不要写成段叙述、不要把任何一章展开写。',
  'novel:chapter': '只写这一章正文；不要写下一章，也不要写大纲、设定或总结。',
  'novel:polish': '只输出润色后的这一章正文；不要写别的章节，也不要写说明。',
  'wechat:body': '只写这一篇正文，不要写下一篇。',
  'xiaohongshu:body': '只写这一篇正文，不要写下一篇。',
}

/** 拼「本步产物边界」：给续写轮用，明确这一步该写什么、绝不要写什么。 */
function stepScopeHint(genreId, stepId, label, artifact) {
  const ban = STEP_SCOPE_BANS[String(genreId) + ':' + String(stepId)] ?? ''
  return '这一步只产出「' + String(label) + '」（' + String(artifact ?? '') + '）；只把这一步的内容写完整，不要写下一步的产物。' + ban
}

/**
 * 章节大纲的越界兜底：本步合法行只有「### 第 N 章 …」「- 字段：…」「表格行」「标题行」。
 * 一旦出现连续的「长散文行」（不以 - / # / | 开头且 ≥24 字），判定为模型开始写正文，从第一段处截断：
 * - 连续 3 行以上；或
 * - 连续 2 行以上且其中带对白引号（「」『』“”\"）——单段对白最能说明它在写正文。
 */
function trimChapterOutlineProse(text) {
  const src = String(text ?? '')
  const lines = src.split(/\r?\n/)
  let run = 0
  let runStart = -1
  let runQuote = false
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim()
    if (t === '') continue
    const legal = /^#{1,6}\s/.test(t) || /^[-*·•]\s/.test(t) || /^\|/.test(t) || /^第\s*[0-9一二三四五六七八九十百零〇两]+\s*章/.test(t)
    if (legal) { run = 0; runStart = -1; runQuote = false; continue }
    if (t.length >= 24) {
      if (run === 0) { runStart = i; runQuote = false }
      run += 1
      if (/[「」『』“”"]/.test(t)) runQuote = true
      if (run >= 3 || (run >= 2 && runQuote)) {
        return { text: lines.slice(0, runStart).join('\n').trimEnd(), trimmed: true }
      }
    } else { run = 0; runStart = -1; runQuote = false }
  }
  return { text: src, trimmed: false }
}

/**
 * 这一步「写够才算完」的字数目标（传给 callModel.targetChars，写不到 90% 就自动续写）：
 * - 正文步（chapter / body）：作品设置里的单章目标字数；
 * - 润色步（polish / deai）：被润色原文的长度 ×0.95（只改文字，篇幅应与原文相当）；
 * - 其余步骤：genres.js 的 STEP_TARGET_CHARS（作品定位按候选数翻倍）；
 * - 都没配到 ⇒ 0，退回旧行为「只有被长度上限截断才续写」。
 */
function targetCharsOf(step, meta, body, sourceChars = 0) {
  if (step === null || step === undefined) return 0
  const id = String(step.id ?? '')
  if (id === 'chapter' || id === 'body') {
    const w = Number(meta?.words)
    if (!Number.isFinite(w) || w <= 0) return 0
    // 夹进合理区间：历史数据里有人把「全书总长度」填进了「单章目标字数」（用户 m02810：300000），
    // 不夹的话单章会一直提示「未达目标 300000 字」并空转续写。
    return WS.clampChapterWords(w)
  }
  if (id === 'polish' || id === 'deai') {
    return sourceChars > 0 ? Math.floor(sourceChars * 0.95) : 0
  }
  const count = Number(body?.count ?? meta?.count ?? 1)
  return stepTargetChars(String(meta?.genre ?? 'novel'), id, Number.isFinite(count) ? count : 1)
}

/**
 * 供客户端渲染的完整步骤视图：步骤元信息 + 生效提示词 + 默认提示词。
 * vaultKeys 里的 key 表示这一步的提示词来自 Obsidian 笔记（客户端会标出来）。
 */
function stepsView(genreId, overrides, vaultKeys) {
  const genre = genreById(genreId)
  const fromVault = vaultKeys instanceof Set ? vaultKeys : new Set()
  return genre.steps.map((step) => {
    const eff = effectivePrompt(overrides, genre.id, step)
    const ov = overrides[eff.key] ?? {}
    return {
      id: step.id,
      no: step.no,
      label: step.label,
      goal: step.goal,
      artifact: step.artifact,
      produces: step.produces ?? '',
      suffix: step.suffix ?? '',
      sourceSuffix: step.sourceSuffix ?? '',
      system: eff.system,
      user: eff.user,
      defaultSystem: step.system,
      defaultUser: step.user,
      overridden: eff.overridden,
      fromVault: fromVault.has(eff.key),
      vaultPath: fromVault.has(eff.key) && typeof ov.path === 'string' ? ov.path : '',
    }
  })
}

/** 供客户端渲染的风格画像视图（七维度 + 元信息）。 */
function styleView(s) {
  return {
    id: s.id,
    name: s.name,
    genre: s.genre,
    tags: s.tags,
    pov: s.pov,
    rhythm: s.rhythm,
    dialogue: s.dialogue,
    description: s.description,
    tone: s.tone,
    chapterRhythm: s.chapterRhythm,
    beatRhythm: s.beatRhythm,
    source: s.source === 'vault' ? 'vault' : 'user',
    path: typeof s.path === 'string' ? s.path : '',
  }
}

/** 从知识库内容推断作品立项元信息：类型/书名/题材/受众/调性/标签（只输出 JSON）。 */
const GENRE_IDS = GENRES.map((g) => g.id)
function inferProjectPrompts(corpus) {
  const genreLine = GENRES.map((g) => g.id + '=' + g.label).join('、')
  const system =
    '你是作品立项助手。根据给定知识库里的内容，判断它最适合写成的作品类型，并给出立项建议。' +
    '只输出一个 JSON 对象，不要输出任何其它文字，不要用代码块标记。'
  const user =
    '【知识库内容（已截断）】\n' + corpus + '\n\n' +
    '请判断并输出一个 JSON：\n' +
    '- genre：从这些里选一个：' + genreLine + '（novel=小说、wechat=公众号、xiaohongshu=小红书）\n' +
    '- name：建议的书名/作品名（novel 可写「未定」，其它类型请给一个可用名）\n' +
    '- theme：一句话题材 / 内容方向\n' +
    '- audience：目标读者\n' +
    '- tone：整体调性\n' +
    '- tags：3-5 个短标签（字符串数组）\n\n' +
    '严格按这个结构输出，双引号，不要任何多余文字：\n' +
    '{"genre":"novel","name":"","theme":"","audience":"","tone":"","tags":["",""]}'
  return { system, user }
}

/** 解析立项推断结果；模型输出不规范时回退到安全默认值（novel + 空字段）。 */
function parseInfer(text) {
  const s = String(text ?? '').trim()
  let obj = null
  try {
    obj = JSON.parse(s)
  } catch {
    const m = /\{[\s\S]*\}/.exec(s)
    if (m !== null) {
      try { obj = JSON.parse(m[0]) } catch { obj = null }
    }
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) obj = {}
  const genre = GENRE_IDS.includes(obj.genre) ? obj.genre : 'novel'
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const tags = Array.isArray(obj.tags)
    ? obj.tags.map((t) => String(t).trim()).filter((t) => t !== '').slice(0, 8)
    : []
  return { genre, name: str(obj.name), theme: str(obj.theme), audience: str(obj.audience), tone: str(obj.tone), tags }
}

// ---------------------------------------------------------------------------
// 技能注册
// ---------------------------------------------------------------------------

/**
 * 把每个写作类型的步骤链注册成一个 dsh 技能，让对话里也能直接唤起。
 *
 * 与 `dsh-novel-craft` 的差别：它是随包发 skills/ 目录、要求用户手工复制到技能目录；
 * 这里走 `ctx.skills.register()` 程序化注册，装上就能用，不需要用户知道技能目录在哪。
 * 技能正文只写「怎么按步骤推进」，模型调用由工作台负责，避免两套入口互相打架。
 */
function skillContentFor(genre) {
  const lines = [
    `# ${genre.label}写作流程`,
    '',
    genre.hint,
    '',
    '按以下步骤推进；每一步都先产出草稿、再由用户确认落盘。不要跳步，'+
      '也不要在用户没确认前自行把后续步骤一起写完。',
    '',
  ]
  for (const step of genre.steps) {
    lines.push(`## 第 ${step.no} 步 · ${step.label}`)
    lines.push(`目标：${step.goal}`)
    lines.push(`产物：${step.artifact}`)
    lines.push('')
  }
  lines.push('## 通用要求')
  lines.push('- 交付前逐项走一遍去 AI 化六维度自检（解释性旁白 / 排比堆砌 / 总结式收尾 / 形容词副词过密 / 对话书面腔 / 段落长度均匀）。')
  lines.push('- 上下文只带已完成的步骤产物，不要要求用户重贴全文。')
  return lines.join('\n')
}

function registerSkills(sctx) {
  const offs = []
  for (const genre of GENRES) {
    try {
      offs.push(
        sctx.skills.register({
          name: `writer-${genre.id}`,
          description: `按 ${genre.label} 的分步流程写作：${genre.steps.map((s) => s.label).join(' → ')}`,
          source: 'runtime',
          provider: NS,
          content: skillContentFor(genre),
        }),
      )
    } catch {
      // 技能名冲突或注册表拒绝：不影响工作台，跳过即可
    }
  }
  return () => {
    for (const off of offs) {
      try {
        off()
      } catch {
        // 释放失败不该影响插件卸载的其余部分
      }
    }
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export async function apply(ctx, rawConfig = {}) {
  const ready = await awaitServices(ctx, ['webServer', 'skills'], 15000)
  if (ready === null) return
  const webServer = ready.webServer ?? ctx.get('webServer')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return

  let config = normalizedConfig(rawConfig)
  const cfg = () => config

  /** 写回插件行配置：优先 configEditor，其次旧版 settings scope。 */
  const saveConfig = async (patch) => {
    const next = normalizedConfig({ ...config, ...patch })
    const editor = ctx.get('configEditor')
    if (editor === undefined || editor === null || typeof editor.edit !== 'function') {
      // 没有 configEditor 时不静默失败：本次会话内仍然生效，同时如实告知用户
      config = next
      return { persisted: false, config: next, warning: '这个 dsh 不支持写入插件配置，改动只在本次会话内生效；请直接编辑 profile 的 cordis.patch.yml' }
    }
    let entries = []
    try {
      entries = typeof editor.entries === 'function' ? editor.entries() : []
    } catch {
      entries = []
    }
    const entry = entries.find((e) => {
      const id = String(e?.id ?? '')
      const nm = typeof e?.name === 'string' && e.name !== '' ? e.name : String(e?.options?.name ?? '')
      return id === NS || nm === NS || id.endsWith(':' + NS) || id.endsWith('/' + NS)
    })
    if (entry === undefined) {
      config = next
      return { persisted: false, config: next, warning: '找不到插件配置行，改动只在本次会话内生效' }
    }
    await editor.edit(entry, (current) => ({ ...(current ?? {}), ...patch }))
    config = next
    return { persisted: true, config: next, warning: '' }
  }

  // 技能注册（skills 服务可能比 webServer 晚到，所以单独 inject 一次）
  try {
    ctx.inject(['skills'], (sctx) => {
      const off = registerSkills(sctx)
      if (typeof sctx.effect === 'function') sctx.effect(() => off)
      // 没有 effect 钩子时保持注册，不立即释放——否则技能刚注册就被卸载（headless 下尤其明显）
    })
  } catch {
    // skills 服务缺席：技能入口没有，工作台照常
  }

  // -------------------------------------------------------------------------
  // 路由
  // -------------------------------------------------------------------------
  /**
   * 注册一条 API 路由。
   * @param path 相对 API_PREFIX 的路径
   * @param handler (body, req) => result；返回体自动 JSON 化，抛错回 400
   * @param options.maxBody 该路由的请求体上限（字节），缺省 JSON_BODY_LIMIT。
   *   只有需要收大体的路由（封面上传）才放宽——上限是内存保护，不是安全边界。
   */
  const route = (path, handler, options = {}) => {
    const maxBody = Number.isFinite(options?.maxBody) && options.maxBody > 0 ? options.maxBody : JSON_BODY_LIMIT
    const off = webServer.register({
      kind: 'exact',
      path: API_PREFIX + path,
      handler: (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        if (!isLoopback(req)) return send(403, { error: 'dsh-writer-m API 只服务本机回环地址' })
        if (cfg().enabled === false) return send(503, { error: 'dsh-writer-m 已被配置停用' })
        Promise.resolve()
          .then(async () => {
            const body = req.method === 'POST' ? await readJsonBody(req, maxBody) : {}
            if (body.__error !== undefined) return send(Number.isInteger(body.__status) ? body.__status : 400, { error: body.__error })
            const result = await handler(body, req)
            if (!res.writableEnded) send(200, result)
          })
          .catch((error) => {
            if (!res.writableEnded) send(400, { error: error instanceof Error ? error.message : String(error) })
          })
      },
    })
    // 改配置会重载插件、apply 再跑一遍；挂进 effect 随插件释放，否则第二次注册撞 duplicate route
    if (typeof off === 'function' && typeof ctx.effect === 'function') ctx.effect(() => off)
  }

  /** 首屏：类型 + 步骤 + 模版 + 作品列表 + 配置。一次拿全，避免前端串行请求。 */
  route('state', async () => {
    const conf = cfg()
    const root = conf.root
    const lib = await readVaultLibrary(cfg().vaultPath)
    const overrides = await readAllOverrides(root, lib)
    const vaultKeys = vaultPromptKeys(lib)
    const templates = await listTemplates({ builtinDir: BUILTIN_TEMPLATE_DIR, root })
    const styles = await listStylesAll(root, lib)
    const vaultRoot = resolveVaultRoot(conf.vaultPath)
    const vaults = listVaults()
    // 作品列表带上风格名（客户端直接显示，不用再查一遍 styles）
    const styleNames = new Map(styles.map((s) => [s.id, s.name]))
    const projects = (await WS.listProjects(root)).map((p) => ({
      ...p,
      styleName: p.styleId === '' ? '' : (styleNames.get(p.styleId) ?? ''),
    }))
    return {
      config: { ...conf },
      root,
      rootExists: (await WS.readProject(root, '__probe__')) === null,
      genres: GENRES.map((g) => ({
        id: g.id,
        label: g.label,
        hint: g.hint,
        supportsVolumes: g.supportsVolumes,
        defaultWords: g.defaultWords,
        requireWords: g.requireWords === true,
        wordsLabel: g.wordsLabel,
        steps: stepsView(g.id, overrides, vaultKeys),
      })),
      templates: templates.map((t) => ({ id: t.id, name: t.name, genre: t.genre, source: t.source, sections: t.sections, constraints: t.constraints })),
      styles: styles.map(styleView),
      library: {
        root: lib.root,
        prompts: Object.keys(lib.prompts).length,
        promptErrors: lib.promptErrors,
        styles: lib.styles.length,
        dirs: { prompts: VAULT_MIRROR_PROMPTS, styles: VAULT_MIRROR_STYLES },
      },
      vault: { root: vaultRoot, available: vaultRoot !== null && vaultRoot !== '', vaults, selected: vaultRoot },
      projects,
      novelOptions: {
        channels: NOVEL_CHANNELS,
        ...(await WS.mergedNovelOptions(root)),
      },
      deai: DEAI_DIMENSIONS,
      llm: {
        configured: conf.provider !== '' && conf.model !== '',
        route: resolveRoute(ctx, conf),
        maxTokens: conf.maxTokens,
      },
      publish: {
        profile: conf.publishProfile,
        script: conf.publishScript !== '' ? conf.publishScript : join(PACKAGE_DIR, 'scripts', 'fanqie_publish.py'),
        bookName: conf.publishBookName,
        ready: conf.publishProfile !== '',
      },
      // 带 tail：设置页要把「等待扫码…」的进度直接显示出来（日志很短，几十行）
      fanqie: await fanqieStatus(),
    }
  })

  /** 保存配置（目前只有根目录与模型路由需要从界面改）。 */
  route('config', async (body) => {
    const patch = body?.patch ?? {}
    const allowed = {}
    const keys = [
      'root', 'enabled', 'provider', 'model', 'maxTokens', 'vaultPath',
      // 番茄发布/登录：设置页要能改，否则只能手编 cordis.patch.yml
      'publishPython', 'publishScript', 'publishProfile', 'publishBookName', 'publishLoginScript',
    ]
    for (const key of keys) {
      if (patch[key] !== undefined) allowed[key] = patch[key]
    }
    return await saveConfig(allowed)
  })

  /** 新建/补全作品、给已有作品换风格，或删除作品（删除会连 vault 里的镜像目录一起清掉）。 */
  route('project', async (body) => {
    const root = cfg().root
    // 给「已有的作品」换风格：只动 styleId，不碰其它元数据（见 setProjectStyle 注释）。
    if (body?.action === 'style') {
      const id = String(body?.id ?? '').trim()
      if (id === '') throw new Error('缺少作品 id')
      const styleId = String(body?.styleId ?? '').trim()
      if (styleId !== '' && (await loadStyleAny(root, styleId, await readVaultLibrary(cfg().vaultPath))) === null) {
        throw new Error('风格画像不存在：' + styleId + '（可能还没安装到 styles 目录，也没有同名 Obsidian 笔记）')
      }
      const saved = await WS.setProjectStyle(root, id, styleId)
      if (saved === null) throw new Error('作品不存在：' + id)
      return { id: saved.id, styleId: saved.meta.styleId, meta: saved.meta }
    }
    // 改篇幅：单章目标字数 / 全书总长度（用户 m02810：新建时把 300000 填进「单章目标字数」，
    // 之后没有任何入口能改回来，单章生成永远提示「未达目标 300000 字」）。
    if (body?.action === 'words') {
      const id = String(body?.id ?? '').trim()
      if (id === '') throw new Error('缺少作品 id')
      const saved = await WS.setProjectWords(root, id, {
        words: Number(body?.words),
        totalWords: Number(body?.totalWords),
      })
      if (saved === null) throw new Error('作品不存在：' + id)
      return { id: saved.id, meta: saved.meta }
    }
    if (body?.action === 'delete') {
      const id = String(body?.id ?? '').trim()
      if (id === '') throw new Error('缺少作品 id')
      const removed = await WS.removeProject(root, id)
      const mirrored = await removeMirrorDir(cfg().vaultPath, join(VAULT_MIRROR_DIR, VAULT_MIRROR_WORKS, id))
      return { removed, mirrored }
    }
    const { id, meta } = await WS.ensureProject(root, {
      name: String(body?.name ?? '').trim(),
      genre: String(body?.genre ?? 'novel'),
      theme: String(body?.theme ?? ''),
      audience: String(body?.audience ?? ''),
      tone: String(body?.tone ?? ''),
      templateId: String(body?.templateId ?? ''),
      styleId: String(body?.styleId ?? ''),
      words: Number(body?.words),
      channel: String(body?.channel ?? ''),
      type: String(body?.type ?? ''),
      totalWords: Number(body?.totalWords),
      tags: Array.isArray(body?.tags) ? body.tags : [],
      count: Number(body?.count),
      vaultNotes: Array.isArray(body?.vaultNotes) ? body.vaultNotes : [],
    })
    return { id, meta, dir: WS.projectDirOf(root, id) }
  })

  /** 选用作品定位候选：把作品改名为所选书名（目录与 meta.name 一起改）。 */
  route('rename', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '')
    const name = String(body?.name ?? '').trim()
    if (id === '') throw new Error('缺少作品 id')
    if (name === '') throw new Error('书名不能为空')
    const result = await WS.renameProject(root, id, name)
    return { ...result, dir: WS.projectDirOf(root, result.id) }
  })

  /** 选用作品定位候选：改名为所选书名，定位产物只保留所选候选（未选候选删除）。 */
  route('adopt', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '')
    const name = String(body?.name ?? '').trim()
    const keep = String(body?.keep ?? '')
    if (id === '') throw new Error('缺少作品 id')
    const result = await WS.adoptPositioning(root, id, name, keep)
    return { ...result, dir: WS.projectDirOf(root, result.id) }
  })

  /**
   * 书名工具（修用户 m01329）：发布到番茄时若站内已有同名作品，必须换个书名，但正文/大纲/人物一个字都不该动。
   * action='generate'（缺省）：读已落盘的定位稿 + 大纲摘录，让模型只回候选书名（≤15 字），**不写盘**。
   * action='apply'：把作品改名为所选书名（目录 + meta.name），并把定位稿里的「- 书名：」行一并改写、镜像 vault。
   */
  route('title', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '')
    if (id === '') throw new Error('缺少作品 id')
    const found = await WS.readProject(root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)
    const action = String(body?.action ?? 'generate')
    const current = String(found.meta?.name ?? id)
    const rel = stepById('novel', 'positioning').artifact

    // ---- 应用：改名 + 同步定位稿里的书名行（正文其余部分 Byte 级不动） ----
    if (action === 'apply') {
      const title = cleanTitle(String(body?.title ?? ''))
      if (title === '') throw new Error('书名不能为空')
      const chars = Array.from(title).length
      if (chars > FANQIE_TITLE_MAX) throw new Error(`书名超过 ${FANQIE_TITLE_MAX} 字（番茄创建页输入框限制）：${title}（现在 ${chars} 字）`)
      const renamed = await WS.renameProject(root, id, title)
      let draftUpdated = false
      if (body?.syncDraft !== false) {
        const draft = await WS.readProjectFile(root, renamed.id, rel)
        if (draft.exists && String(draft.text).trim() !== '') {
          const rep = replaceTitleLines(draft.text, title)
          if (rep.changed) {
            await WS.writeArtifact(root, renamed.id, rel, rep.text)
            await mirrorToVault(cfg().vaultPath, rep.text, join(VAULT_MIRROR_DIR, VAULT_MIRROR_WORKS, renamed.id, rel))
            draftUpdated = true
          }
        }
      }
      return { id: renamed.id, dir: WS.projectDirOf(root, renamed.id), title, renamed: renamed.renamed, draftUpdated, rel }
    }
    if (action !== 'generate') throw new Error(`未知 action：${action}`)

    // ---- 生成：只产出候选书名，不落盘、不碰任何产物 ----
    const llm = ctx.get('llm')
    const route = resolveRoute(ctx, cfg())
    if (llm === undefined || llm === null) throw new Error('这个 dsh 没有可用的 llm 服务')
    if (route === null) throw new Error('没有可用的模型路由：请先设置默认模型')
    const draft = await WS.readProjectFile(root, id, rel)
    let brief = ''
    if (draft.exists && String(draft.text).trim() !== '') {
      const rep = fanqieListingReports([draft.text])[0]
      brief = String(rep?.brief ?? '').trim()
    }
    const outlineArt = await WS.readProjectFile(root, id, 'steps/02-大纲.md')
    const outline = outlineArt.exists ? clip(outlineArt.text, 1200) : ''
    const count = Math.max(1, Math.min(6, Number(body?.count ?? 4) || 4))
    const prompts = titlePrompts({
      current,
      channel: String(found.meta?.channel ?? ''),
      type: String(found.meta?.type ?? ''),
      tags: Array.isArray(found.meta?.tags) ? found.meta.tags : [],
      brief,
      outline,
      count,
    })
    const result = await callModel(llm, route, {
      system: prompts.system,
      user: prompts.user,
      maxTokens: 1200,
      reasoningEffort: 'off',
    })
    const others = (await WS.listProjects(root))
      .map((p) => String(p.name ?? p.id ?? ''))
      .filter((n) => n !== '' && n !== current)
    const candidates = parseTitleCandidates(result.text, { current }).map((c) =>
      Object.assign({}, c, { localConflict: others.some((n) => cleanTitle(n) === c.title) }),
    )
    return {
      id,
      current,
      rel,
      count,
      candidates,
      existingLocal: others.slice(0, 40),
      finish: result.finish,
      warning: finishWarning(result.finish, result.text),
      promptUsed: prompts,
    }
  })

  /** 单作品详情：步骤状态 + 已有产物 + 生效提示词。 */
  route('detail', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '')
    const found = await WS.readProject(root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)
    const lib = await readVaultLibrary(cfg().vaultPath)
    const overrides = await readAllOverrides(root, lib)
    const steps = await WS.stepsStatus(found.dir, found.meta.genre)
    const views = stepsView(found.meta.genre, overrides, vaultPromptKeys(lib))
    const merged = views.map((v) => {
      const st = steps.find((s) => s.id === v.id) ?? {}
      return { ...v, done: st.done === true, chars: st.chars ?? 0, chapters: st.chapters ?? 0, files: st.files ?? [], updatedAt: st.updatedAt ?? '' }
    })
    const volumes = (await WS.listVolumes(found.dir)).map((v) => ({ no: v.no, key: v.key, title: v.title }))
    return { id, dir: found.dir, meta: found.meta, steps: merged, volumes, deai: DEAI_DIMENSIONS, chapterWordsRange: { min: WS.CHAPTER_WORDS_MIN, max: WS.CHAPTER_WORDS_MAX } }
  })

  /** 读某步产物原文（含章节列表）。 */
  route('read', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '')
    const rel = String(body?.path ?? '')
    const found = await WS.readProject(root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)
    const target = rel === '' ? 'project.json' : rel
    const res = await WS.readProjectFile(root, id, target)
    return { path: res.path, exists: res.exists, text: res.text }
  })

  /** 读外部文档（任意绝对路径；回环 API 仅本机浏览器可达）——右侧栏「送进工作台改」的入口。 */
  route('import', async (body) => {
    const path = String(body?.path ?? '').trim()
    if (path === '') throw new Error('缺少文件路径')
    const text = await readTextSafe(path)
    return { path, text, chars: charCount(text) }
  })

  /** 把「送进工作台改」的文档写回原文件（先 .bak 备份再覆盖；回环 API 仅本机浏览器可达）。 */
  route('writeback', async (body) => {
    const path = String(body?.path ?? '').trim()
    if (path === '') throw new Error('缺少文件路径')
    const text = String(body?.text ?? '')
    const before = await readTextSafe(path)
    const bak = path + '.bak'
    await writeAtomic(bak, before)
    await writeAtomic(path, text)
    return { path, backedUpTo: bak, chars: charCount(text) }
  })

  /** 直接写入某个产物（用户在界面里手改后保存）；mode:'polish' 时先备份原稿并做逐字核对。 */
  route('save', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '')
    const rel = String(body?.path ?? '')
    if (rel === '') throw new Error('缺少产物路径')
    const found = await WS.readProject(root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)
    const text = String(body?.text ?? '')

    // 批注式写回（润色把改稿写回原稿）：先备份，再逐字核对；
    // 字数变化过大或原文句子存活率过低（疑似重写/截断）时拒绝写回，除非显式确认。
    if (body?.mode === 'polish') {
      const cur = await WS.readProjectFile(root, id, rel)
      if (cur.exists && String(cur.text ?? '').trim() !== '') {
        await WS.backupArtifact(found.dir, rel)
        const oldChars = charCount(cur.text)
        const newChars = charCount(text)
        const charDelta = oldChars === 0 ? 1 : Math.abs(newChars - oldChars) / oldChars
        const survival = WS.sentenceSurvival(cur.text, text)
        const violent = charDelta > 0.5 || survival.ratio < 0.15
        if (violent && body?.confirm !== true) {
          throw new Error(
            '疑似重写而非润色：字数变化 ' + Math.round(charDelta * 100) + '%，原文句子存活 ' +
            Math.round(survival.ratio * 100) + '%（' + survival.kept + '/' + survival.total + '）。' +
            '原稿已备份为 .bak。若确认这是你要的大改，请勾选「确认大改」后再次保存。',
          )
        }
        const path = await WS.writeArtifact(root, id, rel, text)
        await mirrorToVault(cfg().vaultPath, text, join(VAULT_MIRROR_DIR, VAULT_MIRROR_WORKS, id, rel))
        const steps = await WS.stepsStatus(found.dir, found.meta.genre)
        return { path, chars: newChars, steps, polish: { backedUp: true, charDelta, survival } }
      }
    }

    const path = await WS.writeArtifact(root, id, rel, text)
    await mirrorToVault(cfg().vaultPath, text, join(VAULT_MIRROR_DIR, VAULT_MIRROR_WORKS, id, rel))
    const steps = await WS.stepsStatus(found.dir, found.meta.genre)
    return { path, chars: charCount(text), steps }
  })

  /**
   * 规整已落盘章节的首行标题：统一成「第NNN章 章名」（编号取自文件名 ＝ 落盘编号）。
   * 默认只报告（dry-run），apply:true 才写盘；每个被改的文件先备份 .bak，可手工回退。
   * 编号对不上的历史稿件（正文写卷内局部号）靠这里一次对齐。
   */
  route('normalize', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '')
    const found = await WS.readProject(root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)
    const apply = body?.apply === true
    let names = []
    try {
      names = (await readdir(join(found.dir, 'chapters'))).filter((n) => n.toLowerCase().endsWith('.md')).sort()
    } catch {
      names = []
    }
    const changed = []
    for (const name of names) {
      const rel = 'chapters/' + name
      const cur = await WS.readProjectFile(root, id, rel)
      if (!cur.exists) continue
      const out = normalizeChapterFileText(cur.text, name)
      if (!out.changed) continue
      changed.push({ rel, before: out.before, after: out.heading, renumbered: out.renumbered })
      if (apply) {
        await WS.backupArtifact(found.dir, rel)
        await WS.writeArtifact(root, id, rel, out.text)
        await mirrorToVault(cfg().vaultPath, out.text, join(VAULT_MIRROR_DIR, VAULT_MIRROR_WORKS, id, rel))
      }
    }
    const steps = await WS.stepsStatus(found.dir, found.meta.genre)
    return { id, scanned: names.length, changed, applied: apply, steps }
  })

  /** 保存 / 重置某一步的提示词覆盖。 */
  route('prompt', async (body) => {
    const root = cfg().root
    const genreId = genreById(String(body?.genre ?? 'novel')).id
    const stepId = String(body?.step ?? '')
    if (stepById(genreId, stepId) === null) throw new Error(`未知步骤：${genreId}:${stepId}`)
    const key = `${genreId}:${stepId}`
    const step = stepById(genreId, stepId)
    const vaultRoot = resolveVaultRoot(cfg().vaultPath)
    const isReset = body?.reset === true
    // 本次提交的字段（写穿 vault 时要拿它压过 vault 里已有的旧笔记，见下）
    const patch = {}
    if (typeof body?.system === 'string') patch.system = body.system
    if (typeof body?.user === 'string') patch.user = body.user
    if (isReset) {
      await WS.writePromptOverride(root, key, null)
      // 还原内置：本地覆盖清掉的同时删掉 vault 笔记，否则 vault 侧又把它覆盖回来（vault 优先）。
      if (vaultRoot !== null && vaultRoot !== '') {
        try {
          await removeVaultFile(vaultRoot, promptNoteRel(genreId, stepId))
        } catch {
          /* 笔记不存在 / 越界都无所谓，不阻断还原 */
        }
      }
    } else {
      await WS.writePromptOverride(root, key, patch)
    }
    // 写穿到 vault：这份笔记就是「提示词库」里的可编辑副本，改完下一次生成立刻生效。
    // 还原内置时**不写回**：上面刚把笔记删掉，再写一遍等于「还原没生效」（用户会以为点了个寂寞）。
    if (vaultRoot !== null && vaultRoot !== '' && isReset === false) {
      try {
        const lib = await readVaultLibrary(cfg().vaultPath)
        const cur = effectivePrompt(await readAllOverrides(root, lib), genreId, step)
        // 用户刚提交的字段必须赢：readAllOverrides 里 vault 优先，若 vault 已有一份旧笔记，
        // 它会把刚写进 prompts.json 的这次修改立刻盖掉；写穿时再用「被盖掉后」的内容去覆盖笔记，
        // 用户的修改就永久丢失（用户 m02863：在「人物描述」改完提示词、保存后并不生效）。
        const eff = {
          system: typeof patch.system === 'string' ? patch.system : cur.system,
          user: typeof patch.user === 'string' ? patch.user : cur.user,
        }
        await writeVaultFile(
          vaultRoot,
          promptNoteRel(genreId, stepId),
          renderPromptNote({ genreId, stepId, label: step.label, stepNo: step.no, goal: step.goal, system: eff.system, user: eff.user }),
        )
      } catch {
        /* 写 vault 失败不影响本地覆盖 */
      }
    }
    const lib = await readVaultLibrary(cfg().vaultPath)
    const overrides = await readAllOverrides(root, lib)
    return { steps: stepsView(genreId, overrides, vaultPromptKeys(lib)), vaultPath: vaultRoot === null ? '' : promptNoteRel(genreId, stepId) }
  })

  /**
   * 「本步实际注入」的唯一取数路径：route('run') 与 route('preview') 共用。
   * 拼上下文 → 套模版 / 风格画像 / 参考笔记 → 渲染占位符 → 缺占位符兜底。
   * 拆出来是为了让「预览」看到的就是「真跑」发出去的那一份：复制粘贴的副本一定会互相漂移。
   */
  async function buildStepPrompt({ conf, root, found, genre, step, body }) {
    const lib = await readVaultLibrary(cfg().vaultPath)
    const overrides = await readAllOverrides(root, lib)
    const eff = effectivePrompt(overrides, genre.id, step)
    const meta = found.meta

    // 套模版：项目默认模版 + 本次临时模版（临时优先）
    const templateId = String(body?.templateId ?? meta.templateId ?? '')
    const template = templateId === '' ? null : await loadTemplate({ builtinDir: BUILTIN_TEMPLATE_DIR, root, id: templateId })
    const templateBlock = renderTemplateBlock(template)

    // 套风格画像：项目默认画像 + 本次临时画像（临时优先），按步骤感知渲染
    const styleId = String(body?.styleId ?? meta.styleId ?? '')
    const style = await loadStyleAny(root, styleId, lib)
    const styleBlock = renderStyleBlock(style, step.id)

    // 套参考笔记：项目选中的 Obsidian 笔记（正文），注入 {{vault}}
    const vaultRoot = resolveVaultRoot(conf.vaultPath)
    const vaultNotePaths = Array.isArray(body?.vaultNotes) && body.vaultNotes.length > 0
      ? body.vaultNotes
      : (Array.isArray(meta.vaultNotes) ? meta.vaultNotes : [])
    const vaultNotes = vaultRoot === null || vaultRoot === '' ? [] : await resolveVaultNotes(vaultRoot, vaultNotePaths)
    const vaultBlock = renderVaultBlock(vaultNotes)

    // 前序上下文：只带已完成的步骤产物，有界；小说润色取目标章节正文
    const chapter = String(body?.chapter ?? '')
    const context = await WS.buildContext(found.dir, genre.id, step.id, { maxChars: CONTEXT_MAX_CHARS, chapter })

    // 章节大纲步：目标卷（从卷大纲解析出对应卷，注入 {{volume}}）
    const isVolumeOutline = step.produces === 'volume-outline'
    const volumeKey = String(body?.volume ?? '').trim()
    let volumeText = ''
    let actualVolumeKey = volumeKey
    if (isVolumeOutline) {
      const volumes = await WS.listVolumes(found.dir)
      const vol = volumes.find((v) => v.key === volumeKey) ?? volumes[0] ?? null
      if (vol !== null) {
        volumeText = '## ' + vol.title + '\n' + vol.body
        actualVolumeKey = vol.key
      } else {
        volumeText = '（卷大纲里还没有拆出卷，请先完成「卷大纲」这一步）'
        actualVolumeKey = ''
      }
    }

    // 「本章细纲」这一步的额外要求由用户当场粘贴/选择，不塞进项目字段
    const extra = String(body?.extra ?? '').trim()
    // 小说定位字段：友好字符串，供第一步「作品定位」的占位符渲染
    const channelLabel = (NOVEL_CHANNELS.find((c) => c.id === meta.channel) ?? NOVEL_CHANNELS[0]).label
    const tagsText = Array.isArray(meta.tags) && meta.tags.length > 0 ? meta.tags.join('、') : '未指定'
    const totalWordsText = Number.isFinite(meta.totalWords) && meta.totalWords > 0 ? String(meta.totalWords) + ' 字' : '未指定'
    // 番茄上架信息（阅读标签 + 内容标签 + 50~500 字简介）：只对作品定位步生效
    const fanqieBlock = step.id === 'positioning' ? fanqieListingBlock() : ''
    // 已有设定：作品定位是**第一步**，{{context}}（只带前序产物）永远是空的。
    // 于是「重新生成定位」时模型看不到已经写下的大纲/人物/卷大纲/正文，只能另起一个新故事
    //（实测事故：把「陈默 · 昆仑坊市」重生成成了「许安 · 仙界地产系统」）。这里把**后序**
    // 已存在的产物喂给定位步，让重生成沿着已有设定走。只对定位步生效。
    const existing = step.id === 'positioning'
      ? await WS.buildExistingContext(found.dir, genre.id, step.id, { maxChars: EXISTING_MAX_CHARS })
      : ''
    const existingBlock = existingBlockOf(existing)
    const count = Number.isFinite(body?.count) && Number(body?.count) > 0
      ? Math.min(Math.max(Math.round(Number(body?.count)), 1), 6)
      : (Number.isFinite(meta.count) && meta.count > 0 ? meta.count : 3)
    const vars = {
      title: meta.name ?? id,
      genre: genre.label,
      theme: meta.theme ?? '',
      audience: meta.audience ?? '',
      tone: meta.tone ?? '',
      words: String(meta.words ?? genre.defaultWords),
      channel: channelLabel,
      type: meta.type ?? '',
      totalWords: totalWordsText,
      tags: tagsText,
      count: String(count),
      volume: volumeText === '' ? '（暂无目标卷）' : volumeText,
      extra: extra === '' ? '' : `【本次额外要求】\n${extra}`,
      template: templateBlock,
      style: styleBlock,
      vault: vaultBlock,
      // 只有「作品定位」这一步要产出番茄上架信息；其余步骤用空串（占位符渲染成空，不留痕）
      fanqieTags: fanqieBlock === '' ? '' : fanqieTagCatalog(),
      // 已有设定为空时给一句中性说明，让 {{existing}} 渲染出来读得通（而不是留个空行）
      existing: existing === '' ? '（还没有任何下游产物：这是全新的一本书。）' : existing,
      context: context === '' ? '（暂无前序产物，这是第一步）' : context,
    }

    const rendered = applyMissingBlocks(eff, renderPrompt(eff.system, vars), renderPrompt(eff.user, vars), { styleBlock, vaultBlock, fanqieBlock, existingBlock })
    const system = rendered.system
    const user = rendered.user
    return {
      eff, meta, template, templateBlock, styleId, style, styleBlock,
      vaultRoot, vaultNotes, vaultBlock, chapter, context, fanqieBlock,
      existing, existingBlock,
      isVolumeOutline, actualVolumeKey, extra, vars, rendered,
      system: rendered.system, user: rendered.user,
    }
  }

  /**
   * 这一步的产物要不要规整首行章标题（见 core/chaptertext.js）：
   * - 章节步：编号用客户端算好的全局号（chapterNo），章名优先用本章细纲标题；
   * - 润色步：编号取被润色文件的文件名，章名沿用正文里已有的；
   * - 其余步骤（以及拿不到编号时）原样返回。
   */
  function normalizeRunText(step, body, text) {
    if (step === null || step.artifact !== 'chapters') return { text, heading: '', renumbered: false, changed: false }
    if (step.id === 'polish') return normalizeChapterFileText(text, String(body?.chapter ?? ''))
    return normalizeChapterText(text, { no: body?.chapterNo, title: body?.chapterTitle ?? body?.chapterName ?? '' })
  }

  /**
   * 执行一步：拼上下文 → 渲染提示词 → 调模型 → 返回草稿。
   *
   * 刻意**不自动落盘**：模型输出被截断时（finish=max-tokens）自动落盘会把
   * 半截稿覆盖掉用户已经满意的旧稿。落盘由用户看过草稿后点「保存」触发。
   */
  async function runStep(body, req, extra = {}) {
    const conf = cfg()
    const root = conf.root
    const id = String(body?.id ?? '')
    const genreId = String(body?.genre ?? 'novel')
    const stepId = String(body?.step ?? '')
    const found = await WS.readProject(root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)
    const genre = genreById(genreId)
    const step = stepById(genre.id, stepId)
    if (step === null) throw new Error(`未知步骤：${genre.id}:${stepId}`)

    const llm = ctx.get('llm')
    const route = resolveRoute(ctx, conf)
    if (llm === undefined || llm === null) throw new Error('这个 dsh 没有可用的 llm 服务')
    if (route === null) throw new Error('没有可用的模型路由：请在 dsh 模型设置里选一个默认模型，或在本插件配置里填 provider/model')

    const built = await buildStepPrompt({ conf, root, found, genre, step, body })
    const {
      template, style, styleBlock, vaultBlock, fanqieBlock, existingBlock, vaultNotes, rendered,
      chapter, isVolumeOutline, actualVolumeKey, system, user,
    } = built

    // 长稿兜底：同一份 system 提示词下自动续写（卷大纲/长章节常触发）。
    // 不再共用一个总超时 —— 每轮各自计时，否则第 2 轮会被首轮启动时就跑起来的 180s 掐断。
    // targetChars：按每一步的目标篇幅「写够才停」——本地小模型常写到几百字就自己收尾（finish=stop），
    // 只看「有没有被截断」的旧规则不会续写（用户 m02113 / m02246：每一步都要能分次写够）。
    // 润色步的目标取原文长度（先把被润色的那一章读出来量一下字数）。
    let sourceChars = 0
    if ((step.id === 'polish' || step.id === 'deai') && chapter !== '') {
      const src = await WS.readProjectFile(root, id, 'chapters/' + chapter)
      if (src.exists && typeof src.text === 'string') sourceChars = charCount(src.text)
    }
    const targetChars = targetCharsOf(step, found.meta, body, sourceChars)
    // 续写轮只发「接着写」是不会知道原本要写什么的（细纲/要求都在首轮 user 里）。
    // 这里截一小段任务回执带进续写轮，保证同一章/同一份稿子前后连贯（有界，不把上下文吃满）。
    const continueContext = clip(user, 1200)
    // 续写轮还要知道「本步产物边界」：规划步被推着写够字数时，小模型会一路写成章节正文
    // （用户 m02380：生成「大纲」却写出了第一章原文并开始复读）。
    const continueScope = stepScopeHint(genre.id, step.id, step.label, step.artifact)
    const callOpts = {
      system,
      maxTokens: conf.maxTokens,
      reasoningEffort: LLM_DEFAULTS.reasoningEffort,
      timeoutMs: LLM_DEFAULTS.timeoutMs,
      autoContinue: true,
      continueContext,
      continueScope,
    }
    if (extra?.signal !== undefined && extra?.signal !== null) {
      callOpts.signal = typeof AbortSignal.any === 'function'
        ? AbortSignal.any([extra.signal, AbortSignal.timeout(LLM_DEFAULTS.timeoutMs)])
        : extra.signal
    }
    let result
    let batchCount = 0
    let shortChapters = ''
    if (step.id === 'positioning') {
      // 逐候选生成：每个候选一次独立调用（续写只发生在该候选内部），保证「- 书名：」与
      // 「### 四、上架信息」的 8 行字段在每个候选里都齐全（用户 m02336 的结构写散问题）。
      const countRaw = Number(body?.count ?? found.meta?.count ?? 3)
      const total = Math.max(1, Math.min(6, Number.isFinite(countRaw) && countRaw > 0 ? Math.floor(countRaw) : 3))
      const perTarget = stepTargetChars('novel', 'positioning', 1)
      const texts = []
      let rounds = 0
      let continued = false
      let reached = true
      let finish = 'stop'
      let lastTarget = 0
      for (let i = 1; i <= total; i += 1) {
        const one = await callModel(llm, route, Object.assign({}, callOpts, {
          user: positioningOneUser(user, i, total),
          targetChars: perTarget,
        }))
        texts.push(String(one.text ?? '').trim())
        rounds += one.rounds
        continued = continued || one.continued
        reached = reached && one.reachedTarget
        finish = one.finish
        lastTarget += one.targetChars
      }
      batchCount = total
      result = {
        text: texts.filter((t) => t !== '').join('\n\n'),
        finish,
        rounds,
        continued,
        chars: 0,
        targetChars: lastTarget,
        reachedTarget: reached,
      }
    } else if (step.id === 'characters') {
      // 人物步分段生成（用户 m02441：本地模型一次写不完全部人物）。
      // 步骤：① 先要一份人物名单 → ② 每人一次调用写完整档案 → ③ 最后单独写关系简表。
      const roster = await callModel(llm, route, Object.assign({}, callOpts, {
        user: charactersRosterUser(user, CHARACTER_MAX_PARTS),
        targetChars: 0,
        autoContinue: false,
      }))
      const names = parseCharacterNames(roster.text).slice(0, CHARACTER_MAX_PARTS)
      if (names.length === 0) {
        // 名单没解析出来（模型没按格式）：退回一次成稿，别把这一步卡死
        result = await callModel(llm, route, Object.assign({}, callOpts, { user, targetChars }))
      } else {
        const texts = ['## 人物名单\n' + String(roster.text ?? '').trim()]
        let rounds = roster.rounds
        let continued = roster.continued
        let reached = true
        let finish = roster.finish
        let lastTarget = roster.targetChars
        for (let i = 1; i <= names.length; i += 1) {
          const one = await callModel(llm, route, Object.assign({}, callOpts, {
            user: characterOneUser(user, names[i - 1], i, names.length),
            targetChars: CHARACTER_PART_CHARS,
          }))
          texts.push(String(one.text ?? '').trim())
          rounds += one.rounds
          continued = continued || one.continued
          reached = reached && one.reachedTarget
          finish = one.finish
          lastTarget += one.targetChars
        }
        const rel = await callModel(llm, route, Object.assign({}, callOpts, {
          user: charactersRelationsUser(user, names),
          targetChars: CHARACTER_PART_CHARS,
        }))
        texts.push(String(rel.text ?? '').trim())
        rounds += rel.rounds
        continued = continued || rel.continued
        reached = reached && rel.reachedTarget
        finish = rel.finish
        lastTarget += rel.targetChars
        batchCount = names.length + 2
        result = {
          text: texts.filter((t) => t !== '').join('\n\n'),
          finish,
          rounds,
          continued,
          chars: 0,
          targetChars: lastTarget,
          reachedTarget: reached,
        }
      }
    } else if (step.id === 'chapter-outline') {
      // 章节大纲：按本卷「预计章数」写够（用户 m02587：一卷 15-20 章，模型只写了 6 章就收尾）。
      // 首轮让它自由写；之后数已经写了几章，缺的部分按「第 from~to 章」区间一段段补。
      // body.continue === true 时**从已保存的细纲接着写**（用户 m02715：一次跑不完，再点一次不该从头重来）。
      // 本卷「预计章数」：与 buildStepPrompt 一样从卷大纲里解析（body.volume 是卷 key）
      let want = 0
      let volKey = ''
      {
        const vols = await WS.listVolumes(found.dir)
        const key = String(body?.volume ?? '').trim()
        const vol = vols.find((v) => v.key === key) ?? vols[0] ?? null
        if (vol !== null) {
          volKey = vol.key
          want = expectedChaptersOf('## ' + vol.title + '\n' + vol.body)
        }
      }
      let text = ''
      let droppedChapters = 0
      let rounds = 0
      let continued = false
      let finish = 'stop'
      let lastTarget = 0
      let calls = 0
      let resumedFrom = 0
      if (body?.continue === true && volKey !== '') {
        const saved = await WS.readProjectFile(root, id, 'chapter-outlines/' + volKey + '.md')
        if (saved.exists && typeof saved.text === 'string' && saved.text.trim() !== '') {
          const t = tidyChapterOutline(saved.text)
          text = t.text
          droppedChapters += t.dropped
          resumedFrom = countOutlineChapters(text)
        }
      }
      if (text === '') {
        const one = await callModel(llm, route, Object.assign({}, callOpts, { user, targetChars }))
        // 收尾整理：丢掉末尾半截条目、把跳号的章号重排成 1..K（用户 m02656：生成到 18 章断在半截标题上）
        const firstTidy = tidyChapterOutline(one.text)
        text = firstTidy.text
        droppedChapters += firstTidy.dropped
        rounds = one.rounds
        continued = one.continued
        finish = one.finish
        lastTarget = one.targetChars
        calls = 1
      }
      let have = countOutlineChapters(text)
      // 时间预算：本地 9B 一次补 5 章要几分钟，跑太久不如先给用户一份，再点「继续补齐」接着写
      const outlineDeadline = Date.now() + CHAPTER_OUTLINE_BUDGET_MS
      while (want > 0 && have > 0 && have < want && calls < 9 && Date.now() < outlineDeadline) {
        const from = have + 1
        const to = Math.min(want, have + 5)
        const extra = await callModel(llm, route, Object.assign({}, callOpts, {
          user: chapterOutlineAskUser(user, from, to, clip(text, 1200)),
          targetChars: (to - from + 1) * 260,
        }))
        // 补写轮直接追加（不用 joinContinuation：它按「最长重叠」裁开头，遇到大段重复填充会误判成已写过，吃掉一整章）
        const tidied = tidyChapterOutline(text.trimEnd() + '\n\n' + String(extra.text ?? '').trim())
        droppedChapters += tidied.dropped
        const merged = tidied.text
        const now = countOutlineChapters(merged)
        calls += 1
        rounds += extra.rounds
        continued = continued || extra.continued
        finish = extra.finish
        lastTarget += extra.targetChars
        if (now <= have) break
        text = merged
        have = now
      }
      batchCount = calls
      if (droppedChapters > 0) {
        shortChapters = '最后一条细纲没写完，已丢弃'
      }
      if (want > 0 && have < want) {
        shortChapters = (shortChapters === '' ? '' : shortChapters + '；') +
          '本卷预计 ' + want + ' 章，已写到第 ' + have + ' 章：先保存，再点「继续补齐」会从第 ' + (have + 1) + ' 章接着写'
      }
      if (resumedFrom > 0) {
        shortChapters = (shortChapters === '' ? '' : shortChapters + '；') + '已从已保存的第 ' + resumedFrom + ' 章后面继续补写'
      }
      result = {
        text,
        finish,
        rounds,
        continued,
        chars: 0,
        targetChars: lastTarget,
        reachedTarget: want > 0 ? have >= want : true,
      }
    } else {
      result = await callModel(llm, route, Object.assign({}, callOpts, { user, targetChars }))
    }
    void req
    // 章节首行统一：模型对「写不写第 N 章」时有时无，而且常照抄卷内局部编号，
    // 这里一律按落盘的全局编号重排，让同一本书每章同形（不改提示词，改确定性层）。
    const norm = normalizeRunText(step, body, result.text)
    // 章节大纲的越界兜底（用户 m02480）：模型在细纲后面开始写正文时，从正文的第一段切掉，只留细纲
    let finalText = norm.text
    let driftNote = ''
    if (step.id === 'chapter-outline') {
      const trimmed = trimChapterOutlineProse(finalText)
      if (trimmed.trimmed) {
        finalText = trimmed.text
        driftNote = '模型在细纲后面开始写正文，已自动截断（只保留章节细纲）'
      }
    }
    return {
      text: finalText,
      chapterHead: norm.heading,
      chapterRenumbered: norm.renumbered,
      finish: result.finish,
      warning: [finishWarning(result.finish, result.text, { rounds: result.rounds, targetChars: result.targetChars }), driftNote, shortChapters].filter((s) => s !== '').join(' '),
      rounds: result.rounds,
      continued: result.continued,
      targetChars: result.targetChars,
      reachedTarget: result.reachedTarget,
      batchCount,
      chars: charCount(norm.text),
      route,
      templateId: template?.id ?? '',
      styleId: style?.id ?? '',
      styleName: style?.name ?? '',
      styleApplied: styleBlock !== '',
      styleAppended: rendered.styleAppended,
      vaultApplied: vaultBlock !== '',
      vaultAppended: rendered.vaultAppended,
      fanqieApplied: fanqieBlock !== '',
      fanqieAppended: rendered.fanqieAppended,
      existingApplied: existingBlock !== '',
      existingAppended: rendered.existingAppended,
      vaultNotes: vaultNotes.map((n) => n.path),
      artifact: step.artifact === 'chapters' ? 'chapters' : step.artifact,
      suffix: step.suffix ?? '',
      chapter,
      volume: isVolumeOutline ? actualVolumeKey : '',
      promptUsed: { system, user },
      preview: clip(norm.text, 400),
    }
  }

  route('run', async (body, req) => runStep(body, req))

  /**
   * 「本步实际注入」预览：与 route('run') 走同一条取数 / 渲染路径，只是不调模型。
   * 提示词面板用它显示真正发给模型的那份 system / user —— {{style}} 已被渲染成画像正文，
   * 用户能直接看到「这本挂的画像，在这一步到底注入了哪一段」。
   */
  route('preview', async (body) => {
    const conf = cfg()
    const root = conf.root
    const id = String(body?.id ?? '')
    const genreId = String(body?.genre ?? 'novel')
    const stepId = String(body?.step ?? '')
    const found = await WS.readProject(root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)
    const genre = genreById(genreId)
    const step = stepById(genre.id, stepId)
    if (step === null) throw new Error(`未知步骤：${genre.id}:${stepId}`)
    const built = await buildStepPrompt({ conf, root, found, genre, step, body })
    return {
      step: step.id,
      no: step.no,
      label: step.label,
      styleId: built.style?.id ?? '',
      styleName: built.style?.name ?? '',
      styleSource: built.style?.source ?? '',
      styleBlock: built.styleBlock,
      vaultBlock: built.vaultBlock,
      // 番茄上架信息块（只有「作品定位」步非空）：让「本步实际注入」能看到真正注入了什么
      fanqieBlock: built.fanqieBlock,
      styleApplied: built.styleBlock !== '',
      styleAppended: built.rendered.styleAppended,
      vaultApplied: built.vaultBlock !== '',
      vaultAppended: built.rendered.vaultAppended,
      fanqieApplied: built.fanqieBlock !== '',
      fanqieAppended: built.rendered.fanqieAppended,
      // 已有设定块（只有作品定位步可能非空）：让「本步实际注入」能看清重生成时模型到底看到了什么
      existingBlock: built.existingBlock,
      existingChars: charCount(built.existing),
      existingApplied: built.existingBlock !== '',
      existingAppended: built.rendered.existingAppended,
      vaultNotes: built.vaultNotes.map((n) => n.path),
      contextChars: charCount(built.context),
      system: built.system,
      user: built.user,
    }
  })

  /**
   * 短文快速通道（P1⑫）：公众号/小红书一键把整条步骤链跑完并逐步落盘。
   * 只对没有 chapters 的短文体开放；小说是长流程，不提供一键。
   */
  route('fast', async (body) => {
    const conf = cfg()
    const root = conf.root
    const id = String(body?.id ?? '')
    const found = await WS.readProject(root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)
    const genre = genreById(found.meta.genre)
    if (genre.steps.some((s) => s.artifact === 'chapters')) throw new Error('「快速成文」只对公众号/小红书开放，小说请按步骤逐章写')

    const llm = ctx.get('llm')
    const route = resolveRoute(ctx, conf)
    if (llm === undefined || llm === null) throw new Error('这个 dsh 没有可用的 llm 服务')
    if (route === null) throw new Error('没有可用的模型路由：请先设置默认模型')

    const lib = await readVaultLibrary(cfg().vaultPath)
    const overrides = await readAllOverrides(root, lib)
    const meta = found.meta
    const templateId = String(body?.templateId ?? meta.templateId ?? '')
    const template = templateId === '' ? null : await loadTemplate({ builtinDir: BUILTIN_TEMPLATE_DIR, root, id: templateId })
    const templateBlock = renderTemplateBlock(template)
    const extra = String(body?.extra ?? '').trim()

    // 快速通道同样套风格画像 / 参考笔记（此前这里写死空串，等于短文一键完全绕过画像）
    const styleId = String(body?.styleId ?? meta.styleId ?? '')
    const style = await loadStyleAny(root, styleId, lib)
    const vaultRoot = resolveVaultRoot(conf.vaultPath)
    const vaultPaths = Array.isArray(body?.vaultNotes) && body.vaultNotes.length > 0
      ? body.vaultNotes
      : (Array.isArray(meta.vaultNotes) ? meta.vaultNotes : [])
    const vaultNotes = vaultRoot === null || vaultRoot === '' ? [] : await resolveVaultNotes(vaultRoot, vaultPaths)
    const vaultBlock = renderVaultBlock(vaultNotes)

    const results = []
    for (const step of genre.steps) {
      const context = await WS.buildContext(found.dir, genre.id, step.id, { maxChars: CONTEXT_MAX_CHARS })
      const eff = effectivePrompt(overrides, genre.id, step)
      const styleBlock = renderStyleBlock(style, step.id)
      const vars = {
        title: meta.name ?? id,
        genre: genre.label,
        theme: meta.theme ?? '',
        audience: meta.audience ?? '',
        tone: meta.tone ?? '',
        words: String(meta.words ?? genre.defaultWords),
        extra: extra === '' ? '' : `【本次额外要求】\n${extra}`,
        template: templateBlock,
        style: styleBlock,
        vault: vaultBlock,
        context: context === '' ? '（暂无前序产物，这是第一步）' : context,
      }
      const rendered = applyMissingBlocks(eff, renderPrompt(eff.system, vars), renderPrompt(eff.user, vars), { styleBlock, vaultBlock })
      const system = rendered.system
      const user = rendered.user
      const targetChars = targetCharsOf(step, meta, body)
      const result = await callModel(llm, route, {
        system,
        user,
        maxTokens: conf.maxTokens,
        reasoningEffort: LLM_DEFAULTS.reasoningEffort,
        timeoutMs: LLM_DEFAULTS.timeoutMs,
        autoContinue: true,
        targetChars,
        continueContext: clip(user, 1200),
        continueScope: stepScopeHint(genre.id, step.id, step.label, step.artifact),
      })
      const artifact = step.artifact === 'chapters' ? 'chapters' : step.artifact
      const warning = finishWarning(result.finish, result.text, { rounds: result.rounds, targetChars: result.targetChars })
      // 快速通道就是要落盘；但截断时仍照单步原则不覆盖旧稿，只记录警告
      if (warning === '') {
        await WS.writeArtifact(root, id, artifact, result.text)
        await mirrorToVault(conf.vaultPath, result.text, join(VAULT_MIRROR_DIR, VAULT_MIRROR_WORKS, id, artifact))
      }
      results.push({ step: step.id, no: step.no, label: step.label, artifact, chars: charCount(result.text), warning })
    }
    const steps = await WS.stepsStatus(found.dir, found.meta.genre)
    return { results, steps }
  })

  /**
   * 样例 → 结构模版：这是「套结构模仿写作」的入口。
   * 只提取骨架与硬约束，明确禁止复制样例的措辞与专有名词。
   */
  route('analyze', async (body) => {
    const conf = cfg()
    const genre = genreById(String(body?.genre ?? 'novel'))
    const sample = String(body?.sample ?? '').trim()
    if (sample === '') throw new Error('请粘贴一篇样例（或样例的结构描述）')
    const llm = ctx.get('llm')
    const route = resolveRoute(ctx, conf)
    if (llm === undefined || llm === null) throw new Error('这个 dsh 没有可用的 llm 服务')
    if (route === null) throw new Error('没有可用的模型路由：请先设置默认模型')
    const prompts = sampleAnalysisPrompts({
      sample: clip(sample, SAMPLE_MAX_CHARS),
      genreLabel: genre.label,
      extra: String(body?.extra ?? ''),
    })
    const result = await callModel(llm, route, {
      system: prompts.system,
      user: prompts.user,
      maxTokens: 2000,
      reasoningEffort: 'off',
    })
    return { text: result.text, finish: result.finish, warning: finishWarning(result.finish, result.text) }
  })

  /** 保存模版（用户手改的，或从上面分析结果确认后的）。 */
  route('template', async (body) => {
    const root = cfg().root
    if (body?.action === 'delete') {
      const id = String(body?.id ?? '')
      if (id === '') throw new Error('缺少模版 id')
      const path = resolveInside(root, STATE_DIR_NAME, TEMPLATE_DIR_NAME, `${id}.md`)
      await writeAtomic(path, '')
      return { removed: id }
    }
    const saved = await saveTemplate({
      root,
      template: {
        id: String(body?.id ?? ''),
        name: String(body?.name ?? ''),
        genre: String(body?.genre ?? ''),
        sections: Array.isArray(body?.sections) ? body.sections.map((s) => String(s)) : [],
        constraints: Array.isArray(body?.constraints) ? body.constraints.map((s) => String(s)) : [],
        note: String(body?.note ?? ''),
      },
      text: String(body?.note ?? ''),
    })
    await mirrorToVault(cfg().vaultPath, await readTextSafe(saved.path), join(VAULT_MIRROR_DIR, VAULT_MIRROR_TEMPLATES, saved.id + '.md'))
    const templates = await listTemplates({ builtinDir: BUILTIN_TEMPLATE_DIR, root })
    return { ...saved, templates: templates.map((t) => ({ id: t.id, name: t.name, genre: t.genre, source: t.source, sections: t.sections, constraints: t.constraints })) }
  })

  /** 从样例蒸馏风格画像：只提炼可迁移的文风规律（视角/节奏/对话/描写/调性/章节/爽点），不存原文。 */
  route('analyze-style', async (body) => {
    const conf = cfg()
    const genre = genreById(String(body?.genre ?? 'novel'))
    const llm = ctx.get('llm')
    const route = resolveRoute(ctx, conf)
    if (llm === undefined || llm === null) throw new Error('这个 dsh 没有可用的 llm 服务')
    if (route === null) throw new Error('没有可用的模型路由：请先设置默认模型')
    const extra = String(body?.extra ?? '')

    // 文件模式：读整本 → 策略采样 → 分段蒸馏 → 合并成全书统一画像。
    // 几 M 的整本小说不能（也不该）整本喂模型：风格是统计规律，均匀采样开篇/中段/结尾即可覆盖。
    const path = String(body?.path ?? '').trim()
    if (path !== '') {
      const text = await readTextSafe(path)
      if (text === '') throw new Error('读不到文件或文件为空：' + path)
      const chunks = Math.max(2, Math.min(12, Number.isInteger(body?.chunks) ? body.chunks : STYLE_MAX_CHUNKS))
      const excerpts = sampleExcerpts(text, { chunkChars: STYLE_CHUNK_CHARS, maxChunks: chunks })
      const partials = []
      for (const ex of excerpts) {
        const p = sampleStyleExcerptPrompts({ excerpt: ex.text, label: ex.label, genreLabel: genre.label })
        const r = await callModel(llm, route, { system: p.system, user: p.user, maxTokens: 1200, reasoningEffort: 'off' })
        partials.push({ label: ex.label, chars: ex.text.length, text: r.text.trim() })
      }
      const m = mergeStylePrompts({ partials, genreLabel: genre.label, extra })
      const result = await callModel(llm, route, { system: m.system, user: m.user, maxTokens: 2000, reasoningEffort: 'off' })
      return {
        text: result.text,
        finish: result.finish,
        warning: finishWarning(result.finish, result.text),
        path,
        totalChars: charCount(text),
        excerpts: excerpts.length,
        sampled: partials.map((p) => ({ label: p.label, chars: p.chars })),
      }
    }

    // 粘贴模式：短样例 / 单个章节，单次蒸馏
    const sample = String(body?.sample ?? '').trim()
    if (sample === '') throw new Error('请粘贴一篇样例小说，或填一个小说文件路径')
    const prompts = sampleStylePrompts({
      sample: clip(sample, SAMPLE_MAX_CHARS),
      genreLabel: genre.label,
      extra,
    })
    const result = await callModel(llm, route, {
      system: prompts.system,
      user: prompts.user,
      maxTokens: 2000,
      reasoningEffort: 'off',
    })
    return { text: result.text, finish: result.finish, warning: finishWarning(result.finish, result.text) }
  })

  /** 保存 / 删除风格画像（七维度 + 标签）。 */
  route('style', async (body) => {
    const root = cfg().root
    if (body?.action === 'delete') {
      const id = String(body?.id ?? '')
      if (id === '') throw new Error('缺少风格画像 id')
      const path = resolveInside(root, STATE_DIR_NAME, STYLE_DIR_NAME, id + '.md')
      await writeAtomic(path, '')
      // vault 优先：只清本地会让 vault 里的同一份画像继续生效，所以笔记一起删。
      const vaultRoot = resolveVaultRoot(cfg().vaultPath)
      let vaultRemoved = false
      if (vaultRoot !== null && vaultRoot !== '') {
        const rel = styleNoteRel(id)
        // 先看有没有这篇笔记：vaultRemoved 要如实反映「真的删掉了什么」，重复删除时返回 false。
        const had = await readVaultNote(vaultRoot, rel).then((n) => n.exists === true).catch(() => false)
        if (had) {
          try {
            await removeVaultFile(vaultRoot, rel)
            vaultRemoved = true
          } catch {
            /* 越界等都无所谓 */
          }
        }
      }
      const styles = await listStylesAll(root, await readVaultLibrary(cfg().vaultPath))
      return { removed: id, vaultRemoved, styles: styles.map(styleView) }
    }
    const saved = await saveStyle({
      root,
      style: {
        id: String(body?.id ?? ''),
        name: String(body?.name ?? ''),
        genre: String(body?.genre ?? ''),
        tags: Array.isArray(body?.tags) ? body.tags.map((t) => String(t)) : [],
        pov: String(body?.pov ?? ''),
        rhythm: String(body?.rhythm ?? ''),
        dialogue: String(body?.dialogue ?? ''),
        description: String(body?.description ?? ''),
        tone: String(body?.tone ?? ''),
        chapterRhythm: String(body?.chapterRhythm ?? ''),
        beatRhythm: String(body?.beatRhythm ?? ''),
        note: String(body?.note ?? ''),
      },
      text: String(body?.note ?? ''),
    })
    await mirrorToVault(cfg().vaultPath, await readTextSafe(saved.path), styleNoteRel(saved.id))
    const styles = await listStylesAll(root, await readVaultLibrary(cfg().vaultPath))
    return { ...saved, styles: styles.map(styleView) }
  })

  /**
   * Obsidian 库（提示词 / 风格画像）维护。
   *   action='status'（默认）：库里各有多少笔记、有没有解析不了的。
   *   action='export'：把内置/覆盖版提示词与本地风格画像写成 vault 笔记（kind=prompts|styles|all）。
   *     默认**不覆盖已有笔记**（overwrite:false）——vault 侧优先，覆盖等于把用户在 Obsidian 改过的版本冲掉。
   */
  route('library', async (body) => {
    const root = cfg().root
    const vaultRoot = resolveVaultRoot(cfg().vaultPath)
    if (vaultRoot === null || vaultRoot === '') {
      throw new Error('没有可用的 Obsidian 知识库：请在插件配置里填 vault 路径，或先打开 Obsidian 的某个 vault')
    }
    const action = String(body?.action ?? 'status')
    const status = async () => {
      const lib = await readVaultLibrary(cfg().vaultPath)
      return {
        root: vaultRoot,
        prompts: Object.keys(lib.prompts).length,
        promptErrors: lib.promptErrors,
        styles: lib.styles.length,
        dirs: { prompts: VAULT_MIRROR_PROMPTS, styles: VAULT_MIRROR_STYLES },
      }
    }
    if (action === 'status') return await status()
    if (action !== 'export') throw new Error('未知操作：' + action)

    const kind = String(body?.kind ?? 'all')
    const overwrite = body?.overwrite === true
    const written = []
    const skipped = []
    const failed = []
    const exists = async (rel) => {
      try {
        return (await readVaultNote(vaultRoot, rel)).exists
      } catch {
        return false
      }
    }
    if (kind === 'prompts' || kind === 'all') {
      const overrides = await WS.readPromptOverrides(root)
      for (const g of GENRES) {
        for (const step of g.steps) {
          const rel = promptNoteRel(g.id, step.id)
          if (!overwrite && (await exists(rel))) { skipped.push(rel); continue }
          const eff = effectivePrompt(overrides, g.id, step)
          try {
            await writeVaultFile(vaultRoot, rel, renderPromptNote({ genreId: g.id, stepId: step.id, label: step.label, stepNo: step.no, goal: step.goal, system: eff.system, user: eff.user }))
            written.push(rel)
          } catch (e) {
            failed.push({ path: rel, error: String(e?.message ?? e) })
          }
        }
      }
    }
    if (kind === 'styles' || kind === 'all') {
      for (const s of await listStyles({ root })) {
        const rel = styleNoteRel(s.id)
        if (!overwrite && (await exists(rel))) { skipped.push(rel); continue }
        try {
          const text = await readTextSafe(resolveInside(root, STATE_DIR_NAME, STYLE_DIR_NAME, s.id + '.md'))
          if (text.trim() === '') { failed.push({ path: rel, error: '本地画像文件为空' }); continue }
          await writeVaultFile(vaultRoot, rel, text)
          written.push(rel)
        } catch (e) {
          failed.push({ path: rel, error: String(e?.message ?? e) })
        }
      }
    }
    return { ...(await status()), written, skipped, failed }
  })

  /** 读 Obsidian 知识库：列笔记 / 搜索 / 读单条。只读不写。 */
  route('vault', async (body) => {
    const vaultRoot = resolveVaultRoot(cfg().vaultPath)
    if (vaultRoot === null || vaultRoot === '') {
      throw new Error('没有可用的 Obsidian 知识库：请在插件配置里填 vault 路径，或先打开 Obsidian 的某个 vault')
    }
    const action = String(body?.action ?? 'list')
    if (action === 'read') {
      return await readVaultNote(vaultRoot, String(body?.path ?? '').trim())
    }
    if (action === 'search') {
      const q = String(body?.query ?? '').trim()
      if (q === '') throw new Error('缺少搜索关键词')
      return { results: await searchVaultNotes(vaultRoot, q, { exclude: VAULT_LIB_EXCLUDES }) }
    }
    return { root: vaultRoot, notes: await listVaultNotes(vaultRoot, { exclude: VAULT_LIB_EXCLUDES }) }
  })

  /** 一键：从当前 Obsidian 知识库自动学习（风格画像）+ 推断题材 + 自动建立作品。 */
  route('autocreate', async (body) => {
    const conf = cfg()
    const root = conf.root
    const vaultRoot = resolveVaultRoot(conf.vaultPath)
    if (vaultRoot === null || vaultRoot === '') {
      throw new Error('没有可用的 Obsidian 知识库：请先在上方选择一个 vault')
    }
    const llm = ctx.get('llm')
    const route = resolveRoute(ctx, conf)
    if (llm === undefined || llm === null) throw new Error('这个 dsh 没有可用的 llm 服务')
    if (route === null) throw new Error('没有可用的模型路由：请先设置默认模型')

    // 收集库内容：按笔记名排序取，逐篇截断，总量有界（几 M 的库不能整本喂模型）
    const notes = await listVaultNotes(vaultRoot, { limit: 1000 })
    if (notes.length === 0) throw new Error('这个知识库里没有任何 .md 笔记')
    const parts = []
    let budget = SAMPLE_MAX_CHARS
    for (const n of notes) {
      if (budget <= 0) break
      const r = await readVaultNote(vaultRoot, n.path)
      if (!r.exists) continue
      const body = String(r.content ?? '').trim()
      if (body === '') continue
      const chunk = body.slice(0, Math.min(budget, 6000))
      parts.push(chunk)
      budget -= chunk.length
    }
    const corpus = parts.join('\n\n')
    if (corpus.trim() === '') throw new Error('知识库里的笔记都是空的')

    // 1) 学习风格 → 存成画像（复用「样例→风格画像」的蒸馏契约，只存规律不存原文）
    const vaultName = basename(resolve(vaultRoot))
    const styleId = 'vault-' + vaultName
    const sp = sampleStylePrompts({ sample: clip(corpus, SAMPLE_MAX_CHARS), genreLabel: '小说', extra: '' })
    const styleRes = await callModel(llm, route, { system: sp.system, user: sp.user, maxTokens: 2000, reasoningEffort: 'off' })
    const styleMeta = parseStyle(styleRes.text, { id: styleId, name: '知识库风格·' + vaultName, source: 'vault' })
    styleMeta.id = styleId
    if (styleMeta.name === '' || styleMeta.name === styleId) styleMeta.name = '知识库风格·' + vaultName
    const savedStyle = await saveStyle({ root, style: styleMeta, text: styleMeta.note })
    await mirrorToVault(conf.vaultPath, await readTextSafe(savedStyle.path), join(VAULT_MIRROR_DIR, VAULT_MIRROR_STYLES, savedStyle.id + '.md'))

    // 2) 推断作品立项信息（类型 / 书名 / 题材 / 受众 / 调性 / 标签）
    const ip = inferProjectPrompts(clip(corpus, SAMPLE_MAX_CHARS))
    const metaRes = await callModel(llm, route, { system: ip.system, user: ip.user, maxTokens: 800, reasoningEffort: 'off' })
    const inferred = parseInfer(metaRes.text)
    let name = inferred.name
    if (name === '' || name === '未定' || name === '未定名' || name === '未命名') name = inferred.genre === 'novel' ? '' : vaultName + '·作品'

    // 3) 建立作品：把整个库的笔记都作为参考素材挂上去
    const project = await WS.ensureProject(root, {
      name,
      genre: inferred.genre,
      theme: inferred.theme,
      audience: inferred.audience,
      tone: inferred.tone,
      styleId: savedStyle.id,
      tags: inferred.tags,
      words: inferred.genre === 'novel' ? 3000 : undefined,
      vaultNotes: notes.map((n) => n.path),
    })

    return {
      id: project.id,
      dir: WS.projectDirOf(root, project.id),
      meta: project.meta,
      styleId: savedStyle.id,
      stylePath: savedStyle.path,
      notesCount: notes.length,
      corpusChars: charCount(corpus),
      inferred,
    }
  })

  /** 保证根目录存在：用户改完路径后前端点一下，避免第一次保存才发现路径不存在。 */
  route('mkdir', async (body) => {
    const root = cfg().root
    const rel = String(body?.rel ?? '')
    const path = rel === '' ? resolveInside(root) : resolveInside(root, rel)
    await mkdir(path, { recursive: true })
    return { path }
  })

  /** 批量定稿：把已确认 OK 的润色稿（第NNN章-润色.md）覆盖回原章，原稿备份 .bak 后删除润色稿。 */
  route('finalize', async (body) => {
    const conf = cfg()
    const root = conf.root
    const id = String(body?.id ?? '')
    const found = await WS.readProject(root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)
    const only = Array.isArray(body?.chapters) ? body.chapters.map((c) => String(c)) : []
    const result = await WS.finalizePolished(root, id, only)
    for (const base of result.finalized) {
      const res = await WS.readProjectFile(root, id, 'chapters/' + base)
      if (res.exists) {
        await mirrorToVault(conf.vaultPath, res.text, join(VAULT_MIRROR_DIR, VAULT_MIRROR_WORKS, id, 'chapters/' + base))
      }
    }
    return result
  })

  /** 上传小说封面：接收 jpg/png 的 base64，二进制落盘 cover.<ext> 并镜像 vault。 */
  route('uploadCover', async (body) => {
    const conf = cfg()
    const root = conf.root
    const id = String(body?.id ?? '')
    const found = await WS.readProject(root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)

    const raw = String(body?.data ?? '').trim()
    if (raw === '') throw new Error('没有收到封面图片数据')

    // 兼容纯 base64 与 data URL（data:image/jpeg;base64,...），统一剥到纯 base64
    let b64 = raw
    const marker = ';base64,'
    const comma = b64.indexOf(marker)
    if (comma >= 0) b64 = b64.slice(comma + marker.length)

    const buf = Buffer.from(b64, 'base64')
    if (buf.length === 0) throw new Error('封面图片数据无法解码')

    // 扩展名白名单：jpg / jpeg / png；jpeg 归一到 jpg
    let ext = String(body?.ext ?? '').trim().toLowerCase()
    if (ext.startsWith('.')) ext = ext.slice(1)
    if (ext === 'jpeg') ext = 'jpg'
    if (ext !== 'jpg' && ext !== 'png') throw new Error('仅支持 jpg / png 格式封面')

    if (buf.length > 5 * 1024 * 1024) throw new Error('封面图片不能超过 5MB')

    const rel = `cover.${ext}`
    const path = resolveInside(found.dir, rel)
    await writeBinary(path, buf)

    // 换了扩展名（jpg→png）时删掉旧的那份：coverInfo 固定按 jpg→png 顺序找，
    // 留着另一种扩展名的旧图会让用户看到「传了新的却还是旧图」。
    const stale = ext === 'png' ? 'jpg' : 'png'
    const staleRel = `cover.${stale}`
    await removeFileSafe(resolveInside(found.dir, staleRel))
    const staleVaultRoot = resolveVaultRoot(conf.vaultPath)
    if (staleVaultRoot !== null && staleVaultRoot !== '') {
      await removeVaultFile(staleVaultRoot, join(VAULT_MIRROR_DIR, VAULT_MIRROR_WORKS, id, staleRel)).catch(() => null)
    }

    await mirrorToVaultBinary(conf.vaultPath, buf, join(VAULT_MIRROR_DIR, VAULT_MIRROR_WORKS, id, rel))
    return { path, rel, size: buf.length }
  }, { maxBody: COVER_BODY_LIMIT })

  /** 读取当前封面（cover.jpg / cover.png）：返回 data URL 供预览。 */
  route('coverInfo', async (body) => {
    const conf = cfg()
    const root = conf.root
    const id = String(body?.id ?? '')
    const found = await WS.readProject(root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)

    for (const ext of ['jpg', 'png']) {
      const rel = `cover.${ext}`
      const buf = await readBinary(resolveInside(found.dir, rel))
      if (buf !== null) {
        const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
        return { exists: true, rel, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
      }
    }
    return { exists: false, rel: '', dataUrl: '' }
  })

  // ---------------------------------------------------------------------------
  // 番茄上架信息（阅读标签 / 内容标签 / 作品简介）
  // 解析与校验只在宿主实现一份，客户端只拿结论渲染 —— 客户端是 src-client 纯文本拼接，
  // import 不了 core 下的模块（见 scripts/build-client.mjs），两处各写一份正则必然漂移。
  // ---------------------------------------------------------------------------
  route('fanqieTags', async (body) => {
    const action = String(body?.action ?? 'catalog')
    if (action === 'catalog') return fanqieTagPayload()
    if (action === 'parse') {
      const texts = Array.isArray(body?.texts) ? body.texts.map((t) => String(t ?? '')) : []
      const titles = Array.isArray(body?.titles) ? body.titles.map((t) => String(t ?? '')) : []
      const catalog = fanqieTagPayload()
      const reports = fanqieListingReports(texts).map((report, i) => ({
        index: i,
        title: titles[i] ?? '',
        // 这一段压根不是定位稿（没有「## 候选」分节）时，客户端给一句更准确的话
        candidateHeads: hasCandidateHeadings(texts[i]),
        ...report,
        // 复制按钮的文本由宿主生成：与站点填空的格式只维护这一份
        copy: formatFanqieListing(report, titles[i] ?? ''),
      }))
      return {
        count: texts.length,
        reports,
        limits: { briefMin: catalog.briefMin, briefMax: catalog.briefMax, titleMax: catalog.titleMax, roleNameMax: catalog.roleNameMax },
      }
    }
    throw new Error(`未知 action：${action}`)
  })

  // ---------------------------------------------------------------------------
  // 只补上架信息（用户 m00929）：老书是按旧提示词生成的定位稿，没有「### 四、上架信息」；
  // 而定位步的「生成草稿」在作品已有章节时会被禁用（避免重跑定位推翻已写正文），
  // 于是这类书永远补不上。这里只做最小动作：读定位稿 → 对缺节的候选取一次模型 →
  // 把那一节插到该候选末尾；候选正文与顺序都不动，写盘前先备份。
  // action='plan' 只看不写（不调模型），action='start' 才补。
  // ---------------------------------------------------------------------------
  route('fanqieListing', async (body) => {
    const conf = cfg()
    const id = String(body?.id ?? '')
    const action = String(body?.action ?? 'plan')
    const found = await WS.readProject(conf.root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)

    const step = stepById('novel', 'positioning')
    const rel = step === null ? 'steps/01-作品定位.md' : step.artifact
    const cur = await WS.readProjectFile(conf.root, id, rel)
    if (cur.exists !== true || String(cur.text ?? '').trim() === '') {
      throw new Error(`还没有作品定位稿（${rel}）：先在这一步生成定位，再来补上架信息`)
    }

    const text = String(cur.text)
    const blocks = splitCandidateBlocks(text)
    if (blocks.length === 0) {
      throw new Error(`定位稿里没有「## 候选…」分节（${rel}）：先在「编辑」里照格式手补，或重新生成定位`)
    }

    const reportsOf = (list) => list.map((b, i) => {
      const report = fanqieListingReports([b.body])[0]
      return { index: i, heading: b.heading, title: b.name, hasListing: report.sectionFound === true, ...report }
    })
    const before = reportsOf(blocks)
    const only = Array.isArray(body?.only) ? body.only.map((n) => Number(n)) : null
    const todo = before.filter((it) => it.hasListing !== true && (only === null || only.includes(it.index)))

    if (action === 'plan') {
      return { id, rel, action, candidates: before, todo: todo.map((t) => t.index), catalog: fanqieTagPayload() }
    }
    if (action !== 'start') throw new Error(`未知 action：${action}`)
    if (todo.length === 0) return { id, rel, action, updated: 0, skipped: 0, candidates: before }

    const llm = ctx.get('llm')
    const route = resolveRoute(ctx, conf)
    if (llm === undefined || llm === null) throw new Error('这个 dsh 没有可用的 llm 服务')
    if (route === null) {
      throw new Error('没有可用的模型路由：请在 dsh 模型设置里选一个默认模型，或在本插件配置里填 provider/model')
    }

    const system = '你是番茄小说的责任编辑，负责给一部小说的「作品定位」补齐上架信息（阅读标签、内容标签、作品简介）。'
      + '只输出要求的那一节 Markdown，不要解释、不要复述原文、不要写其他小节。'
    const format = fanqieListingFormat()
    const catalog = fanqieTagCatalog()
    const sections = new Map()
    for (const it of todo) {
      const user = [
        '【番茄小说上架信息官方清单（标签只能从这里选，名字逐字照抄）】',
        catalog,
        '',
        '【这一版候选的作品定位（只作判断依据，不要复述、不要改动）】',
        clip(blocks[it.index].body, 4000),
        '',
        '【要求】只输出下面这一节（小节标题与字段名逐字照抄；不要写别的小节、不要写解释）：',
        format,
        '',
        '注意：主分类必选且只能 1 个；阅读标签的主题/角色/情节各最多 2 个；内容标签的情节/人设各最多 4 个、情感最多 2 个、世界观最多 1 个；',
        '多个标签用顿号「、」分隔；作品简介 50~500 字、一段话，不出现书名、外链、低俗/暴力/血腥内容。',
      ].join('\n')
      const res = await callModel(llm, route, {
        system,
        user,
        maxTokens: 1500,
        reasoningEffort: 'off',
        timeoutMs: LLM_DEFAULTS.timeoutMs,
      })
      const section = extractListingSection(res?.text)
      if (section === '') {
        throw new Error(`模型没给出「上架信息」小节（候选：${it.title !== '' ? it.title : it.heading}）：这次没有写盘，请重试`)
      }
      sections.set(it.index, section)
    }

    // 逐块拼回：只在缺节候选的末尾追加那一节，其余字节原样保留。
    let out = ''
    for (let i = 0; i < blocks.length; i++) {
      const prev = i === 0 ? 0 : blocks[i - 1].end
      out += text.slice(prev, blocks[i].end).replace(/\s+$/, '')
      const section = sections.get(i)
      if (section !== undefined) out += '\n\n' + section
      out += '\n'
    }
    out = out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n'

    await WS.backupArtifact(found.dir, rel)
    const path = await WS.writeArtifact(conf.root, id, rel, out)
    await mirrorToVault(conf.vaultPath, out, join(VAULT_MIRROR_DIR, VAULT_MIRROR_WORKS, id, rel))
    const steps = await WS.stepsStatus(found.dir, found.meta.genre)
    return {
      id, rel, action, path,
      updated: sections.size,
      skipped: before.length - sections.size,
      candidates: reportsOf(splitCandidateBlocks(out)),
      steps,
    }
  })

  // ---------------------------------------------------------------------------
  // 番茄小说发布：宿主只做进程编排 + 进度回读，浏览器自动化全在 Python 侧
  // ---------------------------------------------------------------------------
  let publishJob = null // { child, startedAt, started, running, exitCode, error }

  /** 发布日志与报告路径（放根目录的 .dsh-writer-m 下，不进作品目录）。 */
  const publishPaths = () => {
    const base = join(cfg().root, STATE_DIR_NAME)
    return { log: join(base, 'publish.log'), report: join(base, 'publish-report.json') }
  }

  /** 发布器脚本：优先配置项，缺省用插件自带 scripts/fanqie_publish.py。 */
  const publishScript = () => {
    const conf = cfg()
    return conf.publishScript !== '' ? conf.publishScript : join(PACKAGE_DIR, 'scripts', 'fanqie_publish.py')
  }

  /**
   * 子进程环境：强制 Python 用 UTF-8 写 stdout/stderr。
   * Windows 下子进程的 stdout 是管道时，Python 默认按本地代码页（cp936）编码，
   * 宿主按 UTF-8 解码就会得到「第1章 -> 乱码」这种 GBK 误码。
   */
  const childEnv = () => Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' })

  /**
   * 解码子进程输出：先按 UTF-8；出现替换字符 U+FFFD 说明是本地代码页（GBK）字节，再按 gbk 重解。
   * 双保险：即使外部解释器没吃到 PYTHONUTF8（用户换了 publishPython），界面也不会显示乱码。
   */
  const decodeChildOutput = (buf) => {
    const utf8 = buf.toString('utf8')
    if (utf8.includes('\uFFFD') === false) return utf8
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return utf8
    }
  }

  /** 起子进程并收全 stdout/stderr（带超时；超时按退出码 -2 记）。 */
  const runProcess = (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      let child
      try {
        child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: opts.env ?? childEnv() })
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err) })
        return
      }
      const outChunks = []
      const errChunks = []
      let done = false
      const finish = (code) => {
        if (done === true) return
        done = true
        clearTimeout(timer)
        resolve({
          code,
          stdout: decodeChildOutput(Buffer.concat(outChunks)),
          stderr: decodeChildOutput(Buffer.concat(errChunks)),
        })
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 忽略 */ }
        finish(-2)
      }, opts.timeoutMs ?? 120000)
      if (child.stdout !== null) child.stdout.on('data', (d) => { outChunks.push(Buffer.from(d)) })
      if (child.stderr !== null) child.stderr.on('data', (d) => { errChunks.push(Buffer.from(d)) })
      child.on('error', (err) => { errChunks.push(Buffer.from(String(err?.message ?? err), 'utf8')); finish(-1) })
      child.on('close', (code) => finish(code ?? -1))
    })

  /** 发布状态：进程态 + 日志尾巴 + 最近一次报告 + 已跑秒数。 */
  const publishStatus = async () => {
    const { log, report } = publishPaths()
    // 先取进程态、再读产物：反过来的话，一次刚好跨在子进程退出那一刻的状态查询
    // 会「running=false + 报告还没写完（null）」——回归脚本偶发假失败就是这个竞态。
    const running = publishJob !== null && publishJob.running === true
    const [logText, reportText] = await Promise.all([readTextSafe(log), readTextSafe(report)])
    let data = null
    if (reportText !== '') {
      try { data = JSON.parse(reportText) } catch { data = null }
    }
    return {
      running,
      startedAt: publishJob?.startedAt ?? '',
      seconds: publishJob === null ? 0 : Math.round((Date.now() - publishJob.started) / 1000),
      exitCode: publishJob === null ? null : publishJob.exitCode,
      error: publishJob?.error ?? '',
      logPath: log,
      reportPath: report,
      tail: logText === '' ? [] : logText.split('\n').slice(-80),
      report: data,
      script: publishScript(),
      ready: cfg().publishProfile !== '',
    }
  }

  /**
   * 番茄发布：action=plan 列该发哪些章（--dry，不开浏览器）/ start 后台起发布器 / status 读进度。
   * 站点标题 = 「第{编号}章 {章名}」，编号以文件名为真源，章名取正文首行或细纲 ### 块。
   */
  route('publish', async (body) => {
    const conf = cfg()
    const action = String(body?.action ?? 'plan')
    if (action === 'status') return await publishStatus()

    const id = String(body?.id ?? '')
    const found = await WS.readProject(conf.root, id)
    if (found === null) throw new Error(`作品不存在：${id}`)

    const script = publishScript()
    if (existsSync(script) === false) throw new Error(`发布脚本不存在：${script}`)

    const from = Number.isInteger(body?.from) ? body.from : 1
    const to = Number.isInteger(body?.to) ? body.to : 99999
    if (from < 1 || to < from) throw new Error(`章节范围不合法：${from}..${to}`)

    const { log, report } = publishPaths()
    await mkdir(dirname(log), { recursive: true })

    const args = [
      script,
      '--proj', found.dir,
      '--book-name', conf.publishBookName !== '' ? conf.publishBookName : id,
      '--from', String(from),
      '--to', String(to),
      '--log', log,
      '--report', report,
    ]
    if (conf.publishProfile !== '') args.push('--profile', conf.publishProfile)
    if (body?.polish === true) args.push('--polish')
    const existing = body?.existing ?? {}
    for (const no of Object.keys(existing)) {
      const item = existing[no]
      if (item !== '' && item !== null && item !== undefined) args.push('--existing', `${no}=${item}`)
    }
    const python = conf.publishPython !== '' ? conf.publishPython : 'python'

    if (action === 'plan') {
      args.push('--dry')
      const out = await runProcess(python, args, { cwd: PACKAGE_DIR, timeoutMs: 180000 })
      let data = null
      const m = /\{[\s\S]*\}\s*$/.exec(out.stdout.trim())
      if (m !== null) {
        try { data = JSON.parse(m[0]) } catch { data = null }
      }
      return {
        action: 'plan',
        code: out.code,
        report: data,
        stdout: clip(out.stdout, 4000),
        stderr: clip(out.stderr, 2000),
        logPath: log,
        reportPath: report,
      }
    }

    if (action !== 'start') throw new Error(`未知 action：${action}`)
    if (publishJob !== null && publishJob.running === true) throw new Error('已有发布任务在跑，先等它结束')
    if (conf.publishProfile === '') throw new Error('未配置番茄登录态目录（publishProfile），无法发布')

    const child = spawn(python, args, { cwd: PACKAGE_DIR, windowsHide: true, env: childEnv() })
    const job = { child, startedAt: new Date().toISOString(), started: Date.now(), running: true, exitCode: null, error: '' }
    publishJob = job
    child.on('error', (err) => { job.running = false; job.exitCode = -1; job.error = String(err?.message ?? err) })
    child.on('close', (code) => { job.running = false; job.exitCode = code ?? -1 })
    return { action: 'start', pid: child.pid ?? 0, from, to, logPath: log, reportPath: report, args: args.slice(1).join(' ') }
  })

  // ---------------------------------------------------------------------------
  // 番茄登录态：探活 / 扫码登录 / 保活 / 快照恢复
  // 浏览器自动化全在 Python 侧（scripts/fanqie_login.py），宿主只做进程编排与状态回读。
  // 登录态的唯一载体是 Playwright 持久化目录（publishProfile），所以探活/登录与发布互斥：
  // 两个 Chromium 抢同一个 user-data-dir，可能把 cookie 库写坏（2026-10-07 实测过一次）。
  // ---------------------------------------------------------------------------
  let fanqieJob = null // { child, action, startedAt, started, running, exitCode, error }
  /** 最近一次登录态结论（报告文件的内存缓存，避免每次读盘）。 */
  let fanqieLast = null

  /** 登录脚本：优先配置项，缺省用插件自带 scripts/fanqie_login.py。 */
  const fanqieLoginScript = () => {
    const conf = cfg()
    return conf.publishLoginScript !== '' ? conf.publishLoginScript : join(PACKAGE_DIR, 'scripts', 'fanqie_login.py')
  }

  /** 登录日志/报告/会话快照路径。快照缺省与 profile 同级，跟着登录态一起走。 */
  const fanqiePaths = () => {
    const conf = cfg()
    const base = join(conf.root, STATE_DIR_NAME)
    return {
      log: join(base, 'fanqie-login.log'),
      report: join(base, 'fanqie-status.json'),
      shotDir: base,
      state: conf.publishProfile !== '' ? join(dirname(conf.publishProfile), 'fanqie-session.json') : join(base, 'fanqie-session.json'),
    }
  }

  /** 抠 stdout 末行 FANQIE-RESULT {json}（脚本的输出契约，宿主只认这一行）。 */
  const fanqieResultOf = (stdout) => {
    const lines = String(stdout ?? '').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.startsWith('FANQIE-RESULT ')) {
        try { return JSON.parse(line.slice('FANQIE-RESULT '.length)) } catch { return null }
      }
    }
    return null
  }

  /** 读报告文件（宿主重启后仍能显示上次结论）。 */
  const fanqieReadReport = async () => {
    const text = await readTextSafe(fanqiePaths().report)
    if (text === '') return null
    try { return JSON.parse(text) } catch { return null }
  }

  /**
   * 登录态小结：界面用它一眼看准「还在不在、还有几天过期、上次什么时候看的」。
   * loggedIn 为 null 表示「还没探活过 / 无法判定」，不谎报 False。
   */
  const fanqieStatus = async (withTail = true) => {
    const conf = cfg()
    const paths = fanqiePaths()
    if (fanqieLast === null) fanqieLast = await fanqieReadReport()
    const last = fanqieLast
    const logText = withTail === true ? await readTextSafe(paths.log) : ''
    const running = fanqieJob !== null && fanqieJob.running === true
    return {
      action: 'status',
      running,
      jobAction: fanqieJob?.action ?? '',
      startedAt: fanqieJob?.startedAt ?? '',
      seconds: fanqieJob === null ? 0 : Math.round((Date.now() - fanqieJob.started) / 1000),
      exitCode: fanqieJob === null ? null : fanqieJob.exitCode,
      error: fanqieJob?.error ?? '',
      script: fanqieLoginScript(),
      python: conf.publishPython !== '' ? conf.publishPython : 'python',
      profile: conf.publishProfile,
      profileExists: conf.publishProfile !== '' && existsSync(conf.publishProfile),
      statePath: paths.state,
      stateExists: existsSync(paths.state),
      logPath: paths.log,
      reportPath: paths.report,
      ready: conf.publishProfile !== '',
      lastAction: last?.action ?? '',
      loggedIn: last === null ? null : (last.loggedIn ?? null),
      reason: last?.reason ?? '',
      authorName: last?.authorName ?? '',
      checkedAt: last?.finishedAt ?? last?.startedAt ?? '',
      expiresAt: last?.expiresAt ?? '',
      expiresInDays: typeof last?.expiresInDays === 'number' ? last.expiresInDays : null,
      nearestCookie: last?.nearestCookie ?? '',
      cookieCount: typeof last?.cookies === 'number' ? last.cookies : null,
      tail: withTail === false || logText === '' ? [] : logText.split('\n').slice(-60),
    }
  }

  /** 前置校验 + 组装 login 脚本参数（同步动作共用）。 */
  const fanqiePrepare = async (action) => {
    const conf = cfg()
    if (conf.publishProfile === '') throw new Error('未配置番茄登录态目录（publishProfile）：请先在设置页填好，或先建一个空目录')
    const script = fanqieLoginScript()
    if (existsSync(script) === false) throw new Error(`登录脚本不存在：${script}`)
    if (fanqieJob !== null && fanqieJob.running === true) throw new Error('已有登录任务在进行（浏览器窗口还开着），先等它结束或点「中止」')
    if (publishJob !== null && publishJob.running === true) throw new Error('正在发布章节：两者共用同一个登录态目录，不能同时开浏览器')
    const paths = fanqiePaths()
    await mkdir(dirname(paths.log), { recursive: true })
    const python = conf.publishPython !== '' ? conf.publishPython : 'python'
    const args = [
      script,
      '--action', action,
      '--profile', conf.publishProfile,
      '--log', paths.log,
      '--report', paths.report,
      '--state', paths.state,
      '--shot-dir', paths.shotDir,
    ]
    return { conf, script, paths, python, args }
  }

  /** 跑一个同步动作（probe / keepalive / restore），等它结束并回传结论。 */
  const fanqieRun = async (action, extra = []) => {
    const { paths, python, args } = await fanqiePrepare(action)
    const out = await runProcess(python, [...args, ...extra], { cwd: PACKAGE_DIR, timeoutMs: 300000 })
    const result = fanqieResultOf(out.stdout)
    if (result !== null) fanqieLast = result
    return {
      action,
      code: out.code,
      ok: result === null ? false : result.ok === true,
      loggedIn: result === null ? null : (result.loggedIn ?? null),
      result,
      stdout: clip(out.stdout, 4000),
      stderr: clip(out.stderr, 2000),
      logPath: paths.log,
    }
  }

  /** 弹可见浏览器等扫码登录：后台 spawn，进度用 action=status 轮询，登录成功后自动落会话快照。 */
  const fanqieLoginStart = async (body) => {
    const { paths, python, args } = await fanqiePrepare('login')
    const minutes = Number.isInteger(body?.minutes) && body.minutes > 0 ? Math.min(body.minutes, 120) : 45
    const full = [...args, '--minutes', String(minutes)]
    const child = spawn(python, full, { cwd: PACKAGE_DIR, windowsHide: true, env: childEnv() })
    const job = { child, action: 'login', startedAt: new Date().toISOString(), started: Date.now(), running: true, exitCode: null, error: '' }
    fanqieJob = job
    child.on('error', (err) => { job.running = false; job.exitCode = -1; job.error = String(err?.message ?? err) })
    child.on('close', (code) => {
      job.running = false
      job.exitCode = code ?? -1
      void fanqieReadReport().then((data) => { if (data !== null) fanqieLast = data })
    })
    return { action: 'login', pid: child.pid ?? 0, minutes, logPath: paths.log, statePath: paths.state, args: full.slice(1).join(' ') }
  }

  /**
   * 番茄登录态：status 看结论 / probe 探活 / login 扫码 / keepalive 续期并刷新快照 /
   * restore 免扫码导回快照 / abort 中止登录窗口。
   */
  route('fanqie', async (body) => {
    const action = String(body?.action ?? 'status')
    if (action === 'status') return await fanqieStatus()
    if (action === 'probe') return await fanqieRun('probe')
    if (action === 'keepalive') return await fanqieRun('keepalive')
    if (action === 'restore') {
      const asked = String(body?.from ?? '').trim()
      const from = asked !== '' ? asked : fanqiePaths().state
      if (existsSync(from) === false) throw new Error(`会话快照不存在：${from}（先用「登录番茄」扫一次码即可生成）`)
      return await fanqieRun('restore', ['--restore-from', from])
    }
    if (action === 'login') return await fanqieLoginStart(body)
    if (action === 'abort') {
      const killed = fanqieJob !== null && fanqieJob.running === true
      if (killed) {
        try { fanqieJob.child.kill() } catch { /* 忽略 */ }
        fanqieJob.running = false
        fanqieJob.error = '已被用户中止'
      }
      return { action: 'abort', killed }
    }
    throw new Error(`未知 action：${action}`)
  })

  // -------------------------------------------------------------------------
  // 批量写作：追加路由。生成逻辑一律走上面的 runStep，禁止复制第二份。
  // -------------------------------------------------------------------------
  const batchEngine = BATCH.createEngine({
    getRoot: () => cfg().root,
    getBatchCfg: () => cfg().batch ?? { concurrency: 1, retry: 3, retryDelayMs: 5000 },
    runStep,
  })
  void batchEngine.start()
  if (typeof ctx.effect === 'function') ctx.effect(() => batchEngine.stop())

  const batchView = (t) => ({
    id: t.id,
    bookName: t.bookName,
    genre: t.genre,
    channel: t.channel,
    idea: t.idea,
    targetChapters: t.targetChapters,
    chapterChars: t.chapterChars,
    styleId: t.styleId,
    templateId: t.templateId,
    status: t.status,
    currentStep: t.currentStep,
    currentChapter: t.currentChapter,
    error: t.error,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    projectId: t.projectId,
  })

  route('batch/create', async (body) => {
    const root = cfg().root
    const items = Array.isArray(body?.books) ? body.books : [body]
    const created = []
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      const task = BATCH.taskFromInput(item)
      created.push(await BATCH.saveTask(root, task))
    }
    if (created.length === 0) throw new Error('batch/create 需要至少一本：bookName + idea + targetChapters + chapterChars')
    batchEngine.kick()
    return { tasks: created.map(batchView), count: created.length }
  })

  route('batch/list', async () => {
    const tasks = await BATCH.listTasks(cfg().root)
    return { tasks: tasks.map(batchView) }
  })

  route('batch/status', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '').trim()
    if (id === '') {
      const tasks = await BATCH.listTasks(root)
      return { tasks: tasks.map(batchView) }
    }
    const task = await BATCH.loadTask(root, id)
    if (task === null) throw new Error('任务不存在：' + id)
    return { task: batchView(task) }
  })

  route('batch/pause', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '').trim()
    if (id === '') throw new Error('缺少任务 id')
    const task = await BATCH.loadTask(root, id)
    if (task === null) throw new Error('任务不存在：' + id)
    if (task.status === 'done') return { task: batchView(task) }
    batchEngine.abort(id)
    const next = await BATCH.saveTask(root, { ...task, status: 'paused', error: task.error === '' ? '已暂停' : task.error })
    return { task: batchView(next) }
  })

  route('batch/resume', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '').trim()
    if (id === '') throw new Error('缺少任务 id')
    const task = await BATCH.loadTask(root, id)
    if (task === null) throw new Error('任务不存在：' + id)
    if (task.status === 'done') return { task: batchView(task) }
    if (task.status === 'running' && batchEngine.isRunning(id)) return { task: batchView(task) }
    const next = await BATCH.saveTask(root, { ...task, status: 'queued', error: '' })
    batchEngine.kick()
    return { task: batchView(next) }
  })

  route('batch/cancel', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '').trim()
    if (id === '') throw new Error('缺少任务 id')
    const task = await BATCH.loadTask(root, id)
    if (task === null) throw new Error('任务不存在：' + id)
    batchEngine.abort(id)
    const next = await BATCH.saveTask(root, { ...task, status: 'failed', error: '已取消' })
    return { task: batchView(next) }
  })

  route('batch/remove', async (body) => {
    const root = cfg().root
    const id = String(body?.id ?? '').trim()
    if (id === '') throw new Error('缺少任务 id')
    batchEngine.abort(id)
    await BATCH.removeTask(root, id)
    return { removed: id }
  })

  // 兜底：根目录先建出来，否则首屏「作品列表」永远是空且看不出原因
  try {
    await mkdir(cfg().root, { recursive: true })
  } catch {
    // 用户配的路径不可写时留给 API 报错，不在启动时抛
  }

  void readTextSafe
}
