/**
 * dsh-writer-m — 一次性模型调用
 *
 * 刻意**不 import `@deepseek-ai/dsh-llm`**：
 * - 该包在用户的 desktop profile 里解析不到（`dsh-novel-craft` 就是惰性 import + 失败降级），
 *   依赖它会让「用模型」的每一步都有一次不必要的失败路径；
 * - 平台契约是纯数据：`GenerateOptions.messages` 接受 `{role:'user', content:[{type:'text',text}]}`，
 *   流是 `{type:'text-delta'|'finish'|...}` 的可辨识联合。自己拼十几行就够，不必引一个包。
 *
 * 两个必须显式处理的行为（都是实机踩过的坑）：
 * 1. `reasoningEffort` 要能关掉：起草/改写任务里，思考链会把输出预算吃光，
 *    症状是「模型想了一堆、正文一个字都没有」。
 * 2. 结束原因要带回上层：`max-tokens` 意味着稿子被截断，不能当成功落盘。
 */

export const LLM_DEFAULTS = {
  maxTokens: 3000,
  timeoutMs: 180000,
  reasoningEffort: 'off',
}

/**
 * 自动续写（长稿兜底）。
 *
 * 卷大纲、章节正文这类一步几千字的产物很容易顶到 maxTokens 被截断——实机报障就是
 * 「生成卷大纲时提示模型输出被长度上限截断」。与其让用户自己去调「单次最大输出」，
 * 不如在同一份 system 提示词（这一步的全部写作要求）下再要一次：截断时把已写内容的
 * 结尾回贴给模型，让它从断点接着写，直到正常收尾或到次数上限。
 */
export const CONTINUE_DEFAULTS = {
  /** 最多续写几次（不含首轮） */
  rounds: 3,
  /** 续写时回贴的已写内容尾部长度：够模型认出断点，又不至于把上下文吃满 */
  tailChars: 1500,
  /** 累计正文硬上限：模型绕圈时刹车，避免无限刷下去 */
  maxChars: 60000,
  /** 目标篇幅的达标线：正文写到 targetChars × 这个比例就算够了（留一点余量，别为几十字反复追问） */
  targetRatio: 0.9,
  /** 一轮续写至少要新增这么多字，否则视为模型在空转/绕圈，停止续写 */
  minRoundChars: 120,
}

/**
 * 续写请求：明说「接着写」并附上断点前的结尾。
 * truncated=true（默认）＝上一轮被长度上限截断；truncated=false＝模型自己收尾了但篇幅不够
 * （小模型常见：写到七八百字就 finish=stop），两种情况的措辞必须不同，否则会误导模型。
 */
export function buildContinueUser(text, round, { truncated = true, task = '', scope = '' } = {}) {
  const tail = String(text ?? '').slice(-CONTINUE_DEFAULTS.tailChars)
  const brief = String(task ?? '').trim()
  const bound = String(scope ?? '').trim()
  return [
    truncated
      ? `第 ${round} 次续写：上一次输出因为长度上限被截断了，稿件还没写完。请紧接下面的结尾继续写。`
      : `第 ${round} 次续写：上一次你自己收了尾，但这一章的篇幅还没达到目标字数。请紧接下面的结尾继续往下写。`,
    '- 从断点处直接往下写，不要重复已经写过的内容，不要重新开头，不要总结或复述；',
    '- 不要打招呼、不要解释、不要道歉，不要写「（续）」这类标记；',
    '- 与上文保持一致的格式（标题层级、编号、列表、表格）与文风。',
    '- 续写部分必须继续服务同一个任务：场景、人物、冲突与结尾钩子都要与任务回执一致，不要另起情节。',
    '- 如果你认为这一步该写的都已经写完、确实不宜再加，就只回复「已写完」三个字，不要为了凑字数硬写。',
    '- **不要越界**：继续写的内容必须仍然属于这一步的产物（例如「大纲」步就只把大纲补完整），绝对不要在规划步里开始写章节正文、人物对话或具体场景描写——那属于后面的步骤。',
    ...(bound === '' ? [] : ['- 本步产物边界：' + bound]),
    ...(brief === '' ? [] : ['', '【本步任务回执（续写时仍需遵守，不要复述它）】', brief]),
    '',
    '【已写内容的结尾（只用来定位断点，不要重复它）】',
    tail,
    '【从这里接着写】',
  ].join('\n')
}

