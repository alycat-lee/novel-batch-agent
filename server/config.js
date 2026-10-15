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
  /** 多模型列表：[{ id, label, provider, baseURL, model, apiKey, maxTokens }]。空的 = 只用上面的单模型。 */
  models: [],
  /**
   * 分工指定：四个工种各自指向 models[].id，空串 = 用默认模型（上面的单模型配置）。
   *   planning  规划步（定位/大纲/人物/卷纲/章纲/书名/标签）
   *   drafting  章节正文（含快速通道）
   *   polishing 润色与去AI
   *   analysis  分析与拆书（风格蒸馏/结构拆解/笔记学习）
   */
  lanes: { planning: '', drafting: '', polishing: '', analysis: '' },
}

/** 多模型分工的四个工种（lib 与设置页共用这份名单，避免两边各写一份漂移）。 */
export const LANE_KEYS = ['planning', 'drafting', 'polishing', 'analysis']

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

/** 多模型列表 normalize：model 必填（没有 model 的条目直接丢），id 缺省从 model 派生，按 id 去重。 */
function normalizeModels(models) {
  if (Array.isArray(models) === false) return []
  const out = []
  const seen = new Set()
  for (const item of models) {
    if (item === null || typeof item !== 'object') continue
    const model = String(item.model ?? '').trim()
    if (model === '') continue
    let id = String(item.id ?? '').trim()
    const explicit = id !== ''
    if (explicit === false) {
      const base = model.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model'
      // 派生 id 撞名时自动加序号：两个条目同 model 不同端点很常见，静默丢第二条会让用户以为「存不上」
      id = base
      for (let n = 2; seen.has(id); n += 1) id = base + '-' + n
    } else if (seen.has(id)) {
      continue // 显式 id 重复：上层（config 路由）会报错，这里保底不覆盖先到的条目
    }
    seen.add(id)
    out.push({
      id,
      label: String(item.label ?? '').trim() || id,
      provider: String(item.provider ?? DEFAULTS.provider).trim() || DEFAULTS.provider,
      baseURL: String(item.baseURL ?? DEFAULTS.baseURL).trim() || DEFAULTS.baseURL,
      model,
      apiKey: String(item.apiKey ?? ''),
      maxTokens: Number.isInteger(item.maxTokens) && item.maxTokens > 0 ? item.maxTokens : DEFAULTS.maxTokens,
    })
  }
  return out
}

/** 分工表 normalize：只认四个工种，值是 models[].id 或空串（= 默认模型）。 */
function normalizeLanes(lanes) {
  const src = lanes !== null && typeof lanes === 'object' ? lanes : {}
  const out = {}
  for (const key of LANE_KEYS) out[key] = String(src[key] ?? '').trim()
  return out
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
    models: normalizeModels(src.models),
    lanes: normalizeLanes(src.lanes),
  }
  for (const key of ['publishPython', 'publishScript', 'publishProfile', 'publishBookName', 'publishLoginScript']) {
    merged[key] = String(src[key] ?? DEFAULTS[key] ?? '').trim()
  }
  // hasApiKey / apiKeySource 只给前端 state 用，不落盘
  delete merged.hasApiKey
  delete merged.apiKeySource
  return merged
}

/** 单个密钥字段的公开视图：不回明文，只回「有没有、从哪来」。 */
function keyView(raw0) {
  const raw = String(raw0 ?? '').trim()
  const resolved = resolveEnvRef(raw).trim()
  return {
    hasApiKey: resolved !== '',
    apiKeySource: raw === '' ? 'none' : (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(raw) ? 'env' : 'literal'),
  }
}

/** 传给 apply() 的配置：去掉密钥明文（含多模型列表里每个条目），避免 /api/state 泄露。 */
export function publicConfig(cfg) {
  const out = { ...cfg, ...keyView(cfg.apiKey) }
  delete out.apiKey
  out.models = (Array.isArray(cfg.models) ? cfg.models : []).map((m) => {
    const view = { ...m, ...keyView(m?.apiKey) }
    delete view.apiKey
    return view
  })
  out.lanes = { ...(cfg.lanes ?? {}) }
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
      const merged = { ...current, ...(typeof fn === 'function' ? fn({ ...current }) : {}) }
      const next = normalize(merged)
      // 多模型列表的密钥沿用：前端只持有「是否已配置」，保存时密钥留空 = 沿用旧密钥。
      // 在 normalize 之后做（这时派生 id 已就位）；先按 id 匹配，id 变了再按 model+baseURL 匹配——
      // 否则「改个备注 / 改派生 id」就会把已配置的密钥冲掉
      if (Array.isArray(next.models) && next.models.length > 0) {
        const olds = Array.isArray(current.models) ? current.models : []
        const oldById = new Map(olds.map((m) => [m?.id, m]))
        next.models = next.models.map((m) => {
          if (String(m.apiKey ?? '').trim() !== '') return m
          const old = oldById.get(m.id)
            ?? olds.find((o) => o?.model === m.model && String(o?.baseURL ?? '') === m.baseURL)
          return old === undefined || old === null ? m : { ...m, apiKey: String(old.apiKey ?? '') }
        })
      }
      current = await saveConfig(next)
      if (typeof onChange === 'function') onChange(current)
      return current
    },
    snapshot() {
      return { ...current }
    },
  }
}
