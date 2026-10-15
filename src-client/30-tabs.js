// -----------------------------------------------------------------------
    // 模版页：查看 / 编辑 / 删除结构模版
    // -----------------------------------------------------------------------

    function TemplateTab(props) {
      const { boot, setBoot, setErr, flash, genreFilter } = props
      const filterGenre = typeof genreFilter === 'string' && genreFilter !== '' ? genreFilter : 'novel'
      const genreLabel = ((boot.genres.find((g) => g.id === filterGenre) || {}).label) || filterGenre
      const templates = boot.templates.filter((t) => t.genre === '' || t.genre === filterGenre)
      const [picked, setPicked] = useState(templates.length > 0 ? templates[0].id : '')
      const [edit, setEdit] = useState(null)
      /** true = 手写新建，不被左侧选中项的 useEffect 覆盖 */
      const [creating, setCreating] = useState(false)

      useEffect(() => {
        setCreating(false)
        if (templates.some((t) => t.id === picked)) return
        setPicked(templates.length > 0 ? templates[0].id : '')
      }, [filterGenre, boot.templates])

      const template = creating ? null : (templates.find((t) => t.id === picked) || null)

      useEffect(() => {
        if (creating) return
        if (template === null) {
          setEdit(null)
          return
        }
        setEdit({
          id: template.id,
          name: template.name,
          genre: template.genre === '' ? filterGenre : template.genre,
          sections: (template.sections || []).join('\n'),
          constraints: (template.constraints || []).join('\n'),
          note: '',
        })
      }, [picked, boot.templates, filterGenre, creating])

      const startNew = () => {
        setCreating(true)
        setPicked('')
        setEdit({
          id: filterGenre + '-custom',
          name: '',
          genre: filterGenre,
          sections: '',
          constraints: '',
          note: '',
        })
      }

      const save = async () => {
        if (edit === null) return
        const id = String(edit.id || '').trim()
        const name = String(edit.name || '').trim()
        if (id === '') {
          setErr('请填写模版 id（英文小写短横线，例如 novel-my-tpl）')
          return
        }
        if (name === '') {
          setErr('请填写模版名称')
          return
        }
        try {
          const data = await api('template', {
            id,
            name,
            genre: edit.genre || filterGenre,
            sections: edit.sections.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
            constraints: edit.constraints.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
            note: edit.note,
          })
          setBoot(Object.assign({}, boot, { templates: data.templates }))
          setCreating(false)
          setPicked(data.id)
          flash(creating ? '手写模版已新建' : '模版已保存')
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
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 9px 8px' } },
            h('div', { style: { color: C.faint, fontSize: 11, flex: 1 } },
              genreLabel + '模版 · 共 ' + templates.length + ' 个（含通用）'),
            h(Btn, {
              variant: 'primary',
              style: { padding: '3px 8px', fontSize: 11.5, flexShrink: 0 },
              onClick: startNew,
              title: '手写新建一个空模版',
            }, '+ 新增'),
          ),
          creating
            ? h('div', { style: Object.assign({}, S.step, S.stepActive, { marginBottom: 4 }) },
                h('div', { style: { fontWeight: 600 } }, '手写新建…'),
                h('div', { style: { color: C.faint, fontSize: 11, marginTop: 2 } }, '填右侧表单后点保存'),
              )
            : null,
          ...templates.map((t) =>
            h(
              'button',
              {
                key: t.id,
                type: 'button',
                style: Object.assign({}, S.step, !creating && picked === t.id ? S.stepActive : {}),
                onClick: () => { setCreating(false); setPicked(t.id) },
              },
              h('div', { style: { fontWeight: !creating && picked === t.id ? 600 : 400 } }, t.name),
              h('div', { style: { color: C.faint, fontSize: 11, marginTop: 2 } },
                (t.genre === '' ? '通用' : t.genre) + ' · ' + (t.source === 'builtin' ? '内置' : '自定义') +
                ' · ' + (t.sections || []).length + ' 节'),
            ),
          ),
          templates.length === 0 && !creating
            ? h('div', { style: { color: C.faint, fontSize: 11.5, padding: 9, lineHeight: 1.7 } },
                '当前类型还没有模版。点上方「+ 新增」手写一个。')
            : null,
        ),
        h(
          'div',
          { style: S.scroll },
          edit === null
            ? h('div', { style: S.dim }, '左侧选一个模版，或点「+ 新增」手写新建。')
            : h('div', { style: S.card },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
                  h('span', { style: { fontWeight: 600 } }, creating ? '手写新建模版' : '编辑模版'),
                  creating ? h(Chip, null, '保存后出现在左侧列表') : null,
                  !creating && template !== null && template.source === 'builtin'
                    ? h(Chip, null, '内置：保存会生成同 id 的自定义模版覆盖它')
                    : null,
                  h('div', { style: { flex: 1 } }),
                  creating
                    ? h(Btn, { variant: 'ghost', onClick: () => { setCreating(false); setPicked(templates.length > 0 ? templates[0].id : '') } }, '取消')
                    : null,
                  h(Btn, { variant: 'primary', onClick: () => void save() }, creating ? '创建并保存' : '保存'),
                ),
                h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
                  h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '模版 id（英文小写短横线）' },
                    h(Input, { value: edit.id, placeholder: '例如 novel-my-tpl', onChange: (v) => setEdit(Object.assign({}, edit, { id: v })) }))),
                  h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '名称' },
                    h(Input, { value: edit.name, placeholder: '例如：我的黄金三章', onChange: (v) => setEdit(Object.assign({}, edit, { name: v })) }))),
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
                  h(Area, {
                    value: edit.sections,
                    minHeight: 160,
                    placeholder: '第一章｜开局钩子与主角处境\n第二章｜第一次选择与代价\n第三章｜小高潮并埋长线',
                    onChange: (v) => setEdit(Object.assign({}, edit, { sections: v })),
                  })),
                h(Field, { label: '硬约束：每行一条，要能被机械判定（字数 / 段长 / 条数）' },
                  h(Area, {
                    value: edit.constraints,
                    minHeight: 100,
                    placeholder: '每章 2000-4000 字\n每章结尾必须有钩子',
                    onChange: (v) => setEdit(Object.assign({}, edit, { constraints: v })),
                  })),
                h(Field, { label: '说明（可选）' },
                  h(Area, { value: edit.note, minHeight: 64, placeholder: '这份模版适合什么题材、注意什么', onChange: (v) => setEdit(Object.assign({}, edit, { note: v })) })),
                h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.7 } },
                  '套用方式：在「创建作品」时选它，或在作品里点「生成草稿」时由项目默认模版带入。' +
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
      const { boot, setBoot, setErr, flash, defaultGenre, genreFilter } = props
      const filterGenre = typeof genreFilter === 'string' && genreFilter !== ''
        ? genreFilter
        : (typeof defaultGenre === 'string' && defaultGenre !== '' ? defaultGenre : 'novel')
      const genreLabel = ((boot.genres.find((g) => g.id === filterGenre) || {}).label) || filterGenre
      const allStyles = Array.isArray(boot.styles) ? boot.styles : []
      const styles = allStyles.filter((s) => s.genre === '' || s.genre === filterGenre)
      const [picked, setPicked] = useState(styles.length > 0 ? styles[0].id : '')
      const [edit, setEdit] = useState(null)
      /** true = 手写新建，不被左侧选中项的 useEffect 覆盖 */
      const [creating, setCreating] = useState(false)

      useEffect(() => {
        setCreating(false)
        if (styles.some((s) => s.id === picked)) return
        setPicked(styles.length > 0 ? styles[0].id : '')
      }, [filterGenre, boot.styles])

      const style = creating ? null : (styles.find((s) => s.id === picked) || null)

      useEffect(() => {
        if (creating) return
        if (style === null) {
          setEdit(null)
          return
        }
        setEdit({
          id: style.id,
          name: style.name,
          genre: style.genre === '' ? filterGenre : style.genre,
          tags: (style.tags || []).join('\n'),
          pov: style.pov || '',
          rhythm: style.rhythm || '',
          dialogue: style.dialogue || '',
          description: style.description || '',
          tone: style.tone || '',
          chapterRhythm: style.chapterRhythm || '',
          beatRhythm: style.beatRhythm || '',
        })
      }, [picked, boot.styles, filterGenre, creating])

      const startNew = () => {
        setCreating(true)
        setPicked('')
        setEdit({
          id: filterGenre + '-style',
          name: '',
          genre: filterGenre,
          tags: '',
          pov: '',
          rhythm: '',
          dialogue: '',
          description: '',
          tone: '',
          chapterRhythm: '',
          beatRhythm: '',
        })
      }

      const save = async () => {
        if (edit === null) return
        const id = String(edit.id || '').trim()
        const name = String(edit.name || '').trim()
        if (id === '') {
          setErr('请填写画像 id（英文小写短横线，例如 novel-my-style）')
          return
        }
        if (name === '') {
          setErr('请填写风格名称')
          return
        }
        try {
          const data = await api('style', {
            id,
            name,
            genre: edit.genre || filterGenre,
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
          setCreating(false)
          setPicked(data.id)
          flash(creating ? '手写风格已新建' : '风格画像已保存')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      const remove = async () => {
        if (edit === null || creating) return
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
        const meta = { id: '', name: '', genre: filterGenre, tags: [], pov: '', rhythm: '', dialogue: '', description: '', tone: '', chapterRhythm: '', beatRhythm: '' }
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
          const data = await api('analyze-style', { genre: filterGenre, sample, extra })
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
          const data = await api('analyze-style', { genre: filterGenre, path: path.trim(), extra })
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
            genre: parsed.genre || filterGenre,
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
          setCreating(false)
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
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 9px 8px' } },
            h('div', { style: { color: C.faint, fontSize: 11, flex: 1 } },
              genreLabel + '风格 · 共 ' + styles.length + ' 个（含通用）'),
            h(Btn, {
              variant: 'primary',
              style: { padding: '3px 8px', fontSize: 11.5, flexShrink: 0 },
              onClick: startNew,
              title: '手写新建一份空风格画像',
            }, '+ 新增'),
          ),
          creating
            ? h('div', { style: Object.assign({}, S.step, S.stepActive, { marginBottom: 4 }) },
                h('div', { style: { fontWeight: 600 } }, '手写新建…'),
                h('div', { style: { color: C.faint, fontSize: 11, marginTop: 2 } }, '填右侧七维后点保存'),
              )
            : null,
          ...styles.map((s) =>
            h(
              'button',
              {
                key: s.id,
                type: 'button',
                style: Object.assign({}, S.step, !creating && picked === s.id ? S.stepActive : {}),
                onClick: () => { setCreating(false); setPicked(s.id) },
              },
              h('div', { style: { fontWeight: !creating && picked === s.id ? 600 : 400 } }, s.name),
              h('div', { style: { color: C.faint, fontSize: 11, marginTop: 2 } },
                (s.genre === '' ? '通用' : s.genre) + ' · ' + (s.tags || []).join('、')),
            ),
          ),
          styles.length === 0 && !creating
            ? h('div', { style: { color: C.faint, fontSize: 11.5, padding: 9, lineHeight: 1.7 } },
                '当前类型还没有风格画像。点上方「+ 新增」手写，或在右侧从样例提炼。')
            : null,
        ),
        h(
          'div',
          { style: S.scroll },
          h('div', { style: { maxWidth: 980 } },
            creating
              ? null
              : h('div', { style: S.card },
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
                h('span', { style: { fontWeight: 600 } }, creating ? '手写新建风格画像' : '编辑风格画像'),
                creating ? h(Chip, null, '保存后出现在左侧列表') : null,
                h('div', { style: { flex: 1 } }),
                creating
                  ? h(Btn, { variant: 'ghost', onClick: () => { setCreating(false); setPicked(styles.length > 0 ? styles[0].id : '') } }, '取消')
                  : (edit !== null ? h(Btn, { variant: 'ghost', onClick: () => void remove() }, '删除') : null),
                h(Btn, { variant: 'primary', disabled: edit === null, onClick: () => void save() }, creating ? '创建并保存' : '保存'),
              ),
              edit === null
                ? h('div', { style: S.dim }, '左侧选一个风格画像，点「+ 新增」手写，或在上方从样例提炼。')
                : h('div', null,
                    h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
                      h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '画像 id（英文小写短横线）' },
                        h(Input, { value: edit.id, placeholder: '例如 novel-my-style', onChange: (v) => setEdit(Object.assign({}, edit, { id: v })) }))),
                      h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '名称' },
                        h(Input, { value: edit.name, placeholder: '例如：仙侠·轻松打脸', onChange: (v) => setEdit(Object.assign({}, edit, { name: v })) }))),
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
                      h(Area, { value: edit.tags, minHeight: 70, placeholder: '轻松搞笑\n扮猪吃老虎', onChange: (v) => setEdit(Object.assign({}, edit, { tags: v })) })),
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
      const [baseURL, setBaseURL] = useState(boot.config.baseURL || 'https://api.deepseek.com')
      const [apiKey, setApiKey] = useState('')
      const [model, setModel] = useState(boot.config.model)
      const [maxTokens, setMaxTokens] = useState(String(boot.config.maxTokens || 3000))
      const [busy, setBusy] = useState(false)
      const [testing, setTesting] = useState(false)
      const [testModels, setTestModels] = useState([])
      const [testHint, setTestHint] = useState('')
      const hasApiKey = boot.config.hasApiKey === true
      const apiKeySource = boot.config.apiKeySource === 'env' || boot.config.apiKeySource === 'literal'
        ? boot.config.apiKeySource
        : (hasApiKey ? 'literal' : 'none')
      // 番茄发布/登录：登录态目录、解释器、站点书名
      const [pubProfile, setPubProfile] = useState(boot.config.publishProfile || '')
      const [pubPython, setPubPython] = useState(boot.config.publishPython || '')
      const [pubBook, setPubBook] = useState(boot.config.publishBookName || '')
      // Obsidian 书库：vault 根 + 三个可配置子目录（原文 / 资产 / 作品）
      const [vaultRootPath, setVaultRootPath] = useState(boot.config.vaultPath || '')
      const [vaultSourceDir, setVaultSourceDir] = useState(boot.config.vaultSourceDir || 'dsh-writer-m/爆款原文')
      const [vaultAssetsDir, setVaultAssetsDir] = useState(boot.config.vaultAssetsDir || 'dsh-writer-m/拆书资产')
      const [vaultWorksDir, setVaultWorksDir] = useState(boot.config.vaultWorksDir || 'dsh-writer-m/作品')
      const [fqBusy, setFqBusy] = useState('')
      /** 设置左侧菜单：storage / model / polish / fanqie */
      const [section, setSection] = useState('storage')
      /**
       * 多模型与分工：models 是可编辑列表（apiKey 不回明文，留空 = 沿用），
       * lanes 是四个工种 → 模型 id 的指派（'' = 默认模型）。
       */
      const [models, setModels] = useState(Array.isArray(boot.config.models) ? boot.config.models : [])
      const [lanes, setLanes] = useState(Object.assign({ planning: '', drafting: '', polishing: '', analysis: '' }, boot.config.lanes || {}))
      const [mmBusy, setMmBusy] = useState(false)
      const [mmTesting, setMmTesting] = useState('')
      // 任何一次保存成功后 boot 会刷新：多模型/分工跟着服务端走（含派生 id 回填），不与磁盘漂移
      const modelsJson = JSON.stringify(boot.config.models ?? [])
      const lanesJson = JSON.stringify(boot.config.lanes ?? {})
      useEffect(() => {
        setModels(Array.isArray(boot.config.models) ? boot.config.models : [])
      }, [modelsJson])
      useEffect(() => {
        setLanes(Object.assign({ planning: '', drafting: '', polishing: '', analysis: '' }, boot.config.lanes || {}))
      }, [lanesJson])

      const save = async () => {
        setBusy(true)
        try {
          const patch = {
            root: root.trim(),
            provider: provider.trim(),
            baseURL: baseURL.trim(),
            model: model.trim(),
            maxTokens: Number(maxTokens) || 3000,
          }
          // 留空不改已有密钥；填了才写入
          if (apiKey.trim() !== '') patch.apiKey = apiKey.trim()
          const data = await api('config', { patch })
          if (data.warning !== '') flash(data.warning)
          else flash('配置已写入')
          setApiKey('')
          const fresh = await api('state')
          setBoot(fresh)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      /** 用当前表单里的 url / apiKey 拉 /models，把可用 model 填回输入框并列出可选列表。 */
      const testLlm = async () => {
        setTesting(true)
        setTestHint('')
        try {
          const data = await api('llm-test', {
            baseURL: baseURL.trim(),
            provider: provider.trim(),
            model: model.trim(),
            apiKey: apiKey.trim(),
          })
          const models = Array.isArray(data.models) ? data.models : []
          setTestModels(models)
          if (typeof data.model === 'string' && data.model !== '') setModel(data.model)
          else if (models.length > 0) setModel(models[0])
          const tip = (data.mock === true ? 'MOCK 模式 · ' : '') +
            '连通正常，拉到 ' + models.length + ' 个模型' +
            (typeof data.model === 'string' && data.model !== '' ? '，已填入 ' + data.model : '')
          setTestHint(tip)
          flash(tip)
        } catch (e) {
          setTestModels([])
          const msg = e instanceof Error ? e.message : String(e)
          setTestHint(msg)
          setErr(msg)
        } finally {
          setTesting(false)
        }
      }

      /** 多模型：更新某一行的某个字段（apiKey 输入框为空串 = 保存时沿用旧密钥）。 */
      const setModelRow = (i, key, value) => {
        setModels(models.map((m, at) => at === i ? Object.assign({}, m, { [key]: value }) : m))
      }
      const addModelRow = () => {
        setModels(models.concat([{
          id: '', label: '', provider: provider.trim() || 'deepseek',
          baseURL: 'https://api.deepseek.com', model: '', apiKey: '', maxTokens: 3000,
          hasApiKey: false,
        }]))
      }
      const removeModelRow = (i) => {
        const removed = models[i]
        setModels(models.filter((_, at) => at !== i))
        // 被指派的模型被删了，对应分工自动回默认，避免保存时被服务端拒
        if (removed !== undefined && String(removed.id || '') !== '') {
          const next = Object.assign({}, lanes)
          for (const k of Object.keys(next)) if (next[k] === removed.id) next[k] = ''
          setLanes(next)
        }
      }

      const saveMultiModel = async () => {
        setMmBusy(true)
        try {
          const patch = {
            models: models.map((m) => {
              const row = {
                id: String(m.id || '').trim(),
                label: String(m.label || '').trim(),
                provider: String(m.provider || '').trim(),
                baseURL: String(m.baseURL || '').trim(),
                model: String(m.model || '').trim(),
                maxTokens: Number(m.maxTokens) || 3000,
              }
              const key = String(m.apiKey || '').trim()
              if (key !== '') row.apiKey = key
              return row
            }),
            lanes,
          }
          const data = await api('config', { patch })
          flash(data.warning !== '' ? data.warning : '多模型与分工已写入')
          setBoot(await api('state'))
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setMmBusy(false)
        }
      }

      /** 逐行测试：已保存的行按 profileId 测（密钥不出服务端）；未保存的新行用表单值测。 */
      const testModelRow = async (i) => {
        const row = models[i]
        setMmTesting(String(i))
        try {
          const saved = row.hasApiKey === true && String(row.apiKey || '').trim() === '' && String(row.id || '').trim() !== ''
          const data = await api('llm-test', saved
            ? { profileId: row.id }
            : {
                baseURL: String(row.baseURL || '').trim(),
                provider: String(row.provider || '').trim(),
                model: String(row.model || '').trim(),
                apiKey: String(row.apiKey || '').trim(),
              })
          flash((data.mock === true ? 'MOCK 模式 · ' : '') + '「' + (row.label || row.model || row.id) + '」连通正常，拉到 ' + (data.models || []).length + ' 个模型')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setMmTesting('')
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

      const menuItems = [
        { id: 'storage', label: '落盘位置', hint: '作品根目录' },
        { id: 'model', label: '模型路由', hint: 'provider / url / model' },
        { id: 'vault', label: 'Obsidian 书库', hint: '原文/资产/作品' },
        { id: 'polish', label: '润色自检', hint: '去 AI 化六维度' },
        { id: 'fanqie', label: '番茄登录', hint: '发布登录态' },
      ]

      const panelStorage = h('div', { style: S.card },
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
      )

      const panelModel = h('div', { style: S.card },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, '默认模型（未分工时的兜底）'),
        h('div', { style: S.row },
          h('span', { style: { color: C.sub } }, '当前生效：'),
          boot.llm.route === null
            ? h(Chip, { style: { borderColor: C.err, color: C.err } }, '未配置')
            : h(Chip, null, boot.llm.route.provider + ' / ' + boot.llm.route.model),
          hasApiKey
            ? h(Chip, { style: { borderColor: C.ok, color: C.ok } },
                apiKeySource === 'env' ? 'apiKey 走环境变量' : 'apiKey 已写入配置')
            : h(Chip, { style: { borderColor: C.err, color: C.err } }, 'apiKey 未配置'),
        ),
        h('div', { style: { height: 10 } }),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('div', { style: { flex: '1 1 160px' } }, h(Field, { label: 'provider（留空 = 用默认模型）' },
            h(Input, { value: provider, placeholder: '例如 deepseek', onChange: setProvider }))),
          h('div', { style: { flex: '2 1 280px' } }, h(Field, { label: 'url（OpenAI 兼容基址）' },
            h(Input, { value: baseURL, placeholder: '例如 https://api.deepseek.com', onChange: setBaseURL }))),
        ),
        h(Field, { label: 'apiKey（密钥；已配置可留空不改，支持 ${DEEPSEEK_API_KEY}）' },
          h(Input, {
            type: 'password',
            autoComplete: 'off',
            value: apiKey,
            placeholder: hasApiKey ? '已配置，留空则不修改' : '例如 sk-... 或 ${DEEPSEEK_API_KEY}',
            onChange: setApiKey,
          })),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: 'model（点「测试」可从服务端拉取）' },
            h(Input, { value: model, placeholder: '例如 deepseek-chat', onChange: setModel }))),
          h('div', { style: { flex: '0 1 160px' } }, h(Field, { label: '单次最大输出 token' },
            h(Input, { value: maxTokens, placeholder: '3000', onChange: (v) => setMaxTokens(v.replace(/[^0-9]/g, '')) }))),
        ),
        testModels.length > 0
          ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, marginBottom: 4 } },
              h('span', { style: { color: C.sub, fontSize: 12, alignSelf: 'center' } }, '可用模型：'),
              ...testModels.map((id) =>
                h(Btn, {
                  key: id,
                  variant: id === model ? 'primary' : undefined,
                  onClick: () => setModel(id),
                }, id),
              ),
            )
          : null,
        testHint !== ''
          ? h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.6, marginBottom: 6 } }, testHint)
          : null,
        h('div', { style: S.row },
          h(Btn, { disabled: testing || busy, onClick: () => void testLlm() }, testing ? '测试中…' : '测试'),
          h(Btn, { variant: 'primary', disabled: busy || testing, onClick: () => void save() }, busy ? '保存中…' : '保存模型配置'),
        ),
        h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.7, marginTop: 8 } },
          'apiKey 写入本机 .agent-config.json，state 只回「是否已配置」、不回明文。' +
          '「测试」用表单里的 url / apiKey（可未保存）请求 /models，连通后把 model 填回；多模型可点下方按钮切换。' +
          '单次默认 3000 token；长章截断时会自动续写（最多 3 次），续写仍没写完才提示「被截断」。'),
      )

      const LANE_LABELS = [
        ['planning', '规划步（定位/大纲/人物/卷纲/章纲/书名/标签）'],
        ['drafting', '章节正文（含快速通道）'],
        ['polishing', '润色与去AI'],
        ['analysis', '分析与拆书（风格蒸馏/结构拆解）'],
      ]

      const panelMultiModel = h('div', { style: S.card },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '多模型与分工'),
        h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.7, marginBottom: 10 } },
          '在这里登记多个模型端点（比如本地 8B + 远程 DeepSeek），再把不同工种指派给不同模型——' +
          '粗活给本地、精活给远程，token 花在刀刃上。没有分工的工种走下面的默认模型。密钥不回明文，留空 = 沿用已保存的。'),
        models.length === 0
          ? h('div', { style: { color: C.faint, fontSize: 12, marginBottom: 8 } }, '（还没有登记多模型，全部走默认模型）')
          : models.map((m, i) =>
              h('div', { key: i, style: { borderTop: '1px solid ' + C.line, paddingTop: 8, marginBottom: 10 } },
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('div', { style: { flex: '1 1 130px' } }, h(Field, { label: '备注' },
                    h(Input, { value: m.label || '', placeholder: '本地 8B / DeepSeek', onChange: (v) => setModelRow(i, 'label', v) }))),
                  h('div', { style: { flex: '1 1 130px' } }, h(Field, { label: 'id（分工用，可留空自动派生）' },
                    h(Input, { value: m.id || '', placeholder: 'local-8b', onChange: (v) => setModelRow(i, 'id', v) }))),
                  h('div', { style: { flex: '1 1 110px' } }, h(Field, { label: 'provider' },
                    h(Input, { value: m.provider || '', placeholder: 'deepseek', onChange: (v) => setModelRow(i, 'provider', v) }))),
                ),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('div', { style: { flex: '2 1 240px' } }, h(Field, { label: 'url（OpenAI 兼容基址）' },
                    h(Input, { value: m.baseURL || '', placeholder: 'http://127.0.0.1:11434/v1', onChange: (v) => setModelRow(i, 'baseURL', v) }))),
                  h('div', { style: { flex: '1 1 160px' } }, h(Field, { label: 'model' },
                    h(Input, { value: m.model || '', placeholder: 'qwen2.5:8b', onChange: (v) => setModelRow(i, 'model', v) }))),
                  h('div', { style: { flex: '0 1 110px' } }, h(Field, { label: '最大输出' },
                    h(Input, { value: String(m.maxTokens || 3000), onChange: (v) => setModelRow(i, 'maxTokens', v.replace(/[^0-9]/g, '')) }))),
                ),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' } },
                  h('div', { style: { flex: '2 1 240px' } }, h(Field, { label: 'apiKey' },
                    h(Input, {
                      type: 'password',
                      autoComplete: 'off',
                      value: m.apiKey || '',
                      placeholder: m.hasApiKey === true ? '已配置，留空则不修改' : '例如 sk-... 或 ${ENV_VAR}（本地可乱填）',
                      onChange: (v) => setModelRow(i, 'apiKey', v),
                    }))),
                  h(Btn, { disabled: mmTesting !== '' || mmBusy, onClick: () => void testModelRow(i) },
                    mmTesting === String(i) ? '测试中…' : '测试'),
                  h(Btn, { variant: 'ghost', disabled: mmBusy, onClick: () => removeModelRow(i) }, '删除'),
                ),
              ),
            ),
        h('div', { style: { marginBottom: 12 } },
          h(Btn, { variant: 'ghost', disabled: mmBusy, onClick: addModelRow }, '+ 添加模型'),
        ),
        h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 6 } }, '分工指定'),
        ...LANE_LABELS.map(([key, label]) =>
          h('div', { key, style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
            h('div', { style: { flex: 1, fontSize: 12, color: C.sub } }, label),
            h('select', {
              style: Object.assign({}, S.input, { flex: '0 1 240px' }),
              value: lanes[key] || '',
              onChange: (e) => setLanes(Object.assign({}, lanes, { [key]: e.target.value })),
            },
              h('option', { value: '' }, '默认模型'),
              ...models.map((m, i) =>
                h('option', { key: i, value: String(m.id || m.model || '') },
                  (m.label || m.id || m.model || '（未命名）') + (m.model ? '（' + m.model + '）' : '')),
              ),
            ),
          ),
        ),
        h('div', { style: S.row },
          h(Btn, { variant: 'primary', disabled: mmBusy || mmTesting !== '', onClick: () => void saveMultiModel() },
            mmBusy ? '保存中…' : '保存多模型与分工'),
        ),
        h('div', { style: { color: C.faint, fontSize: 11.5, lineHeight: 1.7, marginTop: 6 } },
          '分工只在「模型列表 + 分工」一起保存后生效；某个模型被删除时，指向它的分工自动回落默认模型。' +
          '本地模型（如 Ollama / LM Studio 的 OpenAI 兼容端点）apiKey 随便填个非空串即可。'),
      )

      const panelPolish = h('div', { style: S.card },
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
      )

      const panelFanqie = h('div', { style: S.card },
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
      )

      /** 只提交 Obsidian 书库相关配置（vault 根 + 三个子目录；非法组合后端会拒）。 */
      const saveVault = async () => {
        setBusy(true)
        try {
          const data = await api('config', {
            patch: {
              vaultPath: vaultRootPath.trim(),
              vaultSourceDir: vaultSourceDir.trim(),
              vaultAssetsDir: vaultAssetsDir.trim(),
              vaultWorksDir: vaultWorksDir.trim(),
            },
          })
          flash(data.warning !== '' ? data.warning : 'Obsidian 书库配置已写入')
          setBoot(await api('state'))
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      const panelVault = h('div', { style: S.card },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, 'Obsidian 书库'),
        h(Field, { label: 'vault 根目录（绝对路径；留空则自动探测第一个打开的库）' },
          h(Input, { value: vaultRootPath, onChange: setVaultRootPath, placeholder: 'D:/Notes/我的写作库' })),
        h(Field, { label: '爆款原文目录（第一部分原料，相对 vault 根）' },
          h(Input, { value: vaultSourceDir, onChange: setVaultSourceDir })),
        h(Field, { label: '拆书资产目录（拆书卡片 / 风格 / 模版）' },
          h(Input, { value: vaultAssetsDir, onChange: setVaultAssetsDir })),
        h(Field, { label: '作品目录（第二部分生成的小说）' },
          h(Input, { value: vaultWorksDir, onChange: setVaultWorksDir })),
        h('div', { style: S.row },
          h(Btn, { variant: 'primary', disabled: busy, onClick: () => void saveVault() }, busy ? '保存中…' : '保存书库配置'),
          h(Btn, {
            disabled: busy,
            title: '在 vault 里一次性建齐三棵树（爆款原文 / 拆书资产 / 作品）与资产树子目录，已存在的不动',
            onClick: async () => {
              setBusy(true)
              try {
                const data = await api('vault-dirs', { action: 'init' })
                flash(data.created.length > 0
                  ? '已创建 ' + data.created.length + ' 个目录：' + data.created.join('、')
                  : '目录都已存在，无需初始化')
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e))
              } finally {
                setBusy(false)
              }
            },
          }, '初始化书库目录'),
        ),
        h('div', { style: { color: C.faint, fontSize: 11.5, marginTop: 8, lineHeight: 1.7 } },
          '三个子目录都是 vault 内的相对路径，留空保存会用默认值；三者必须互相独立、不许嵌套（例如资产目录不能在作品目录下面）。' +
          '配置保存后到「书库」页签浏览三棵树的内容。'),
      )

      const panels = {
        storage: panelStorage,
        model: h('div', null, panelMultiModel, h('div', { style: { height: 12 } }), panelModel),
        vault: panelVault,
        polish: panelPolish,
        fanqie: panelFanqie,
      }

      return h(
        'div',
        { style: Object.assign({}, S.main, { flexDirection: 'row' }) },
        h(
          'div',
          { style: Object.assign({}, S.steps, { width: 200 }) },
          h('div', { style: { color: C.faint, fontSize: 11, padding: '0 9px 8px' } }, '设置'),
          ...menuItems.map((item) =>
            h(
              'button',
              {
                key: item.id,
                type: 'button',
                style: Object.assign({}, S.step, section === item.id ? S.stepActive : {}),
                onClick: () => setSection(item.id),
              },
              h('div', { style: { fontWeight: section === item.id ? 600 : 400 } }, item.label),
              h('div', { style: { color: C.faint, fontSize: 11, marginTop: 2 } }, item.hint),
            ),
          ),
        ),
        h(
          'div',
          { style: S.scroll },
          h('div', { style: { maxWidth: 760 } }, panels[section] || panelStorage),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // 书库页：浏览 Obsidian 里的三棵树（爆款原文 / 拆书资产 / 作品）
    // -----------------------------------------------------------------------

    function VaultLibTab(props) {
      const { setErr, flash } = props
      const [overview, setOverview] = useState(null)
      const [loading, setLoading] = useState(true)
      const [tree, setTree] = useState('source')
      /** relStack：从树根往下的路径段（面包屑）；entries：当前层条目 */
      const [relStack, setRelStack] = useState([])
      const [entries, setEntries] = useState([])
      const [preview, setPreview] = useState(null)
      /** 第一部分·原文入库表单：showImport 展开，importing 防重复提交 */
      const [showImport, setShowImport] = useState(false)
      const [importForm, setImportForm] = useState({ name: '', channel: '', type: '', path: '', text: '' })
      const [importing, setImporting] = useState(false)
      /** 第一部分·拆书：tearing 防重复触发，teardownResult 展示三件套落点 */
      const [tearing, setTearing] = useState(false)
      const [teardownResult, setTeardownResult] = useState(null)

      const loadOverview = async () => {
        setLoading(true)
        try {
          const data = await api('vault-dirs', { action: 'overview' })
          setOverview(data)
        } catch (e) {
          setOverview(null)
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setLoading(false)
        }
      }

      useEffect(() => {
        void loadOverview()
      }, [])

      const loadLevel = async (treeKey, stack) => {
        try {
          const data = await api('vault-dirs', { action: 'list', tree: treeKey, rel: stack.join('/') })
          setEntries(data.entries || [])
        } catch (e) {
          setEntries([])
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      useEffect(() => {
        if (overview === null) return
        setPreview(null)
        void loadLevel(tree, relStack)
      }, [tree, relStack, overview])

      const openEntry = async (entry) => {
        if (entry.kind === 'dir') {
          setRelStack(relStack.concat([entry.name]))
          return
        }
        try {
          const data = await api('vault-dirs', { action: 'read', tree, rel: relStack.concat([entry.name]).join('/') })
          setPreview({ name: entry.name, text: data.text })
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      if (loading) return h('div', { style: S.card }, '正在读取 Obsidian 书库…')
      if (overview === null) {
        return h('div', { style: S.card },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, 'Obsidian 书库未配置'),
          h('div', { style: { color: C.sub, fontSize: 12, lineHeight: 1.8 } },
            '到「设置 → Obsidian 书库」填上 vault 根目录（绝对路径），三个子目录不填就用默认值。'),
        )
      }

      const current = (overview.trees || []).find((t) => t.key === tree)
      const crumb = (current ? current.dir : '') + (relStack.length > 0 ? '/' + relStack.join('/') : '')
      const missing = (overview.trees || []).filter((t) => t.exists !== true)

      const initDirs = async () => {
        try {
          const data = await api('vault-dirs', { action: 'init' })
          flash(data.created.length > 0
            ? '已创建 ' + data.created.length + ' 个目录：' + data.created.join('、')
            : '目录都已存在，无需初始化')
          await loadOverview()
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      /** 导入原文到「爆款原文」树：路径优先，其次粘贴文本；成功后刷新树。 */
      const doImport = async () => {
        if (importForm.name.trim() === '') {
          setErr('先填书名')
          return
        }
        if (importForm.path.trim() === '' && importForm.text.trim() === '') {
          setErr('填一个原文文件路径，或粘贴原文')
          return
        }
        setImporting(true)
        try {
          const data = await api('source-import', {
            name: importForm.name.trim(),
            channel: importForm.channel.trim(),
            type: importForm.type.trim(),
            path: importForm.path.trim(),
            text: importForm.text,
          })
          flash('已入库《' + data.name + '》（' + data.chars + ' 字）→ ' + data.rel)
          setImportForm({ name: '', channel: '', type: '', path: '', text: '' })
          setShowImport(false)
          await loadOverview()
          await loadLevel(tree, relStack)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setImporting(false)
        }
      }

      /** 对预览中的原文跑拆书：统计指纹 + 蒸馏风格/模版 + 卡片，三件套落进资产树。
       *  quick=true 是连载书追更用的快刷：只刷指纹与卡片，零 token，风格/模版沿用上次。 */
      const doTeardown = async (quick) => {
        if (preview === null) return
        setTearing(true)
        setTeardownResult(null)
        try {
          const data = await api('teardown', { rel: relStack.concat([preview.name]).join('/'), quick: quick === true })
          setTeardownResult(data)
          flash(quick === true
            ? '快刷完成：《' + data.name + '》指纹已更新（' + data.stats.chapterCount + ' 章）'
            : '拆书完成：《' + data.name + '》→ 风格 ' + data.styleId + ' / 模版 ' + data.templateId)
          await loadOverview()
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setTearing(false)
        }
      }

      const metaChips = (meta) => {
        const chips = []
        if (meta === null || meta === undefined) return chips
        if (typeof meta.type === 'string' && meta.type !== '') chips.push(h(Chip, { key: 'type' }, meta.type))
        if (typeof meta['状态'] === 'string' && meta['状态'] !== '') {
          const st = meta['状态']
          const style = st === 'final' ? { borderColor: C.ok, color: C.ok } : (st === 'draft' ? { borderColor: C.warn, color: C.warn } : {})
          chips.push(h(Chip, { key: 'st', style }, st))
        }
        return chips
      }

      return h('div', { style: S.scroll },
        h('div', { style: { maxWidth: 860, padding: 12 } },
          h('div', { style: S.row },
            ...(overview.trees || []).map((t) =>
              h(Btn, {
                key: t.key,
                variant: tree === t.key ? 'primary' : 'ghost',
                onClick: () => { setTree(t.key); setRelStack([]); setPreview(null) },
              }, t.label + '（' + t.files + '）'),
            ),
            h('div', { style: { flex: 1 } }),
            tree === 'source' ? h(Btn, {
              variant: showImport ? 'ghost' : 'primary',
              onClick: () => setShowImport(!showImport),
            }, showImport ? '收起导入' : '导入原文') : null,
            missing.length === 0 ? null : h(Btn, { variant: 'primary', onClick: () => void initDirs() },
              '初始化书库目录（缺 ' + missing.length + ' 个）'),
            h(Btn, { variant: 'ghost', onClick: () => { void loadOverview().then(() => loadLevel(tree, relStack)) } }, '刷新'),
          ),
          showImport === false || tree !== 'source' ? null : h('div', { style: Object.assign({}, S.card, { marginTop: 10 }) },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '导入爆款原文（第一部分·原文入库）'),
            h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 10 } },
              '原文写入「爆款原文」树并带元信息头；入库后打开文件点「拆这本书」即可产出风格画像 + 结构模版 + 拆书卡片。'),
            h(Field, { label: '书名' },
              h(Input, { value: importForm.name, placeholder: '例：我在精神病院学斩神', onChange: (v) => setImportForm(Object.assign({}, importForm, { name: v })) })),
            h('div', { style: { display: 'flex', gap: 10 } },
              h('div', { style: { flex: 1 } },
                h(Field, { label: '频道（可空）' },
                  h(Input, { value: importForm.channel, placeholder: '男频 / 女频', onChange: (v) => setImportForm(Object.assign({}, importForm, { channel: v })) }))),
              h('div', { style: { flex: 1 } },
                h(Field, { label: '类型（可空）' },
                  h(Input, { value: importForm.type, placeholder: '都市高武 / 悬疑脑洞…', onChange: (v) => setImportForm(Object.assign({}, importForm, { type: v })) }))),
            ),
            h(Field, { label: '原文文件路径（整本 txt/md，优先于粘贴）' },
              h(Input, { value: importForm.path, placeholder: '例：D:\\novels\\斩神.txt 或 /home/me/book.txt', onChange: (v) => setImportForm(Object.assign({}, importForm, { path: v })) })),
            importForm.path.trim() !== '' ? null : h(Field, { label: '或粘贴原文' },
              h(Area, { value: importForm.text, placeholder: '把原文粘贴到这里…', minHeight: 110, onChange: (v) => setImportForm(Object.assign({}, importForm, { text: v })) })),
            h('div', { style: S.row },
              h(Btn, { variant: 'primary', disabled: importing, onClick: () => void doImport() }, importing ? '入库中…' : '确认入库'),
              h(Btn, { variant: 'ghost', disabled: importing, onClick: () => setShowImport(false) }, '取消'),
            ),
          ),
          h('div', { style: Object.assign({}, S.card, { marginTop: 10 }) },
            h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8 } },
              crumb,
              current !== undefined && current.exists !== true ? '（目录还不存在，写下第一本后会自动创建）' : ''),
            relStack.length === 0 ? null : h('div', { style: { marginBottom: 8 } },
              h(Btn, { variant: 'ghost', onClick: () => setRelStack(relStack.slice(0, -1)) }, '← 上一层')),
            entries.length === 0
              ? h('div', { style: { color: C.faint, fontSize: 12 } }, '（空目录）')
              : h('div', null,
                  entries.map((entry) =>
                    h('div', {
                      key: entry.rel,
                      style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', cursor: 'pointer', borderBottom: '1px solid ' + C.line },
                      onClick: () => void openEntry(entry),
                    },
                      h('span', { style: { width: 18, textAlign: 'center' } }, entry.kind === 'dir' ? '📁' : '📄'),
                      h('span', { style: { flex: 1, fontSize: 12.5 } }, entry.name),
                      ...metaChips(entry.meta),
                      entry.kind === 'file' && typeof entry.size === 'number'
                        ? h('span', { style: { color: C.faint, fontSize: 11 } }, Math.round(entry.size / 1024) + ' KB')
                        : null,
                    ),
                  ),
                ),
          ),
          preview === null ? null : h('div', { style: Object.assign({}, S.card, { marginTop: 10 }) },
            h('div', { style: S.row },
              h('div', { style: { fontSize: 12.5, fontWeight: 600, flex: 1 } }, preview.name),
              tree === 'source' && /\.md$/i.test(preview.name)
                ? h(Btn, { variant: 'primary', disabled: tearing, onClick: () => void doTeardown(false) },
                    tearing ? '拆书中（采样+蒸馏，需要几分钟）…' : '拆这本书')
                : null,
              tree === 'source' && /\.md$/i.test(preview.name)
                ? h(Btn, { variant: 'ghost', disabled: tearing, title: '连载书追更用：只刷指纹与卡片，零 token，风格/模版沿用上次', onClick: () => void doTeardown(true) },
                    '快刷指纹')
                : null,
              h(Btn, { variant: 'ghost', onClick: () => { setPreview(null); setTeardownResult(null) } }, '关闭预览'),
            ),
            h('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.8, color: C.sub, maxHeight: 420, overflow: 'auto', margin: 0 } }, preview.text),
          ),
          teardownResult === null ? null : h('div', { style: Object.assign({}, S.card, { marginTop: 10 }) },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } },
              (teardownResult.quick === true ? '指纹已快刷：《' : '拆书三件套已产出：《') + teardownResult.name + '》' +
              (typeof teardownResult.lastChapter === 'string' && teardownResult.lastChapter !== '' ? '（截至 ' + teardownResult.lastChapter + '）' : '')),
            h('div', { style: { fontSize: 12, lineHeight: 2, color: C.sub } },
              h('div', null, '风格画像：' + teardownResult.styleId + '（风格页可选，注入章节步与润色步）'),
              h('div', null, '结构模版：' + teardownResult.templateId + '（模版页可选，注入大纲步）'),
              h('div', null, '拆书卡片：' + teardownResult.cardRel),
              h('div', null,
                '指纹：' + teardownResult.stats.chapterCount + ' 章 / 单章均 ' + teardownResult.stats.avgChapterChars + ' 字' +
                ' / 对话段占比约 ' + teardownResult.stats.avgDialogueRatio + '%' +
                (teardownResult.stats.hookDist.length > 0
                  ? ' / 钩子主类型 ' + teardownResult.stats.hookDist[0].hook + '（' + teardownResult.stats.hookDist[0].pct + '%）'
                  : '')),
              teardownResult.cardUpdated === true
                ? h('div', { style: { color: C.warn } }, '卡片已存在：本次只更新指纹与三件套引用，人填的标签/实战记录/评级已保留。')
                : null,
              ...(teardownResult.warnings || []).map((w, i) => h('div', { key: i, style: { color: C.warn } }, w)),
            ),
          ),
        ),
      )
    }
