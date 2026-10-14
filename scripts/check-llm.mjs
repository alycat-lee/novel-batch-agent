/**
 * llm.js 的离线自检：**自动续写**（截断时接着写）与结束原因提示。
 *
 * 这是实机报障驱动的：生成卷大纲时输出顶到 maxTokens 被截断，用户只看到一句
 * 「模型输出被长度上限截断」。修法是同一份 system 提示词下自动续写，所以这里
 * 用假 llm.stream 把各种收尾序列跑一遍：
 *   - 截断一次后正常收尾 → 两段拼起来、rounds=2、没有警告；
 *   - 一直截断 → 到次数上限就停，警告要说明「已续写 N 次」；
 *   - 没开 autoContinue → 行为与以前完全一致（不能悄悄改变别的调用方）；
 *   - 续写轮必须带 system、带断点前的结尾、带「不要重复」的约束；
 *   - 接缝去重、空轮刹车、累计字数上限、推理档位回退重试。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)))
const LLM = await import('file://' + join(pkgDir, 'lib/core/llm.js').replace(/\\/g, '/'))
const { callModel, finishWarning, buildContinueUser, joinContinuation, CONTINUE_DEFAULTS, LLM_DEFAULTS } = LLM

const fails = []
const ok = (label, cond) => {
  console.log((cond === true ? '  ok   ' : '  FAIL ') + label)
  if (cond !== true) fails.push(label)
}

/** 假 llm：script 是逐轮的输出序列；每轮是 [{type:'text-delta',text}|{type:'finish',reason:{kind}}]。 */
function fakeLlm(script) {
  const calls = []
  let i = 0
  return {
    calls,
    stream(options) {
      const step = script[Math.min(i, script.length - 1)]
      i += 1
      calls.push(options)
      const chunks = typeof step === 'function' ? step(options, calls.length) : step
      return (async function* () {
        for (const c of chunks) yield c
      })()
    },
  }
}
const deltas = (text, finish) => [{ type: 'text-delta', text }, { type: 'finish', reason: { kind: finish } }]
const route = { provider: 'p', model: 'm' }

console.log('== 默认不续写（不影响其它调用方） ==')
{
  const llm = fakeLlm([deltas('半截稿', 'max-tokens'), deltas('不该被调用', 'stop')])
  const r = await callModel(llm, route, { system: 'S', user: 'U', maxTokens: 4500 })
  ok('只调用一次模型', llm.calls.length === 1)
  ok('rounds=1 / continued=false', r.rounds === 1 && r.continued === false)
  ok('正文就是这一轮的输出', r.text === '半截稿' && r.finish === 'max-tokens')
  ok('沿用改造前的警告文案', finishWarning(r.finish, r.text) === '模型输出被长度上限截断：这份稿子不完整，建议提高「单次最大输出」或拆小这一步')
}

console.log('== 截断一次 → 自动续写补全 ==')
{
  const head = '## 第一卷 少年出山\n- 第1章 起点\n'
  const tailText = '从断点处接着写下去不要重复前面已经写过的内容'
  const llm = fakeLlm([
    deltas(head + tailText, 'max-tokens'),
    deltas(tailText + '，接着补完剩下的章节。', 'stop'),
  ])
  const r = await callModel(llm, route, {
    system: '这一步的全部写作要求',
    user: '写卷大纲',
    maxTokens: 4500,
    timeoutMs: 180000,
    reasoningEffort: 'off',
    autoContinue: true,
  })
  ok('调用了两次模型（首轮 + 1 次续写）', llm.calls.length === 2)
  ok('rounds=2 / continued=true', r.rounds === 2 && r.continued === true)
  ok('收尾是 stop，警告为空（可以正常落盘）', r.finish === 'stop' && finishWarning(r.finish, r.text, { rounds: r.rounds }) === '')
  ok('两段拼成一整份稿', r.text.startsWith(head) && r.text.endsWith('接着补完剩下的章节。'))
  ok('接缝处没有重复那句（重叠部分被裁掉）', r.text === head + tailText + '，接着补完剩下的章节。')
  ok('续写轮沿用同一份 system', llm.calls[1].system === '这一步的全部写作要求' && llm.calls[0].system === '这一步的全部写作要求')
  ok('首轮发原始提示词、续写轮发续写提示词', llm.calls[0].messages[0].content[0].text === '写卷大纲' && llm.calls[1].messages[0].content[0].text.includes('【从这里接着写】'))
  ok('续写提示词带断点前的结尾', llm.calls[1].messages[0].content[0].text.includes(tailText))
  ok('续写提示词要求「不要重复」', llm.calls[1].messages[0].content[0].text.includes('不要重复'))
  ok('maxTokens / reasoningEffort 逐轮不变', llm.calls[1].maxTokens === 4500 && llm.calls[1].reasoningEffort === 'off')
  ok('每轮各自计时（不是共用一个超时信号）', llm.calls[0].signal !== llm.calls[1].signal)
}