/** 拼接续写结果：裁掉与上一段尾部重叠的开头，避免接缝处重复一句。 */
export function joinContinuation(acc, next) {
  const base = String(acc ?? '')
  let add = String(next ?? '')
  if (add === '') return base
  add = add.replace(/^\s+/, '')
  const max = Math.min(300, base.length, add.length)
  for (let k = max; k >= 12; k -= 1) {
    if (base.slice(-k) === add.slice(0, k)) {
      add = add.slice(k)
      break
    }
  }
  return base + add
}

/**
 * 解析模型路由：优先用配置里指定的 provider/model，否则用 dsh 当前的默认模型。
 * 返回 null 表示「没有可用的路由」，由上层给出人话提示。
 */
/**
 * 多模型分工（lane）：每个生成步骤都可以单独指定模型端点。
 * lane 取值（步级）：positioning 定位 / outline 大纲 / characters 人物 / volume-outline 卷纲 /
 *   chapter-outline 章纲 / title 书名 / tags 标签 / chapter 章节正文（含快速通道）/ polish 润色（含去AI）/ analysis 分析拆书。
 * config.lanes[lane] 指向 config.models[].id；解析不到（未配置/被删了）就回落到单模型默认配置。
 * 密钥不过 lib 层：route 只带 profileId，真正的 baseURL/apiKey 由宿主适配层按 id 查全量配置。
 */

/** 步级分工键名单：与 server/config.js 的 LANE_KEYS 保持一致（lib 不引 server，这里各存一份）。 */
export const LANE_STEP_KEYS = [
  'positioning', 'outline', 'characters', 'volume-outline', 'chapter-outline',
  'title', 'tags', 'chapter', 'polish', 'analysis',
]
export function resolveRoute(ctx, config, lane) {
  const laneKey = typeof lane === 'string' ? lane : ''
  const laneId = laneKey === '' ? '' : String(config?.lanes?.[laneKey] ?? '').trim()
  if (laneId !== '' && Array.isArray(config?.models)) {
    const profile = config.models.find((p) => p !== null && typeof p === 'object' && p.id === laneId) ?? null
    if (profile !== null && String(profile.model ?? '').trim() !== '') {
      const provider = String(profile.provider ?? '').trim() || String(config?.provider ?? '').trim()
      return {
        provider: provider === '' ? 'deepseek' : provider,
        model: String(profile.model).trim(),
        profileId: profile.id,
        label: String(profile.label ?? '').trim() || profile.id,
        maxTokens: Number.isInteger(profile.maxTokens) && profile.maxTokens > 0 ? profile.maxTokens : undefined,
      }
    }
  }
  const provider = String(config?.provider ?? '').trim()
  const model = String(config?.model ?? '').trim()
  if (provider !== '' && model !== '') return { provider, model }
  const fallback = ctx.get('agentDefaultModel')
  if (fallback !== undefined && fallback !== null && typeof fallback.currentSelection === 'function') {
    let selection
    try {
      selection = fallback.currentSelection()
    } catch {
      selection = undefined
    }
    const p = String(selection?.provider ?? '').trim()
    const m = String(selection?.model ?? '').trim()
    if (p !== '' && m !== '') return { provider: p, model: m }
  }
  return null
}

/** 正文字数（去掉所有空白），用于目标篇幅判定与达标回报。 */
function countChars(s) {
  return String(s ?? '').replace(/\s/g, '').length
}

/**
 * 生成步骤 → 分工 lane 的映射（步级）。
 * 同义键归并：fast/draft 归 chapter（快速通道就是正文），deai 归 polish；
 * 短文链的 topic/hook/structure 归 outline、body 归 chapter（这几步没有单独的分工键）。
 * 分析类路由直接传 'analysis'，不走这里。
 */
export function laneForStep(stepId) {
  const s = String(stepId ?? '')
  if (LANE_STEP_KEYS.includes(s)) return s
  if (s === 'draft' || s === 'fast' || s === 'body') return 'chapter'
  if (s === 'deai') return 'polish'
  if (s === 'topic' || s === 'hook' || s === 'structure') return 'outline'
  return ''
}

