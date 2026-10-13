/**
 * fanqie-tags.js — 番茄小说「上架信息」（阅读标签 / 内容标签 / 作品简介）的契约、提示词块与解析。
 *
 * 为什么放在 core：站点创建作品页要求填两个标签下拉 + 50~500 字简介，而清单只能从页面 DOM 抓
 * （没有目录 API，见 scripts/fanqie-tags-gen.mjs 头部说明）。清单落在 fanqie-tagdata.js（生成物），
 * 本文件负责三件事：
 *   1) fanqieTagCatalog()  —— 把清单渲染成提示词里的枚举文本（作品定位步注入 {{fanqieTags}}）；
 *   2) fanqieListingBlock()—— 用户改过提示词、丢掉了 {{fanqieTags}} 时的兜底块（不许静默丢）；
 *   3) parse/validate      —— 把模型写出的「### 四、上架信息」解析成结构化结果并校验（客户端上架信息卡
 *                             与回归脚本共用同一条取数路径，避免两处各解析一遍后互相漂移）。
 */
import {
  FANQIE_TAG_SOURCE,
  FANQIE_TAG_CAPTURED_AT,
  FANQIE_READ_TIP,
  FANQIE_CONTENT_TIP,
  FANQIE_TITLE_MAX,
  FANQIE_ROLE_NAME_MAX,
  FANQIE_BRIEF_MIN,
  FANQIE_BRIEF_MAX,
  FANQIE_READ_GROUPS,
  FANQIE_CONTENT_GROUPS,
} from './fanqie-tagdata.js'

export {
  FANQIE_TAG_SOURCE,
  FANQIE_TAG_CAPTURED_AT,
  FANQIE_READ_TIP,
  FANQIE_CONTENT_TIP,
  FANQIE_TITLE_MAX,
  FANQIE_ROLE_NAME_MAX,
  FANQIE_BRIEF_MIN,
  FANQIE_BRIEF_MAX,
  FANQIE_READ_GROUPS,
  FANQIE_CONTENT_GROUPS,
}

/** 两类标签的元信息：kind 用于解析时区分「阅读标签·情节」与「内容标签·情节」。 */
const KINDS = [
  { kind: 'read', label: '阅读标签', tip: FANQIE_READ_TIP, groups: FANQIE_READ_GROUPS },
  { kind: 'content', label: '内容标签', tip: FANQIE_CONTENT_TIP, groups: FANQIE_CONTENT_GROUPS },
]

/** 只看阅读标签能填的名字（主分类/主题/角色）与只看内容标签的名字（情感/人设/世界观）；情节两边都有。 */
const READ_ONLY = new Set(['主分类', '主题', '角色'])
const CONTENT_ONLY = new Set(['情感', '人设', '世界观'])

/** 候选块的分隔与客户端 parsePositionCandidates 完全一致（对齐第 N 个候选靠它）。 */
const CANDIDATE_SPLIT_RE = /^##[ \t]+候选[^\n]*$/gm
/** 「### 四、上架信息」这类小节标题。 */
const HEADING_RE = /^[ \t]*#{1,6}[ \t]*\S/
/** 一行键值：「- 阅读标签·主分类：东方仙侠」。前缀与分隔符都放宽：模型偶尔写成全角冒号或 · 号。 */
const KEY_LINE_RE = /^[ \t]*[-*·•]?[ \t]*(?:(阅读标签|内容标签)[ \t]*[·•・\-－—]?[ \t]*)?(主分类|主题|角色|情节|情感|人设|世界观)[ \t]*[:：][ \t]*(.*)$/
/** 作品简介行（可能后面还跟一段多行正文）。 */
const BRIEF_LINE_RE = /^[ \t]*[-*·•]?[ \t]*(?:作品简介|简介)[ \t]*[:：]?[ \t]*(.*)$/
/** 值里的分隔符：顿号/逗号/斜杠/竖线。 */
const VALUE_SPLIT_RE = /[、,，/|]+/
/** 「无 / 未指定 / - 」这类占位值不算标签。 */
const EMPTY_VALUES = new Set(['', '无', '暂无', '未指定', '没有', '空', 'none', 'None', 'N/A', 'n/a', '-', '—', 'null'])

