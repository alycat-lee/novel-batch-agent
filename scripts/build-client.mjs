/**
 * 把 src-client/ 下的片段按文件名序号拼成 lib/client.js。
 *
 * 为什么要拼而不是直接写一个大文件：客户端半区没有构建器（仓内那份 tsdown preset
 * 不随包发布），但产物契约又要求它是一个 lazy-CJS factory。用「片段 + 拼接」
 * 既能保持可读的分文件编辑，又能产出严格符合契约的单文件。
 *
 * 拼接是纯文本连接 + 序号排序，没有任何转换，所以不存在「改片段忘了重建」
 * 之外的构建风险；scripts/check-client.mjs 会做语法与契约自检。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = dirname(here)
const srcDir = join(pkgDir, 'src-client')
const outFile = join(pkgDir, 'lib', 'client.js')

const files = (await readdir(srcDir)).filter((f) => f.endsWith('.js')).sort()
if (files.length === 0) throw new Error('src-client/ 下没有片段文件')

const parts = []
for (const f of files) {
  const text = await readFile(join(srcDir, f), 'utf8')
  if (/\n\s*\n\s*\n/.test(text)) {
    // 片段里连续空行通常来自复制粘贴，产物不必保留三连空行
  }
  parts.push(text.replace(/\s*$/, ''))
}

const out = parts.join('\n') + '\n'
await writeFile(outFile, out, 'utf8')
console.log(`built ${outFile} from ${files.length} fragment(s): ${files.join(', ')} (${out.length} bytes)`)
