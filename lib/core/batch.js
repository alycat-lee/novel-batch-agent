/**
 * novel-batch-agent — 批量写作任务与队列
 *
 * 任务落盘 <root>/.batch/<id>.json；执行器由宿主注入 runStep（与单本工作台共用）。
 * 「有文件才算做过」：每步执行前看磁盘，已存在且非空则跳过。
 *
 * 原插件版权：alycat-lee/dsh-writer-m（MIT）
 */
import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonSafe, writeJson, resolveInside, slugify, readTextSafe, statSafe } from './fsx.js'
import { stepById } from './genres.js'
import * as WS from './workspace.js'

export const BATCH_DIR = '.batch'
export const STATUSES = ['queued', 'running', 'done', 'failed', 'paused']

export function batchDirOf(root) {
  return resolveInside(root, BATCH_DIR)
}

export function taskPathOf(root, id) {
  return resolveInside(root, BATCH_DIR, String(id) + '.json')
}

function nowIso() {
  return new Date().toISOString()
}

export function normalizeTask(raw, fallback = {}) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const status = STATUSES.includes(src.status) ? src.status : 'queued'
  const channel = src.channel === 'female' ? 'female' : 'male'
  const targetChapters = Number.isFinite(Number(src.targetChapters)) && Number(src.targetChapters) > 0
    ? Math.min(200, Math.max(1, Math.round(Number(src.targetChapters))))
    : 3
  const chapterChars = Number.isFinite(Number(src.chapterChars)) && Number(src.chapterChars) > 0
    ? Math.round(Number(src.chapterChars))
    : 800
  return {
    id: String(src.id ?? fallback.id ?? ''),
    bookName: String(src.bookName ?? fallback.bookName ?? '').trim(),
    genre: 'novel',
    channel,
    idea: String(src.idea ?? '').trim(),
    targetChapters,
    chapterChars,
    styleId: String(src.styleId ?? '').trim(),
    templateId: String(src.templateId ?? '').trim(),
    status,
    currentStep: String(src.currentStep ?? ''),
    currentChapter: Number.isFinite(Number(src.currentChapter)) ? Math.max(0, Math.round(Number(src.currentChapter))) : 0,
    error: String(src.error ?? ''),
    createdAt: String(src.createdAt ?? nowIso()),
    updatedAt: String(src.updatedAt ?? nowIso()),
    projectId: String(src.projectId ?? ''),
  }
}

export async function saveTask(root, task) {
  const next = normalizeTask({ ...task, updatedAt: nowIso() })
  if (next.id === '') throw new Error('任务缺少 id')
  await writeJson(taskPathOf(root, next.id), next)
  return next
}

export async function loadTask(root, id) {
  const data = await readJsonSafe(taskPathOf(root, id), null)
  return data === null ? null : normalizeTask(data, { id })
}

