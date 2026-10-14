/**
 * 独立宿主配置：落盘到数据根目录下的 .agent-config.json。
 *
 * 与 dsh 的 configEditor 对齐：edit(entry, fn) 直接写盘，
 * 这样 lib/index.js 的 saveConfig 会走 persisted:true 路径。
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const NS = 'dsh-writer-m'
const CONFIG_FILE = '.agent-config.json'

export const DEFAULTS = {
  root: join(homedir(), 'Documents', 'novel-batch-agent'),
  enabled: true,
  provider: 'deepseek',
  model: 'deepseek-chat',
  apiKey: '${DEEPSEEK_API_KEY}',
  baseURL: 'https://api.deepseek.com',
  maxTokens: 3000,
  vaultPath: '',
  vaultSourceDir: 'dsh-writer-m/爆款原文',
  vaultAssetsDir: 'dsh-writer-m/拆书资产',
  vaultWorksDir: 'dsh-writer-m/作品',
  publishPython: '',
  publishScript: '',
  publishProfile: '',
  publishBookName: '',
  publishLoginScript: '',
  batch: {
    concurrency: 1,
    retry: 3,
    retryDelayMs: 5000,
  },
}

/** 解析 apiKey 里的 ${ENV_VAR} 引用；解析不到时回空串，由调用方报人话。 */
export function resolveEnvRef(value) {
  const raw = String(value ?? '')
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = process.env[name]
    return typeof v === 'string' ? v : ''
  })
}

function defaultRoot() {
  const env = String(process.env.WRITER_ROOT ?? '').trim()
  return env === '' ? DEFAULTS.root : env
}

function configPathOf(root) {
  return join(root, CONFIG_FILE)
}

function normalizeBatch(batch) {
  const src = batch !== null && typeof batch === 'object' ? batch : {}
  const concurrency = Number.isInteger(src.concurrency) && src.concurrency > 0 ? src.concurrency : DEFAULTS.batch.concurrency
  const retry = Number.isInteger(src.retry) && src.retry >= 0 ? src.retry : DEFAULTS.batch.retry
  const retryDelayMs = Number.isInteger(src.retryDelayMs) && src.retryDelayMs >= 0 ? src.retryDelayMs : DEFAULTS.batch.retryDelayMs
  return { concurrency, retry, retryDelayMs }
}

export function normalize(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const rootRaw = String(src.root ?? '').trim()
  const merged = {
    ...DEFAULTS,
    ...src,
    root: rootRaw === '' ? defaultRoot() : rootRaw,
    enabled: src.enabled === false ? false : true,
    provider: String(src.provider ?? DEFAULTS.provider).trim(),
    model: String(src.model ?? DEFAULTS.model).trim(),
    apiKey: String(src.apiKey ?? DEFAULTS.apiKey),
    baseURL: String(src.baseURL ?? DEFAULTS.baseURL).trim() || DEFAULTS.baseURL,
    maxTokens: Number.isInteger(src.maxTokens) && src.maxTokens > 0 ? src.maxTokens : DEFAULTS.maxTokens,
    vaultPath: String(src.vaultPath ?? '').trim(),
    vaultSourceDir: String(src.vaultSourceDir ?? DEFAULTS.vaultSourceDir).trim() || DEFAULTS.vaultSourceDir,
    vaultAssetsDir: String(src.vaultAssetsDir ?? DEFAULTS.vaultAssetsDir).trim() || DEFAULTS.vaultAssetsDir,
    vaultWorksDir: String(src.vaultWorksDir ?? DEFAULTS.vaultWorksDir).trim() || DEFAULTS.vaultWorksDir,
    batch: normalizeBatch(src.batch),
  }
  for (const key of ['publishPython', 'publishScript', 'publishProfile', 'publishBookName', 'publishLoginScript']) {
    merged[key] = String(src[key] ?? DEFAULTS[key] ?? '').trim()
  }
  // hasApiKey / apiKeySource 只给前端 state 用，不落盘
  delete merged.hasApiKey
  delete merged.apiKeySource
  return merged
}

/** 传给 apply() 的配置：去掉密钥明文，只回 hasApiKey / apiKeySource，避免 /api/state 泄露。 */
export function publicConfig(cfg) {
  const out = { ...cfg }
  const raw = String(cfg.apiKey ?? '').trim()
  const resolved = resolveEnvRef(raw).trim()
  delete out.apiKey
  out.hasApiKey = resolved !== ''
  out.apiKeySource = raw === '' ? 'none' : (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(raw) ? 'env' : 'literal')
  return out
}

async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp-' + process.pid
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

export async function loadConfig() {
  const root = defaultRoot()
  await mkdir(root, { recursive: true })
  const path = configPathOf(root)
  let disk = {}
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf8')
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      disk = JSON.parse(text)
    } catch {
      disk = {}
    }
  }
  let cfg = normalize({ ...disk, root: String(disk.root ?? '').trim() === '' ? root : disk.root })
  // 配置里的 root 若与启动探测不一致，以文件为准再读一次（极少见）
  if (cfg.root !== root && existsSync(configPathOf(cfg.root))) {
    try {
      const raw = await readFile(configPathOf(cfg.root), 'utf8')
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      disk = JSON.parse(text)
      cfg = normalize({ ...disk, root: cfg.root })
    } catch {
      /* 用已经 normalize 的那份 */
    }
  }
  await saveConfig(cfg)
  return cfg
}

export async function saveConfig(cfg) {
  const next = normalize(cfg)
  await mkdir(next.root, { recursive: true })
  const body = JSON.stringify(next, null, 2) + '\n'
  await atomicWrite(configPathOf(next.root), body)
  return next
}

/**
 * 与 dsh configEditor 等价：entries() 找出本插件行，edit(entry, fn) 把 fn 的返回值写盘。
 * 内存态通过 onChange 回推，让 apply 闭包里的 config 与磁盘一致。
 */
export function createConfigEditor(initial, onChange) {
  let current = normalize(initial)
  return {
    entries() {
      return [{ id: NS, name: NS, options: { name: NS } }]
    },
    async edit(entry, fn) {
      const id = String(entry?.id ?? '')
      const nm = typeof entry?.name === 'string' ? entry.name : ''
      if (id !== NS && nm !== NS && !id.endsWith(':' + NS) && !id.endsWith('/' + NS)) {
        throw new Error('未知配置行：' + id)
      }
      const next = normalize({ ...current, ...(typeof fn === 'function' ? fn({ ...current }) : {}) })
      current = await saveConfig(next)
      if (typeof onChange === 'function') onChange(current)
      return current
    },
    snapshot() {
      return { ...current }
    },
  }
}
