/**
 * 宿主半区的离线自检。
 *
 * 不启动 dsh、不装进 profile，直接 import 每个模块并用假 ctx 跑一遍：
 *   - 数据层：三种类型、步骤编号连续、每步都有 system/user、占位符都能渲染；
 *   - 模版层：内置模版都能被解析出骨架与约束；frontmatter 解析器对坏输入不抛；
 *   - 落盘层：路径越界必须被拒（这是硬约束，必须有实证）；产物读写与进度判定正确；
 *   - 提示词覆盖：改一步不影响另一步，reset 能回到内置默认。
 *
 * 这些是「装上去之前能证明的部分」，装上去之后剩下的不确定只有真机加载与模型调用。
 */
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 必须用 fileURLToPath 而不是 URL.pathname：本目录名里带空格，
// pathname 会保留 %20，于是每个拼出来的路径都不存在，
// 测试会以「内置模版读不到」这种看起来像功能缺陷的方式失败。
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)))

const { GENRES, genreById, stepById, renderPrompt, deaiChecklistText, NOVEL_CHANNELS, NOVEL_TYPES, NOVEL_TAGS } = await import(
  'file://' + join(pkgDir, 'lib/core/genres.js').replace(/\\/g, '/')
)
const TPL = await import('file://' + join(pkgDir, 'lib/core/templates.js').replace(/\\/g, '/'))
const STY = await import('file://' + join(pkgDir, 'lib/core/styles.js').replace(/\\/g, '/'))
const WS = await import('file://' + join(pkgDir, 'lib/core/workspace.js').replace(/\\/g, '/'))
const FSX = await import('file://' + join(pkgDir, 'lib/core/fsx.js').replace(/\\/g, '/'))
const VLT = await import('file://' + join(pkgDir, 'lib/core/vault.js').replace(/\\/g, '/'))

const fails = []
const ok = (label, cond) => {
  if (cond === true) console.log('  ok   ' + label)
  else {
    console.log('  FAIL ' + label)
    fails.push(label)
  }
}

console.log('== 数据层 ==')
ok('三种写作类型', GENRES.length === 3 && GENRES.map((g) => g.id).join(',') === 'novel,wechat,xiaohongshu')
for (const g of GENRES) {
  const nos = g.steps.map((s) => s.no)
  const seq = nos.every((n, i) => n === i + 1)
  ok(`${g.label}：${g.steps.length} 步，编号连续`, seq)
  ok(`${g.label}：每步都有 system/user/artifact`, g.steps.every((s) => s.system.length > 20 && s.user.length > 20 && s.artifact !== ''))
  ok(`${g.label}：最后一步是润色或去AI化`, ['polish', 'deai'].includes(g.steps[g.steps.length - 1].id))
}
const novel = genreById('novel')
ok('小说频道/类型/标签选项已导出', NOVEL_CHANNELS.length === 2 && NOVEL_CHANNELS[0].id === 'male' && NOVEL_TYPES.length > 0 && NOVEL_TAGS.includes('扮猪吃老虎'))
ok('小说步序 = 作品定位→大纲→人物→卷大纲→章节大纲→章节→润色',
  novel.steps.map((s) => s.id).join(',') === 'positioning,outline,characters,volume-outline,chapter-outline,chapter,polish')
ok('去AI化六维度清单可生成', deaiChecklistText().split('\n').length === 6)
const coNovelStep = stepById('novel', 'chapter-outline')
ok('章节大纲步：产物是目录并标记 produces', coNovelStep.artifact === 'chapter-outlines' && coNovelStep.produces === 'volume-outline')
ok('章节大纲提示词含 {{volume}} 占位符', coNovelStep.user.includes('{{volume}}'))
const voStep = stepById('novel', 'volume-outline')
ok('卷大纲提示词显式引用人物描述+大纲', voStep.user.includes('人物描述') && voStep.user.includes('大纲'))
ok('卷大纲提示词要求连贯性与完整性', voStep.user.includes('连贯性') && voStep.user.includes('完整性'))
ok('卷大纲提示词要求人物设定表(三部分)', voStep.user.includes('每章出场人物清单') && voStep.user.includes('人物小传') && voStep.user.includes('台词风格示例'))

