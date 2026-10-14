/**
 * novel-batch-agent — 拆书：把爆款小说拆成「可直接接入生成管线」的三件套。
 *
 * 跟风方法论的三个借鉴对象与落点：
 *   1. 对话风格 / 文风      → 风格画像（styleId，注入章节步与润色步，renderStyleBlock）
 *   2. 剧情发展方式 / 节奏  → 结构模版（templateId，注入大纲步）+ 实测节奏指纹
 *   3. 故事背景 / 题材      → 不搬。这是换皮区，由作品定位步重新生成差异候选。
 *
 * 设计纪律（与 styles.js / templates.js 一致）：
 *   - 统计层纯代码、零幻觉——指纹是事实，不是模型印象；
 *   - LLM 层只提炼抽象规律，绝不复制原句、专有名词、金句（借骨架不抄文字）；
 *   - 原文带 frontmatter 入库，统计与采样前必须剥头，否则指纹被元信息污染。
 *
 * 指纹的注入通道：renderStyleBlock 只渲染七维标量，所以统计指纹折叠进
 * chapterRhythm / beatRhythm 两个维度值里，随风格画像一起到达章节步与润色步。
 */

/** 章节标题行：「第 12 章 章名」「第十二章」、允许 markdown 标题前缀。 */
const CHAPTER_HEADING_RE = /^(?:#{1,4}[ \t]*)?第[ \t]*[0-9零一二三四五六七八九十百千万两]+[ \t]*章[^\n]*$/gm

/** 剥掉 md 文件头部的 frontmatter 块（原文入库带了元信息，统计前必须去掉）。 */
export function stripFrontmatter(text) {
  return String(text ?? '').replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

/**
 * 识别下载器导出的「书籍信息」头（番茄下载器常见格式）：
 *   书籍信息 / 书名：… / 作者：… / 连载状态：… / 字数：… / 章节数：… / 书籍 ID：… / 阅读量：…
 *   最后更新时间：… / 【简介】…
 * 这些元信息里藏着市场信号（阅读量）与完本状态（连载状态），正文统计用不上但卡片要。
 * @returns {{ meta: Record<string,string>, body: string }} body 从第一个章节头起（无章节头则原样返回）
 */
export function parseDownloaderHeader(text) {
  const src = String(text ?? '')
  if (/^\s*书籍信息\s*$/m.test(src.slice(0, 2000)) === false) return { meta: {}, body: src }
  const firstChapter = src.search(/^第[ \t]*[0-9零一二三四五六七八九十百千万两]+[ \t]*章/m)
  const head = firstChapter > 0 ? src.slice(0, firstChapter) : src.slice(0, 4000)
  const meta = {}
  let introAt = -1
  const lines = head.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (/^【简介】/.test(line)) {
      introAt = i
      break
    }
    const kv = /^([^：:\n]{1,12})[：:]\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1].replace(/\s+/g, '')
    if (['书名', '作者', '连载状态', '字数', '章节数', '书籍ID', '阅读量', '最后更新时间'].includes(key)) {
      meta[key] = kv[2].trim()
    }
  }
  if (introAt >= 0) {
    meta['简介'] = lines.slice(introAt).join('\n').replace(/^【简介】\s*/, '').trim()
  }
  return { meta, body: firstChapter > 0 ? src.slice(firstChapter) : src }
}