/**
 * 一次调用，流式收完拼成纯文本；`autoContinue: true` 时输出被长度上限截断会自动续写。
 * @param {any} llm ctx.get('llm') 拿到的 LlmRuntime
 * @param {{provider: string, model: string}} route
 * @param {{system?: string, user: string, maxTokens?: number, timeoutMs?: number, reasoningEffort?: string, signal?: AbortSignal, autoContinue?: boolean, continueRounds?: number}} request
 * @returns {Promise<{text: string, finish: string, rounds: number, continued: boolean}>} rounds = 实际调用次数（1 表示没有续写）
 */
export async function callModel(llm, route, request) {
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('这个 dsh 没有可用的 llm 服务：本地能力照常可用，这一步请改用对话方式手动做')
  }
  // maxTokens 优先级：调用方显式值 > 分工模型的「最大输出」。profile 里配了上限时是**硬顶**——
  // 本地小模型吐不长是常态，超出的部分由自动续写补，而不是让端点被超限请求打挂。
  const asked = Number.isInteger(request.maxTokens) ? request.maxTokens : LLM_DEFAULTS.maxTokens
  const maxTokens = Number.isInteger(route.maxTokens) && route.maxTokens > 0
    ? Math.min(asked, route.maxTokens)
    : asked
  const timeoutMs = Number.isInteger(request.timeoutMs) ? request.timeoutMs : LLM_DEFAULTS.timeoutMs
  const autoContinue = request.autoContinue === true
  const maxRounds = autoContinue
    ? Math.max(1, Number.isInteger(request.continueRounds) ? request.continueRounds : CONTINUE_DEFAULTS.rounds + 1)
    : 1

  const run = async (userText, withEffort) => {
    const options = {
      provider: route.provider,
      model: route.model,
      // 多模型分工：profileId 交给宿主适配层查全量配置取 baseURL/apiKey（密钥不过 lib 层）
      ...(typeof route.profileId === 'string' && route.profileId !== '' ? { profileId: route.profileId } : {}),
      ...(typeof request.system === 'string' && request.system !== '' ? { system: request.system } : {}),
      messages: [{ role: 'user', content: [{ type: 'text', text: String(userText ?? '') }] }],
      maxTokens,
      // 每轮各自计时：续写轮不该被首轮开始时就启动的总超时掐断（调用方若要总闸，传 signal）
      signal: request.signal ?? AbortSignal.timeout(timeoutMs),
      ...(withEffort ? { reasoningEffort: request.reasoningEffort ?? LLM_DEFAULTS.reasoningEffort } : {}),
    }
    let text = ''
    let finish = 'stop'
    for await (const chunk of llm.stream(options)) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind
        if (typeof kind === 'string') finish = kind
        if (kind === 'error' || kind === 'aborted') {
          const raw = chunk.reason?.failure?.message
          const message = typeof raw === 'string' && raw.trim() !== ''
            ? raw.trim()
            : (kind === 'aborted'
              ? '请求超时或被中断（本地模型拆书/长提示词很慢时常见：请提高超时、减小采样，或换更快的模型）'
              : '未知错误（上游未返回具体原因）')
          throw new Error(`模型调用失败：${message}`)
        }
      }
    }
    return { text, finish }
  }

  const attempt = async (userText) => {
    try {
      return await run(userText, true)
    } catch (error) {
      // 模型不认这个推理档位时退一步重试；别的错误照抛，不要吞掉真正的问题
      const message = error instanceof Error ? error.message : String(error)
      if (!/reasoning effort/i.test(message)) throw error
      return await run(userText, false)
    }
  }

  const baseUser = String(request.user ?? '')
  // 目标篇幅（正文字数，不含空白）。传了它以后，续写不再只看「有没有被截断」：
  // 小模型常写到七八百字就 finish=stop（用户 m02113：本地一次性生成的长度不够），
  // 这种情况也要接着写，直到够长、或到次数/硬上限、或模型连续空转。
  const targetChars = Number.isFinite(request.targetChars) && request.targetChars > 0 ? Math.floor(request.targetChars) : 0
  const goalChars = targetChars > 0 ? Math.ceil(targetChars * CONTINUE_DEFAULTS.targetRatio) : 0
  let text = ''
  let finish = 'stop'
  let rounds = 0
  while (rounds < maxRounds) {
    const continueTask = String(request.continueContext ?? '')
    const continueScope = String(request.continueScope ?? '')
    const result = await attempt(rounds === 0 ? baseUser : buildContinueUser(text, rounds, { truncated: finish === 'max-tokens', task: continueTask, scope: continueScope }))
    const addition = String(result.text ?? '').trim()
    // 模型明确回「已写完」⇒ 它是真的认为没有可写的了：收手，且不把这三个字拼进正文。
    // 注意要在 rounds += 1 之后再 break，否则调用次数与回报的轮数会对不上。
    const saysDone = rounds > 0 && addition.length <= 12 && addition.indexOf('已写完') >= 0
    // 整段复读刹车：续写轮把已经写过的大段内容又抄一遍（本地小模型常见）⇒ 丢掉这一轮并收手，
    // 否则正文里会出现同一段重复两三次。
    const dupStart = addition.slice(0, Math.min(120, addition.length))
    const repeated = rounds > 0 && addition.length >= 60 && dupStart.length >= 40 && text.indexOf(dupStart) >= 0
    const addedChars = countChars(result.text)
    if (!saysDone && !repeated) {
      text = rounds === 0 ? result.text : joinContinuation(text, result.text)
      finish = result.finish
    }
    rounds += 1
    if (saysDone || repeated) break
    if (!autoContinue) break
    const chars = countChars(text)
    // 达标即停（哪怕这一轮是被截断的）；没给目标篇幅时退回旧规则：只有截断才继续
    if (targetChars > 0 ? chars >= goalChars : finish !== 'max-tokens') break
    // 已到累计硬上限 / 这一轮几乎没新增（再问也是空转）—— 都停下
    if (text.length >= CONTINUE_DEFAULTS.maxChars) break
    // 一个字都没吐（再问也是空转）—— 不论收尾原因都停
    if (addedChars === 0) break
    // 空转刹车只在「续写轮 + 这一轮不是被截断的」时生效：
    // 首轮短不代表模型写不动（可能只是还没展开）；被截断的轮次再短也是真被切断了，不能因此提前放弃。
    if (rounds > 1 && finish !== 'max-tokens' && addedChars < CONTINUE_DEFAULTS.minRoundChars) break
  }
  const chars = countChars(text)
  return {
    text,
    finish,
    rounds,
    continued: rounds > 1,
    chars,
    targetChars,
    reachedTarget: targetChars === 0 ? true : chars >= goalChars,
  }
}