export async function listTasks(root) {
  let names = []
  try {
    names = (await readdir(batchDirOf(root))).filter((n) => n.endsWith('.json'))
  } catch {
    names = []
  }
  const out = []
  for (const name of names) {
    const id = name.replace(/\.json$/i, '')
    const t = await loadTask(root, id)
    if (t !== null) out.push(t)
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return out
}

export async function removeTask(root, id) {
  try {
    await rm(taskPathOf(root, id), { force: true })
    return true
  } catch {
    return false
  }
}

/** 进程重启：把残留的 running 收成 queued，下次泵会接着跑。 */
export async function recoverRunning(root) {
  const all = await listTasks(root)
  const recovered = []
  for (const t of all) {
    if (t.status !== 'running') continue
    recovered.push(await saveTask(root, { ...t, status: 'queued', error: '' }))
  }
  return recovered
}

export function newTaskId() {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

export function taskFromInput(input) {
  const bookName = String(input?.bookName ?? input?.name ?? '').trim()
  if (bookName === '') throw new Error('缺少 bookName')
  return normalizeTask({
    id: newTaskId(),
    bookName,
    genre: 'novel',
    channel: input?.channel,
    idea: input?.idea ?? input?.theme ?? '',
    targetChapters: input?.targetChapters,
    chapterChars: input?.chapterChars ?? input?.words,
    styleId: input?.styleId,
    templateId: input?.templateId,
    status: 'queued',
    currentStep: '',
    currentChapter: 0,
    error: '',
    createdAt: nowIso(),
    projectId: slugify(bookName, 'untitled'),
  })
}

/** 非空文件才算做过。 */
async function fileNonEmpty(abs) {
  const st = await statSafe(abs)
  if (st === null || !st.isFile()) return false
  const text = await readTextSafe(abs)
  return String(text).trim() !== ''
}

export async function chapterFileExists(dir, no) {
  const stem = '第' + String(no).padStart(3, '0') + '章'
  const files = await WS.listChapterFiles(dir, '')
  return files.some((f) => {
    const s = String(f).replace(/\.md$/i, '')
    return s === stem || s.startsWith(stem + '-')
  })
}

export async function polishFileExists(dir, no) {
  const stem = '第' + String(no).padStart(3, '0') + '章'
  const files = await WS.listChapterFiles(dir, '润色')
  return files.some((f) => String(f).replace(/\.md$/i, '').startsWith(stem + '-润色') || String(f).replace(/\.md$/i, '') === stem + '-润色')
}

export async function stepArtifactDone(dir, stepId) {
  const step = stepById('novel', stepId)
  if (step === null) return false
  if (step.artifact === 'chapters') {
    const files = await WS.listChapterFiles(dir, step.suffix ?? '')
    return files.length > 0
  }
  if (step.artifact === 'chapter-outlines') {
    const status = await WS.stepsStatus(dir, 'novel')
    const hit = status.find((s) => s.id === 'chapter-outline')
    return hit !== undefined && hit.done === true
  }
  return await fileNonEmpty(join(dir, step.artifact))
}

/** 从章节大纲文本里抠「### 第 N 章 章名」块。 */
export function parseOutlineBlocks(text) {
  const blocks = []
  const re = /^###[ \t]+(.+)$/gm
  const starts = []
  let m
  while ((m = re.exec(String(text ?? ''))) !== null) starts.push({ title: m[1].trim(), at: m.index })
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1].at : text.length
    blocks.push({ title: starts[i].title, body: String(text).slice(starts[i].at, end).trim() })
  }
  return blocks
}

export function chapterNoFromTitle(title) {
  const m = /第\s*0*(\d{1,3})\s*章/.exec(String(title ?? ''))
  return m === null ? null : Number(m[1])
}

