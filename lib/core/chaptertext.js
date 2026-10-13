/**
 * dsh-writer-m — 章节正文的「首行章标题」规整
 *
 * 为什么需要这一层：章节步的提示词只说「不要在开头写「第 N 章」以外的任何说明」，
 * 既没说必须写、也没规定格式，于是模型时而写 `## 第 3 章 章名`（而且常照抄**卷内局部**编号，
 * 与 chapters/ 里的全局编号对不上）、时而直接甩正文。同一本书里两种形态混排，
 * 阅读与全书定稿时前后不一致。
 *
 * 唯一约定：每章正文首行 = `第NNN章 章名`
 * - 编号以**落盘文件名的全局编号**为真源（第016章.md → 016），保证与目录/文件名同源；
 * - 章名优先级：调用方显式给出 > 正文里已有的 > 文件名后缀；
 * - 纯文本，不带 `#`——阅读/定稿层要 markdown 标题时自己加。
 */

// 章号字符集：阿拉伯（全/半角）+ 中文数字
const NUM_CHARS = '0-9０-９零〇一二三四五六七八九十百千两'
const HEADING_RE = new RegExp(
  '^[ \\t]*#{0,6}[ \\t]*第[ \\t]*([0-9０-９]{1,4}|[零〇一二三四五六七八九十百千两]+)[ \\t]*章'
  + '[ \\t]*[:：、,.\\-—_·]?[ \\t]*([^\\n]*)$',
)
const SEP_RE = /^[-—_·.、\s]+/

/** '016' / 16 → '第016章'；带章名 → '第016章 旧志有鬼'。 */
export function chapterHeading(no, title = '') {
  const n = Number(no)
  const base = '第' + String(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0).padStart(3, '0') + '章'
  const t = cleanTitle(title)
  return t === '' ? base : base + ' ' + t
}

/** 把任意「第 N 章 章名」「## 章名」「—— 章名」形式洗成纯章名。 */
export function cleanTitle(title) {
  let t = String(title ?? '').trim()
  if (t === '') return ''
  t = t.replace(/^#{1,6}[ \t]*/, '')
  t = t.replace(new RegExp('^第[ \\t]*[' + NUM_CHARS + ']+[ \\t]*章[ \\t]*[:：、,.\\-—_·]?[ \\t]*'), '')
  t = t.replace(SEP_RE, '')
  return t.trim()
}

/** 中文/阿拉伯数字 → 整数；认不出返回 null。 */
export function parseHeadingNo(s) {
  const t = String(s ?? '').trim()
  if (t === '') return null
  if (/^[0-9０-９]+$/.test(t)) {
    const half = t.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    const n = Number(half)
    return Number.isFinite(n) ? n : null
  }
  const digit = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const unit = { 十: 10, 百: 100, 千: 1000 }
  let total = 0
  let num = 0
  for (const ch of t) {
    if (unit[ch] !== undefined) {
      total += (num === 0 ? 1 : num) * unit[ch]
      num = 0
    } else if (digit[ch] !== undefined) {
      num = digit[ch]
    } else {
      return null
    }
  }
  const out = total + num
  return out > 0 ? out : null
}

/** 从文件名解析 { no, title }：'第016章-旧志有鬼.md' → {no:16,title:'旧志有鬼'}；认不出返回 null。 */
export function parseChapterFileName(fileName) {
  const base = String(fileName ?? '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.md$/i, '')
    .replace(/-润色$/, '')
    .trim()
  const m = /^第[ \t]*0*([0-9]+)[ \t]*章(?:[ \t]*[-—_·.、]+[ \t]*(.*))?$/.exec(base)
  if (m === null) return null
  const no = Number(m[1])
  if (!Number.isFinite(no) || no <= 0) return null
  return { no, title: cleanTitle(m[2] ?? '') }
}

/** 拆出正文开头的章标题行 → { heading, no, title, body }；没有标题行时 heading=''、no=null。 */
export function splitChapterHeading(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '')
  const lines = src.split(/\r?\n/)
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  const m = i < lines.length ? HEADING_RE.exec(lines[i]) : null
  if (m === null) return { heading: '', no: null, title: '', body: src.trim() }
  let j = i + 1
  while (j < lines.length && lines[j].trim() === '') j++
  return {
    heading: lines[i].trim(),
    no: parseHeadingNo(m[1]),
    title: cleanTitle(m[2]),
    body: lines.slice(j).join('\n').trim(),
  }
}

/**
 * 把一章正文规整成 `第NNN章 章名` + 空行 + 正文。
 * no 缺省/非法 → 原样返回（不猜编号）；正文本来就空且没有标题行 → 也不动（不凭空造标题）。
 */
export function normalizeChapterText(text, options = {}) {
  const src = String(text ?? '')
  const no = Number(options.no)
  if (!Number.isFinite(no) || no <= 0) {
    return { text: src, heading: '', body: src.trim(), title: '', changed: false, renumbered: false, before: '' }
  }
  const parts = splitChapterHeading(src)
  if (parts.body === '' && parts.heading === '') {
    return { text: src, heading: '', body: '', title: '', changed: false, renumbered: false, before: '' }
  }
  const title = cleanTitle(options.title) !== '' ? cleanTitle(options.title) : parts.title
  const heading = chapterHeading(no, title)
  const body = parts.body
  const out = body === '' ? heading : heading + '\n\n' + body
  return {
    text: out,
    heading,
    body,
    title,
    changed: out !== src.trim(),
    renumbered: parts.no !== null && parts.no !== Math.floor(no),
    before: parts.heading,
  }
}

/** 按文件名规整一章：编号取文件名（唯一真源），章名沿用正文已有的、再退回文件名后缀。 */
export function normalizeChapterFileText(text, fileName) {
  const parsed = parseChapterFileName(fileName)
  if (parsed === null) {
    return { text: String(text ?? ''), heading: '', body: '', title: '', changed: false, renumbered: false, before: '', skipped: true }
  }
  return Object.assign(normalizeChapterText(text, { no: parsed.no, title: parsed.title }), { skipped: false })
}