console.log('== 占位符 ==')
const rendered = renderPrompt('A{{title}}B{{unknown}}C{{ words }}D', { title: 'X', words: '3000' })
ok('已知占位符被替换、未知渲染成空、允许空格', rendered === 'AXBC3000D')
for (const g of GENRES) {
  for (const s of g.steps) {
    const vars = { title: 't', genre: g.label, theme: 'th', audience: 'a', tone: 'to', words: '3000', channel: '男频', type: '玄幻', totalWords: '800000 字', tags: '扮猪吃老虎、逆袭', count: '3', volume: 'v', extra: 'e', template: 'tp', style: 'sty', vault: 'vlt', context: 'c' }
    const out = renderPrompt(s.system, vars) + renderPrompt(s.user, vars)
    if (/\{\{/.test(out)) {
      fails.push(`${g.id}:${s.id} 渲染后仍有未替换占位符`)
      console.log('  FAIL ' + g.id + ':' + s.id + ' 残留占位符')
    }
  }
}
ok('所有步骤的占位符全部可渲染', fails.filter((f) => f.includes('残留占位符')).length === 0)

console.log('== 模版层 ==')
const builtinDir = join(pkgDir, 'templates')
const meta = TPL.parseTemplate(
  ['---', 'id: t1', 'name: 测试模版', 'genre: wechat', 'sections:', '  - 第一节｜开场', '  - 第二节｜论证', 'constraints:', '  - 800 字', '---', '', '说明文字'].join('\n'),
  { id: 't1' },
)
ok('frontmatter 解析：id/name/genre', meta.id === 't1' && meta.name === '测试模版' && meta.genre === 'wechat')
ok('frontmatter 解析：sections 与 constraints 数组', meta.sections.length === 2 && meta.constraints.length === 1)
ok('坏输入不抛错', (() => { try { TPL.parseTemplate('没有 frontmatter 的纯文本', { id: 'x' }); return true } catch { return false } })())
ok('无 frontmatter 时整篇进 note', TPL.parseTemplate('纯文本', { id: 'x' }).note === '纯文本')

const tmp = await mkdtemp(join(tmpdir(), 'writer-m-'))
try {
  const list = await TPL.listTemplates({ builtinDir, root: tmp })
  ok('内置模版全部可读且各有骨架', list.length >= 4 && list.every((t) => t.sections.length > 0))
  ok('渲染模版块含骨架与硬约束', /骨架/.test(TPL.renderTemplateBlock(list[0])) && /硬约束/.test(TPL.renderTemplateBlock(list[0])))
  ok('没套模版时渲染成空串', TPL.renderTemplateBlock(null) === '')

  const saved = await TPL.saveTemplate({
    root: tmp,
    template: { id: 'my-tpl', name: '我的模版', genre: 'novel', sections: ['A｜甲', 'B｜乙'], constraints: ['1000 字'], note: '备注' },
    text: '备注',
  })
  const reload = await TPL.listTemplates({ builtinDir, root: tmp })
  const mine = reload.find((t) => t.id === 'my-tpl')
  ok('保存后能读回，且骨架完整', mine !== undefined && mine.sections.length === 2 && mine.constraints.length === 1)
  ok('保存路径在根目录内', saved.path.startsWith(tmp))
} finally {
  await rm(tmp, { recursive: true, force: true })
}

console.log('== 风格画像 ==')
const styleTmp = await mkdtemp(join(tmpdir(), 'writer-m-sty-'))
try {
  const styleText = [
    '---',
    'id: xianxia-qingsong',
    'name: 仙侠·轻松搞笑',
    'genre: novel',
    'tags:',
    '  - 轻松搞笑',
    '  - 扮猪吃老虎',
    'pov: 第三人称限知',
    'rhythm: 短句打点',
    'dialogue: 口语化',
    'description: 低密度',
    'tone: 轻松明快',
    'chapterRhythm: 开头钩子',
    'beatRhythm: 2-3章一爽点',
    '---',
    '',
    '说明文字',
  ].join('\n')
  const parsed = STY.parseStyle(styleText, { id: 'xianxia-qingsong' })
  ok('风格画像：七维度全部解析', STY.STYLE_DIMENSIONS.length === 7 && STY.STYLE_DIMENSIONS.every((d) => parsed[d.id] !== ''))
  ok('风格画像：tags 数组解析', parsed.tags.length === 2 && parsed.tags.includes('轻松搞笑'))
  ok('风格画像：id/name/genre 解析', parsed.id === 'xianxia-qingsong' && parsed.name === '仙侠·轻松搞笑' && parsed.genre === 'novel')
  ok('风格画像：坏输入不抛错', (() => { try { STY.parseStyle('纯文本无 frontmatter', { id: 'x' }); return true } catch { return false } })())

  const chapterBlock = STY.renderStyleBlock(parsed, 'chapter')
  ok('chapter 注入完整七维画像', STY.STYLE_DIMENSIONS.every((d) => chapterBlock.includes(d.label)))
  const polishBlock = STY.renderStyleBlock(parsed, 'polish')
  ok('polish 注入完整七维画像', STY.STYLE_DIMENSIONS.every((d) => polishBlock.includes(d.label)) && polishBlock.includes('润色须保持'))
  const planBlock = STY.renderStyleBlock(parsed, 'outline')
  // 2026-10-06 契约变更：规划步原先只给 tone+beatRhythm（大纲层看起来「画像没生效」），
  // 现改为七维齐全、并明确说明这一步只做规划；仍比正文块轻（无「严格遵循」指令语）。
  ok('规划步注入七维文风基调', planBlock.includes('文风基调') && STY.STYLE_DIMENSIONS.every((d) => planBlock.includes(d.label)))
  // 「轻」= 不带强制写作指令语（不再断言长度：规划块多一句「只做规划」的说明，反而略长）
  ok('规划步不带强制写作指令语', !planBlock.includes('严格遵循') && planBlock.includes('只做规划'))
  ok('没套风格渲染成空串', STY.renderStyleBlock(null, 'chapter') === '')

  const savedStyle = await STY.saveStyle({
    root: styleTmp,
    style: {
      id: 'my-style', name: '我的风格', genre: 'novel',
      tags: ['爽文'], pov: 'P', rhythm: 'R', dialogue: 'D', description: 'De', tone: 'T', chapterRhythm: 'C', beatRhythm: 'B', note: '备注',
    },
    text: '备注',
  })
  const reloadStyles = await STY.listStyles({ root: styleTmp })
  const mineStyle = reloadStyles.find((s) => s.id === 'my-style')
  ok('保存后能读回七维度', mineStyle !== undefined && mineStyle.pov === 'P' && mineStyle.beatRhythm === 'B' && mineStyle.tags.length === 1)
  ok('loadStyle 按 id 读回', (await STY.loadStyle({ root: styleTmp, id: 'my-style' }))?.name === '我的风格')
  ok('保存路径在根目录内', savedStyle.path.startsWith(styleTmp))
} finally {
  await rm(styleTmp, { recursive: true, force: true })
}

console.log('== 大文件采样 ==')
{
  const short = STY.sampleExcerpts('短文本', { chunkChars: 6000, maxChunks: 6 })
  ok('短文本只采 1 段且为全文', short.length === 1 && short[0].label === '全文' && short[0].text === '短文本')

  const long = '甲'.repeat(100000)
  const ex = STY.sampleExcerpts(long, { chunkChars: 6000, maxChunks: 6 })
  ok('长文本采样段数正确', ex.length === 6)
  ok('首段是开篇、末段是结尾', ex[0].label === '开篇' && ex[ex.length - 1].label === '结尾')
  ok('首段从开头开始、末段到结尾结束', ex[0].start === 0 && ex[ex.length - 1].start === 100000 - 6000)
  ok('每段长度不超过 chunkChars', ex.every((e) => e.text.length <= 6000))

  const small = '乙'.repeat(15000)
  const ex2 = STY.sampleExcerpts(small, { chunkChars: 6000, maxChunks: 6 })
  ok('小文件按比例减少段数', ex2.length >= 2 && ex2.length < 6)

  const p1 = STY.sampleStyleExcerptPrompts({ excerpt: '甲甲', label: '开篇', genreLabel: '小说' })
  ok('片段提示词含片段与维度', p1.user.includes('开篇') && p1.user.includes('pov') && p1.user.includes('甲甲') && p1.system.includes('风格'))
  const p2 = STY.mergeStylePrompts({ partials: [{ label: '开篇', text: 'pov: 一' }, { label: '结尾', text: 'tone: 二' }], genreLabel: '小说', extra: '' })
  ok('合并提示词含各片段与输出格式', p2.user.includes('开篇') && p2.user.includes('结尾') && p2.user.includes('id:') && p2.user.includes('tags:'))
}

console.log('== Obsidian 知识库 ==')
{
  const vaultTmp = await mkdtemp(join(tmpdir(), 'writer-m-vault-'))
  try {
    await mkdir(join(vaultTmp, '.obsidian'), { recursive: true })
    await mkdir(join(vaultTmp, '子目录'), { recursive: true })
    await mkdir(join(vaultTmp, '.hidden'), { recursive: true })
    await writeFile(join(vaultTmp, '笔记A.md'), '---\ntitle: 主角设定\ntags:\n  - 主角\n  - 金手指\n---\n\n主角是穿越者。\n')
    await writeFile(join(vaultTmp, '子目录', '笔记B.md'), '# 世界\n\n这是一片大陆。\n')
    await writeFile(join(vaultTmp, '.obsidian', 'config.md'), '忽略我\n')
    await writeFile(join(vaultTmp, '.hidden', 'h.md'), '隐藏目录\n')

    // 自动探测：把 APPDATA 指向临时目录放一个假 obsidian.json
    const fakeAppdata = await mkdtemp(join(tmpdir(), 'writer-m-appdata-'))
    const savedAppdata = process.env.APPDATA
    try {
      await mkdir(join(fakeAppdata, 'obsidian'), { recursive: true })
      await writeFile(join(fakeAppdata, 'obsidian', 'obsidian.json'), JSON.stringify({ vaults: [{ path: vaultTmp, open: true }] }))
      process.env.APPDATA = fakeAppdata
      ok('resolveVaultRoot 显式配置优先于探测', VLT.resolveVaultRoot(vaultTmp) === vaultTmp)
      ok('resolveVaultRoot 空配置自动探测到 open vault', VLT.resolveVaultRoot('') === vaultTmp)
      const listed = VLT.listVaults()
      ok('listVaults 列出注册 vault（数组形式）', Array.isArray(listed) && listed.length === 1 && listed[0].path === vaultTmp && listed[0].open === true && typeof listed[0].name === 'string' && listed[0].name !== '')
      await writeFile(join(fakeAppdata, 'obsidian', 'obsidian.json'), JSON.stringify({ vaults: { '69fb7a532addb216': { path: vaultTmp, open: true } } }))
      const listed2 = VLT.listVaults()
      ok('listVaults 列出注册 vault（对象形式，带 id）', Array.isArray(listed2) && listed2.length === 1 && listed2[0].id === '69fb7a532addb216' && listed2[0].path === vaultTmp)
    } finally {
      process.env.APPDATA = savedAppdata
      await rm(fakeAppdata, { recursive: true, force: true })
    }

    let threw = false
    try { VLT.guardVaultPath(vaultTmp, '../escape.md') } catch { threw = true }
    ok('guardVaultPath 越界被拒', threw === true)

    const notes = await VLT.listVaultNotes(vaultTmp)
    ok('listVaultNotes 列出 .md 且排除 .obsidian/隐藏目录', notes.length === 2 && notes.some((n) => n.path === '笔记A.md') && notes.some((n) => n.path === '子目录/笔记B.md'))

    const a = await VLT.readVaultNote(vaultTmp, '笔记A.md')
    ok('readVaultNote 解析 frontmatter 与正文', a.exists === true && a.title === '主角设定' && a.content.includes('主角是穿越者'))
    const bad = await VLT.readVaultNote(vaultTmp, '不存在.md')
    ok('readVaultNote 坏路径不抛且 exists=false', bad.exists === false)

    const found = await VLT.searchVaultNotes(vaultTmp, '穿越者')
    ok('searchVaultNotes 命中正文', found.length === 1 && found[0].path === '笔记A.md')

    const resolved = await VLT.resolveVaultNotes(vaultTmp, ['笔记A.md', '不存在.md'])
    ok('resolveVaultNotes 单条坏路径不阻断', resolved.length === 1 && resolved[0].path === '笔记A.md')

    const block = VLT.renderVaultBlock(resolved)
    ok('renderVaultBlock 含参考笔记头与标题', block.includes('【参考笔记') && block.includes('主角设定'))
    ok('renderVaultBlock 空列表返回空串', VLT.renderVaultBlock([]) === '')
    ok('renderVaultBlock 裁剪有上界', VLT.renderVaultBlock(resolved, 100).length <= 400)

    const mirrorPath = await VLT.writeVaultFile(vaultTmp, 'dsh-writer-m/作品/测试/chapters/第001章.md', '# 第一章\n\n正文内容。')
    ok('writeVaultFile 写进 vault 并返回绝对路径', typeof mirrorPath === 'string' && mirrorPath.startsWith(join(vaultTmp, 'dsh-writer-m')))
    const mirroredText = await readFile(join(vaultTmp, 'dsh-writer-m', '作品', '测试', 'chapters', '第001章.md'), 'utf8')
    ok('writeVaultFile 内容落盘且父目录自动创建', mirroredText.includes('正文内容'))
    let mirrorThrew = false
    try { await VLT.writeVaultFile(vaultTmp, '../escape.md', 'x') } catch { mirrorThrew = true }
    ok('writeVaultFile 越界被拒', mirrorThrew === true)

    // 删作品时清理镜像：removeVaultDir 要能删镜像目录，但绝不能碰 vault 根或越界路径
    await VLT.removeVaultDir(vaultTmp, 'dsh-writer-m/作品/测试')
    ok('removeVaultDir 删掉镜像目录',
      (await VLT.readVaultNote(vaultTmp, 'dsh-writer-m/作品/测试/chapters/第001章.md')).exists === false)
    let vaultRootThrew = false
    try { await VLT.removeVaultDir(vaultTmp, '') } catch { vaultRootThrew = true }
    ok('removeVaultDir 拒绝空相对路径（vault 根）', vaultRootThrew === true)
    let vaultEscapeThrew = false
    try { await VLT.removeVaultDir(vaultTmp, '../escape') } catch { vaultEscapeThrew = true }
    ok('removeVaultDir 越界被拒', vaultEscapeThrew === true)
    ok('两次拒绝后 vault 里的笔记仍在', (await readFile(join(vaultTmp, '笔记A.md'), 'utf8')).includes('主角是穿越者'))
  } finally {
    await rm(vaultTmp, { recursive: true, force: true })
  }
}

console.log('== 路径越界（硬约束） ==')
const base = 'C:\\works'
const cases = [
  [['a', 'b.txt'], true],
  [['..', 'b.txt'], false],
  [['a', '..', '..', 'b.txt'], false],
  [['C:\\Windows\\x.txt'], false],
  [['a', 'b', 'c.md'], true],
]
for (const [parts, shouldPass] of cases) {
  let threw = false
  try {
    FSX.resolveInside(base, ...parts)
  } catch {
    threw = true
  }
  ok(`resolveInside(${JSON.stringify(parts)}) ${shouldPass ? '应通过' : '应被拒'}`, threw === !shouldPass)
}
ok('slugify 去掉非法字符', FSX.slugify('a/b:c*d?e"f<g>h|i') === 'a-b-c-d-e-f-g-h-i')
ok('slugify 空串回落', FSX.slugify('   ') === 'untitled')
ok('slugify 会中和 .. 路径段', !FSX.slugify('..\\..\\evil').includes('..'))

console.log('== 落盘与进度 ==')
const root = await mkdtemp(join(tmpdir(), 'writer-m-ws-'))
try {
  const { id, meta: pm } = await WS.ensureProject(root, {
    name: '测试作品',
    genre: 'novel',
    theme: '悬疑',
    audience: '通勤读者',
    tone: '冷峻',
    templateId: 'novel-golden-three',
    styleId: 'xianxia-qingsong',
    words: 3500,
    channel: 'male',
    type: '历史',
    totalWords: 800000,
    tags: ['扮猪吃老虎', '逆袭'],
    count: 5,
  })
  ok('作品建立，words 被采纳', pm.words === 3500 && pm.genre === 'novel')
  ok('定位字段被采纳（频道/类型/总字数/标签/数量）', pm.channel === 'male' && pm.type === '历史' && pm.totalWords === 800000 && pm.tags.join(',') === '扮猪吃老虎,逆袭' && pm.count === 5)
  ok('风格画像 id 被采纳', pm.styleId === 'xianxia-qingsong')

  const again = await WS.ensureProject(root, { name: '测试作品', genre: 'novel', theme: '改了题材' })
  ok('同名再次建立不覆盖已有字段', again.meta.tone === '冷峻' && again.meta.theme === '改了题材')
  ok('定位字段在同名补全时不丢', again.meta.channel === 'male' && again.meta.type === '历史' && again.meta.count === 5 && again.meta.tags.length === 2 && again.meta.styleId === 'xianxia-qingsong')

  // 只换风格绑定：走 setProjectStyle，其它字段一个都不能动（不走 ensureProject 的默认值补齐）
  const restyled = await WS.setProjectStyle(root, id, 'fanqie-dushi-naodong')
  ok('setProjectStyle 只改 styleId', restyled.meta.styleId === 'fanqie-dushi-naodong')
  // 注意：theme 在上一条 ensureProject 用例里被改成「改了题材」，这里断言的是「保持现状」而不是原始值
  ok('setProjectStyle 不动其它元数据', restyled.meta.tone === '冷峻' && restyled.meta.theme === '改了题材' && restyled.meta.words === 3500 && restyled.meta.type === '历史' && restyled.meta.count === 5 && restyled.meta.tags.length === 2)
  const reread = await WS.readProject(root, id)
  ok('setProjectStyle 落盘后重读仍是新绑定', reread.meta.styleId === 'fanqie-dushi-naodong' && reread.meta.tone === '冷峻')
  const unbound = await WS.setProjectStyle(root, id, '')
  ok('setProjectStyle 传空串 = 解除绑定', unbound.meta.styleId === '')
  const missingStyle = await WS.setProjectStyle(root, '不存在的作品', 'fanqie-dushi-naodong')
  ok('setProjectStyle 对不存在的作品返回 null', missingStyle === null)

  const noCount = await WS.ensureProject(root, { name: '默认候选数量', genre: 'novel', words: 3000 })
  ok('候选数量缺省时默认 3 且频道默认男频', noCount.meta.count === 3 && noCount.meta.channel === 'male')
  await WS.removeProject(root, noCount.id)

  // 作品名留空自动命名 + renameProject 改目录与 meta.name
  const auto = await WS.ensureProject(root, { name: '', genre: 'novel', words: 3000 })
  ok('作品名留空时自动命名', auto.meta.name !== '' && auto.id !== '' && auto.meta.name.startsWith('未命名-'))
  const renamed = await WS.renameProject(root, auto.id, '长夜将明')
  ok('renameProject 改 meta.name 与目录', renamed.meta.name === '长夜将明' && renamed.id !== auto.id && renamed.renamed === true)
  ok('renameProject 后旧目录消失', (await WS.readProject(root, auto.id)) === null)
  ok('renameProject 后新目录可读', (await WS.readProject(root, renamed.id))?.meta.name === '长夜将明')
  await WS.removeProject(root, renamed.id)

  // 选用作品定位候选：改名 + 定位产物只保留所选候选（未选候选删除）
  const ad = await WS.ensureProject(root, { name: '定位候选', genre: 'novel', words: 3000 })
  await WS.writeArtifact(root, ad.id, 'steps/01-作品定位.md', '## 候选一\n- 书名：甲\n\n## 候选二\n- 书名：问剑\n\n## 候选三\n- 书名：丙\n')
  const adopted = await WS.adoptPositioning(root, ad.id, '问剑', '## 候选二\n- 书名：问剑')
  ok('adoptPositioning 改名', adopted.meta.name === '问剑' && adopted.id !== ad.id)
  const adText = await WS.readArtifact(adopted.dir, 'novel', 'positioning', null)
  ok('adoptPositioning 只保留所选候选', adText.includes('候选二') && adText.includes('问剑') && !adText.includes('候选一') && !adText.includes('候选三'))
  await WS.removeProject(root, adopted.id)

  // 自定义类型/标签沉淀进预设：非内置值进入 novel-options.json，内置值不重复
  const cu = await WS.ensureProject(root, { name: '自定预设', genre: 'novel', words: 3000, type: '克苏鲁', tags: ['无限流', '赛博朋克', '扮猪吃老虎'] })
  const cuOpts = await WS.readNovelOptions(root)
  ok('自定义类型沉淀进预设', cuOpts.types.includes('克苏鲁'))
  ok('自定义标签沉淀进预设', cuOpts.tags.includes('无限流') && cuOpts.tags.includes('赛博朋克'))
  ok('内置标签不沉淀为自定义', !cuOpts.tags.includes('扮猪吃老虎') && !cuOpts.tags.includes('逆袭'))
  const merged = await WS.mergedNovelOptions(root)
  ok('预设合并：内置在前且含自定义', merged.types[0] === '历史' && merged.types.includes('克苏鲁') && merged.tags[0] === '扮猪吃老虎' && merged.tags.includes('无限流'))
  const cu2 = await WS.ensureProject(root, { name: '自定预设二', genre: 'novel', words: 3000, type: '克苏鲁', tags: ['无限流'] })
  const cuOpts2 = await WS.readNovelOptions(root)
  ok('自定义预设去重', cuOpts2.types.filter((t) => t === '克苏鲁').length === 1 && cuOpts2.tags.filter((t) => t === '无限流').length === 1)
  await WS.removeProject(root, cu.id)
  await WS.removeProject(root, cu2.id)

  // 卷大纲上下文：大纲+人物描述应排到作品定位之前（字数上限下保住基础设定主线）
  const voProj = await WS.ensureProject(root, { name: '卷大纲上下文', genre: 'novel', words: 3000 })
  await WS.writeArtifact(root, voProj.id, 'steps/01-作品定位.md', 'POSITION_MARK')
  await WS.writeArtifact(root, voProj.id, 'steps/02-大纲.md', 'OUTLINE_MARK')
  await WS.writeArtifact(root, voProj.id, 'steps/03-人物.md', 'CHARACTER_MARK')
  const voCtx = await WS.buildContext(WS.projectDirOf(root, voProj.id), 'novel', 'volume-outline')
  ok('卷大纲上下文含大纲与人物描述', voCtx.includes('OUTLINE_MARK') && voCtx.includes('CHARACTER_MARK'))
  ok('卷大纲上下文把大纲+人物描述排在作品定位之前',
    voCtx.indexOf('OUTLINE_MARK') !== -1 && voCtx.indexOf('CHARACTER_MARK') !== -1 && voCtx.indexOf('POSITION_MARK') !== -1 &&
    voCtx.indexOf('OUTLINE_MARK') < voCtx.indexOf('POSITION_MARK') && voCtx.indexOf('CHARACTER_MARK') < voCtx.indexOf('POSITION_MARK'))
  await WS.removeProject(root, voProj.id)

  const found = await WS.readProject(root, id)
  let status = await WS.stepsStatus(found.dir, 'novel')
  ok('初始：7 步全部未完成', status.length === 7 && status.every((s) => s.done === false))

  await WS.writeArtifact(root, id, 'steps/01-作品定位.md', '# 《长夜将明》\n\n卖点……')
  status = await WS.stepsStatus(found.dir, 'novel')
  ok('写一步后只有那一步完成', status[0].done === true && status[1].done === false)
  ok('字数被统计', status[0].chars > 0)

  await WS.writeArtifact(root, id, 'chapters/第001章-开端.md', '正文内容')
  status = await WS.stepsStatus(found.dir, 'novel')
  const chapterStep = status.find((s) => s.id === 'chapter')
  ok('章节步按目录内文件数判定', chapterStep.done === true && chapterStep.chapters === 1)

  const ctx = await WS.buildContext(found.dir, 'novel', 'outline')
  ok('前序上下文只含已完成的更早步骤', /长夜将明/.test(ctx) && !/正文内容/.test(ctx))

  const ctxLate = await WS.buildContext(found.dir, 'novel', 'polish', { maxChars: 30 })
  ok('上下文有上界', ctxLate.length <= 400)

  // 障碍1：小说润色 buildContext 应取目标章节正文，而不是前序大纲
  const polishCtx = await WS.buildContext(found.dir, 'novel', 'polish', { chapter: '第001章-开端.md' })
  ok('小说润色上下文取目标章节正文', polishCtx.includes('正文内容') && !polishCtx.includes('长夜将明'))
  ok('未指定章节时回退最新一章', (await WS.buildContext(found.dir, 'novel', 'polish')).includes('正文内容'))
  ok('章节文件列表只含 .md', (await WS.listChapterFiles(found.dir)).length === 1)

  // 润色提示词 = 原润色内容 + 去AI化六维度清单（只做增量合并，deai 步已删除）
  const polishStep = novel.steps.find((s) => s.id === 'polish')
  ok('润色步 artifact=suffix=润色', polishStep.artifact === 'chapters' && polishStep.suffix === '润色')
  ok('润色提示词保留原润色范围(增量)', polishStep.user.includes('【润色范围（只做这些）】'))
  ok('润色提示词并入去AI化清单(增量)', polishStep.user.includes('【去AI化检查清单') && polishStep.user.includes(deaiChecklistText()))
  ok('小说已无 deai 步', novel.steps.every((s) => s.id !== 'deai'))
  ok('公众号已无 deai 步', genreById('wechat').steps.every((s) => s.id !== 'deai'))
  ok('小红书保留 deai 步(无润色)', genreById('xiaohongshu').steps.some((s) => s.id === 'deai'))

  ok('chapterVariantName 生成版本文件名', WS.chapterVariantName('第001章.md', '润色') === '第001章-润色.md' && WS.chapterVariantName('第001章.md', '') === '第001章.md')
  await WS.writeArtifact(root, id, 'chapters/第001章-开端-润色.md', '润色稿正文')
  ok('listChapterFiles 默认排除版本文件', (await WS.listChapterFiles(found.dir)).length === 1 && (await WS.listChapterFiles(found.dir))[0] === '第001章-开端.md')
  ok('listChapterFiles 按后缀只列润色稿', (await WS.listChapterFiles(found.dir, '润色')).length === 1 && (await WS.listChapterFiles(found.dir, '润色'))[0] === '第001章-开端-润色.md')
  status = await WS.stepsStatus(found.dir, 'novel')
  ok('润色步按版本文件判定完成', status.find((s) => s.id === 'polish').done === true && status.find((s) => s.id === 'polish').files.length === 1)

  // 按卷章节大纲：卷大纲按 ## 分块解析 + chapter-outlines 目录判定
  ok('未写卷大纲时 listVolumes 返回空', (await WS.listVolumes(found.dir)).length === 0)
  await WS.writeArtifact(root, id, 'steps/04-卷大纲.md', '## 第一卷 初入江湖\n- 本卷目标\n\n## 第二卷 风起云涌\n- 本卷目标')
  const vols = await WS.listVolumes(found.dir)
  ok('卷大纲按 ## 分块解析出两卷', vols.length === 2 && vols[0].key === '第1卷' && vols[1].key === '第2卷')
  ok('每卷都截出正文', vols[0].body.includes('本卷目标') && vols[1].body.includes('风起云涌'))
  ok('artifactPath 把章节大纲落进 chapter-outlines 目录', WS.artifactPath(coNovelStep, '第1卷.md').replace(/\\/g, '/').includes('chapter-outlines/第1卷.md'))

  await WS.writeArtifact(root, id, 'chapter-outlines/第1卷.md', '### 第 1 章 开端\n- 场景')
  status = await WS.stepsStatus(found.dir, 'novel')
  const coStatus = status.find((s) => s.id === 'chapter-outline')
  ok('章节大纲步按目录文件数判定', coStatus.done === true && coStatus.chapters === 1)

  // chapter-outlines 是目录产物，不进入章节步的 {{context}}
  const chapterCtx = await WS.buildContext(found.dir, 'novel', 'chapter')
  ok('章节步上下文不含章节大纲目录内容但含卷大纲', !chapterCtx.includes('场景') && chapterCtx.includes('初入江湖'))

  // ⑩：逐句核对 + 备份
  const surv = WS.sentenceSurvival('他缓缓走进了这间空房间。窗外下着灰蒙蒙的雨。', '他缓缓走进了这间空房间。雨已经停了。')
  ok('逐句核对：存活原句被识别', surv.kept === 1 && surv.total === 2)
  const bakPath = await WS.backupArtifact(found.dir, 'chapters/第001章-开端.md')
  ok('备份产物写入 .bak 且内容一致', (await FSX.readTextSafe(bakPath)) === '正文内容')

  await WS.writePromptOverride(root, 'novel:outline', { user: '自定义大纲提示词' })
  const ov = await WS.readPromptOverrides(root)
  ok('提示词覆盖按 类型:步骤 存储', ov['novel:outline'].user === '自定义大纲提示词' && ov['novel:positioning'] === undefined)
  await WS.writePromptOverride(root, 'novel:outline', null)
  const ov2 = await WS.readPromptOverrides(root)
  ok('reset 能删除覆盖', ov2['novel:outline'] === undefined)

  const read = await WS.readProjectFile(root, id, 'steps/01-作品定位.md')
  ok('读回产物内容一致', /长夜将明/.test(read.text) && read.exists === true)

  let blocked = false
  try {
    await WS.writeArtifact(root, id, '../../escape.md', 'x')
  } catch {
    blocked = true
  }
  ok('写越界路径被拒', blocked === true)

  const projects = await WS.listProjects(root)
  ok('作品列表含刚建的作品', projects.length === 1 && projects[0].id === id)

  await WS.removeProject(root, id)
  ok('删除作品后列表为空', (await WS.listProjects(root)).length === 0)

  // 小说单章目标字数强制必填：未填不留 3000 兜底，直接报错；其他类型仍回退默认值
  let novelRequiredThrew = false
  try {
    await WS.ensureProject(root, { name: '无字数小说', genre: 'novel', theme: '悬疑' })
  } catch {
    novelRequiredThrew = true
  }
  ok('小说未填单章字数被拒', novelRequiredThrew === true)
  const wx = await WS.ensureProject(root, { name: '公众号默认字数', genre: 'wechat', theme: '职场' })
  ok('公众号未填字数仍回退默认 1800', wx.meta.words === 1800)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('== 宿主入口（静态） ==')
const hostSrc = await readFile(join(pkgDir, 'lib/index.js'), 'utf8')
ok('导出 name = dsh-writer-m', /export const name = 'dsh-writer-m'/.test(hostSrc))
ok('导出 apply', /export async function apply\(ctx, rawConfig/.test(hostSrc))
ok('不 import @deepseek-ai/dsh-llm', !/from '@deepseek-ai\/dsh-llm'/.test(hostSrc))
ok('注册了全部 API 路由', ['state', 'config', 'project', 'detail', 'read', 'import', 'writeback', 'save', 'normalize', 'preview', 'prompt', 'run', 'fast', 'analyze', 'analyze-style', 'template', 'style', 'mkdir', 'rename', 'adopt', 'vault', 'autocreate', 'finalize', 'uploadCover', 'coverInfo', 'publish'].every((r) => hostSrc.includes(`route('${r}'`)))
ok('API 前缀正确', hostSrc.includes("/dsh-writer-m/api/"))

console.log('')
if (fails.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${fails.length} 项：`)
for (const f of fails) console.log('  - ' + f)
process.exit(1)