async function readAllOutlines(dir) {
  const vols = await WS.listVolumes(dir)
  const files = []
  if (vols.length === 0) files.push('第1卷.md')
  else for (const v of vols) files.push(v.key + '.md')
  const blocks = []
  for (const name of files) {
    const text = await readTextSafe(join(dir, 'chapter-outlines', name))
    if (String(text).trim() === '') continue
    for (const b of parseOutlineBlocks(text)) blocks.push(b)
  }
  // 也扫目录里其它细纲
  try {
    const names = (await readdir(join(dir, 'chapter-outlines'))).filter((n) => n.toLowerCase().endsWith('.md'))
    for (const name of names) {
      if (files.includes(name)) continue
      const text = await readTextSafe(join(dir, 'chapter-outlines', name))
      for (const b of parseOutlineBlocks(text)) blocks.push(b)
    }
  } catch {
    /* 目录还不存在 */
  }
  return blocks
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) {
        clearTimeout(t)
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function isAbort(error) {
  return error !== null && typeof error === 'object' && (error.name === 'AbortError' || /aborted/i.test(String(error.message ?? '')))
}

/**
 * 跑完一本小说的 7 步链。runStep 必须是宿主抽出来的那份（禁止第二份生成逻辑）。
 */
export async function executeBook(task, deps) {
  const {
    root,
    runStep,
    signal,
    onProgress,
    retry = 3,
    retryDelayMs = 5000,
  } = deps
  const project = await WS.ensureProject(root, {
    name: task.bookName,
    genre: 'novel',
    channel: task.channel,
    theme: task.idea,
    words: task.chapterChars,
    styleId: task.styleId,
    templateId: task.templateId,
  })
  const id = project.id
  const found = await WS.readProject(root, id)
  if (found === null) throw new Error('作品创建失败：' + id)
  const dir = found.dir

  const persist = async (patch) => {
    const latest = await loadTask(root, task.id)
    if (latest !== null && (latest.status === 'paused' || (latest.status === 'failed' && latest.error === '已取消'))) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    const next = await saveTask(root, { ...(latest ?? task), ...patch, projectId: id })
    Object.assign(task, next)
    if (typeof onProgress === 'function') onProgress(next)
    return next
  }

  const writeOut = async (rel, text) => {
    await WS.writeArtifact(root, id, rel, text)
  }

  const runOnce = async (body) => {
    return await runStep(body, null, { signal })
  }

  const withRetry = async (label, fn) => {
    let last = null
    const max = Math.max(0, retry)
    for (let attempt = 0; attempt <= max; attempt += 1) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      try {
        return await fn()
      } catch (error) {
        last = error
        if (isAbort(error)) throw error
        if (attempt >= max) break
        const delay = retryDelayMs * Math.pow(2, attempt)
        await sleep(delay, signal)
      }
    }
    throw new Error(label + ' 失败（已重试 ' + max + ' 次）：' + (last instanceof Error ? last.message : String(last)))
  }

  const baseBody = {
    id,
    genre: 'novel',
    templateId: task.templateId,
    styleId: task.styleId,
  }

  // 1-4：定位 / 大纲 / 人物 / 卷大纲
  const early = [
    { step: 'positioning', extra: task.idea === '' ? '' : '创作想法：' + task.idea, count: 3 },
    { step: 'outline', extra: '' },
    { step: 'characters', extra: '' },
    { step: 'volume-outline', extra: `只出一卷。预计章数必须写「预计章数：${task.targetChapters} 章」。` },
  ]
  for (const item of early) {
    await persist({ currentStep: item.step, currentChapter: 0, status: 'running' })
    if (await stepArtifactDone(dir, item.step)) continue
    const data = await withRetry(item.step, () => runOnce({ ...baseBody, step: item.step, extra: item.extra, ...(item.count ? { count: item.count } : {}) }))
    const step = stepById('novel', item.step)
    await writeOut(step.artifact, data.text)
  }

  // 5：章节大纲（按卷；已有细纲则跳过）
  await persist({ currentStep: 'chapter-outline', currentChapter: 0, status: 'running' })
  const volumes = await WS.listVolumes(dir)
  const volList = volumes.length > 0 ? volumes : [{ key: '第1卷', title: '第1卷', body: '' }]
  for (const vol of volList) {
    const rel = 'chapter-outlines/' + vol.key + '.md'
    const existed = await fileNonEmpty(join(dir, rel))
    if (existed) continue
    const data = await withRetry('chapter-outline:' + vol.key, () => runOnce({
      ...baseBody,
      step: 'chapter-outline',
      volume: vol.key,
      extra: `本卷预计章数：${task.targetChapters} 章，必须从第 1 章写到第 ${task.targetChapters} 章。`,
    }))
    const volKey = typeof data.volume === 'string' && data.volume !== '' ? data.volume : vol.key
    await writeOut('chapter-outlines/' + volKey + '.md', data.text)
  }

  // 6：章节循环至 targetChapters
  const outlines = await readAllOutlines(dir)
  for (let no = 1; no <= task.targetChapters; no += 1) {
    await persist({ currentStep: 'chapter', currentChapter: no, status: 'running' })
    if (await chapterFileExists(dir, no)) continue
    const block = outlines.find((b) => chapterNoFromTitle(b.title) === no) ?? outlines[no - 1] ?? null
    const data = await withRetry('chapter:' + no, () => runOnce({
      ...baseBody,
      step: 'chapter',
      extra: block === null ? `第 ${no} 章` : block.body,
      chapterNo: no,
      chapterTitle: block === null ? `第 ${no} 章` : block.title,
    }))
    const stem = '第' + String(no).padStart(3, '0') + '章'
    await writeOut('chapters/' + stem + '.md', data.text)
  }

  // 7：润色已落盘的 1..targetChapters
  const chapterFiles = await WS.listChapterFiles(dir, '')
  for (let no = 1; no <= task.targetChapters; no += 1) {
    await persist({ currentStep: 'polish', currentChapter: no, status: 'running' })
    if (await polishFileExists(dir, no)) continue
    const stem = '第' + String(no).padStart(3, '0') + '章'
    const file = chapterFiles.find((f) => {
      const s = String(f).replace(/\.md$/i, '')
      return s === stem || s.startsWith(stem + '-')
    }) ?? (stem + '.md')
    const data = await withRetry('polish:' + no, () => runOnce({
      ...baseBody,
      step: 'polish',
      chapter: file,
    }))
    const fileStem = String(file).replace(/\.md$/i, '')
    await writeOut('chapters/' + fileStem + '-润色.md', data.text)
  }

  await persist({ currentStep: 'polish', currentChapter: task.targetChapters, status: 'done', error: '' })
  return task
}