/** 供 route('fanqieTags') action=catalog 与客户端展示的完整契约（结构化，不是提示词文本）。 */
export function fanqieTagPayload() {
  return {
    source: FANQIE_TAG_SOURCE,
    capturedAt: FANQIE_TAG_CAPTURED_AT,
    titleMax: FANQIE_TITLE_MAX,
    roleNameMax: FANQIE_ROLE_NAME_MAX,
    briefMin: FANQIE_BRIEF_MIN,
    briefMax: FANQIE_BRIEF_MAX,
    kinds: KINDS.map((k) => ({
      kind: k.kind,
      label: k.label,
      tip: k.tip,
      total: k.groups.reduce((n, g) => n + g.items.length, 0),
      groups: k.groups.map((g) => ({ id: g.id, title: g.title, required: g.required === true, max: g.max, items: g.items.slice() })),
    })),
  }
}

/** 单组一行枚举文本。 */
function groupLine(g) {
  const limit = g.required === true ? '必选，只能选 ' + g.max + ' 个' : '最多选 ' + g.max + ' 个'
  return '- ' + g.title + '（' + limit + '）：' + g.items.join('、')
}

/**
 * 提示词里的标签枚举文本（作品定位步的 {{fanqieTags}}）。
 * 只给清单与规则，不给输出格式——输出格式写在提示词里，用户改提示词时也能自己调。
 */
export function fanqieTagCatalog() {
  const lines = [
    '（番茄小说「创建作品」页官方清单 · 采集于 ' + FANQIE_TAG_CAPTURED_AT + ' · 来源 ' + FANQIE_TAG_SOURCE + '）',
  ]
  for (const k of KINDS) {
    lines.push('【' + k.label + '】' + k.tip)
    for (const g of k.groups) lines.push(groupLine(g))
  }
  return lines.join('\n')
}

/** 上架信息的输出格式（提示词与本兜底块共用同一份文案，避免两处写法不一致）。 */
export function fanqieListingFormat() {
  const lines = ['### 四、上架信息']
  for (const k of KINDS) {
    for (const g of k.groups) {
      const range = g.required === true ? '必填 1 个' : '0~' + g.max + ' 个'
      lines.push('- ' + k.label + '·' + g.title + '：<' + range + '，只能用上面清单里的名字，多个用顿号分隔>')
    }
  }
  lines.push('- 作品简介：<' + FANQIE_BRIEF_MIN + '~' + FANQIE_BRIEF_MAX + ' 字，一段话，不要出现书名、外链、低俗/暴力/血腥内容>')
  return lines.join('\n')
}

/**
 * 用户改过提示词（覆盖版）里没有 {{fanqieTags}} 时的兜底块。
 * 与 {{style}} / {{vault}} 同理：宁可把要求追加到末尾，也不要静默丢掉上架信息这一步的产出。
 */
export function fanqieListingBlock() {
  return '\n【番茄小说上架信息（创建作品页要填）】\n' + fanqieTagCatalog() + '\n除上面各节外，每个候选都要再补一节（字段名固定，方便工具解析）：\n' + fanqieListingFormat() + '\n'
}

/** 把「上架信息」小节从候选块里切出来；没写小节标题时退回整块（容忍模型只写了键值行）。 */
function listingSection(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (!HEADING_RE.test(lines[i])) continue
    const title = lines[i].replace(/^[ \t]*#{1,6}[ \t]*/, '')
    if (title.includes('上架')) { start = i + 1; break }
  }
  if (start < 0) return { body: lines.join('\n'), sectionFound: false }
  const rest = []
  for (let i = start; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) break
    rest.push(lines[i])
  }
  return { body: rest.join('\n'), sectionFound: true }
}

