/**
 * 独立宿主的 llm 适配器：对外契约与 dsh 的 ctx.get('llm') 完全一致。
 *
 *   stream(options) 异步迭代器，产出
 *     { type:'text-delta', text } /
 *     { type:'finish', reason:{ kind:'stop'|'max-tokens'|'error'|'aborted', failure?:{ message } } }
 *
 * options 形如 { provider, model, system, messages:[{role,content:[{type:'text',text}]}],
 *                maxTokens, signal, reasoningEffort }
 * reasoningEffort 忽略（本适配器不走思考链）。
 *
 * MOCK_LLM=1 时不发网络请求，按目标字数生成可分辨假正文，finish 恒为 stop。
 */
import { resolveEnvRef } from './config.js'

function userTextOf(options) {
  const msgs = Array.isArray(options?.messages) ? options.messages : []
  const parts = []
  for (const m of msgs) {
    const content = m?.content
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
      }
    }
  }
  return parts.join('\n')
}

function countChars(s) {
  return String(s ?? '').replace(/\s/g, '').length
}

function pad(seed, minChars) {
  const unit = `【MOCK:${seed}】这是一段可分辨的占位正文，仅用于离线验收，不代表模型真写。`
  let out = ''
  const want = Math.max(80, Number.isFinite(minChars) ? minChars : 400)
  while (countChars(out) < want) out += unit
  return out
}

function parseWantedChapters(user) {
  const s = String(user ?? '')
  const m = /预计章数[\s\S]{0,80}?(\d{1,3})\s*(?:[-–~—至到]\s*(\d{1,3})\s*)?章/.exec(s)
  if (m !== null) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) return Math.min(60, Math.max(1, Math.floor(n)))
  }
  const ask = /只补写第\s*(\d+)\s*章到第\s*(\d+)\s*章/.exec(s)
  if (ask !== null) {
    const from = Number(ask[1])
    const to = Number(ask[2])
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) return { from, to }
  }
  return 3
}