console.log('== 一直截断 → 到上限就停，并说清续写了几次 ==')
{
  const llm = fakeLlm([deltas('A'.repeat(50), 'max-tokens')])
  const r = await callModel(llm, route, { system: 'S', user: 'U', autoContinue: true, maxTokens: 100 })
  ok('共调用 1 + ' + CONTINUE_DEFAULTS.rounds + ' 次', llm.calls.length === 1 + CONTINUE_DEFAULTS.rounds && r.rounds === 1 + CONTINUE_DEFAULTS.rounds)
  ok('结束原因仍是 max-tokens', r.finish === 'max-tokens')
  const w = finishWarning(r.finish, r.text, { rounds: r.rounds })
  ok('警告说明「已自动续写 N 次仍未写完」', w.includes('已自动续写 ' + CONTINUE_DEFAULTS.rounds + ' 次仍未写完'))
  ok('警告建议拆小这一步', w.includes('拆小'))
}

console.log('== continueRounds 可覆盖次数 ==')
{
  const llm = fakeLlm([deltas('A'.repeat(30), 'max-tokens')])
  const r = await callModel(llm, route, { system: 'S', user: 'U', autoContinue: true, continueRounds: 2, maxTokens: 100 })
  ok('continueRounds=2 ⇒ 共调用 2 次', llm.calls.length === 2 && r.rounds === 2)
}

console.log('== 空轮刹车 / 累计上限 ==')
{
  const empty = fakeLlm([deltas('有内容', 'max-tokens'), deltas('', 'max-tokens')])
  const r1 = await callModel(empty, route, { system: 'S', user: 'U', autoContinue: true, maxTokens: 100 })
  ok('续写轮吐空 ⇒ 立刻停（不再空转）', empty.calls.length === 2 && r1.rounds === 2)

  // 每轮给不同的字，避免触发「整段复读刹车」（那是另一条用例），专门测累计上限
  const huge = fakeLlm([(o, n) => deltas(String.fromCharCode(64 + n).repeat(30000), 'max-tokens')])
  const r2 = await callModel(huge, route, { system: 'S', user: 'U', autoContinue: true, continueRounds: 9, maxTokens: 100 })
  // 每轮 30000 字，第 2 轮后仍不到 60000（接缝去重裁掉了一段），第 3 轮越线即停
  ok('累计正文到 maxChars 就停（' + r2.text.length + ' 字，调用 ' + r2.rounds + ' 次）',
    r2.text.length >= CONTINUE_DEFAULTS.maxChars && r2.rounds < 9)
}

console.log('== 推理档位回退重试仍然生效 ==')
{
  let first = true
  const llm = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      const isFirst = first
      first = false
      return (async function* () {
        if (isFirst) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'reasoning effort is not supported by this model' } } }
          return
        }
        yield { type: 'text-delta', text: '正文' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const r = await callModel(llm, route, { system: 'S', user: 'U', maxTokens: 100 })
  ok('第一次带推理档位失败后去掉档位重试', llm.calls.length === 2 && r.text === '正文' && r.finish === 'stop')
  ok('重试的那次没有 reasoningEffort 字段', llm.calls[0].reasoningEffort === 'off' && llm.calls[1].reasoningEffort === undefined)
}

console.log('== 拼接与提示词工具函数 ==')
{
  ok('无重叠直接拼', joinContinuation('前缀', '后缀') === '前缀后缀')
  ok('裁掉开头空白', joinContinuation('甲', '   乙') === '甲乙')
  ok('长重叠被裁掉', joinContinuation('头' + 'X'.repeat(20), 'X'.repeat(20) + '尾') === '头' + 'X'.repeat(20) + '尾')
  ok('短重叠（<12 字）不动，避免误伤正常重复词', joinContinuation('甲乙丙丁戊己庚辛壬癸', '庚辛壬癸子丑') === '甲乙丙丁戊己庚辛壬癸庚辛壬癸子丑')
  const p = buildContinueUser('结尾内容', 2)
  ok('续写提示词标注轮次', p.startsWith('第 2 次续写'))
  ok('续写提示词只回贴尾部 tailChars', buildContinueUser('A'.repeat(5000), 1).includes('A'.repeat(CONTINUE_DEFAULTS.tailChars)))
  ok('默认上限没被改动', LLM_DEFAULTS.maxTokens === 3000 && LLM_DEFAULTS.timeoutMs === 180000)
}

