    /**
     * 宿主 API 基址。
     * 桌面版页面是 file://，`location.origin` 会变成字符串 'null'，相对路径会被
     * 当成文件路径，请求全打空 —— 与 dsh 自带 connection / file-upload 插件同一套做法：
     * 退回 http://dsh.internal，由桌面外壳把它转发给宿主。
     */
    const HOST_BASE = (() => {
      const loc = globalThis.location
      if (loc !== undefined && loc !== null && typeof loc.origin === 'string' && loc.origin !== 'null') return loc.origin
      return 'http://dsh.internal'
    })()
    const API = new URL('/dsh-writer-m/api/', HOST_BASE).toString()

    /** 需要较长服务端时间的接口路径（模型生成类），fetch 超时设长一些。 */
    const LONG_PATHS = /^(run|preview|publish|teardown|analyze|analyze-style|autocreate)$/
    /** 长接口超时：15 分钟（章节大纲多轮续写 + 本地慢模型可能超过 10 分钟）。 */
    const LONG_TIMEOUT_MS = 15 * 60 * 1000

    /** 统一请求：非 2xx 一律抛宿主给的中文错误，调用方只管 catch。 */
    async function api(path, body) {
      const isLong = LONG_PATHS.test(path)
      const init =
        body === undefined
          ? { headers: { accept: 'application/json' }, ...(isLong ? { signal: AbortSignal.timeout(LONG_TIMEOUT_MS) } : {}) }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(isLong ? { signal: AbortSignal.timeout(LONG_TIMEOUT_MS) } : {}) }
      let res
      try {
        res = await fetch(API + path, init)
      } catch (err) {
        // fetch 只在「连接层」失败时抛错（宿主回了非 2xx 是走到下面抛它给的中文原因的）。
        // 最常见的原因：
        //   • 请求体太大被宿主/代理掐断连接 → Failed to fetch
        //   • 服务端处理时间过长（章节大纲多轮生成）→ 超时中断（AbortError / TimeoutError）
        //   • 宿主进程未启动 / 端口不通 → connection refused / reset
        const detail = err instanceof Error && err.message !== '' ? err.message : String(err)
        const isTimeout = err instanceof DOMException && err.name === 'TimeoutError'
          || (err instanceof Error && /timeout|aborted/i.test(err.message))
        if (isTimeout) {
          throw new Error('请求超时（' + path + '）：服务端处理时间过长（已等 ' + (LONG_TIMEOUT_MS / 1000) + ' 秒）。若正在生成章节大纲/正文，可缩短单章目标字数或换用更快的模型后重试。')
        }
        throw new Error('连不上宿主（' + path + '）：' + detail + '。若是上传大文件失败，请重试或换一张更小的图片。')
      }
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

    /**
     * 「工作台是否打开」不再用模块级布尔 store：工作台现在挂在 main 槽位
     * （keyed，key='writer-m'），由 ctx.layout.selectPanel 决定中列显示哪个面板。
     * 选中它 = 打开，selectPanel(null) = 退回会话；右侧栏「送进工作台改」也因此
     * 改为切面板。pendingImport 仍保留（右侧栏 → 工作台的导入桥梁）。
     */

    /**
     * 「送进工作台改」的待导入文档：右侧栏 document.actions 按钮把当前文档的
     * 宿主绝对路径写进这里再打开工作台；工作台启动时读取并导入成草稿。
     */
    const pendingImport = (() => {
      let value = null
      const listeners = new Set()
      const emit = () => {
        for (const fn of listeners) {
          try {
            fn()
          } catch {
            // 单个订阅者抛错不影响其它订阅者
          }
        }
      }
      return {
        get: () => value,
        set: (next) => {
          value = next
          emit()
        },
        clear: () => {
          value = null
          emit()
        },
        subscribe: (fn) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      }
    })()

    function fmtChars(n) {
      const v = Number(n === undefined || n === null ? 0 : n)
      if (v >= 10000) return (v / 10000).toFixed(1) + ' 万字'
      return v + ' 字'
    }

    /** 提示词里是否留了某个占位符（system/user 任一处即可）。 */
    function heldPlaceholder(prompt, ph) {
      if (prompt === null || prompt === undefined) return false
      return String(prompt.system === undefined || prompt.system === null ? '' : prompt.system).includes(ph)
        || String(prompt.user === undefined || prompt.user === null ? '' : prompt.user).includes(ph)
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(String(text === undefined || text === null ? '' : text))
        return true
      } catch {
        return false
      }
    }

    // -----------------------------------------------------------------------
    // 样式：全部内联，不引 CSS 文件
    // 仓外插件若引 .module.css，就得自己复刻仓内的 lightningcss 编译步骤；
    // 这个工作台的视觉复杂度远没到需要那一步的程度。
    // -----------------------------------------------------------------------
    const C = {
      bg: '#0f1115',
      panel: '#171a21',
      panel2: '#1e222b',
      line: '#2a2f3a',
      text: '#e7e9ef',
      sub: '#98a1b1',
      faint: '#6b7484',
      accent: '#4c8dff',
      ok: '#3ddc84',
      warn: '#ffb454',
      err: '#ff6b6b',
    }

    const fontStack =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
    const monoStack = 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace'

    /** 工作台根容器：占满中列主面板（main 槽位），内部纵向 flex + 滚动。 */
    const S = {
      overlay: {
        flex: 1,
        minHeight: 0,
        background: C.bg,
        color: C.text,
        fontFamily: fontStack,
        fontSize: 13,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      },
      topbar: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderBottom: '1px solid ' + C.line,
        background: C.panel,
        flexShrink: 0,
      },
      title: { fontSize: 14, fontWeight: 600, letterSpacing: 0.2 },
      tabs: { display: 'flex', gap: 4, marginLeft: 12 },
      body: { flex: 1, minHeight: 0, display: 'flex' },
      col: { display: 'flex', flexDirection: 'column', minHeight: 0 },
      steps: {
        width: 236,
        flexShrink: 0,
        borderRight: '1px solid ' + C.line,
        background: C.panel,
        overflowY: 'auto',
        padding: '8px 8px 24px',
      },
      main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
      scroll: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 },
      card: {
        background: C.panel,
        border: '1px solid ' + C.line,
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
      },
      label: { fontSize: 11.5, color: C.sub, marginBottom: 4, display: 'block' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        background: C.panel2,
        color: C.text,
        border: '1px solid ' + C.line,
        borderRadius: 6,
        padding: '6px 8px',
        fontFamily: 'inherit',
        fontSize: 12.5,
        outline: 'none',
      },
      area: {
        width: '100%',
        boxSizing: 'border-box',
        background: C.panel2,
        color: C.text,
        border: '1px solid ' + C.line,
        borderRadius: 6,
        padding: '8px 10px',
        fontFamily: monoStack,
        fontSize: 12,
        lineHeight: 1.65,
        resize: 'vertical',
        outline: 'none',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      btn: {
        background: C.panel2,
        color: C.text,
        border: '1px solid ' + C.line,
        borderRadius: 6,
        padding: '5px 11px',
        fontSize: 12.5,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      btnPrimary: {
        background: C.accent,
        color: '#fff',
        border: '1px solid ' + C.accent,
        borderRadius: 6,
        padding: '5px 12px',
        fontSize: 12.5,
        fontFamily: 'inherit',
        cursor: 'pointer',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      },
      btnGhost: {
        background: 'transparent',
        color: C.sub,
        border: '1px solid transparent',
        borderRadius: 6,
        padding: '5px 9px',
        fontSize: 12.5,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid ' + C.line,
        color: C.sub,
      },
      step: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        color: C.text,
        border: '1px solid transparent',
        borderRadius: 6,
        padding: '7px 9px',
        marginBottom: 2,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 12.5,
      },
      stepActive: { background: C.panel2, borderColor: C.accent },
      pre: {
        background: C.panel2,
        border: '1px solid ' + C.line,
        borderRadius: 6,
        padding: 10,
        fontFamily: monoStack,
        fontSize: 12,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: 0,
        maxHeight: 520,
        overflowY: 'auto',
      },
      err: {
        background: 'rgba(255,107,107,.1)',
        border: '1px solid ' + C.err,
        color: C.err,
        borderRadius: 6,
        padding: '7px 10px',
        marginBottom: 10,
        fontSize: 12.5,
        whiteSpace: 'pre-wrap',
      },
      warn: {
        background: 'rgba(255,180,84,.1)',
        border: '1px solid ' + C.warn,
        color: C.warn,
        borderRadius: 6,
        padding: '7px 10px',
        marginBottom: 10,
        fontSize: 12.5,
      },
      dim: { color: C.sub, fontSize: 12, lineHeight: 1.7 },
    }

    function Btn(props) {
      const base = props.variant === 'primary' ? S.btnPrimary : props.variant === 'ghost' ? S.btnGhost : S.btn
      const style = Object.assign({}, base, props.style || {}, props.disabled === true ? { opacity: 0.45, cursor: 'not-allowed' } : {})
      return h(
        'button',
        {
          type: 'button',
          style,
          disabled: props.disabled === true,
          title: props.title,
          onClick: props.disabled === true ? undefined : props.onClick,
        },
        props.children,
      )
    }

    function Chip(props) {
      return h('span', { style: Object.assign({}, S.chip, props.style || {}) }, props.children)
    }

    function Field(props) {
      return h(
        'div',
        { style: { marginBottom: 10 } },
        props.label === undefined ? null : h('label', { style: S.label }, props.label),
        props.children,
      )
    }

    function Input(props) {
      return h('input', {
        type: props.type || 'text',
        style: Object.assign({}, S.input, props.style || {}),
        value: props.value,
        placeholder: props.placeholder,
        autoComplete: props.autoComplete,
        spellCheck: false,
        list: props.list,
        onKeyDown: props.onKeyDown,
        onChange: (e) => props.onChange(e.target.value),
      })
    }

    function Area(props) {
      return h('textarea', {
        style: Object.assign({}, S.area, { minHeight: props.minHeight || 90 }, props.style || {}),
        value: props.value,
        placeholder: props.placeholder,
        spellCheck: false,
        onChange: (e) => props.onChange(e.target.value),
      })
    }

    /** 行内样式：加粗 **x** / 行内代码 `x` / 斜体 *x*（用于最终定稿正文渲染）。 */
    function mdInline(text) {
      const nodes = []
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g
      let last = 0
      let m
      let k = 0
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) nodes.push(text.slice(last, m.index))
        const tok = m[0]
        if (tok.startsWith('**')) nodes.push(h('strong', { key: 'b' + k++ }, tok.slice(2, -2)))
        else if (tok.startsWith('`')) nodes.push(h('code', { key: 'c' + k++, style: { fontFamily: monoStack, background: C.panel2, padding: '1px 4px', borderRadius: 4 } }, tok.slice(1, -1)))
        else nodes.push(h('em', { key: 'i' + k++ }, tok.slice(1, -1)))
        last = m.index + tok.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    /** markdown → 只读视图：标题/段落/有序·无序列表/引用/表格/代码块/分割线。 */
    function renderMarkdown(text) {
      const lines = String(text === undefined || text === null ? '' : text).split('\n')
      const blocks = []
      let para = []
      let list = []
      let listOrdered = false
      let code = []
      let inCode = false
      let key = 0
      const flushPara = () => {
        if (para.length === 0) return
        blocks.push(h('p', { key: 'p' + key++, style: { margin: '0 0 10px', lineHeight: 1.75 } }, mdInline(para.join(' '))))
        para = []
      }
      const flushList = () => {
        if (list.length === 0) return
        const items = list.map((li, i) => h('li', { key: i, style: { marginBottom: 3 } }, mdInline(li)))
        blocks.push(listOrdered
          ? h('ol', { key: 'ol' + key++, style: { margin: '0 0 10px', paddingLeft: 22, lineHeight: 1.7 } }, items)
          : h('ul', { key: 'ul' + key++, style: { margin: '0 0 10px', paddingLeft: 20, lineHeight: 1.7 } }, items))
        list = []
        listOrdered = false
      }
      const flushCode = () => {
        if (code.length === 0) return
        blocks.push(h('pre', { key: 'code' + key++, style: { background: C.panel2, border: '1px solid ' + C.line, borderRadius: 6, padding: 10, fontFamily: monoStack, fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '0 0 10px' } }, code.join('\n')))
        code = []
        inCode = false
      }
      const splitRow = (s) => {
        let t = String(s).trim()
        if (t.startsWith('|')) t = t.slice(1)
        if (t.endsWith('|')) t = t.slice(0, -1)
        return t.split('|').map((c) => c.trim())
      }
      const renderTable = (head, rows) => {
        const th = (t, i) => h('th', { key: i, style: { border: '1px solid ' + C.line, padding: '5px 9px', fontSize: 12, fontWeight: 600, background: C.panel2, textAlign: 'left', lineHeight: 1.6 } }, mdInline(t))
        const td = (t, i) => h('td', { key: i, style: { border: '1px solid ' + C.line, padding: '5px 9px', fontSize: 12, lineHeight: 1.6, verticalAlign: 'top' } }, mdInline(t))
        return h('div', { key: 'tbl' + key++, style: { overflowX: 'auto', margin: '0 0 12px' } },
          h('table', { style: { borderCollapse: 'collapse', width: '100%', minWidth: 360 } },
            h('thead', null, h('tr', null, head.map(th))),
            h('tbody', null, rows.map((r, ri) => h('tr', { key: ri }, r.map(td))))))
      }
      let i = 0
      while (i < lines.length) {
        const raw = lines[i]
        const line = raw.replace(/\s+$/, '')

        const fence = /^\s*(\u0060{3}|~~~)/.exec(line)
        if (fence !== null) {
          flushPara(); flushList()
          if (!inCode) { inCode = true; code = [] }
          else { flushCode() }
          i++
          continue
        }
        if (inCode) { code.push(raw); i++; continue }

        if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
          flushPara(); flushList()
          blocks.push(h('hr', { key: 'hr' + key++, style: { border: 'none', borderTop: '1px solid ' + C.line, margin: '14px 0' } }))
          i++
          continue
        }

        if (/^\s*\|.*\|\s*$/.test(line)) {
          const next = lines[i + 1]
          const sep = next === undefined ? '' : next.replace(/\s+$/, '')
          if (/^\s*\|?[\s:|-]+\|?\s*$/.test(sep) && sep.includes('-')) {
            flushPara(); flushList()
            const head = splitRow(line)
            const rows = []
            let j = i + 2
            while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j].replace(/\s+$/, ''))) {
              rows.push(splitRow(lines[j]))
              j++
            }
            blocks.push(renderTable(head, rows))
            i = j
            continue
          }
          if (list.length > 0) flushList()
          para.push(line.trim())
          i++
          continue
        }

        if (line.trim() === '') { flushPara(); flushList(); i++; continue }

        const hm = /^(#{1,4})\s+(.+)$/.exec(line)
        if (hm !== null) {
          flushPara(); flushList()
          const sizes = { 1: 21, 2: 18, 3: 16, 4: 14 }
          blocks.push(h('div', { key: 'h' + key++, style: { fontSize: sizes[hm[1].length], fontWeight: 600, margin: hm[1].length === 1 ? '4px 0 14px' : '14px 0 8px', lineHeight: 1.4 } }, mdInline(hm[2])))
          i++
          continue
        }

        const olm = /^\s*\d+[.)]\s+(.+)$/.exec(line)
        if (olm !== null) {
          flushPara()
          if (list.length > 0 && listOrdered) { list.push(olm[1]) }
          else { flushList(); list = [olm[1]]; listOrdered = true }
          i++
          continue
        }

        const lm = /^\s*[-*]\s+(.+)$/.exec(line)
        if (lm !== null) {
          flushPara()
          if (list.length > 0 && !listOrdered) { list.push(lm[1]) }
          else { flushList(); list = [lm[1]]; listOrdered = false }
          i++
          continue
        }

        if (/^\s*>\s?/.test(line)) {
          flushPara(); flushList()
          blocks.push(h('div', { key: 'q' + key++, style: { borderLeft: '3px solid ' + C.line, paddingLeft: 10, color: C.sub, margin: '0 0 10px', lineHeight: 1.7 } }, mdInline(line.replace(/^\s*>\s?/, ''))))
          i++
          continue
        }

        if (list.length > 0) flushList()
        para.push(line.trim())
        i++
      }
      flushPara()
      flushList()
      flushCode()
      if (blocks.length === 0) return h('div', { style: { color: C.faint } }, '（空）')
      return h('div', null, blocks)
    }
