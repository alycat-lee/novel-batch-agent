/**
 * 批量写作命令行：跟工作台同一套 HTTP API 说话。
 *
 *   node scripts/batch-cli.mjs submit --file examples/books.json
 *   node scripts/batch-cli.mjs list
 *   node scripts/batch-cli.mjs status [id]
 *   node scripts/batch-cli.mjs pause <id>
 *   node scripts/batch-cli.mjs resume <id>
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const API = String(process.env.BATCH_URL ?? 'http://127.0.0.1:8787/dsh-writer-m/api/').replace(/\/?$/, '/')

async function api(path, body = {}) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  let data = {}
  try {
    data = await res.json()
  } catch {
    data = {}
  }
  if (!res.ok) {
    const msg = typeof data.error === 'string' && data.error !== '' ? data.error : 'HTTP ' + res.status
    throw new Error(msg)
  }
  return data
}

function printTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    console.log('(没有任务)')
    return
  }
  for (const t of tasks) {
    const step = t.currentStep === '' ? '-' : t.currentStep + (t.currentChapter > 0 ? '#' + t.currentChapter : '')
    const err = t.error === '' ? '' : '  err=' + t.error
    console.log(`${t.id}  ${t.status.padEnd(8)}  ${step.padEnd(22)}  ${t.bookName}${err}`)
  }
}

const argv = process.argv.slice(2)
const cmd = argv[0] ?? ''

try {
  if (cmd === 'submit') {
    const fileIdx = argv.indexOf('--file')
    if (fileIdx < 0 || argv[fileIdx + 1] === undefined) throw new Error('用法：submit --file books.json')
    const raw = JSON.parse(await readFile(resolve(argv[fileIdx + 1]), 'utf8'))
    const books = Array.isArray(raw) ? raw : Array.isArray(raw.books) ? raw.books : [raw]
    const data = await api('batch/create', { books })
    console.log('已提交 ' + data.count + ' 本')
    printTasks(data.tasks)
  } else if (cmd === 'list') {
    const data = await api('batch/list')
    printTasks(data.tasks)
  } else if (cmd === 'status') {
    const id = argv[1] ?? ''
    const data = await api('batch/status', id === '' ? {} : { id })
    if (data.task !== undefined) printTasks([data.task])
    else printTasks(data.tasks)
  } else if (cmd === 'pause' || cmd === 'resume' || cmd === 'cancel' || cmd === 'remove') {
    const id = argv[1]
    if (id === undefined || id === '') throw new Error('用法：' + cmd + ' <id>')
    const data = await api('batch/' + cmd, { id })
    if (data.task !== undefined) printTasks([data.task])
    else console.log(JSON.stringify(data))
  } else {
    console.log('用法：')
    console.log('  node scripts/batch-cli.mjs submit --file books.json')
    console.log('  node scripts/batch-cli.mjs list')
    console.log('  node scripts/batch-cli.mjs status [id]')
    console.log('  node scripts/batch-cli.mjs pause <id>')
    console.log('  node scripts/batch-cli.mjs resume <id>')
    process.exit(cmd === '' || cmd === '-h' || cmd === '--help' ? 0 : 1)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