/** 按章节标题切分全文。返回 [{ no, title, text }]；没有章节头时整本当一章。 */
export function splitChapters(text) {
  const src = String(text ?? '')
  const heads = []
  let m
  while ((m = CHAPTER_HEADING_RE.exec(src)) !== null) {
    heads.push({ title: m[0].replace(/^#{1,4}[ \t]*/, '').trim(), at: m.index, end: m.index + m[0].length })
  }
  if (heads.length === 0) return [{ no: 1, title: '（无章节标题）', text: src }]
  const chapters = []
  for (let i = 0; i < heads.length; i += 1) {
    const end = i + 1 < heads.length ? heads[i + 1].at : src.length
    chapters.push({ no: i + 1, title: heads[i].title, text: src.slice(heads[i].end, end) })
  }
  return chapters
}

/**
 * 章末钩子粗分类（启发式，只看最后一个非空段落的收尾特征，报告中标注为机器粗判）：
 * 疑问留白 / 冲突爆发 / 戛然而止 / 系统提示 / 陈述收尾。
 */
function classifyHook(tail) {
  const t = String(tail ?? '').trim()
  if (t === '') return '陈述收尾'
  if (/[?？]["”’」』]*$/.test(t)) return '疑问留白'
  if (/[!！]["”’」』]*$/.test(t)) return '冲突爆发'
  if (/(……|—|——)["”’」』]*$/.test(t)) return '戛然而止'
  if (/【|系统|面板|叮/.test(t)) return '系统提示'
  return '陈述收尾'
}

/** 一段是否对话段：含中文引号对或「」对。 */
function isDialogueParagraph(p) {
  return /“[^”]*”/.test(p) || /「[^」]*」/.test(p)
}

/** 整本书的客观节奏指纹。纯统计，不调模型。 */
export function chapterStats(text) {
  const chapters = splitChapters(text)
  const per = chapters.map((c) => {
    const paras = c.text.split(/\n+/).map((p) => p.trim()).filter((p) => p !== '')
    const chars = c.text.replace(/\s/g, '').length
    const dialogue = paras.filter(isDialogueParagraph).length
    const tail = paras[paras.length - 1] ?? ''
    return {
      no: c.no,
      title: c.title,
      chars,
      paragraphs: paras.length,
      paraAvgChars: paras.length === 0 ? 0 : Math.round(chars / paras.length),
      dialogueRatio: paras.length === 0 ? 0 : Math.round((dialogue / paras.length) * 100),
      hook: classifyHook(tail),
    }
  })
  const n = per.length
  const charsArr = per.map((c) => c.chars)
  const hookCount = {}
  for (const c of per) hookCount[c.hook] = (hookCount[c.hook] ?? 0) + 1
  return {
    chapterCount: n,
    totalChars: charsArr.reduce((a, b) => a + b, 0),
    avgChapterChars: n === 0 ? 0 : Math.round(charsArr.reduce((a, b) => a + b, 0) / n),
    minChapterChars: n === 0 ? 0 : Math.min(...charsArr),
    maxChapterChars: n === 0 ? 0 : Math.max(...charsArr),
    avgDialogueRatio: n === 0 ? 0 : Math.round(per.reduce((a, c) => a + c.dialogueRatio, 0) / n),
    avgParaChars: n === 0 ? 0 : Math.round(per.reduce((a, c) => a + c.paraAvgChars, 0) / n),
    hookDist: Object.entries(hookCount)
      .sort((a, b) => b[1] - a[1])
      .map(([hook, count]) => ({ hook, count, pct: Math.round((count / n) * 100) })),
    chapters: per,
  }
}

/** 指纹文本：给拆书报告、卡片，也给 LLM 结构分析当事实底稿。 */
export function renderStatsText(stats, { perChapter = false } = {}) {
  const lines = [
    `章节数：${stats.chapterCount}（总字数 ${stats.totalChars}）`,
    `单章字数：均值 ${stats.avgChapterChars}，区间 ${stats.minChapterChars}~${stats.maxChapterChars}`,
    `段落长度：段均 ${stats.avgParaChars} 字`,
    `对话占比：平均 ${stats.avgDialogueRatio}% 的段落含对话`,
    '章末钩子分布（机器粗判，只看收尾标点特征）：' +
      (stats.hookDist.length === 0 ? '无' : stats.hookDist.map((h) => `${h.hook} ${h.pct}%`).join(' / ')),
  ]
  if (perChapter) {
    lines.push('', '逐章明细：')
    for (const c of stats.chapters) {
      lines.push(`- ${c.title}｜${c.chars} 字｜段均 ${c.paraAvgChars} 字｜对话 ${c.dialogueRatio}%｜章末 ${c.hook}`)
    }
  }
  return lines.join('\n')
}

/** 把统计指纹折叠进风格画像的「章节节奏 / 爽点节奏」维度（renderStyleBlock 只渲染七维标量）。 */
export function mergeStatsIntoStyle(style, stats) {
  const fingerprint =
    `实测指纹：单章 ${stats.minChapterChars}~${stats.maxChapterChars} 字（均值 ${stats.avgChapterChars}），` +
    `段均 ${stats.avgParaChars} 字，对话段占比约 ${stats.avgDialogueRatio}%。`
  const hookFacts = stats.hookDist.length === 0
    ? ''
    : `章末钩子分布：${stats.hookDist.map((h) => `${h.hook} ${h.pct}%`).join('、')}。`
  style.chapterRhythm = String(style.chapterRhythm ?? '').trim()
  style.chapterRhythm = style.chapterRhythm === '' ? fingerprint : style.chapterRhythm + ' ' + fingerprint
  style.beatRhythm = String(style.beatRhythm ?? '').trim()
  style.beatRhythm = hookFacts === '' ? style.beatRhythm : (style.beatRhythm === '' ? hookFacts : style.beatRhythm + ' ' + hookFacts)
  return style
}

/**
 * 结构拆书提示词：开篇样章 + 全书统计指纹 → 结构模版（注入大纲步）+ 剧情节拍表（人看）。
 * 骨架进 frontmatter 参与注入；节拍表进模版正文备注（renderTemplateBlock 只渲染 sections/constraints）。
 */
export function teardownStructurePrompts({ statsText, sample, bookName, genreLabel, status }) {
  const system =
    '你是长篇网文的结构分析师，专门拆解爆款书的写法骨架。你的任务是**只提取结构与节奏规律，不复制内容**。\n' +
    '你绝不复制样例里的原句、比喻、人名地名、专有名词、金句——那些是内容，不是结构。'
  // 连载书只拆已写部分：不许脑补结局——包装成「全书结构」的半成品是幻觉最危险的形态
  const ongoing = String(status ?? '').includes('连载')
  const statusBlock = ongoing
    ? '【重要】本书仍在连载，你只有已写部分。只拆已有章节的写法骨架：sections 覆盖已写阶段的推进规律，' +
      '最后一节必须标注「（截至当前，后续未知）」。严禁推测结局走向，严禁把已有骨架描述成「全书结构」。\n\n'
    : ''
  const user =
    `拆解爆款${genreLabel}《${bookName}》的写法，产出一份可复用的结构模版与一张剧情节拍表。\n\n` +
    statusBlock +
    `【全书节奏指纹（客观统计，优先于你的印象）】\n${statsText}\n\n` +
    `【开篇样章】\n${sample}\n\n` +
    '【输出格式，严格照此】\n' +
    '---\n' +
    'id: （英文小写短横线）\n' +
    'name: （中文模版名，形如「跟风·XX结构」）\n' +
    'genre: novel\n' +
    'sections:\n' +
    '  - 节名｜这一节要完成的动作（全书骨架：开局怎么起、中段怎么撑、高潮怎么排）\n' +
    'constraints:\n' +
    '  - 一条可判定的硬约束（优先采用上面指纹里的数字：单章字数区间、对话占比、钩子类型比例等）\n' +
    '---\n' +
    '\n' +
    '## 剧情节拍表\n' +
    '（frontmatter 之后输出：这本书的剧情是怎么推进的。表格：章节区间 | 剧情功能 | 爽点/反转类型 | 与读者的情绪契约。\n' +
    '只看节奏规律，不写具体剧情。）\n\n' +
    '【自查】sections 与节拍表里没有样例的原句与专有名词；constraints 每条都能机械判定。'
  return { system, user }
}

/**
 * 拆书卡片（Obsidian 拆书库索引卡，schema 见设计规范 §3.2）。
 * 三件套字段机器管；实战记录与胜率评级人管——重拆时若卡片已存在，由调用方决定保留人的字段。
 */
export function renderTeardownCard({ name, sourceRel, channel, type, stats, styleId, templateId, date, status, lastChapter, views }) {
  const hookTop = stats.hookDist.length === 0 ? '' : stats.hookDist[0].hook
  return [
    '---',
    'type: teardown-card',
    '来源书名: ' + name,
    '原文路径: ' + sourceRel,
    '频道: ' + (channel ?? ''),
    '类型: ' + (type ?? ''),
    '连载状态: ' + (status ?? ''),
    '拆书截止: ' + (lastChapter ?? ''),
    '入库阅读量: ' + (views ?? ''),
    '题材标签: []',
    '风格标签: []',
    '拆书日期: ' + date,
    '样本章数: ' + stats.chapterCount,
    'styleId: ' + styleId,
    'templateId: ' + templateId,
    '单章字数: ' + stats.minChapterChars + '~' + stats.maxChapterChars,
    '对话占比: ' + stats.avgDialogueRatio,
    '钩子主类型: ' + hookTop,
    '实战记录: []',
    '胜率评级: 未评级',
    '---',
    '',
    '## 节奏指纹（机器统计）',
    '',
    renderStatsText(stats),
    '',
    '> 题材标签 / 风格标签 / 实战记录 / 胜率评级由人工补充；重拆只更新指纹与三件套引用，不改人的字段。',
    '',
  ].join('\n')
}

/** 人填字段的白名单：重拆更新卡片时，这些字段以旧卡片为准（人的地盘机器不碰）。 */
const CARD_HUMAN_KEYS = ['题材标签', '风格标签', '实战记录', '胜率评级', '频道', '类型']

/** 取某个键在旧卡里的行与其后缩进的列表项，并判断是否有「人填的有效值」。 */
function humanEntry(lines, idx, key) {
  const line = lines[idx]
  const inline = line.slice(key.length + 1).trim()
  const list = []
  for (let j = idx + 1; j < lines.length; j++) {
    if (/^\s+-\s+/.test(lines[j])) list.push(lines[j])
    else break
  }
  const meaningful = list.length > 0 || (inline !== '' && inline !== '[]' && inline !== '未评级')
  return { line, list, meaningful }
}

/** 合并新旧卡片文本：机器字段用新卡，人填字段（白名单，含缩进列表项）从旧卡继承。 */
export function mergeCardHumanFields(newCard, oldCard) {
  const oldText = String(oldCard ?? '')
  if (oldText.trim() === '') return newCard
  const oldLines = oldText.split('\n')
  const lines = String(newCard).split('\n')
  for (const key of CARD_HUMAN_KEYS) {
    const oldIdx = oldLines.findIndex((l) => l.startsWith(key + ':'))
    const newIdx = lines.findIndex((l) => l.startsWith(key + ':'))
    if (oldIdx < 0 || newIdx < 0) continue
    const oldVal = humanEntry(oldLines, oldIdx, key)
    if (!oldVal.meaningful) continue
    let end = newIdx + 1
    while (end < lines.length && /^\s+-\s+/.test(lines[end])) end++
    lines.splice(newIdx, end - newIdx, oldVal.line, ...oldVal.list)
  }
  return lines.join('\n')
}
