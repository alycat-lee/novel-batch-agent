/**
 * vaultlib（Obsidian 库）解析层单元自检：不启动 dsh，只测 parsePromptNote / renderPromptNote。
 *
 * 约定：提示词笔记 = frontmatter(genre/step) + 正文里的 `## system` / `## user` 两段。
 * 写出去（renderPromptNote）和读回来（parsePromptNote）必须往返一致，否则「在 Obsidian 里改提示词」
 * 会读不到、或者读了半截 —— 这类错误不会在生成时报错，只会让用户以为改的没生效。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..')
const VL = await import('file://' + join(pkgDir, 'lib', 'core', 'vaultlib.js').replace(/\\/g, '/'))

const fails = []
const ok = (label, cond) => {
  console.log((cond === true ? '  ok   ' : '  FAIL ') + label)
  if (cond !== true) fails.push(label)
}

// 路径约定
ok('提示词笔记路径 = dsh-writer-m/提示词/<genre>-<step>.md', VL.promptNoteRel('novel', 'chapter') === 'dsh-writer-m/提示词/novel-chapter.md')
ok('风格画像笔记路径 = dsh-writer-m/风格画像/<id>.md', VL.styleNoteRel('fanqie-dushi-gaowu') === 'dsh-writer-m/风格画像/fanqie-dushi-gaowu.md')

// 往返
const note = VL.renderPromptNote({
  genreId: 'novel', stepId: 'chapter', label: '章节', stepNo: 6, goal: '按细纲写正文',
  system: '你是爽文作者。\n必须每章留钩子。', user: '【细纲】\n主角进门。',
})
ok('渲染出 frontmatter 的 genre/step', note.includes('genre: novel') && note.includes('step: chapter'))
ok('渲染出自解释说明', note.includes('dsh-writer-m 的提示词笔记'))
const parsed = VL.parsePromptNote(note)
ok('往返：解析成功', parsed !== null)
ok('往返：genreId/stepId 还原', parsed.genreId === 'novel' && parsed.stepId === 'chapter')
ok('往返：system 原样还原（含换行）', parsed.system === '你是爽文作者。\n必须每章留钩子。')
ok('往返：user 原样还原（含换行）', parsed.user === '【细纲】\n主角进门。')

// 容错
ok('没有 frontmatter 的笔记被忽略', VL.parsePromptNote('# 随便一篇笔记\n\n正文') === null)
ok('frontmatter 缺 step 被忽略', VL.parsePromptNote('---\ngenre: novel\n---\n\n## system\n\nx') === null)
ok('有 frontmatter 但没有 system/user 段被忽略', VL.parsePromptNote('---\ngenre: novel\nstep: chapter\n---\n\n正文') === null)
const onlyUser = VL.parsePromptNote('---\ngenre: wechat\nstep: body\n---\n\n## user\n\n只给 user')
ok('只有 user 段也算有效（另一段回落内置）', onlyUser !== null && onlyUser.system === '' && onlyUser.user === '只给 user')

// 大小写 / 空格
const loose = VL.parsePromptNote('---\n Genre : novel \n Step : chapter \n---\n\n## System\n\nA\n\n## USER\n\nB')
ok('frontmatter 键大小写不敏感、值去空格', loose !== null && loose.genreId === 'novel' && loose.user === 'B')
ok('## system 标记大小写不敏感', loose.system === 'A')
ok('标记后面可以带说明文字', VL.parsePromptNote('---\ngenre: novel\nstep: outline\n---\n\n## system（角色与约束）\n\nS') !== null)

// 读库
const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const vault = await mkdtemp(join(tmpdir(), 'dsht-vlib-'))
try {
  await mkdir(join(vault, VL.VAULT_LIB_DIR, VL.VAULT_LIB_PROMPTS), { recursive: true })
  await mkdir(join(vault, VL.VAULT_LIB_DIR, VL.VAULT_LIB_STYLES), { recursive: true })
  await writeFile(join(vault, 'dsh-writer-m', '提示词', 'novel-chapter.md'), note, 'utf8')
  await writeFile(join(vault, 'dsh-writer-m', '提示词', 'broken.md'), '---\ngenre: novel\nstep: outline\n---\n\n没有段落', 'utf8')
  await writeFile(join(vault, 'dsh-writer-m', '提示词', 'notes.txt'), '不是 md', 'utf8')
  await writeFile(join(vault, 'dsh-writer-m', '风格画像', 'vault-only-style.md'), [
    '---', 'id: vault-only-style', 'name: Vault 专属风格', 'genre: novel', 'tags:', '  - vault',
    'pov: 第一人称', 'rhythm: 短句', 'dialogue: 少', 'description: 冷', 'tone: 压抑',
    'chapterRhythm: 快', 'beatRhythm: 两章一爽点', '---', '', '备注',
  ].join('\n'), 'utf8')
  await writeFile(join(vault, 'dsh-writer-m', '风格画像', 'empty.md'), '', 'utf8')

  const lib = await VL.readPromptLibrary(vault)
  ok('读库：好的笔记进 notes', lib.notes['novel:chapter'] !== undefined && lib.notes['novel:chapter'].path === 'dsh-writer-m/提示词/novel-chapter.md')
  ok('读库：system/user 与写出去的一致', lib.notes['novel:chapter'].system === parsed.system && lib.notes['novel:chapter'].user === parsed.user)
  ok('读库：坏笔记进 errors', lib.errors.length === 1 && lib.errors[0].endsWith('broken.md'))
  const styles = await VL.readStyleLibrary(vault)
  ok('读风格库：解析出七维', styles.length === 1 && styles[0].id === 'vault-only-style' && styles[0].tone === '压抑' && styles[0].beatRhythm === '两章一爽点')
  ok('读风格库：source 标成 vault', styles[0].source === 'vault' && styles[0].path === 'dsh-writer-m/风格画像/vault-only-style.md')
  ok('读风格库：空文件被跳过', styles.every((s) => s.id !== 'empty'))

  const noVault = await VL.readPromptLibrary(join(vault, '不存在的目录'))
  ok('库目录不存在时返回空库而不是抛错', Object.keys(noVault.notes).length === 0 && noVault.errors.length === 0)
} finally {
  await rm(vault, { recursive: true, force: true })
}

console.log(fails.length === 0 ? 'vaultlib 单元校验全部通过。' : 'FAILED: ' + fails.join(' | '))
process.exit(fails.length === 0 ? 0 : 1)