/** 把结束原因翻译成人话；空串表示正常。meta.rounds = 实际调用次数，用于区分「一次截断」与「续写多次仍没写完」。 */
export function finishWarning(finish, text, meta) {
  if (finish === 'max-tokens') {
    const rounds = Number.isInteger(meta?.rounds) && meta.rounds > 0 ? meta.rounds : 1
    if (rounds > 1) {
      return `已自动续写 ${rounds - 1} 次仍未写完：这一步的产物超长（或模型在绕圈），建议把这一步拆小（例如按卷分别生成）后再试`
    }
    return '模型输出被长度上限截断：这份稿子不完整，建议提高「单次最大输出」或拆小这一步'
  }
  const chars = countChars(text)
  const target = Number.isFinite(meta?.targetChars) && meta.targetChars > 0 ? Math.floor(meta.targetChars) : 0
  if (String(text ?? '').trim() === '') return '模型只输出了思考、没有正文：把推理档位设为 off 或换一个模型'
  if (target > 0 && chars < target * CONTINUE_DEFAULTS.targetRatio) {
    const rounds = Number.isInteger(meta?.rounds) && meta.rounds > 0 ? meta.rounds : 1
    return `模型自己收了尾但只写了 ${chars} 字（目标 ${target} 字）：已自动续写 ${rounds - 1} 次仍未达标，建议降低单章目标字数，或换指令遵循更好的模型`
  }
  return ''
}
