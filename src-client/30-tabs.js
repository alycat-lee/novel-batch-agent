// -----------------------------------------------------------------------
    // 模版页：查看 / 编辑 / 删除结构模版
    // -----------------------------------------------------------------------

    function TemplateTab(props) {
      const { boot, setBoot, setErr, flash, detail } = props
      const [picked, setPicked] = useState(boot.templates.length > 0 ? boot.templates[0].id : '')
      const [edit, setEdit] = useState(null)

      const template = boot.templates.find((t) => t.id === picked) || null

      useEffect(() => {
        if (template === null) {
          setEdit(null)
          return
        }
        setEdit({
          id: template.id,
          name: template.name,
          genre: template.genre,
          sections: (template.sections || []).join('\n'),
          constraints: (template.constraints || []).join('\n'),
          note: '',
        })
      }, [picked, boot.templates])

      const save = async () => {
        if (edit === null) return
        try {
          const data = await api('template', {
            id: edit.id,
            name: edit.name,
            genre: edit.genre,
            sections: edit.sections.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
            constraints: edit.constraints.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
            note: edit.note,
          })
          setBoot(Object.assign({}, boot, { templates: data.templates }))
          setPicked(data.id)
          flash('模版已保存')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: Object.assign({}, S.steps, { width: 280 }) },
          h('div', { style: { color: C.faint, fontSize: 11, padding: '0 9px 8px' } },
            '共 ' + boot.templates.length + ' 个模版（内置 + 自定义）'),
          ...boot.templates.map((t) =>
            h(
              'button',
              {
                key: t.id,
                type: 'button',
                style: Object.assign({}, S.step, picked === t.id ? S.stepActive : {}),
                onClick: () => setPicked(t.id),
              },
              h('div', { style: { fontWeight: picked === t.id ? 600 : 400 } }, t.name),
              h('div', { style: { color: C.faint, fontSize: 11, marginTop: 2 } },
                (t.genre === '' ? '通用' : t.genre) + ' · ' + (t.source === 'builtin' ? '内置' : '自定义') +
                ' · ' + (t.sections || []).length + ' 节'),
            ),
          ),
          boot.templates.length === 0
            ? h('div', { style: { color: C.faint, fontSize: 11.5, padding: 9, lineHeight: 1.7 } },
                '没有模版。可以在「样例→模版」页粘一篇样例，让模型提炼一套骨架。')
            : null,
        ),
        h(
          'div',
          { style: S.scroll },
          edit === null
            ? h('div', { style: S.dim }, '左侧选一个模版。')
            : h('div', { style: S.card },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
                  h('span', { style: { fontWeight: 600 } }, '编辑模版'),
                  template !== null && template.source === 'builtin'
                    ? h(Chip, null, '内置：保存会生成同 id 的自定义模版覆盖它')
                    : null,
                  h('div', { style: { flex: 1 } }),
                  h(Btn, { variant: 'primary', onClick: () => void save() }, '保存'),
                ),
                h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
                  h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '模版 id（英文小写短横线）' },
                    h(Input, { value: edit.id, onChange: (v) => setEdit(Object.assign({}, edit, { id: v })) }))),
                  h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '名称' },
                    h(Input, { value: edit.name, onChange: (v) => setEdit(Object.assign({}, edit, { name: v })) }))),
                  h('div', { style: { flex: '0 1 160px' } }, h(Field, { label: '适用类型' },
                    h('select', {
                      style: Object.assign({}, S.input, { cursor: 'pointer' }),
                      value: edit.genre,
                      onChange: (e) => setEdit(Object.assign({}, edit, { genre: e.target.value })),
                    },
                      h('option', { value: '' }, '通用'),
                      ...boot.genres.map((g) => h('option', { key: g.id, value: g.id }, g.label)),
                    ))),
                ),
                h(Field, { label: '骨架：每行一节，格式「节名｜这一节要完成的动作」' },
                  h(Area, { value: edit.sections, minHeight: 160, onChange: (v) => setEdit(Object.assign({}, edit, { sections: v })) })),
                h(Field, { label: '硬约束：每行一条，要能被机械判定（字数 / 段长 / 条数）' },
                  h(Area, { value: edit.constraints, minHeight: 100, onChange: (v) => setEdit(Object.assign({}, edit, { constraints: v })) })),
                h(Field, { label: '说明（可选）' },
                  h(Area, { value: edit.note, minHeight: 64, onChange: (v) => setEdit(Object.assign({}, edit, { note: v })) })),
                h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.7 } },
                  '套用方式：在「写作」页新建作品时选它，或在作品里点「生成草稿」时由项目默认模版带入。' +
                  '模版只影响结构（分节、篇幅、硬约束），不影响文风。'),
              ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // 样例→模版页：粘一篇样例，提炼出结构骨架
    // -----------------------------------------------------------------------

    function SampleTab(props) {
      const { boot, setBoot, setErr, flash, defaultGenre } = props
      const [genre, setGenre] = useState(defaultGenre || 'novel')
      const [sample, setSample] = useState('')
      const [extra, setExtra] = useState('')
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState('')
      const [parsed, setParsed] = useState(null)

      /**
       * 解析模型返回的 frontmatter 块。
       * 刻意在前端也解析一遍（宿主端解析在 templates.js）：前端要即时预览，
       * 让用户先看到「提炼出了哪几节」再决定要不要保存——直接写盘会污染模版列表。
       */
      const parse = (text) => {
        const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || '').replace(/^\s+/, ''))
        if (m === null) return null
        const meta = { id: '', name: '', genre: genre, sections: [], constraints: [], note: '' }
        let list = null
        for (const line of m[1].split(/\r?\n/)) {
          if (line.trim() === '') continue
          const item = /^\s*-\s+(.*)$/.exec(line)
          if (item !== null && list !== null) {
            meta[list].push(item[1].trim())
            continue
          }
          const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
          if (kv === null) continue
          if (kv[1] === 'sections' || kv[1] === 'constraints') {
            list = kv[1]
            continue
          }
          list = null
          if (kv[1] === 'id' || kv[1] === 'name' || kv[1] === 'genre') meta[kv[1]] = kv[2].trim()
        }
        return meta
      }

      const analyze = async () => {
        if (sample.trim() === '') {
          setErr('请先粘贴一篇样例')
          return
        }
        setBusy(true)
        setErr('')
        setResult('')
        setParsed(null)
        try {
          const data = await api('analyze', { genre, sample, extra })
          setResult(data.text)
          const p = parse(data.text)
          setParsed(p)
          if (data.warning !== '') flash(data.warning)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      const save = async () => {
        if (parsed === null) return
        try {
          const data = await api('template', {
            id: parsed.id || parsed.name || 'from-sample',
            name: parsed.name || '样例提炼模版',
            genre: parsed.genre || genre,
            sections: parsed.sections,
            constraints: parsed.constraints,
            note: parsed.note,
          })
          setBoot(Object.assign({}, boot, { templates: data.templates }))
          flash('模版已保存到模版库：' + data.id)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      return h(
        'div',
        { style: S.scroll },
        h('div', { style: { maxWidth: 980 } },
          h('div', { style: S.card },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '从样例提炼结构模版'),
            h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.8, marginBottom: 10 } },
              '粘一篇你认可的样例，模型只提取**结构**：有哪几节、每节干什么、篇幅与硬约束。' +
              '它被明确要求不复制样例的原句、比喻与专有名词——所以提炼出的模版可以直接套到新选题上，' +
              '而不会把别人的内容带进来。'),
            h(Field, { label: '样例类型' },
              h('div', { style: S.row },
                ...boot.genres.map((g) =>
                  h(Btn, { key: g.id, variant: genre === g.id ? 'primary' : undefined, onClick: () => setGenre(g.id) }, g.label)))),
            h(Field, { label: '样例正文' },
              h(Area, { value: sample, minHeight: 240, placeholder: '把样例全文粘进来（超过 20000 字会被截断）', onChange: setSample })),
            h(Field, { label: '额外要求（可选）' },
              h(Input, { value: extra, placeholder: '例如：只关心开头三节的结构', onChange: setExtra })),
            h('div', { style: S.row },
              h(Btn, { variant: 'primary', disabled: busy, onClick: () => void analyze() }, busy ? '分析中…' : '提炼结构模版'),
              h('span', { style: { color: C.faint, fontSize: 11.5 } }, '一次分析约 1-2k token 输出。'),
            ),
          ),

          result === '' ? null : h('div', { style: S.card },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
              h('span', { style: { fontWeight: 600 } }, '提炼结果'),
              parsed === null ? h(Chip, null, '未识别出模版块') : h(Chip, null, (parsed.sections || []).length + ' 节 · ' + (parsed.constraints || []).length + ' 条约束'),
              h('div', { style: { flex: 1 } }),
              h(Btn, { variant: 'primary', disabled: parsed === null, onClick: () => void save() }, '保存到模版库'),
              h(Btn, { onClick: () => void copyText(result).then((ok) => flash(ok ? '已复制' : '复制失败')) }, '复制'),
            ),
            parsed === null
              ? h('div', { style: S.warn }, '模型没有按 frontmatter 格式输出，无法自动保存。可以直接复制下面的文字，去「模版」页手工新建一个。')
              : h('div', { style: { marginBottom: 8 } },
                  h('div', { style: { color: C.sub, fontSize: 12, marginBottom: 4 } }, '骨架预览：'),
                  ...(parsed.sections || []).map((s, i) =>
                    h('div', { key: 's' + i, style: { fontSize: 12, lineHeight: 1.7, color: C.text } }, i + 1 + '. ' + s)),
                  (parsed.constraints || []).length === 0 ? null : h('div', { style: { color: C.sub, fontSize: 12, margin: '8px 0 4px' } }, '硬约束：'),
                  ...(parsed.constraints || []).map((s, i) =>
                    h('div', { key: 'c' + i, style: { fontSize: 12, lineHeight: 1.7, color: C.text } }, '- ' + s)),
                ),
            h('pre', { style: S.pre }, result),
          ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // 风格页：从样例学习风格（蒸馏风格画像）+ 编辑风格画像
    // -----------------------------------------------------------------------

    /** 风格画像七维度：与宿主侧 styles.js 的 STYLE_DIMENSIONS 一一对应。 */
    const STYLE_DIMS = [
      { id: 'pov', label: '叙事视角' },
      { id: 'rhythm', label: '句子节奏' },
      { id: 'dialogue', label: '对话风格' },
      { id: 'description', label: '描写密度' },
      { id: 'tone', label: '情绪调性' },
      { id: 'chapterRhythm', label: '章节节奏' },
      { id: 'beatRhythm', label: '爽点节奏' },
    ]

    function StyleTab(props) {
      const { boot, setBoot, setErr, flash, defaultGenre } = props
      const styles = Array.isArray(boot.styles) ? boot.styles : []
      const [picked, setPicked] = useState(styles.length > 0 ? styles[0].id : '')
      const [edit, setEdit] = useState(null)
      const style = styles.find((s) => s.id === picked) || null

      useEffect(() => {
        if (style === null) {
          setEdit(null)
          return
        }
        setEdit({
          id: style.id,
          name: style.name,
          genre: style.genre,
          tags: (style.tags || []).join('\n'),
          pov: style.pov || '',
          rhythm: style.rhythm || '',
          dialogue: style.dialogue || '',
          description: style.description || '',
          tone: style.tone || '',
          chapterRhythm: style.chapterRhythm || '',
          beatRhythm: style.beatRhythm || '',
        })
      }, [picked, boot.styles])

      const save = async () => {
        if (edit === null) return
        try {
          const data = await api('style', {
            id: edit.id,
            name: edit.name,
            genre: edit.genre,
            tags: edit.tags.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
            pov: edit.pov,
            rhythm: edit.rhythm,
            dialogue: edit.dialogue,
            description: edit.description,
            tone: edit.tone,
            chapterRhythm: edit.chapterRhythm,
            beatRhythm: edit.beatRhythm,
            note: '',
          })
          setBoot(Object.assign({}, boot, { styles: data.styles }))
          setPicked(data.id)
          flash('风格画像已保存')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      const remove = async () => {
        if (edit === null) return
        try {
          const data = await api('style', { action: 'delete', id: edit.id })
          setBoot(Object.assign({}, boot, { styles: data.styles }))
          setPicked('')
          setEdit(null)
          flash('风格画像已删除')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      // 从样例学习风格（仿 SampleTab）：分析 → 前端解析 frontmatter 预览 → 保存到风格库
      const [sample, setSample] = useState('')
      const [extra, setExtra] = useState('')
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState('')
      const [parsed, setParsed] = useState(null)
      const [path, setPath] = useState('')
      const [fileInfo, setFileInfo] = useState(null)

      const parseStyleFront = (text) => {
        const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || '').replace(/^\s+/, ''))
        if (m === null) return null
        const meta = { id: '', name: '', genre: defaultGenre || 'novel', tags: [], pov: '', rhythm: '', dialogue: '', description: '', tone: '', chapterRhythm: '', beatRhythm: '' }
        let list = null
        for (const line of m[1].split(/\r?\n/)) {
          if (line.trim() === '') continue
          const item = /^\s*-\s+(.*)$/.exec(line)
          if (item !== null && list === 'tags') {
            meta.tags.push(item[1].trim())
            continue
          }
          const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
          if (kv === null) continue
          if (kv[1] === 'tags') {
            list = 'tags'
            if (kv[2].trim() !== '') meta.tags.push(kv[2].trim())
            continue
          }
          list = null
          if (kv[1] === 'id' || kv[1] === 'name' || kv[1] === 'genre') meta[kv[1]] = kv[2].trim()
          else if (STYLE_DIMS.some((d) => d.id === kv[1])) meta[kv[1]] = kv[2].trim()
        }
        return meta
      }

      const analyze = async () => {
        if (sample.trim() === '') {
          setErr('请先粘贴一篇样例小说')
          return
        }
        setBusy(true)
        setErr('')
        setResult('')
        setParsed(null)
        try {
          const data = await api('analyze-style', { genre: defaultGenre || 'novel', sample, extra })
          setResult(data.text)
          const p = parseStyleFront(data.text)
          setParsed(p)
          if (data.warning !== '') flash(data.warning)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      const analyzeFile = async () => {
        if (path.trim() === '') {
          setErr('请填写小说文件的完整路径（txt / md 均可）')
          return
        }
        setBusy(true)
        setErr('')
        setResult('')
        setParsed(null)
        setFileInfo(null)
        try {
          const data = await api('analyze-style', { genre: defaultGenre || 'novel', path: path.trim(), extra })
          setResult(data.text)
          const p = parseStyleFront(data.text)
          setParsed(p)
          if (data.totalChars !== undefined) setFileInfo({ totalChars: data.totalChars, excerpts: data.excerpts })
          if (data.warning !== '') flash(data.warning)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      const saveSample = async () => {
        if (parsed === null) return
        try {
          const data = await api('style', {
            id: parsed.id || parsed.name || 'from-sample',
            name: parsed.name || '样例风格画像',
            genre: parsed.genre || defaultGenre || 'novel',
            tags: parsed.tags,
            pov: parsed.pov,
            rhythm: parsed.rhythm,
            dialogue: parsed.dialogue,
            description: parsed.description,
            tone: parsed.tone,
            chapterRhythm: parsed.chapterRhythm,
            beatRhythm: parsed.beatRhythm,
            note: '',
          })
          setBoot(Object.assign({}, boot, { styles: data.styles }))
          setPicked(data.id)
          flash('风格画像已保存：' + data.id)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: Object.assign({}, S.steps, { width: 280 }) },
          h('div', { style: { color: C.faint, fontSize: 11, padding: '0 9px 8px' } },
            '共 ' + styles.length + ' 个风格画像'),
          ...styles.map((s) =>
            h(
              'button',
              {
                key: s.id,
                type: 'button',
                style: Object.assign({}, S.step, picked === s.id ? S.stepActive : {}),
                onClick: () => setPicked(s.id),
              },
              h('div', { style: { fontWeight: picked === s.id ? 600 : 400 } }, s.name),
              h('div', { style: { color: C.faint, fontSize: 11, marginTop: 2 } },
                (s.genre === '' ? '通用' : s.genre) + ' · ' + (s.tags || []).join('、')),
            ),
          ),
          styles.length === 0
            ? h('div', { style: { color: C.faint, fontSize: 11.5, padding: 9, lineHeight: 1.7 } },
                '没有风格画像。在右侧「从样例学习风格」粘一篇样例小说，让模型提炼一套文风规律。')
            : null,
        ),
        h(
          'div',
          { style: S.scroll },
          h('div', { style: { maxWidth: 980 } },
            h('div', { style: S.card },
              h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '从样例学习风格'),
              h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.8, marginBottom: 10 } },
                '粘一篇你认可的小说样例，模型只提炼**文风规律**：叙事视角、句子节奏、对话风格、描写密度、情绪调性、章节节奏、爽点节奏，外加风格标签。' +
                '它被明确要求不复制样例的原句、比喻与专有名词——只存可迁移的风格，不存原文。'),
              h(Field, { label: '样例正文' },
                h(Area, { value: sample, minHeight: 220, placeholder: '把样例小说粘进来（超过 20000 字会被截断）', onChange: setSample })),
              h(Field, { label: '额外要求（可选）' },
                h(Input, { value: extra, placeholder: '例如：重点提炼对话与爽点节奏', onChange: setExtra })),
              h('div', { style: S.row },
                h(Btn, { variant: 'primary', disabled: busy, onClick: () => void analyze() }, busy ? '分析中…' : '提炼风格画像'),
                h('span', { style: { color: C.faint, fontSize: 11.5 } }, '一次分析约 1-2k token 输出。'),
              ),
              h('div', { style: { borderTop: '1px solid ' + C.line, margin: '12px 0', paddingTop: 10 } },
                h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, '大文件（整本小说）'),
                h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.8, marginBottom: 8 } },
                  '几 M 的整本小说不用整本粘贴：填文件路径，插件会均匀采样开篇 / 中段 / 结尾共 6 段，' +
                  '逐段提炼后合并成一份全书统一的风格画像（约 7 次调用，需 1-2 分钟）。'),
                h('div', { style: S.row },
                  h(Input, { value: path, placeholder: '小说文件的完整路径，例如 C:/books/xianxia.txt', onChange: setPath, style: { flex: 1 } }),
                  h(Btn, { variant: 'primary', disabled: busy, onClick: () => void analyzeFile() }, busy ? '提炼中…' : '从文件提炼风格'),
                ),
                fileInfo === null ? null : h('div', { style: { color: C.faint, fontSize: 11.5, marginTop: 6 } },
                  '全文约 ' + fileInfo.totalChars + ' 字 · 采样 ' + fileInfo.excerpts + ' 段'),
              ),
              result === '' ? null : h('div', { style: { marginTop: 10 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                  h('span', { style: { fontWeight: 600 } }, '提炼结果'),
                  parsed === null ? h(Chip, null, '未识别出画像块') : h(Chip, null, (parsed.tags || []).length + ' 标签 · ' + STYLE_DIMS.filter((d) => parsed[d.id]).length + ' 维度'),
                  h('div', { style: { flex: 1 } }),
                  h(Btn, { variant: 'primary', disabled: parsed === null, onClick: () => void saveSample() }, '保存到风格库'),
                  h(Btn, { onClick: () => void copyText(result).then((ok) => flash(ok ? '已复制' : '复制失败')) }, '复制'),
                ),
                parsed === null
                  ? h('div', { style: S.warn }, '模型没有按 frontmatter 格式输出，无法自动保存。可以直接复制下面的文字，去下方「编辑风格画像」手工新建一个。')
                  : h('div', { style: { marginBottom: 8 } },
                      ...STYLE_DIMS.map((d, i) =>
                        h('div', { key: 'd' + i, style: { fontSize: 12, lineHeight: 1.7, color: C.text } }, d.label + '：' + (parsed[d.id] || '未识别')))),
                h('pre', { style: S.pre }, result),
              ),
            ),
            h('div', { style: S.card },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
                h('span', { style: { fontWeight: 600 } }, '编辑风格画像'),
                h('div', { style: { flex: 1 } }),
                edit !== null ? h(Btn, { variant: 'ghost', onClick: () => void remove() }, '删除') : null,
                h(Btn, { variant: 'primary', disabled: edit === null, onClick: () => void save() }, '保存'),
              ),
              edit === null
                ? h('div', { style: S.dim }, '左侧选一个风格画像，或在上方「从样例学习风格」提炼后保存。')
                : h('div', null,
                    h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
                      h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '画像 id（英文小写短横线）' },
                        h(Input, { value: edit.id, onChange: (v) => setEdit(Object.assign({}, edit, { id: v })) }))),
                      h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '名称' },
                        h(Input, { value: edit.name, onChange: (v) => setEdit(Object.assign({}, edit, { name: v })) }))),
                      h('div', { style: { flex: '0 1 160px' } }, h(Field, { label: '适用类型' },
                        h('select', {
                          style: Object.assign({}, S.input, { cursor: 'pointer' }),
                          value: edit.genre,
                          onChange: (e) => setEdit(Object.assign({}, edit, { genre: e.target.value })),
                        },
                          h('option', { value: '' }, '通用'),
                          ...boot.genres.map((g) => h('option', { key: g.id, value: g.id }, g.label)),
                        ))),
                    ),
                    h(Field, { label: '风格标签：每行一个（用于按标签匹配风格画像）' },
                      h(Area, { value: edit.tags, minHeight: 70, onChange: (v) => setEdit(Object.assign({}, edit, { tags: v })) })),
                    ...STYLE_DIMS.map((d) =>
                      h(Field, { label: d.label },
                        h(Input, { value: edit[d.id], placeholder: '例如：短句打点 / 口语化 / 低密度', onChange: (v) => setEdit(Object.assign({}, edit, { [d.id]: v })) }))),
                  ),
            ),
          ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // 设置页：落盘根目录 / 模型路由 / 润色（含去AI化）清单
    // -----------------------------------------------------------------------

    function SettingsTab(props) {
      const { boot, setBoot, setErr, flash } = props
      const [root, setRoot] = useState(boot.config.root)
      const [provider, setProvider] = useState(boot.config.provider)
      const [model, setModel] = useState(boot.config.model)
      const [maxTokens, setMaxTokens] = useState(String(boot.config.maxTokens))
      const [busy, setBusy] = useState(false)
      // 番茄发布/登录：登录态目录、解释器、站点书名
      const [pubProfile, setPubProfile] = useState(boot.config.publishProfile || '')
      const [pubPython, setPubPython] = useState(boot.config.publishPython || '')
      const [pubBook, setPubBook] = useState(boot.config.publishBookName || '')
      const [fqBusy, setFqBusy] = useState('')

      const save = async () => {
        setBusy(true)
        try {
          const data = await api('config', {
            patch: {
              root: root.trim(),
              provider: provider.trim(),
              model: model.trim(),
              maxTokens: Number(maxTokens) || 0,
            },
          })
          if (data.warning !== '') flash(data.warning)
          else flash('配置已写入')
          const fresh = await api('state')
          setBoot(fresh)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      const mkdir = async () => {
        try {
          const data = await api('mkdir', { rel: '' })
          flash('目录已就绪：' + data.path)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      /** 只提交番茄相关配置项（不含 root/模型，避免误覆盖）。 */
      const savePublish = async () => {
        setBusy(true)
        try {
          const data = await api('config', {
            patch: {
              publishProfile: pubProfile.trim(),
              publishPython: pubPython.trim(),
              publishBookName: pubBook.trim(),
            },
          })
          flash(data.warning !== '' ? data.warning : '番茄配置已写入')
          setBoot(await api('state'))
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      /**
       * 调一次登录脚本动作并把结论用一句话讲清楚。
       * probe/keepalive/restore 是同步的（等它跑完），login 只是弹窗等扫码（后台跑，轮询状态）。
       */
      const fqCall = async (action, label) => {
        setFqBusy(action)
        try {
          const data = await api('fanqie', { action })
          const r = data.result === undefined || data.result === null ? {} : data.result
          if (action === 'login') {
            flash('已弹出浏览器：请在 ' + data.minutes + ' 分钟内扫码登录（登录成功后自动保存登录态）')
          } else if (action === 'abort') {
            flash(data.killed === true ? '已中止登录窗口' : '当前没有在跑的登录窗口')
          } else {
            const verdict = r.loggedIn === true ? '已登录' : (r.loggedIn === false ? '未登录' : '无法判定')
            const who = r.authorName !== undefined && r.authorName !== '' ? ' · ' + r.authorName : ''
            const why = r.reason !== undefined && r.reason !== '' ? '（' + r.reason + '）' : ''
            flash(label + '：' + verdict + who + why)
          }
          setBoot(await api('state'))
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setFqBusy('')
        }
      }

      // 登录窗口开着时每 3 秒回读一次状态（脚本会边等边往日志里写进度）
      useEffect(() => {
        const fq = boot.fanqie
        if (fq === undefined || fq.running !== true) return undefined
        const timer = setInterval(() => {
          void api('state').then(setBoot).catch(() => { /* 轮询失败不打断界面 */ })
        }, 3000)
        return () => clearInterval(timer)
      }, [boot.fanqie === undefined ? false : boot.fanqie.running])

      const fq = boot.fanqie === undefined ? {} : boot.fanqie
      const fqLeft = fq.expiresInDays === null || fq.expiresInDays === undefined ? '' : '（剩 ' + Number(fq.expiresInDays).toFixed(1) + ' 天）'
      const fqChip = fq.running === true
        ? h(Chip, null, fq.jobAction === 'login' ? '等待扫码登录中…' : '检查中…')
        : fq.ready !== true
          ? h(Chip, { style: { borderColor: C.err, color: C.err } }, '未配置登录态目录')
          : fq.loggedIn === true
            ? h(Chip, { style: { borderColor: C.ok, color: C.ok } }, '已登录' + (fq.authorName !== '' ? ' · ' + fq.authorName : '') + fqLeft)
            : fq.loggedIn === false
              ? h(Chip, { style: { borderColor: C.err, color: C.err } }, '未登录')
              : h(Chip, null, '还没探活')
      const fqLog = fq.tail === undefined ? [] : fq.tail.slice(-10)

      return h(
        'div',
        { style: S.scroll },
        h('div', { style: { maxWidth: 760 } },
          h('div', { style: S.card },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, '落盘位置'),
            h(Field, { label: '落盘根目录（每个作品是它下面的一个子目录）' },
              h(Input, { value: root, onChange: setRoot })),
            h('div', { style: S.row },
              h(Btn, { onClick: () => void mkdir() }, '建立目录'),
              h(Btn, { variant: 'primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
            ),
            h('div', { style: { color: C.faint, fontSize: 11.5, marginTop: 8, lineHeight: 1.7 } },
              '作品目录结构：<根>/<作品名>/steps/01-作品定位.md … chapters/第001章-章名.md；' +
              '模版与提示词覆盖存在 <根>/.dsh-writer-m/。所有写盘路径都会做越界校验，' +
              '作品名里的 ../ 会被拒绝而不是写到根目录外面。'),
          ),

          h('div', { style: S.card },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, '模型路由'),
            h('div', { style: S.row },
              h('span', { style: { color: C.sub } }, '当前生效：'),
              boot.llm.route === null
                ? h(Chip, { style: { borderColor: C.err, color: C.err } }, '未配置')
                : h(Chip, null, boot.llm.route.provider + ' / ' + boot.llm.route.model),
            ),
            h('div', { style: { height: 10 } }),
            h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
              h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: 'provider（留空 = 用 dsh 默认模型）' },
                h(Input, { value: provider, placeholder: '例如 deepseek-web', onChange: setProvider }))),
              h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: 'model' },
                h(Input, { value: model, placeholder: '例如 deepseek-reasoner', onChange: setModel }))),
              h('div', { style: { flex: '0 1 160px' } }, h(Field, { label: '单次最大输出 token' },
                h(Input, { value: maxTokens, onChange: (v) => setMaxTokens(v.replace(/[^0-9]/g, '')) }))),
            ),
            h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.7 } },
              '中文一章 3000 字约需 4500+ 输出 token。设小了会被截断：插件会在同一份提示词下自动续写' +
              '（最多 3 次；卷大纲、长章节常靠它补全），续写多次仍没写完才明确提示「被截断」，绝不把半截稿当成功。'),
          ),

          h('div', { style: S.card },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '润色自检清单（六维度，含去 AI 化）'),
            h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.8, marginBottom: 8 } },
              '「润色」步骤会把这六条作为判定清单交给模型，要求按清单逐项判定、只对命中的地方做最小改写——' +
              '而不是整篇重写一遍（整篇重写会和前文一致性打架，是现有工具的常见翻车点）。'),
            ...boot.deai.map((d, i) =>
              h('div', { key: d.id, style: { fontSize: 12, lineHeight: 1.8 } },
                h('span', { style: { color: C.accent } }, (i + 1) + '. ' + d.label + '　'),
                h('span', { style: { color: C.sub } }, d.hint),
              ),
            ),
          ),

          h('div', { style: S.card },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, '番茄小说登录态（登录一次，之后保持登录）'),
            h('div', { style: S.row },
              h('span', { style: { color: C.sub } }, '当前状态：'),
              fqChip,
              fq.checkedAt !== undefined && fq.checkedAt !== ''
                ? h('span', { style: { color: C.faint, fontSize: 11.5 } },
                    '上次检查 ' + fq.checkedAt + (fq.expiresAt !== undefined && fq.expiresAt !== '' ? ' · 最早到期的登录 cookie：' + fq.nearestCookie + ' ' + fq.expiresAt + fqLeft : ''))
                : null,
            ),
            h('div', { style: { height: 10 } }),
            h(Field, { label: '登录态目录（Playwright 持久化 profile，发布章节也用它）' },
              h(Input, { value: pubProfile, placeholder: '例如 O:/DeepSeek Plugin/fanqie-data/writer-profile', onChange: setPubProfile })),
            h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
              h('div', { style: { flex: '1 1 240px' } }, h(Field, { label: 'python 解释器（留空 = 用 PATH 上的 python）' },
                h(Input, { value: pubPython, placeholder: '例如 D:/Python/python.exe', onChange: setPubPython }))),
              h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '番茄站点书名（留空 = 用作品名匹配同名书）' },
                h(Input, { value: pubBook, onChange: setPubBook }))),
            ),
            h('div', { style: S.row },
              h(Btn, { variant: 'primary', disabled: fqBusy !== '', onClick: () => void fqCall('probe', '探活') }, fqBusy === 'probe' ? '检查中…' : '探活（看还在不在）'),
              h(Btn, { disabled: fqBusy !== '' || fq.running === true, onClick: () => void fqCall('login', '登录') }, fqBusy === 'login' ? '启动中…' : '登录番茄（弹浏览器扫码）'),
              h(Btn, { disabled: fqBusy !== '' || fq.running === true, onClick: () => void fqCall('keepalive', '保活') }, fqBusy === 'keepalive' ? '保活中…' : '保活续期'),
              h(Btn, { disabled: fqBusy !== '' || fq.running === true, onClick: () => void fqCall('restore', '恢复') }, fqBusy === 'restore' ? '恢复中…' : '从快照恢复'),
              fq.running === true ? h(Btn, { onClick: () => void fqCall('abort', '中止') }, '中止登录') : null,
              h(Btn, { variant: 'primary', disabled: busy, onClick: () => void savePublish() }, '保存番茄配置'),
            ),
            h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.7, marginTop: 8 } },
              '「登录番茄」打开一个浏览器窗口，用番茄小说 App 扫码即可；登录成功后脚本把登录态写进上面这个目录（发布章节用的就是它），并另存一份会话快照 ' +
              (fq.statePath === undefined ? '' : fq.statePath) + '。',
              h('br', null),
              '登录态丢了（换了目录、cookie 被清）先点「从快照恢复」：快照没过期就能免扫码恢复，不行再点「登录番茄」重扫。' +
              '「保活续期」会访问首页与作家后台刷新 cookie 并更新快照。探活/登录与发布互斥——同一个目录不能同时开两个浏览器，否则会把登录态写坏。'),
            fqLog.length > 0 ? h('pre', { style: S.pre }, fqLog.join(String.fromCharCode(10))) : null,
          ),
        ),
      )
    }