function mockBody(options) {
  const user = userTextOf(options)
  const system = String(options?.system ?? '')
  const blob = user + '\n' + system
  const maxTokens = Number.isInteger(options?.maxTokens) && options.maxTokens > 0 ? options.maxTokens : 3000
  // 中文约 1 token ≈ 1.5~2 字；mock 按 maxTokens 的一半估目标字数，再被结构块覆盖
  const target = Math.min(8000, Math.max(200, Math.floor(maxTokens * 0.45)))

  // 续写轮：明确回「已写完」，避免 mock 为凑字数把结构写散
  if (/第\s*\d+\s*次续写/.test(user)) return '已写完'

  if (/本次只输出第\s*\d+\s*个候选/.test(user)) {
    const idx = Number((/本次只输出第\s*(\d+)\s*个候选/.exec(user) ?? [])[1] ?? 1)
    const cn = ['一', '二', '三', '四', '五', '六'][idx - 1] ?? String(idx)
    return [
      `## 候选${cn}`,
      '### 一、作品定位',
      `- 书名：长夜将明·候选${cn}`,
      '- 核心卖点：凡人逆袭，装弱打脸',
      '- 频道：男频',
      '### 二、主角人设',
      '- 主角人名：陈默',
      '- 身份：坊市杂役',
      '### 三、重要配角',
      '- 苏晚 | 19 | 外冷内热的师姐',
      '- 赵衡 | 40 | 表面慈祥的掌柜',
      '### 四、上架信息',
      '- 阅读标签·主分类：玄幻',
      '- 阅读标签·主题：升级流',
      '- 阅读标签·角色：凡人流',
      '- 阅读标签·情节：逆袭',
      '- 内容标签·情节：扮猪吃老虎',
      '- 内容标签·情感：热血',
      '- 内容标签·人设：成长',
      '- 内容标签·世界观：修仙',
      '- 作品简介：陈默在昆仑坊市当杂役，被人当空气。一次意外让他捡到一枚残破玉简，从此踏上漫长的逆袭之路。他要活下去，还要把欠他的一一讨回来。坊市的灯火夜夜如昼，可他心里那点火，比灯火更亮。',
      pad('positioning-' + idx, 400),
    ].join('\n')
  }

  if (/本次只输出人物名单/.test(user)) {
    return ['- 陈默 | 主角 | 坊市杂役，隐忍逆袭', '- 苏晚 | 师姐 | 外冷内热', '- 赵衡 | 掌柜 | 表面慈祥'].join('\n')
  }

  if (/本次只输出第\s*\d+\s*个人物档案/.test(user)) {
    const name = (/只写「##\s*([^」]+)」/.exec(user) ?? ['', '陈默'])[1]
    return [
      `## ${name}`,
      '- 身份：修仙者',
      '- 外貌与气质：清瘦、眼神稳',
      '- 性格与说话方式：少言，关键处才硬',
      '- 他想要什么（欲望）：活下去并讨回尊严',
      '- 他怕什么：再一次被当空气',
      '- 秘密：残破玉简',
      '- 与主角的关系：自身或同伴',
      '- 成长弧线：从隐忍到敢下手',
      pad('char-' + name, 200),
    ].join('\n')
  }

  if (/本次只输出人物关系简表/.test(user)) {
    return '| 人物A | 关系 | 人物B | 张力/伏笔 |\n| 陈默 | 师徒暧昧 | 苏晚 | 隐瞒身世 |\n| 陈默 | 表面主仆 | 赵衡 | 掌柜另有图谋 |'
  }

  if (/拆分卷次|本卷目标|各卷之间/.test(blob) && /卷/.test(blob)) {
    const n = typeof parseWantedChapters(user) === 'number' ? parseWantedChapters(user) : 3
    return [
      `## 第一卷 坊市试炼`,
      '- 卷名：坊市试炼',
      '- 本卷目标：陈默在坊市站稳脚跟，激活玉简第一层',
      '- 主要事件：被当空气、捡到玉简、第一次打脸、卷入拍卖、卷末被追杀',
      '- 本卷新登场人物：陈默、苏晚、赵衡',
      '- 卷末转折 / 钩子：玉简露出第二层封印',
      `- 预计章数：${n} 章`,
      '- 情绪走向：憋屈 → 小爽 → 更大的危机',
      pad('volume-1', 500),
    ].join('\n')
  }

  if (/章节细纲|只针对上面【本卷大纲】|### 第 N 章/.test(blob) || /本次只补写第/.test(user)) {
    const parsed = parseWantedChapters(user)
    const from = typeof parsed === 'object' ? parsed.from : 1
    const to = typeof parsed === 'object' ? parsed.to : parsed
    const lines = []
    for (let i = from; i <= to; i += 1) {
      lines.push(`### 第 ${i} 章 ${i === 1 ? '杂役的灯' : i === 2 ? '玉简温热' : '坊市反咬'}`)
      lines.push('- 场景：昆仑坊市，夜')
      lines.push('- 冲突：陈默与轻视他的人')
      lines.push('- 出场人物：陈默、苏晚')
      lines.push('- 本章推进的剧情点：主角向前一步')
      lines.push('- 结尾钩子：下一章必须看的变故')
      lines.push('- 目标字数：800 字')
      lines.push('')
    }
    lines.push(pad('outline-' + from + '-' + to, 200))
    return lines.join('\n')
  }

  if (/润色并去 AI 化|只润色、不重写/.test(blob)) {
    return pad('polish', Math.min(target, 1200))
  }

  if (/写一章正文|只写这一章/.test(blob)) {
    return '第 ' + (/\d+/.exec(user)?.[0] ?? '1') + ' 章\n\n' + pad('chapter', target)
  }

  if (/一句话故事|核心冲突|主线三幕/.test(blob)) {
    return ['一句话故事：杂役少年凭残玉简逆袭坊市。', '核心冲突：活下去 vs 被当空气。', pad('outline', target)].join('\n')
  }

  return pad('generic', Math.min(target, 1600))
}

async function sleep(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return
  await new Promise((resolve, reject) => {
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

async function* mockStream(options) {
  const signal = options?.signal
  if (signal?.aborted) {
    yield { type: 'finish', reason: { kind: 'aborted' } }
    return
  }
  const delay = Number(process.env.MOCK_LLM_DELAY_MS ?? 0)
  try {
    await sleep(delay, signal)
  } catch {
    yield { type: 'finish', reason: { kind: 'aborted' } }
    return
  }
  const text = mockBody(options)
  const chunkSize = 200
  for (let i = 0; i < text.length; i += chunkSize) {
    if (signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted' } }
      return
    }
    yield { type: 'text-delta', text: text.slice(i, i + chunkSize) }
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function normalizeBaseURL(baseURL) {
  const b = String(baseURL ?? '').trim().replace(/\/+$/, '')
  if (b === '') return 'https://api.deepseek.com'
  if (b.endsWith('/chat/completions')) return b.slice(0, -'/chat/completions'.length) || 'https://api.deepseek.com'
  return b
}

function completionsUrl(baseURL) {
  return normalizeBaseURL(baseURL) + '/chat/completions'
}

function modelsUrl(baseURL) {
  return normalizeBaseURL(baseURL) + '/models'
}

/**
 * 探测 OpenAI 兼容 /models：连通性 + 可用模型 id 列表。
 * overrides 可带未保存的表单值（baseURL / model / apiKey）。
 */
async function testConnection(cfg, overrides = {}) {
  if (process.env.MOCK_LLM === '1' || process.env.MOCK_LLM === 'true') {
    const wanted = String(overrides.model ?? cfg.model ?? 'mock-chat').trim() || 'mock-chat'
    const models = ['mock-chat', 'mock-reasoner']
    return {
      ok: true,
      mock: true,
      models,
      model: models.includes(wanted) ? wanted : models[0],
      baseURL: normalizeBaseURL(overrides.baseURL ?? cfg.baseURL),
    }
  }
  const overrideKey = String(overrides.apiKey ?? '').trim()
  const apiKey = (overrideKey !== '' ? resolveEnvRef(overrideKey) : resolveEnvRef(cfg.apiKey)).trim()
  if (apiKey === '') {
    throw new Error('未配置 apiKey（请在设置页填写，或写 .agent-config.json / 设 DEEPSEEK_API_KEY）')
  }
  const base = normalizeBaseURL(overrides.baseURL ?? cfg.baseURL)
  const url = modelsUrl(base)
  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + apiKey,
      },
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error('连不上模型服务（' + url + '）：' + detail)
  }
  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch { detail = '' }
    throw new Error(httpErrorMessage(res.status, detail))
  }
  let json
  try {
    json = await res.json()
  } catch {
    throw new Error('模型列表不是合法 JSON')
  }
  const rows = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : [])
  const models = []
  for (const row of rows) {
    const id = typeof row === 'string' ? row : String(row?.id ?? '').trim()
    if (id !== '' && !models.includes(id)) models.push(id)
  }
  if (models.length === 0) throw new Error('模型列表为空（请检查 url / apiKey 是否对应同一服务）')
  const wanted = String(overrides.model ?? cfg.model ?? '').trim()
  const model = models.includes(wanted) ? wanted : models[0]
  return { ok: true, mock: false, models, model, baseURL: base }
}

function mapFinish(reason) {
  if (reason === 'length') return 'max-tokens'
  if (reason === 'stop' || reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
  if (reason === 'content_filter') return 'stop'
  return 'stop'
}

function extractDelta(json) {
  const choice = json?.choices?.[0]
  if (choice === undefined || choice === null) return { text: '', finish: null }
  const delta = choice.delta ?? choice.message ?? {}
  const text = typeof delta.content === 'string' ? delta.content : ''
  const fr = choice.finish_reason
  return { text, finish: typeof fr === 'string' && fr !== '' && fr !== 'null' ? fr : null }
}

async function* liveStream(options, cfg) {
  const signal = options?.signal
  if (signal?.aborted) {
    yield { type: 'finish', reason: { kind: 'aborted' } }
    return
  }
  const apiKey = resolveEnvRef(cfg.apiKey).trim()
  if (apiKey === '') {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: '未配置 apiKey（可在 .agent-config.json 填写或设 DEEPSEEK_API_KEY）' } },
    }
    return
  }
  const url = completionsUrl(cfg.baseURL)
  const user = userTextOf(options)
  const body = {
    model: String(options?.model || cfg.model || 'deepseek-chat'),
    stream: true,
    max_tokens: Number.isInteger(options?.maxTokens) && options.maxTokens > 0 ? options.maxTokens : cfg.maxTokens,
    messages: [
      ...(typeof options?.system === 'string' && options.system !== ''
        ? [{ role: 'system', content: options.system }]
        : []),
      { role: 'user', content: user },
    ],
  }
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    const aborted = signal?.aborted || (error !== null && typeof error === 'object' && error.name === 'AbortError')
    yield {
      type: 'finish',
      reason: aborted
        ? { kind: 'aborted' }
        : { kind: 'error', failure: { message: error instanceof Error ? error.message : String(error) } },
    }
    return
  }
  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch { detail = '' }
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: httpErrorMessage(res.status, detail) } },
    }
    return
  }
  if (res.body === null || typeof res.body.getReader !== 'function') {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: '响应没有可读的 SSE 流' } } }
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let finish = null
  try {
    while (true) {
      if (signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted' } }
        return
      }
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      buf = buf.replace(/\r\n/g, '\n')
      let sep
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        const dataLines = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .filter((l) => l !== '')
        if (dataLines.length === 0) continue
        const data = dataLines.join('')
        if (data === '[DONE]') {
          yield { type: 'finish', reason: { kind: finish === null ? 'stop' : mapFinish(finish) } }
          return
        }
        let json
        try { json = JSON.parse(data) } catch { continue }
        const piece = extractDelta(json)
        if (piece.text !== '') yield { type: 'text-delta', text: piece.text }
        if (piece.finish !== null) finish = piece.finish
      }
    }
  } catch (error) {
    const aborted = signal?.aborted || (error !== null && typeof error === 'object' && error.name === 'AbortError')
    yield {
      type: 'finish',
      reason: aborted
        ? { kind: 'aborted' }
        : { kind: 'error', failure: { message: error instanceof Error ? error.message : String(error) } },
    }
    return
  }
  yield { type: 'finish', reason: { kind: finish === null ? 'stop' : mapFinish(finish) } }
}