/**
 * 队列泵：并发受 batch.concurrency 限制；单步失败指数退避，耗尽标 failed 继续下一本。
 */
export function createEngine({ getRoot, getBatchCfg, runStep }) {
  const inflight = new Map()
  let pumping = false
  let stopped = false

  const cfgOf = () => {
    const b = typeof getBatchCfg === 'function' ? getBatchCfg() : {}
    return {
      concurrency: Number.isInteger(b?.concurrency) && b.concurrency > 0 ? b.concurrency : 1,
      retry: Number.isInteger(b?.retry) && b.retry >= 0 ? b.retry : 3,
      retryDelayMs: Number.isInteger(b?.retryDelayMs) && b.retryDelayMs >= 0 ? b.retryDelayMs : 5000,
    }
  }

  const pump = async () => {
    if (stopped || pumping) return
    pumping = true
    try {
      while (!stopped) {
        const root = getRoot()
        const { concurrency, retry, retryDelayMs } = cfgOf()
        const tasks = await listTasks(root)
        const queued = tasks.filter((t) => t.status === 'queued')
        while (inflight.size < concurrency && queued.length > 0) {
          const task = queued.shift()
          const claimed = await saveTask(root, { ...task, status: 'running', error: '' })
          const ac = new AbortController()
          inflight.set(claimed.id, ac)
          void (async () => {
            try {
              await executeBook({ ...claimed, status: 'running' }, {
                root,
                runStep,
                signal: ac.signal,
                retry,
                retryDelayMs,
              })
            } catch (error) {
              const latest = (await loadTask(root, task.id)) ?? task
              if (latest.status === 'paused') return
              if (isAbort(error)) {
                if (latest.status !== 'paused' && latest.status !== 'failed') {
                  await saveTask(root, { ...latest, status: 'paused', error: '已暂停' })
                }
                return
              }
              await saveTask(root, { ...latest, status: 'failed', error: error instanceof Error ? error.message : String(error) })
            } finally {
              inflight.delete(task.id)
              if (!stopped) void pump()
            }
          })()
        }
        break
      }
    } finally {
      pumping = false
    }
  }

  return {
    async start() {
      stopped = false
      const root = getRoot()
      await recoverRunning(root)
      await pump()
    },
    stop() {
      stopped = true
      for (const ac of inflight.values()) {
        try { ac.abort() } catch { /* 忽略 */ }
      }
    },
    kick() {
      if (!stopped) void pump()
    },
    abort(id) {
      const ac = inflight.get(id)
      if (ac !== undefined) ac.abort()
    },
    isRunning(id) {
      return inflight.has(id)
    },
  }
}