/** 「无 / 未指定」这类占位值不算标签。 */
function splitValues(raw) {
  const out = []
  for (const piece of String(raw ?? '').split(VALUE_SPLIT_RE)) {
    const v = piece.trim().replace(/^[[【（(「'"]+/, '').replace(/[\]】）)」'"]+$/, '').trim()
    if (EMPTY_VALUES.has(v)) continue
    out.push(v)
  }
  return out
}

/**
 * 解析一个候选块的「上架信息」。
 * 返回 { sectionFound, groups: [{kind, groupId, items}], brief, notes }，未识别的行进 notes（不静默丢）。
 */
export function parseFanqieListing(text) {
  const sec = listingSection(text)
  const acc = { read: {}, content: {} }
  let brief = ''
  let briefMode = false
  const notes = []
  for (const line of sec.body.split(/\r?\n/)) {
    if (briefMode && /^[ \t]*[-*·•]/.test(line)) briefMode = false
    if (briefMode) { brief = (brief + '\n' + line).trim(); continue }
    const bm = BRIEF_LINE_RE.exec(line)
    if (bm !== null) { brief = String(bm[1] ?? '').trim(); briefMode = true; continue }
    const m = KEY_LINE_RE.exec(line)
    if (m === null) continue
    const explicit = m[1] ?? ''
    const groupId = m[2]
    const values = splitValues(m[3])
    let kind = explicit === '阅读标签' ? 'read' : (explicit === '内容标签' ? 'content' : '')
    if (kind === '') {
      if (READ_ONLY.has(groupId)) kind = 'read'
      else if (CONTENT_ONLY.has(groupId)) kind = 'content'
      else {
        // 情节：两类标签都有这一组，没写前缀时按更常见的内容标签归类，并在校验里提示。
        kind = acc.read[groupId] === undefined ? 'read' : 'content'
        notes.push('「' + groupId + '」这一行没写「阅读标签/内容标签」前缀，已按' + (kind === 'read' ? '阅读标签' : '内容标签') + '解析')
      }
    }
    const prev = Array.isArray(acc[kind][groupId]) ? acc[kind][groupId] : []
    acc[kind][groupId] = prev.concat(values)
  }
  const groups = []
  for (const k of KINDS) {
    for (const g of k.groups) {
      const items = acc[k.kind][g.id] ?? []
      groups.push({ kind: k.kind, kindLabel: k.label, groupId: g.id, title: g.title, required: g.required === true, max: g.max, items })
    }
  }
  return { sectionFound: sec.sectionFound, groups, brief, notes }
}

/** 非空白字符数：站点按「字」计，换行与空格不算。 */
export function briefChars(brief) {
  return String(brief ?? '').replace(/\s+/g, '').length
}

/** 校验一份解析结果：problems=必须改，warnings=可能是站点清单更新或模型自由发挥。 */
export function validateFanqieListing(parsed) {
  const problems = []
  const warnings = []
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : []
  const official = new Map()
  for (const k of KINDS) for (const g of k.groups) official.set(k.kind + '·' + g.id, new Set(g.items))
  for (const g of groups) {
    const set = official.get(g.kind + '·' + g.groupId)
    if (g.required === true && g.items.length === 0) problems.push(g.kindLabel + '·' + g.title + ' 必选，至少要选 1 个')
    if (g.items.length > g.max) problems.push(g.kindLabel + '·' + g.title + ' 最多 ' + g.max + ' 个，实际 ' + g.items.length + ' 个：' + g.items.join('、'))
    if (set !== undefined) {
      const bad = g.items.filter((x) => !set.has(x))
      if (bad.length > 0) warnings.push(g.kindLabel + '·' + g.title + ' 不在官方清单里：' + bad.join('、') + '（可能站点已更新，请到创建页核对）')
    }
  }
  const n = briefChars(parsed?.brief)
  if (n === 0) problems.push('没有给出作品简介（站点要求 ' + FANQIE_BRIEF_MIN + '~' + FANQIE_BRIEF_MAX + ' 字）')
  else if (n < FANQIE_BRIEF_MIN) problems.push('作品简介只有 ' + n + ' 字，站点要求至少 ' + FANQIE_BRIEF_MIN + ' 字')
  else if (n > FANQIE_BRIEF_MAX) problems.push('作品简介 ' + n + ' 字，站点要求不超过 ' + FANQIE_BRIEF_MAX + ' 字')
  if (Array.isArray(parsed?.notes)) for (const t of parsed.notes) warnings.push(t)
  return { ok: problems.length === 0, problems, warnings }
}

/**
 * 一次解析多份候选文本：宿主 route('fanqieTags') action=parse 与回归脚本共用。
 * 返回数组与传入的 texts 一一对应（客户端按第 N 个候选取第 N 项，不靠文本内容匹配）。
 */
export function fanqieListingReports(texts) {
  const list = Array.isArray(texts) ? texts : []
  return list.map((t) => {
    const parsed = parseFanqieListing(t)
    const check = validateFanqieListing(parsed)
    return {
      sectionFound: parsed.sectionFound,
      groups: parsed.groups,
      brief: parsed.brief,
      briefChars: briefChars(parsed.brief),
      problems: check.problems,
      warnings: check.warnings,
      ok: check.ok,
    }
  })
}

/**
 * 把定位稿切成候选块：与客户端 parsePositionCandidates 用同一个分隔符，但额外给出每块的
 * 起止下标，供宿主「只补上架信息」把新小节插在**该候选末尾**（不改前面的定位正文）。
 * 返回 [{ heading, name, body, start, end }]；name 是「- 书名：」里的书名，可能为空串。
 */
export function splitCandidateBlocks(text) {
  const src = String(text ?? '')
  const re = /^##[ \t]+候选[^\n]*$/gm
  const starts = []
  let m
  while ((m = re.exec(src)) !== null) starts.push({ index: m.index, heading: m[0] })
  const out = []
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index
    const end = i + 1 < starts.length ? starts[i + 1].index : src.length
    const body = src.slice(start, end)
    const nm = /^\s*(?:[-*]\s*)?书名\s*[:：]\s*(.+)$/m.exec(body)
    out.push({
      heading: starts[i].heading.replace(/^[#\s]+/, '').trim(),
      name: nm === null ? '' : String(nm[1]).trim(),
      body,
      start,
      end,
    })
  }
  return out
}

/**
 * 从模型输出里抠出「### 四、上架信息」这一节。
 * 只认含「上架」的小节标题；模型没写标题但给了键值行时补上标题；两样都没有时返回空串
 * （调用方据此报错，绝不把一段解释性文字写进定位稿）。
 */
export function extractListingSection(text) {
  let body = String(text ?? '').trim()
  body = body.replace(/^\s*```[a-zA-Z]*[ \t]*\n/, '').replace(/\n```\s*$/, '').trim()
  const lines = body.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!HEADING_RE.test(lines[i])) continue
    const title = lines[i].replace(/^[ \t]*#{1,6}[ \t]*/, '')
    if (title.includes('上架')) return lines.slice(i).join('\n').trim()
  }
  const hasKey = lines.some((l) => KEY_LINE_RE.test(l) || BRIEF_LINE_RE.test(l))
  if (!hasKey) return ''
  return ('### 四、上架信息\n' + body).trim()
}

/**
 * 书名重名时的「只重新生成书名」提示词：模型只看现状、只回候选书名，不碰定位正文。
 * 发布到番茄时若站内已有同名作品，必须换名；这里刻意不重跑作品定位（正文/大纲/人物一个字都不动）。
 */
export function titlePrompts({ current = '', channel = '', type = '', tags = [], brief = '', outline = '', count = 4 } = {}) {
  const system = [
    '你是番茄小说的资深签约编辑，专门给一本书「换一个能过审、能吸量的新书名」。',
    '你只输出候选书名，一行一个，不写解释段落、不写正文、不写其他内容。',
  ].join('\n')
  const tagText = (Array.isArray(tags) ? tags : []).map((t) => String(t)).filter((t) => t !== '').join('、')
  const lines = [
    '【现在的书名】' + (current === '' ? '（未命名）' : '《' + current + '》'),
    '这本书发布到番茄小说时，站内已经有同名作品，必须换一个书名。**只改书名**：正文、大纲、人物设定一个字都不用动。',
    '',
    '【这本书是什么】',
    '- 频道：' + (channel === 'male' ? '男频' : channel === 'female' ? '女频' : channel === '' ? '（未填）' : channel),
    '- 类型：' + (type === '' ? '（未填）' : type),
    '- 标签：' + (tagText === '' ? '（未填）' : tagText),
  ]
  const b = String(brief ?? '').trim()
  if (b !== '') lines.push('- 现在的作品简介：' + b.slice(0, 240))
  const o = String(outline ?? '').trim()
  if (o !== '') {
    lines.push('', '【已有大纲摘录（只能沿用，不许改设定）】', o.slice(0, 1200))
  }
  lines.push(
    '',
    '【要求】',
    '- 给 ' + String(count) + ' 个候选，一行一个，格式固定：书名｜一句话理由（20 字以内）',
    '- 书名 2~' + String(FANQIE_TITLE_MAX) + ' 个汉字（番茄创建页的输入框最多 ' + String(FANQIE_TITLE_MAX) + ' 字）；不要书名号、不要标点、不要空格、不要「小说」二字',
    '- 每个候选换一个方向：①保留原名里的关键词换种说法 ②把主角身份或金手指前置 ③把爽点或反差前置 ④口语化、带悬念',
    '- 不要和现在的书名重复，也不要和番茄站内常见句式雷同（把「我在某某搞某某」这类句式换掉）',
    '- 不要堆「最强/无敌/神」这类空泛词，要让人一眼看出这本书到底讲什么',
  )
  return { system, user: lines.join('\n') }
}

/** 去掉书名号/引号/空白，得到能直接当作品名的纯书名。 */
export function cleanTitle(raw) {
  let s = String(raw ?? '')
  // 先摘掉结尾的括号备注（如「（暂定）」「(改名版)」），再清首尾的包裹符与列表符号
  s = s.replace(/[（(][^（()）]{0,30}[)）]\s*$/, '')
  s = s.replace(/^[\s\-–—*·•「『【《"'（(]+/, '')
  s = s.replace(/[\s」』】》"')）]+$/, '')
  s = s.replace(/\s+/g, '')
  s = s.replace(/[。！？，,、；;：:!?~～]+$/g, '')
  return s.trim()
}

/**
 * 解析模型给回的候选书名（每行「书名｜理由」）。容错：列表符号/编号/「书名：」前缀/书名号/重复行
 * 都清掉；超长或过短的行保留但标 ok=false，让界面能提示「这个不能用」而不是静默消失。
 * 传 current 时，与当前书名同名的候选会被标 same=true 且 ok=false（发布重名时不能用原名）。
 */
export function parseTitleCandidates(text, { max = FANQIE_TITLE_MAX, current = '' } = {}) {
  const out = []
  const seen = new Set()
  const cur = cleanTitle(current)
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = String(raw).trim()
    if (line === '' || /^```/.test(line) || HEADING_RE.test(line) || /^[>|]/.test(line)) continue
    // 模型偶尔会先写一句说明再列候选：整句（带句末标点）或「理由：」这类行直接跳过
    if (/[。！？]$/.test(line) || /^(?:说明|注意|理由|解释|以上|以下是|候选如下)/.test(line)) continue
    line = line.replace(/^\s*(?:[-*·•–—]|\(?\d+[).、)）]|候选[一二三四五六七八九十\d]+[.、)）:：]?)\s*/, '')
    line = line.replace(/^(?:候选)?书名\s*[:：]\s*/, '')
    const parts = line.split(/[｜|]/)
    const title = cleanTitle(parts[0])
    if (title === '') continue
    if (seen.has(title)) continue
    seen.add(title)
    const reason = parts.slice(1).join('｜').trim().replace(/^[-—:：\s]+/, '').slice(0, 60)
    const chars = Array.from(title).length
    const same = cur !== '' && title === cur
    out.push({ title, reason, chars, same, ok: chars >= 2 && chars <= max && !same })
  }
  return out
}

/**
 * 把定位稿里所有「- 书名：…」行改写成新书名（只动书名行，别的字节不动）。
 * 返回 { text, changed }；changed=false 表示这份稿子里没有书名行（调用方自己决定要不要提示）。
 */
export function replaceTitleLines(text, title) {
  const t = cleanTitle(title)
  let changed = false
  const re = /^([ \t]*(?:[-*·•]?[ \t]*)?书名[ \t]*[:：][ \t]*)[^\r\n]*$/gm
  const out = String(text ?? '').replace(re, (_m, p1) => {
    changed = true
    return p1 + t
  })
  return { text: out, changed }
}

/** 判定一段文本里有没有「候选」分节（route 侧用来提示「这不是定位稿」）。 */
export function hasCandidateHeadings(text) {
  CANDIDATE_SPLIT_RE.lastIndex = 0
  return CANDIDATE_SPLIT_RE.test(String(text ?? ''))
}

/** 供人读的上架信息文本（客户端「复制」按钮与站点填空共用一份格式）。 */
export function formatFanqieListing(report, title = '') {
  const lines = []
  if (String(title ?? '') !== '') lines.push('《' + title + '》番茄上架信息')
  else lines.push('番茄上架信息')
  if (report?.sectionFound === false) lines.push('（这一段里没有「上架信息」小节，请重新生成作品定位）')
  for (const k of KINDS) {
    const gs = (Array.isArray(report?.groups) ? report.groups : []).filter((g) => g.kind === k.kind)
    lines.push('【' + k.label + '】')
    for (const g of gs) lines.push(g.title + '：' + (g.items.length === 0 ? '（未指定）' : g.items.join('、')))
  }
  lines.push('【作品简介】（' + briefChars(report?.brief) + ' 字）')
  lines.push(String(report?.brief ?? '').trim() === '' ? '（未给出）' : String(report.brief).trim())
  return lines.join('\n')
}