console.log('== 目标篇幅驱动续写（用户 m02113：本地模型一次写不长） ==')
{
  // 模型每轮都「自己收尾」但只写 600 字；targetChars=2000 ⇒ 达标线 1800（ratio 0.9）
  const chunk = (label) => deltas(label + '甲'.repeat(698), 'stop')  // 每轮 699 字：3 轮 2097 ≥ 达标线 1800
  const llm = fakeLlm([chunk('一'), chunk('二'), chunk('三'), chunk('四'), chunk('五')])
  const r = await callModel(llm, route, { system: 'S', user: 'U', autoContinue: true, maxTokens: 100, targetChars: 2000 })
  ok('没截断但篇幅不够 ⇒ 继续续写直到达标', r.rounds === 3 && r.continued === true)
  ok('达标线 = targetChars × targetRatio', r.targetChars === 2000 && r.reachedTarget === true && r.chars >= Math.ceil(2000 * CONTINUE_DEFAULTS.targetRatio))
  ok('续写轮用的是「你自己收了尾」措辞，不是「被截断」', String(llm.calls[1].messages[0].content[0].text).indexOf('你自己收了尾') >= 0 && String(llm.calls[1].messages[0].content[0].text).indexOf('被截断') === -1)
  ok('达标后不再多问一轮', llm.calls.length === 3)
  ok('达标时没有警告', finishWarning(r.finish, r.text, { rounds: r.rounds, targetChars: r.targetChars }) === '')
}
{
  // 第一轮就写够 ⇒ 不续写、不打扰
  const llm = fakeLlm([deltas('甲'.repeat(2500), 'stop')])
  const r = await callModel(llm, route, { system: 'S', user: 'U', autoContinue: true, maxTokens: 100, targetChars: 2000 })
  ok('一轮写够 ⇒ rounds=1 / reachedTarget=true', llm.calls.length === 1 && r.rounds === 1 && r.reachedTarget === true)
}
{
  // 每轮只加 50 字（低于 minRoundChars）⇒ 判定空转，停下并给「自己收了尾但太短」的警告
  const llm = fakeLlm([deltas('甲'.repeat(50), 'stop'), deltas('乙'.repeat(50), 'stop'), deltas('丙'.repeat(50), 'stop')])
  const r = await callModel(llm, route, { system: 'S', user: 'U', autoContinue: true, maxTokens: 100, targetChars: 2000, continueRounds: 9 })
  ok('连续空转 ⇒ 提前停（不刷到次数上限）', r.rounds === 2 && llm.calls.length === 2)
  ok('未达标如实回报', r.reachedTarget === false && r.chars < 2000)
  const w = finishWarning(r.finish, r.text, { rounds: r.rounds, targetChars: r.targetChars })
  ok('警告说明「自己收了尾但太短」并给出目标字数', w.indexOf('自己收了尾但只写了') >= 0 && w.indexOf('目标 2000 字') >= 0)
}
{
  // 没给 targetChars ⇒ 退回旧规则（只有截断才续写）
  const llm = fakeLlm([deltas('短稿', 'stop'), deltas('不该被调用', 'stop')])
  const r = await callModel(llm, route, { system: 'S', user: 'U', autoContinue: true, maxTokens: 100 })
  ok('无 targetChars ⇒ 不因「写得短」而续写', llm.calls.length === 1 && r.rounds === 1 && r.reachedTarget === true)
  ok('无 targetChars 时 targetChars 回报为 0', r.targetChars === 0)
}
{
  const p2 = buildContinueUser('结尾内容', 1, { truncated: false })
  ok('buildContinueUser 支持「未截断」措辞', p2.indexOf('你自己收了尾') >= 0 && p2.indexOf('被截断') === -1)
  ok('两种措辞都保留断点回贴与「不要重复」约束', p2.indexOf('不要重复已经写过的内容') >= 0 && p2.indexOf('结尾内容') >= 0)
  const p3 = buildContinueUser('结尾内容', 1, { task: '【本章细纲】主角在丹房砍柴' })
  ok('任务回执会带进续写轮', p3.indexOf('【本步任务回执') >= 0 && p3.indexOf('主角在丹房砍柴') >= 0)
  ok('没传任务回执时不出现空标题', buildContinueUser('x', 1).indexOf('【本步任务回执') === -1)
}

console.log('== 续写不越界 + 整段复读刹车（用户 m02380：大纲步写出了第一章正文） ==')
{
  const scope = '这一步只产出「大纲」（steps/02-大纲.md）；只把这一步的内容写完整，不要写下一步的产物。'
  const c = buildContinueUser('已写的大纲', 1, { scope })
  ok('续写提示词带「不要越界」约束', c.indexOf('不要越界') >= 0 && c.indexOf('不要写下一步的产物') >= 0)
  ok('续写提示词带本步产物边界', c.indexOf('本步产物边界：' + scope) >= 0)
  ok('不传 scope 时不出现边界行', buildContinueUser('x', 1).indexOf('本步产物边界') === -1)
  // 模型把上一轮内容整段复读 ⇒ 丢掉这一轮并收手
  const first = '第一章 起点\n' + '甲乙丙丁戊己庚辛壬癸'.repeat(12)
  const again = first + '（这段是复读）'
  const llm = fakeLlm([deltas(first, 'stop'), deltas(again, 'stop')])
  const r = await callModel(llm, route, { system: 'S', user: 'U', autoContinue: true, maxTokens: 100, targetChars: 5000, continueScope: scope })
  ok('整段复读：调用 2 次即收手', llm.calls.length === 2 && r.rounds === 2)
  ok('整段复读：复读内容没被拼进正文', r.text === first && r.reachedTarget === false)
}

console.log('')
if (fails.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log('失败 ' + fails.length + ' 项：')
for (const f of fails) console.log('  - ' + f)
process.exit(1)