function clip(s, n) {
  const t = String(s ?? '')
  return t.length <= n ? t : t.slice(0, n)
}

/** 把上游 HTTP 错误翻成人话（402 余额不足最常见）。 */
function httpErrorMessage(status, detail) {
  const raw = String(detail ?? '')
  if (status === 402 || /Insufficient Balance/i.test(raw)) {
    return '模型账户余额不足（HTTP 402）。请到服务商控制台充值，或在设置里换成有余额的 apiKey 并点「保存模型配置」（当前配置若仍是 ${DEEPSEEK_API_KEY}，改环境变量后还需重启本服务）。原文：' + clip(raw, 240)
  }
  if (status === 401 || /invalid.*api.?key|authentication/i.test(raw)) {
    return 'apiKey 无效或未授权（HTTP ' + status + '）。请在设置里重新填写并保存。原文：' + clip(raw, 240)
  }
  return 'HTTP ' + status + ' ' + clip(raw, 400)
}

export function createLlm(getConfig) {
  return {
    async *stream(options) {
      const cfg = typeof getConfig === 'function' ? getConfig() : getConfig
      if (process.env.MOCK_LLM === '1' || process.env.MOCK_LLM === 'true') {
        yield* mockStream(options)
        return
      }
      yield* liveStream(options, cfg)
    },
    /** 测试连通性并返回可用 model id（供设置页「测试」按钮返显）。 */
    async test(overrides = {}) {
      const cfg = typeof getConfig === 'function' ? getConfig() : getConfig
      return testConnection(cfg ?? {}, overrides)
    },
  }
}
