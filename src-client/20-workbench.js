// -----------------------------------------------------------------------
    // 工作台主体
    // -----------------------------------------------------------------------

    /**
     * 顶层状态机：workspace（作品列表/新建）↔ studio（某个作品的步骤链）。
     * 刻意不用路由：全屏浮层只有一个入口，回退靠一个按钮就够，
     * 引入路由只会让「关掉再打开还在原地」这件事变复杂。
     */
    function Workbench(props) {
      const [boot, setBoot] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState('')
      /** 顶栏类型：小说 / 公众号 / 小红书；主列表、模版、风格都按它过滤。 */
      const [genreFilter, setGenreFilter] = useState('novel')
      /** 顶栏菜单：works=已生成列表 / create=创建作品 / template / style / settings */
      const [tab, setTab] = useState('works')
      const [projectId, setProjectId] = useState('')
      const [detail, setDetail] = useState(null)
      const [draft, setDraft] = useState(null)
      const [toast, setToast] = useState('')
      const [importDoc, setImportDoc] = useState(null)
      /** 正在等待二次确认删除的作品 id（空串=没在确认）。 */
      const [confirmDel, setConfirmDel] = useState('')

      const flash = useCallback((text) => {
        setToast(text)
        setTimeout(() => setToast(''), 2600)
      }, [])

      /** 把导入的外部文档写回原文件（带 .bak 备份）。 */
      const writeBack = async () => {
        if (importDoc === null) return
        setBusy('writeback')
        try {
          const data = await api('writeback', { path: importDoc.path, text: importDoc.text })
          flash('已写回原文件，原稿已备份：' + data.backedUpTo)
          setImportDoc(null)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      const loadState = useCallback(async () => {
        try {
          const data = await api('state')
          setBoot(data)
          setErr('')
          return data
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
          return null
        }
      }, [])

      useEffect(() => {
        void loadState()
      }, [loadState])

      // 右侧栏「送进工作台改」：订阅 pendingImport，把文档内容读进来编辑
      useEffect(() => {
        const onPending = () => {
          const pending = pendingImport.get()
          if (pending === null || pending === undefined) return
          pendingImport.clear()
          const p = pending.absolutePath
          if (typeof p !== 'string' || p === '') return
          api('import', { path: p })
            .then((d) => setImportDoc({ path: p, text: d.text }))
            .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
        }
        onPending()
        return pendingImport.subscribe(onPending)
      }, [])

      const openProject = useCallback(
        async (id) => {
          setBusy('detail')
          try {
            const data = await api('detail', { id })
            setDetail(data)
            setProjectId(id)
            setDraft(null)
            setErr('')
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e))
          } finally {
            setBusy('')
          }
        },
        [],
      )

      /**
       * 删除一个作品：列表上的 🗑 先把 confirmDel 置成该作品 id（二次确认），
       * 确认后才真删；删除动作在宿主侧执行（作品目录 + vault 里的镜像目录一起清）。
       */
      const deleteProject = useCallback(
        async (p) => {
          setBusy('delete')
          setErr('')
          try {
            const data = await api('project', { action: 'delete', id: p.id })
            setConfirmDel('')
            if (projectId === p.id) {
              setProjectId('')
              setDetail(null)
              setDraft(null)
            }
            await loadState()
            flash('已删除作品「' + p.name + '」' + (data.mirrored === true ? '，vault 镜像一并清理' : ''))
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e))
          } finally {
            setBusy('')
          }
        },
        [projectId, loadState, flash],
      )

      const onCreated = useCallback(
        async (payload) => {
          const data = await loadState()
          void data
          await openProject(payload.id)
          setTab('works')
          flash('作品已建立：' + payload.dir)
        },
        [loadState, openProject, flash],
      )

      /** 切换写作类型：关掉已打开作品，回到列表，并让创建表单跟着同步。 */
      const switchGenre = useCallback((id) => {
        setGenreFilter(id)
        setDetail(null)
        setDraft(null)
        setProjectId('')
        setConfirmDel('')
        if (tab === 'create' || tab === 'template' || tab === 'style' || tab === 'works') {
          /* 保持当前菜单，只换类型过滤 */
        } else {
          setTab('works')
        }
      }, [tab])

      const close = () => {
        if (props !== null && props !== undefined && typeof props.close === 'function') props.close()
      }

      /** 回到当前类型首页列表（小说→小说列表，公众号/小红书同理）；在作品内返回时跟着作品类型走。 */
      const goHome = useCallback(() => {
        if (detail !== null) {
          const g = String(detail.meta?.genre ?? '')
          if (g === 'novel' || g === 'wechat' || g === 'xiaohongshu') setGenreFilter(g)
        }
        setDetail(null)
        setDraft(null)
        setProjectId('')
        setConfirmDel('')
        setTab('works')
      }, [detail])

      /** 顶栏「返回」/ Esc：不在首页就回列表；已在首页再退出工作台。 */
      const onReturn = useCallback(() => {
        if (detail !== null || tab !== 'works') {
          goHome()
          return
        }
        close()
      }, [detail, tab, goHome])

      useEffect(() => {
        const onKey = (e) => {
          if (e.key === 'Escape') onReturn()
        }
        globalThis.addEventListener('keydown', onKey)
        return () => globalThis.removeEventListener('keydown', onKey)
      }, [onReturn])

      if (boot === null) {
        return h(
          'div',
          { style: S.overlay },
          h(
            'div',
            { style: { padding: 24 } },
            h('div', { style: S.title }, '写作工作台'),
            err === '' ? h('div', { style: S.dim }, '正在读取配置…') : h('div', { style: S.err }, err),
            h('div', { style: { marginTop: 12 } }, h(Btn, { onClick: close }, '关闭')),
          ),
        )
      }

      if (importDoc !== null) {
        return h(
          'div',
          { style: S.overlay },
          h(
            'div',
            { style: S.topbar },
            h('span', { style: { fontSize: 15 } }, '✍️'),
            h('span', { style: S.title }, '送进工作台改'),
            h('div', { style: { flex: 1 } }),
            h(Btn, { variant: 'primary', disabled: busy === 'writeback', onClick: () => void writeBack() },
              busy === 'writeback' ? '写回中…' : '写回原文件（带备份）'),
            h(Btn, { variant: 'ghost', onClick: () => setImportDoc(null) }, '关闭'),
          ),
          h(
            'div',
            { style: S.scroll },
            h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, wordBreak: 'break-all' } }, importDoc.path),
            h('textarea', {
              style: Object.assign({}, S.area, { minHeight: 480 }),
              value: importDoc.text,
              spellCheck: false,
              onChange: (e) => setImportDoc(Object.assign({}, importDoc, { text: e.target.value })),
            }),
          ),
        )
      }

      const genreLabel = (id) => {
        const g = boot.genres.find((x) => x.id === id)
        return g === undefined ? id : g.label
      }

      const genreTitles = { novel: '已生成的小说', wechat: '已生成的公众号', xiaohongshu: '已生成的小红书' }
      const inStudio = detail !== null

      return h(
        'div',
        { style: S.overlay },
        // ---- 顶栏 ----
        h(
          'div',
          { style: S.topbar },
          h('span', { style: { fontSize: 15 } }, '✍️'),
          h('span', {
            style: Object.assign({}, S.title, { cursor: 'pointer' }),
            title: '回到已生成列表',
            onClick: goHome,
          }, '写作工作台'),
          inStudio
            ? h(Chip, null, detail.meta.name + ' · ' + genreLabel(detail.meta.genre))
            : h(
                'div',
                { style: Object.assign({}, S.tabs, { marginLeft: 4 }) },
                ...boot.genres.map((g) =>
                  h(Btn, {
                    key: g.id,
                    variant: genreFilter === g.id ? 'primary' : 'ghost',
                    title: g.hint,
                    onClick: () => switchGenre(g.id),
                  }, g.label),
                ),
              ),
          h(
            'div',
            { style: S.tabs },
            ...[
              ['create', '创建作品'],
              ['template', '模版'],
              ['style', '风格'],
              ['vaultlib', '书库'],
              ['settings', '设置'],
            ].map(([id, label]) =>
              h(
                Btn,
                {
                  key: id,
                  variant: !inStudio && tab === id ? 'primary' : 'ghost',
                  onClick: () => {
                    setDetail(null)
                    setDraft(null)
                    setTab(id)
                  },
                },
                label,
              ),
            ),
          ),
          h('div', { style: { flex: 1 } }),
          toast === '' ? null : h('span', { style: { color: C.ok, fontSize: 12 } }, toast),
          h(Btn, { variant: 'ghost', onClick: () => void loadState(), title: '重新读取配置与作品列表' }, '刷新'),
          h(Btn, {
            onClick: onReturn,
            title: detail !== null || tab !== 'works'
              ? '返回当前类型的作品列表（Esc）'
              : '退出工作台（Esc）',
            style: { flexShrink: 0 },
          }, '✕ 返回'),
        ),

        // ---- 主体 ----
        h(
          'div',
          { style: S.body },
          err === '' ? null : h('div', { style: { position: 'absolute', margin: 12, zIndex: 5, maxWidth: 560 } }, h('div', { style: S.err }, err)),

          inStudio || tab === 'works' || tab === 'create'
            ? h(WriteTab, {
                boot,
                setBoot,
                refresh: loadState,
                detail,
                busy,
                setBusy,
                setErr,
                flash,
                openProject,
                onCreated,
                setDetail,
                draft,
                setDraft,
                confirmDel,
                setConfirmDel,
                deleteProject,
                genreFilter,
                mode: inStudio ? 'studio' : (tab === 'create' ? 'create' : 'list'),
                listTitle: genreTitles[genreFilter] || '已生成的作品',
                onBackToList: goHome,
              })
            : null,
          !inStudio && tab === 'template' ? h(TemplateTab, { boot, setBoot, setErr, flash, detail, genreFilter }) : null,
          !inStudio && tab === 'style' ? h(StyleTab, { boot, setBoot, setErr, flash, defaultGenre: genreFilter, genreFilter }) : null,
          !inStudio && tab === 'settings' ? h(SettingsTab, { boot, setBoot, setErr, flash }) : null,
          !inStudio && tab === 'vaultlib' ? h(VaultLibTab, { boot, setBoot, setErr, flash }) : null,
        ),
      )
    }

    /** 按风格画像标签与当前作品标签的交集数排序（交集多的排前）。 */
    function sortStylesByTags(styles, tags) {
      const list = Array.isArray(styles) ? styles : []
      const tagSet = new Set(Array.isArray(tags) ? tags.map((t) => String(t)) : [])
      const score = (s) => {
        let n = 0
        for (const t of Array.isArray(s.tags) ? s.tags : []) if (tagSet.has(String(t))) n += 1
        return n
      }
      return list.map((s) => ({ s, n: score(s) })).sort((a, b) => b.n - a.n).map((x) => x.s)
    }

    // -----------------------------------------------------------------------
    // 写作页：作品列表 / 新建 / 步骤链
    // -----------------------------------------------------------------------

    /** 章节文件名自动递增：从已落盘章节里取最大编号 +1。 */
    function nextChapterName(files) {
      let max = 0
      for (const f of files) {
        const m = /^第0*(\d+)章/.exec(f)
        if (m !== null) max = Math.max(max, Number(m[1]))
      }
      const next = max > 0 ? max + 1 : files.length + 1
      return '第' + String(next).padStart(3, '0') + '章'
    }

    /** 章节正文落盘文件名：编号锁定为所选章节（大纲「第 N 章」），章名可作后缀。 */
    function chapterFileName(chapterNo, chapterName, files) {
      const num = chapterNo !== null ? '第' + String(chapterNo).padStart(3, '0') + '章' : nextChapterName(files)
      const title = String(chapterName ?? '').trim().replace(/^第\s*0*\d+\s*章/, '').replace(/^[-—_·.\s]+/, '').trim()
      return title === '' ? num : num + '-' + title
    }

    /** 解析章节大纲（steps/05-章节大纲.md）里的「### 第 N 章 章名」块。 */
    function parseOutlineBlocks(text) {
      const blocks = []
      const re = /^###[ \t]+(.+)$/gm
      const starts = []
      let m
      while ((m = re.exec(text)) !== null) starts.push({ title: m[1].trim(), at: m.index })
      for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1].at : text.length
        blocks.push({ title: starts[i].title, body: text.slice(starts[i].at, end).trim() })
      }
      return blocks
    }

    /** 从「第 N 章 章名」标题解析章节序号（阿拉伯或中文数字），失败返回 null。 */
    function chapterNoFromTitle(title) {
      let m = /第\s*0*(\d{1,3})\s*章/.exec(title)
      if (m !== null) return Number(m[1])
      m = /第\s*([零一二三四五六七八九十百]+)\s*章/.exec(title)
      if (m !== null) return cnToInt(m[1])
      return null
    }

    function cnToInt(s) {
      const d = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
      let section = 0
      let num = 0
      for (const ch of s) {
        if (ch === '十') { section += (num === 0 ? 1 : num) * 10; num = 0 }
        else if (ch === '百') { section += (num === 0 ? 1 : num) * 100; num = 0 }
        else { const v = d[ch]; if (v === undefined) return null; num = v }
      }
      section += num
      return section
    }

    /** 解析作品定位草稿里的候选：按「## 候选N」分块，取每块「- 书名：…」。 */
    function parsePositionCandidates(text) {
      const blocks = []
      const re = /^##[ \t]+候选[^\n]*$/gm
      const starts = []
      let m
      while ((m = re.exec(text)) !== null) starts.push({ at: m.index, title: m[0].trim().replace(/^##[ \t]*/, '') })
      for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1].at : text.length
        const body = text.slice(starts[i].at, end)
        const bm = /^\s*(?:[-*]\s*)?书名\s*[:：]\s*(.+)$/m.exec(body)
        blocks.push({ title: starts[i].title, name: bm === null ? '' : bm[1].trim(), body })
      }
      return blocks
    }

    /**
     * 「番茄上架信息」核对卡：草稿与「已落盘稿」共用；解析与校验只在宿主（lib/core/fanqie-tags.js）做。
     */
    function FanqieListingCard(props) {
      const reports = props.reports
      const limits = props.limits === undefined ? null : props.limits
      const source = props.source === undefined ? '草稿' : props.source
      const flash = props.flash
      // 缺「上架信息」小节时的提示：草稿侧与「已落盘稿」侧该点的按钮不一样
      // （后者才有「只补写上架信息」；作品已有章节时定位步的「生成草稿」是禁用的）。
      const fixHint = props.fixHint === undefined
        ? '这个候选没有输出「### 四、上架信息」小节：点本步的「生成草稿」按新提示词重跑一次就会带上（也可以在「编辑」里照格式手补 «- 阅读标签·主分类：…»）。'
        : props.fixHint
      const actions = props.actions === undefined || props.actions === null ? null : props.actions
      const hint = props.hint === undefined
        ? '这一节是给番茄「创建作品」页直接抄的：标签名只能用站点官方清单里的名字（清单已写进定位步的提示词），模型自创的名字会在下面标黄。书名 ≤' + (limits === null ? 15 : limits.titleMax) + ' 字、主角人名 ≤' + (limits === null ? 5 : limits.roleNameMax) + ' 字是站点输入框的硬限制。'
        : props.hint
      return h('div', { style: Object.assign({}, S.card, { marginBottom: 10 }) },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600 } }, '番茄上架信息'),
          h(Chip, null, source),
          h(Chip, null, '阅读标签：主分类必选 1 个 · 主题/角色/情节各 ≤2'),
          h(Chip, null, '内容标签：情节/人设 ≤4 · 情感 ≤2 · 世界观 ≤1'),
          h(Chip, null, '作品简介 ' + (limits === null ? '50~500' : (limits.briefMin + '~' + limits.briefMax)) + ' 字'),
          h('div', { style: { flex: 1 } }),
          actions,
        ),
        h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } }, hint),
        ...reports.map((r, i) =>
          h('div', {
            key: i,
            style: { borderTop: i === 0 ? 'none' : '1px solid ' + C.line, paddingTop: i === 0 ? 0 : 8, marginTop: i === 0 ? 0 : 8 },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 500 } }, (r.title === '' || r.title === undefined ? ('候选' + (i + 1)) : r.title)),
              h(Chip, { style: r.ok === true ? { color: C.ok, borderColor: C.ok } : { color: C.err, borderColor: C.err } },
                r.sectionFound === false ? '没有上架信息' : (r.ok === true ? '按规则可填' : '有 ' + r.problems.length + ' 处要改')),
              r.sectionFound === false ? null : h(Chip, null, '作品简介 ' + r.briefChars + ' 字'),
              h(Btn, { onClick: () => void copyText(r.copy).then((ok) => flash(ok ? '已复制上架信息' : '复制失败，请手动选中')) }, '复制上架信息'),
            ),
            r.sectionFound === false
              ? h('div', { style: { color: C.warn, fontSize: 11.5, marginBottom: 6, lineHeight: 1.7 } },
                  r.candidateHeads === false
                    ? '这份文本里没有「## 候选」分节，不像是作品定位稿。'
                    : fixHint)
              : null,
            r.sectionFound === false
              ? null
              : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 } },
                  ...r.groups.filter((g) => g.items.length > 0).map((g, j) =>
                    h(Chip, {
                      key: j,
                      style: g.items.length > g.max ? { color: C.err, borderColor: C.err } : {},
                    }, g.kindLabel + '·' + g.title + '（' + g.items.length + '/' + g.max + '）：' + g.items.join('、'))),
                  r.groups.some((g) => g.items.length > 0)
                    ? null
                    : h('span', { style: { color: C.faint, fontSize: 11.5 } }, '没有解析到任何标签行（格式应为「- 阅读标签·主分类：东方仙侠」这种）。'),
                ),
            r.sectionFound === false || r.brief === ''
              ? null
              : h('div', { style: { color: C.sub, fontSize: 11.5, marginBottom: 6, lineHeight: 1.7 } },
                  '作品简介（' + r.briefChars + ' 字）：' + r.brief),
            ...r.problems.map((t, j) => h('div', { key: 'p' + j, style: { color: C.err, fontSize: 11.5, lineHeight: 1.7 } }, '· ' + t)),
            ...r.warnings.map((t, j) => h('div', { key: 'w' + j, style: { color: C.warn, fontSize: 11.5, lineHeight: 1.7 } }, '· ' + t)),
          ),
        ),
      )
    }

    /** 去掉首行章标题与所有空白后比较：判断润色稿是否与原文逐字一致（润色空转时给用户明示）。 */
    function sameChapterBody(a, b) {
      const strip = (t) => String(t === undefined || t === null ? '' : t)
        .replace(/^[ \t]*#{0,6}[ \t]*第[ \t]*[0-9零〇一二三四五六七八九十百千两]+[ \t]*章[^\n]*\n?/, '')
        .replace(/\s+/g, '')
      return strip(a) !== '' && strip(a) === strip(b)
    }

    function WriteTab(props) {
      const {
        boot, setBoot, detail, busy, setBusy, setErr, flash, openProject, onCreated, setDetail,
        draft, setDraft, confirmDel, setConfirmDel, deleteProject, refresh,
        genreFilter, mode, listTitle, onBackToList,
      } = props
      const activeGenre = typeof genreFilter === 'string' && genreFilter !== '' ? genreFilter : 'novel'
      const viewModeHome = mode === 'create' ? 'create' : 'list'
      const defaultWordsOf = (gid) => {
        const g = (boot.genres || []).find((x) => x.id === gid)
        if (g !== undefined && Number(g.defaultWords) > 0) return Number(g.defaultWords)
        return gid === 'novel' ? 2500 : 0
      }
      const [form, setForm] = useState({
        name: '',
        genre: activeGenre,
        theme: '',
        audience: '',
        tone: '',
        templateId: '',
        styleId: '',
        vaultNotes: [],
        words: defaultWordsOf(activeGenre),
        channel: 'male',
        type: '',
        totalWords: 0,
        tags: [],
        count: 3,
      })
      // 顶栏换类型时，创建表单跟着同步（避免列表筛小说、创建却还在公众号）
      useEffect(() => {
        if (detail !== null) return
        setForm((prev) => prev.genre === activeGenre
          ? prev
          : Object.assign({}, prev, { genre: activeGenre, templateId: '', styleId: '', words: defaultWordsOf(activeGenre) }))
      }, [activeGenre, detail])
      const [stepId, setStepId] = useState('')
      const [extra, setExtra] = useState('')
      const [showPrompt, setShowPrompt] = useState(false)
      const [promptEdit, setPromptEdit] = useState(null)
      const [promptPreview, setPromptPreview] = useState(true)
      const [injectOpen, setInjectOpen] = useState(false)
      const [injectData, setInjectData] = useState(null)
      const [injectBusy, setInjectBusy] = useState(false)
      const [outlineBlocks, setOutlineBlocks] = useState([])
      // 章节大纲步已保存的章数（用于「继续补齐」按钮）
      const [coCount, setCoCount] = useState(0)
      // 篇幅编辑（单章目标字数 / 全书总长度）：与 detail.meta 同步，改完立刻反映到步骤提示词
      const [wordsPick, setWordsPick] = useState({ words: 0, totalWords: 0 })
      // 单章目标字数的合理区间由宿主给（lib/core/workspace.js 的 CHAPTER_WORDS_MIN/MAX）
      const wordsRange = detail === null || detail.chapterWordsRange === undefined ? null : detail.chapterWordsRange
      const [wordsSaving, setWordsSaving] = useState(false)
      const [outlineSel, setOutlineSel] = useState('')
      const [chapterSel, setChapterSel] = useState('')
      const [volumeSel, setVolumeSel] = useState('')
      const [chapterName, setChapterName] = useState('')
      const [positionCount, setPositionCount] = useState(0)
      // 定位步「已有设定」时的二次确认令牌（'<作品id>:positioning'）；换步骤即失效
      const [posConfirm, setPosConfirm] = useState('')
      // 番茄上架信息核对：宿主 route('fanqieTags') 返回的逐候选结论（客户端不重复实现解析）
      const [fanqieReports, setFanqieReports] = useState(null)
      const [fanqieLimits, setFanqieLimits] = useState(null)
      const [viewMode, setViewMode] = useState('step')
      const [tagInput, setTagInput] = useState('')
      const [vaultQuery, setVaultQuery] = useState('')
      const [vaultResults, setVaultResults] = useState([])
      const [overwriteNotes, setOverwriteNotes] = useState(false)
      const [autoProgress, setAutoProgress] = useState(null)
      const [chapterOffset, setChapterOffset] = useState(0)
      const [cover, setCover] = useState(null)
      // 「已有作品」换风格：选中值与当前绑定分开存，避免一下拉就写盘
      const [stylePick, setStylePick] = useState('')
      const [styleSaving, setStyleSaving] = useState(false)
      // 番茄发布
      const [pubFromInput, setPubFromInput] = useState('1')
      const [pubToInput, setPubToInput] = useState('')
      const [pubBusy, setPubBusy] = useState('')
      const [pubMsg, setPubMsg] = useState('')
      const [pubResult, setPubResult] = useState(null)
      const [pubStatus, setPubStatus] = useState(null)
      // 书名重名时的「只重新生成书名」（修用户 m01329）：宿主 route('title')，只动书名，正文/大纲/人物不动
      const [titleCands, setTitleCands] = useState(null)
      const [titleBusy, setTitleBusy] = useState('')
      const [titleMsg, setTitleMsg] = useState('')

      const genre = boot.genres.find((g) => g.id === (detail === null ? form.genre : detail.meta.genre)) || boot.genres[0]
      const steps = detail === null ? genre.steps : detail.steps
      const active = steps.find((s) => s.id === stepId) || steps[0]
      const chapterStep = detail === null ? undefined : detail.steps.find((s) => s.id === 'chapter')
      const chapterFiles = chapterStep === undefined ? [] : chapterStep.files
      const hasChapters = chapterFiles.length > 0
      // 「已有设定」：定位步重生成时，宿主会把下游已写产物（大纲/人物/卷大纲/章节大纲/正文标题）
      // 作为 {{existing}} 注入，让模型沿着已有设定写而不是另起一本新书（用户 m01079 的诉求）。
      const posExisting = detail === null ? [] : (() => {
        const names = []
        for (const [sid, label] of [['outline', '大纲'], ['characters', '人物'], ['volume-outline', '卷大纲'], ['chapter-outlines', '章节大纲']]) {
          const st = detail.steps.find((s) => s.id === sid)
          if (st !== undefined && st.done === true) names.push(label)
        }
        if (chapterFiles.length > 0) names.push('正文 ' + chapterFiles.length + ' 章')
        return names
      })()
      const posHasExisting = posExisting.length > 0
      const posExistingHint = posExisting.join(' / ')
      const posToken = detail === null ? '' : detail.id + ':positioning'
      const posConfirmed = posConfirm === posToken
      const isPolish = active.id === 'polish'
      const polishStep = detail === null ? undefined : detail.steps.find((s) => s.id === 'polish')
      const polishFiles = polishStep === undefined || !Array.isArray(polishStep.files) ? [] : polishStep.files
      const polishedSet = new Set(polishFiles.map((x) => String(x).replace(/-润色\.md$/i, '')))
      const noPolishYet = chapterFiles.filter((x) => !polishedSet.has(x.replace(/\.md$/i, '')))
      const isNovel = chapterStep !== undefined

      /** 步骤链第二行的进度文案。润色步单列「已润色 N / M 章」，免得只看到一个数字判断不出进度。 */
      const stepStat = (s) => {
        if (s.id === 'polish' && chapterFiles.length > 0) {
          const total = chapterFiles.length
          if (s.chapters >= total) return '已润色 ' + total + ' / ' + total + ' 章 · ' + fmtChars(s.chars)
          if (s.chapters > 0) return '已润色 ' + s.chapters + ' / ' + total + ' 章（还剩 ' + (total - s.chapters) + ' 章）· ' + fmtChars(s.chars)
          return '未润色（本作品共 ' + total + ' 章）'
        }
        return s.done
          ? (s.chapters > 0 ? s.chapters + (s.artifact === 'chapter-outlines' ? ' 卷 · ' : ' 章 · ') : '') + fmtChars(s.chars)
          : '未做'
      }
      const volumes = detail === null ? [] : (Array.isArray(detail.volumes) ? detail.volumes : [])
      // 卷下拉的显示标签：卷标题本身常带「第N卷：」（与 key 重复），展示时去掉前缀
      const volLabel = (v) => {
        const short = String(v.title ?? '').replace(/^(?:第[ \t]*[0-9０-９零〇一二三四五六七八九十百千两]+[ \t]*卷|卷[ \t]*[0-9０-９零〇一二三四五六七八九十百千两]+)[ \t]*[:：·、,.\-—_]+[ \t]*/, '')
        return v.key + ' · ' + (short === '' ? String(v.title ?? '') : short)
      }
      const isVolumeOutline = active.produces === 'volume-outline'
      const _cn = outlineSel === '' ? null : chapterNoFromTitle(outlineSel)
      const chapterNo = _cn === null ? null : chapterOffset + _cn
      const posCandidates = draft !== null && draft.stepId === 'positioning' ? parsePositionCandidates(draft.text) : []
      const posText = draft !== null && draft.stepId === 'positioning' ? String(draft.text === undefined || draft.text === null ? '' : draft.text) : ''

      // 「番茄上架信息」核对：解析与校验只在宿主做（lib/core/fanqie-tags.js），这里只拿结论渲染。
      // 依赖草稿全文：重新生成 / 手改草稿后自动重算；切换步骤或作品时清空。
      useEffect(() => {
        if (active.id !== 'positioning' || posCandidates.length === 0) {
          setFanqieReports(null)
          setFanqieLimits(null)
          return undefined
        }
        let alive = true
        api('fanqieTags', {
          action: 'parse',
          texts: posCandidates.map((c) => c.body),
          titles: posCandidates.map((c) => c.name),
        })
          .then((r) => {
            if (!alive) return
            setFanqieReports(Array.isArray(r.reports) ? r.reports : [])
            setFanqieLimits(r.limits === undefined ? null : r.limits)
          })
          .catch(() => {
            if (!alive) return
            setFanqieReports(null)
            setFanqieLimits(null)
          })
        return () => { alive = false }
      }, [active.id, posText])

      useEffect(() => {
        if (detail !== null && stepId === '') setStepId(detail.steps[0].id)
      }, [detail, stepId])

      useEffect(() => {
        setPromptEdit(null)
        setShowPrompt(false)
        setPromptPreview(true)
        setInjectOpen(false)
        setInjectData(null)
        setExtra('')
      }, [stepId, detail === null ? '' : detail.id])

      // 定位步「已有设定」的二次确认：换步骤就作废，避免跨步骤残留
      useEffect(() => {
        setPosConfirm('')
      }, [stepId, detail === null ? '' : detail.id])

      useEffect(() => {
        setViewMode('step')
      }, [detail === null ? '' : detail.id])

      // 切作品（或保存后详情刷新）时，把「风格画像」下拉对齐到该作品当前的绑定
      useEffect(() => {
        setStylePick(detail === null ? '' : (detail.meta.styleId ?? ''))
      }, [detail === null ? '' : detail.id, detail === null ? '' : (detail.meta.styleId ?? '')])

      useEffect(() => {
        if (detail === null) {
          setChapterSel('')
          return
        }
        if (chapterStep !== undefined && chapterStep.files.length > 0) {
          setChapterSel(chapterStep.files[chapterStep.files.length - 1])
        } else {
          setChapterSel('')
        }
      }, [detail === null ? '' : detail.id])

      useEffect(() => {
        if (detail === null) { setVolumeSel(''); return }
        const vols = Array.isArray(detail.volumes) ? detail.volumes : []
        if (vols.length === 0) { setVolumeSel(''); return }
        setVolumeSel((prev) => (prev !== '' && vols.some((v) => v.key === prev)) ? prev : vols[0].key)
      }, [detail === null ? '' : detail.id])

      useEffect(() => {
        setOutlineSel('')
        setChapterName('')
        setOutlineBlocks([])
        setChapterOffset(0)
        if (detail === null || active.produces !== 'chapter') return
        const coStep = detail.steps.find((s) => s.id === 'chapter-outline')
        if (coStep === undefined || coStep.done !== true) return
        if (volumeSel === '') return
        let alive = true
        const vols = Array.isArray(detail.volumes) ? detail.volumes : []
        const idx = vols.findIndex((v) => v.key === volumeSel)
        // 全局章节偏移：当前卷之前所有卷的章节大纲块数之和，把卷内「第 N 章」映射为全局「第NNN章」编号
        const offsetP = idx > 0
          ? Promise.all(vols.slice(0, idx).map((v) =>
              api('read', { id: detail.id, path: 'chapter-outlines/' + v.key + '.md' })
                .then((d) => parseOutlineBlocks(d.text || '').length)
                .catch(() => 0),
            )).then((counts) => counts.reduce((a, b) => a + b, 0))
          : Promise.resolve(0)
        const blocksP = api('read', { id: detail.id, path: 'chapter-outlines/' + volumeSel + '.md' })
          .then((d) => parseOutlineBlocks(d.text || ''))
          .catch(() => [])
        Promise.all([offsetP, blocksP]).then(([offset, blocks]) => {
          if (!alive) return
          setChapterOffset(offset)
          setOutlineBlocks(blocks)
        })
        return () => { alive = false }
      }, [detail, stepId, volumeSel])

      useEffect(() => {
        setWordsPick({
          words: detail === null ? 0 : Number(detail.meta.words ?? 0),
          totalWords: detail === null ? 0 : Number(detail.meta.totalWords ?? 0),
        })
      }, [detail === null ? '' : detail.id, detail === null ? 0 : detail.meta.words, detail === null ? 0 : detail.meta.totalWords])

      useEffect(() => {
        setCoCount(0)
        if (detail === null || active.id !== 'chapter-outline' || volumeSel === '') return
        let alive = true
        api('read', { id: detail.id, path: 'chapter-outlines/' + volumeSel + '.md' })
          .then((d) => { if (alive) setCoCount(parseOutlineBlocks(d.text || '').length) })
          .catch(() => { /* 还没保存过：保持 0 */ })
        return () => { alive = false }
      }, [detail, stepId, volumeSel])

      const saveProjectWords = async () => {
        if (detail === null) return
        if (!(wordsPick.words > 0)) { setErr('单章目标字数必须大于 0'); return }
        setWordsSaving(true)
        setErr('')
        try {
          const data = await api('project', { action: 'words', id: detail.id, words: wordsPick.words, totalWords: wordsPick.totalWords })
          await onCreated({ id: detail.id })
          const w = data.meta === undefined ? wordsPick.words : data.meta.words
          flash('篇幅已更新：单章目标 ' + w + ' 字（对之后生成的每一步生效）')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setWordsSaving(false)
        }
      }

      const create = async () => {
        if (form.genre !== 'novel' && form.name.trim() === '') {
          setErr('请先填作品名（它同时是书名/项目名，也是落盘目录名）')
          return
        }
        if (genre.requireWords === true && !(form.words > 0)) {
          setErr('请填写「' + genre.wordsLabel + '」——「' + genre.label + '」类型必填')
          return
        }
        setBusy('create')
        try {
          const payload = await api('project', {
            name: form.name.trim(),
            genre: form.genre,
            theme: form.theme,
            audience: form.audience,
            tone: form.tone,
            templateId: form.templateId,
            styleId: form.styleId,
            vaultNotes: form.vaultNotes,
            words: form.words > 0 ? form.words : undefined,
            channel: form.channel,
            type: form.type,
            totalWords: form.totalWords > 0 ? form.totalWords : undefined,
            tags: form.tags,
            count: form.count,
          })
          await onCreated(payload)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      const addTag = () => {
        const t = tagInput.trim()
        if (t === '') return
        setForm(Object.assign({}, form, { tags: form.tags.includes(t) ? form.tags : form.tags.concat([t]) }))
        setTagInput('')
      }

      const searchVault = async () => {
        setErr('')
        try {
          const q = vaultQuery.trim()
          const d = q === ''
            ? await api('vault', { action: 'list' })
            : await api('vault', { action: 'search', query: q })
          setVaultResults(d.notes !== undefined ? d.notes : (d.results !== undefined ? d.results : []))
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      const listVault = async () => {
        setErr('')
        try {
          const d = await api('vault', { action: 'list' })
          setVaultResults(d.notes !== undefined ? d.notes : [])
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      const toggleVaultNote = (p) => {
        setForm(Object.assign({}, form, {
          vaultNotes: form.vaultNotes.includes(p) ? form.vaultNotes.filter((x) => x !== p) : form.vaultNotes.concat([p]),
        }))
      }

      /** 切换当前 Obsidian 知识库（vault）：把所选 vault 路径写进配置，再刷新状态与笔记列表。 */
      const selectVault = async (path) => {
        if (path === null || path === undefined || path === '') return
        setErr('')
        try {
          const data = await api('config', { patch: { vaultPath: path } })
          if (data.warning !== '') flash(data.warning)
          const fresh = await api('state')
          setBoot(fresh)
          setVaultResults([])
          setVaultQuery('')
          setForm(Object.assign({}, form, { vaultNotes: [] }))
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      /** 一键：从当前 vault 自动学习（风格画像）+ 推断题材 + 建立作品。 */
      const autoCreate = async () => {
        if (busy === 'autocreate') return
        setErr('')
        setBusy('autocreate')
        try {
          const data = await api('autocreate', {})
          await onCreated(data)
          flash('已自动学习并建立作品：' + data.meta.name + '（读 ' + data.notesCount + ' 篇笔记 · 风格 ' + data.styleId + '）')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      /** 把提示词 / 风格画像导出成 vault 笔记（Obsidian 库）。默认不覆盖已有笔记，避免冲掉手改版。 */
      const exportLibrary = async (kind) => {
        if (busy === 'library') return
        setErr('')
        setBusy('library')
        try {
          const data = await api('library', { action: 'export', kind, overwrite: overwriteNotes })
          flash('已导出 ' + data.written.length + ' 篇' + (data.skipped.length > 0 ? '，跳过已有 ' + data.skipped.length + ' 篇' : '') + (data.failed.length > 0 ? '，失败 ' + data.failed.length + ' 篇' : ''))
          await refresh()
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      /** 上传封面：选择 jpg/png 图片，读成 base64 后上传，落盘 cover.<ext>。 */
      const pickCover = () => {
        const input = document.getElementById('cover-file-input')
        if (input) input.click()
      }

      const readFileAsDataURL = (file) => new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.onerror = () => reject(new Error('读取封面文件失败'))
        fr.readAsDataURL(file)
      })

      const onCoverFile = async (ev) => {
        const file = ev && ev.target && ev.target.files && ev.target.files[0]
        if (file === undefined || file === null || detail === null) return
        ev.target.value = ''
        const ext = String((file.name.split('.').pop() || '')).toLowerCase()
        if (ext !== 'jpg' && ext !== 'jpeg' && ext !== 'png') {
          setErr('仅支持 jpg / png 封面图片')
          return
        }
        if (file.size > 5 * 1024 * 1024) {
          setErr('封面图片不能超过 5MB')
          return
        }
        setErr('')
        setBusy('cover')
        try {
          const data = await readFileAsDataURL(file)
          const res = await api('uploadCover', { id: detail.id, data, ext: ext === 'jpeg' ? 'jpg' : ext })
          setCover({ url: data, rel: res.rel })
          flash('封面已上传：' + res.rel)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      /** 把当前封面下载为原始图片文件。 */
      const downloadCover = () => {
        if (cover === null || cover.url === '') return
        const a = document.createElement('a')
        a.href = cover.url
        a.download = cover.rel
        a.click()
      }

      // 打开作品时若已有封面（cover.jpg / cover.png），直接载入预览
      useEffect(() => {
        if (detail === null) { setCover(null); return }
        let alive = true
        api('coverInfo', { id: detail.id })
          .then((d) => { if (alive && d.exists) setCover({ url: d.dataUrl, rel: d.rel }) })
          .catch(() => {})
        return () => { alive = false }
      }, [detail === null ? '' : detail.id])

      /** 给「已有的作品」换风格：只改绑定，不动其它元数据（宿主 route('project') 的 style 分支）。 */
      const saveProjectStyle = useCallback(
        async () => {
          if (detail === null) return
          setStyleSaving(true)
          setErr('')
          try {
            // 同时带上 name/genre：宿主未重启（还没有 style 分支）时会退回 ensureProject 的同名补全路径，
            // 结果仍是「更新这个作品」，而不是新建一个「未命名-时间戳」的垃圾作品。
            await api('project', { action: 'style', id: detail.id, styleId: stylePick, name: detail.meta.name, genre: detail.meta.genre })
            const fresh = await api('detail', { id: detail.id })
            setDetail(fresh)
            await refresh()
            const picked = boot.styles.find((s) => s.id === stylePick)
            flash(stylePick === '' ? '已解除风格画像绑定' : '已绑定风格画像：' + (picked === undefined ? stylePick : picked.name))
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e))
          } finally {
            setStyleSaving(false)
          }
        },
        [detail, stylePick, refresh, setDetail, flash, setErr, boot.styles],
      )

      // 「本步实际注入」：与 route('run') 同一条取数/渲染路径（不发模型调用），
      // 让用户直接看到 {{style}} / {{vault}} 在本步被渲染成了什么。
      const loadInject = async () => {
        if (injectOpen) { setInjectOpen(false); return }
        setInjectOpen(true)
        setInjectData(null)
        setInjectBusy(true)
        try {
          const data = await api('preview', {
            id: detail.id,
            genre: detail.meta.genre,
            step: active.id,
            templateId: detail.meta.templateId ?? '',
            chapter: chapterSel ?? '',
            volume: isVolumeOutline ? volumeSel : '',
            extra: extra,
          })
          setInjectData(data)
        } catch (e) {
          setErr(String(e && e.message ? e.message : e))
          setInjectOpen(false)
        } finally {
          setInjectBusy(false)
        }
      }

      const runStep = async (opts) => {
        const cont = opts !== null && typeof opts === 'object' && opts.continue === true
        if (busy === 'autowrite' || busy === 'autopolish') return
        if (detail === null) return
        if (active.id === 'positioning' && posHasExisting && !posConfirmed) {
          // 已有下游产物时不再硬锁，改为二次确认（用户 m01079：定位重跑不能再凭空另起一本新书）
          setPosConfirm(posToken)
          setErr('这部作品已经写下：' + posExistingHint + '。重新点一次「按已有设定重写」才会重跑定位：会把上面这些已有设定发给模型，要求人物/地名/金手指/主线与它们一致（不会另起新故事）；仍会覆盖当前定位草稿，已写章节正文不动。')
          return
        }
        if (active.id === 'positioning') setPosConfirm('')
        if (isVolumeOutline && volumes.length === 0) {
          setErr('请先完成「卷大纲」这一步（拆出卷次），再为某一卷生成章节大纲')
          return
        }
        if (isPolish && hasChapters && chapterSel === '') {
          setErr('请先选择要润色的那一章')
          return
        }
        if (active.produces === 'chapter') {
          if (outlineBlocks.length === 0) {
            setErr('这一卷还没有章节大纲。请先完成「章节大纲」步骤（并在上方选对卷），再回来写正文')
            return
          }
          if (outlineSel === '') {
            setErr('请先从章节大纲里选择要写的这一章')
            return
          }
        }
        setBusy('run')
        setErr('')
        setDraft(null)
        try {
          const body = {
            id: detail.id,
            genre: detail.meta.genre,
            step: active.id,
            extra,
            templateId: detail.meta.templateId,
          }
          if (active.id === 'positioning' && positionCount > 0) body.count = positionCount
          // 章节大纲「继续补齐」：从已保存的细纲往后接着写，不从头重来（用户 m02715）
          if (cont) body.continue = true
          if (isPolish && hasChapters) body.chapter = chapterSel
          if (isVolumeOutline) body.volume = volumeSel
          // 章节步把「全局章号 + 本章细纲标题」带给宿主：宿主据此把正文首行统一成
          // 「第NNN章 章名」（模型自己写的编号常是卷内局部号，不可信）。
          if (active.produces === 'chapter' && chapterNo !== null) {
            body.chapterNo = chapterNo
            body.chapterTitle = outlineSel !== '' ? outlineSel : chapterName
          }
          const data = await api('run', body)
          setDraft(Object.assign({}, data, { stepId: active.id }))
          if (data.artifact === 'chapters' && chapterName.trim() === '') setChapterName(nextChapterName(chapterFiles))
          if (data.warning !== '') flash(data.warning)
          else if (data.rounds > 1) flash('已分 ' + data.rounds + ' 轮写完（自动续写 ' + (data.rounds - 1) + ' 次补齐篇幅）')
          if (isPolish && chapterSel !== '') {
            // 润色稿与原文逐字一致时明示一次：否则用户会以为「润色没生效 / 一直显示未改」。
            try {
              const orig = await api('read', { id: detail.id, path: 'chapters/' + chapterSel })
              if (sameChapterBody(orig.text, data.text)) {
                flash('⚠ 这一章的润色稿与原文逐字一致（模型这次没改动任何字）。可以在「本次额外要求」里写清要改的点，或重新生成一次。')
              }
            } catch (e) { /* 读原文失败不打扰生成流程 */ }
          }
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      const saveDraft = async () => {
        if (busy === 'autowrite' || busy === 'autopolish') return
        if (draft === null || detail === null) return
        setBusy('save')
        try {
          let rel = draft.artifact
          if (rel === 'chapter-outlines') {
            const volKey = (typeof draft.volume === 'string' && draft.volume !== '' ? draft.volume : volumeSel)
            rel = 'chapter-outlines/' + volKey + '.md'
          } else if (rel === 'chapters') {
            if (draft.stepId === 'polish') {
              // 润色落成独立版本文件：chapters/第NNN章-润色.md（原章不覆盖）
              const stem = String(draft.chapter ?? '').replace(/\.md$/i, '')
              if (stem === '') {
                setErr('请先选择要润色的那一章，再保存')
                return
              }
              rel = 'chapters/' + stem + '-润色.md'
            } else {
              // 章节正文：编号锁定为所选章节（大纲「第 N 章」），章名可作后缀（第NNN章[-章名].md）
              const chapterStep = detail.steps.find((s) => s.id === 'chapter')
              const files = chapterStep === undefined ? [] : chapterStep.files
              rel = 'chapters/' + chapterFileName(chapterNo, chapterName, files) + '.md'
            }
          }
          await api('save', { id: detail.id, path: rel, text: draft.text })
          const fresh = await api('detail', { id: detail.id })
          setDetail(fresh)
          setDraft(null)
          flash('已落盘：' + rel)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      /** 整卷自动生成：按所选卷的章节大纲顺序，逐章生成正文并落盘（跳过已有章节）。 */
      const autoWriteVolume = async () => {
        if (detail === null || busy !== '') return
        if (outlineBlocks.length === 0) {
          setErr('这一卷还没有章节大纲。请先完成「章节大纲」步骤（并在上方选对卷），再整卷自动生成')
          return
        }
        const chapterStep = detail.steps.find((s) => s.id === 'chapter')
        const files = chapterStep === undefined ? [] : chapterStep.files
        const isDone = (stem) => files.some((f) => {
          const s = String(f).replace(/\.md$/i, '')
          return s === stem || s.startsWith(stem + '-')
        })
        const todo = []
        for (const b of outlineBlocks) {
          const localNo = chapterNoFromTitle(b.title)
          if (localNo === null) continue
          const no = chapterOffset + localNo
          const stem = '第' + String(no).padStart(3, '0') + '章'
          if (isDone(stem)) continue
          todo.push({ stem, no, title: b.title, body: b.body })
        }
        if (todo.length === 0) {
          flash('这一卷的章节都已生成，无需重复生成')
          return
        }
        setBusy('autowrite')
        setErr('')
        setAutoProgress({ current: '', index: 0, total: todo.length, fail: [] })
        let done = 0
        const fail = []
        for (let i = 0; i < todo.length; i++) {
          const item = todo[i]
          setAutoProgress({ current: item.stem, index: done, total: todo.length, fail: fail.slice() })
          try {
            const data = await api('run', {
              id: detail.id,
              genre: detail.meta.genre,
              step: 'chapter',
              extra: item.body,
              chapterNo: item.no,
              chapterTitle: item.title,
              templateId: detail.meta.templateId,
            })
            await api('save', { id: detail.id, path: 'chapters/' + item.stem + '.md', text: data.text })
            done++
          } catch (e) {
            fail.push(item.stem + '：' + (e instanceof Error ? e.message : String(e)))
          }
          setAutoProgress({ current: item.stem, index: done, total: todo.length, fail: fail.slice() })
        }
        setBusy('')
        setAutoProgress(null)
        const fresh = await api('detail', { id: detail.id })
        setDetail(fresh)
        if (fail.length === 0) {
          flash('整卷自动生成完成：已生成 ' + done + ' 章')
        } else {
          setErr('整卷生成结束：成功 ' + done + ' 章，失败 ' + fail.length + ' 章。' + fail.join('；'))
        }
      }

      /**
       * 规整已落盘章节的首行标题：统一成「第NNN章 章名」（编号以文件名为真源）。
       * 新生成的章节宿主已经会规整，这里是为改造前写下的旧章节做一次性对齐；写前每个文件自动备份 .bak。
       */
      const normalizeChapters = async () => {
        if (detail === null || busy !== '') return
        setBusy('normalize')
        setErr('')
        try {
          const data = await api('normalize', { id: detail.id, apply: true })
          const fresh = await api('detail', { id: detail.id })
          setDetail(fresh)
          if (data.changed.length === 0) flash('已检查 ' + data.scanned + ' 章，首行标题本来就是统一的')
          else flash('已规整 ' + data.changed.length + ' / ' + data.scanned + ' 章的首行标题（原文件已备份为 .bak）')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      /** 整卷自动润色：对每一章原文生成润色稿并落盘（跳过已有润色稿）。 */
      const autoPolish = async () => {
        if (detail === null || busy !== '') return
        const chapterStep = detail.steps.find((s) => s.id === 'chapter')
        const chapterFiles = chapterStep === undefined ? [] : chapterStep.files
        if (chapterFiles.length === 0) {
          setErr('还没有已落盘的章节正文，请先在「章节」步生成章节')
          return
        }
        const polishStep = detail.steps.find((s) => s.id === 'polish')
        const polishFiles = polishStep === undefined ? [] : polishStep.files
        const todo = []
        for (const cf of chapterFiles) {
          const stem = String(cf).replace(/\.md$/i, '')
          if (polishFiles.some((f) => String(f).replace(/\.md$/i, '').startsWith(stem + '-润色'))) continue
          todo.push({ chapter: cf, stem })
        }
        if (todo.length === 0) {
          flash('所有章节都已润色，无需重复润色')
          return
        }
        setBusy('autopolish')
        setErr('')
        setAutoProgress({ current: '', index: 0, total: todo.length, fail: [] })
        let done = 0
        const fail = []
        for (let i = 0; i < todo.length; i++) {
          const item = todo[i]
          setAutoProgress({ current: item.chapter, index: done, total: todo.length, fail: fail.slice() })
          try {
            const data = await api('run', {
              id: detail.id,
              genre: detail.meta.genre,
              step: 'polish',
              chapter: item.chapter,
              templateId: detail.meta.templateId,
            })
            await api('save', { id: detail.id, path: 'chapters/' + item.stem + '-润色.md', text: data.text })
            done++
          } catch (e) {
            fail.push(item.chapter + '：' + (e instanceof Error ? e.message : String(e)))
          }
          setAutoProgress({ current: item.chapter, index: done, total: todo.length, fail: fail.slice() })
        }
        setBusy('')
        setAutoProgress(null)
        const fresh = await api('detail', { id: detail.id })
        setDetail(fresh)
        if (fail.length === 0) {
          flash('整卷自动润色完成：已润色 ' + done + ' 章')
        } else {
          setErr('整卷润色结束：成功 ' + done + ' 章，失败 ' + fail.length + ' 章。' + fail.join('；'))
        }
      }

      /** 批量定稿：把确认 OK 的润色稿覆盖回原章（原稿备份 .bak，润色稿删除），宿主一次完成。 */
      const finalizeAll = async () => {
        if (detail === null || busy !== '') return
        setBusy('finalize')
        setErr('')
        try {
          const data = await api('finalize', { id: detail.id })
          const fresh = await api('detail', { id: detail.id })
          setDetail(fresh)
          if (data.count > 0) flash('已定稿 ' + data.count + ' 章：润色稿已替换原稿，原稿备份为 .bak')
          else flash('没有可定稿的润色稿（请先「整卷自动润色」）')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      /** 番茄发布：范围输入与状态轮询（后台 Python 进程，宿主只回读日志/报告）。 */
      const pubMaxNo = chapterFiles.reduce((mx, f) => {
        const m = /^第0*(\d+)章/.exec(String(f))
        return m === null ? mx : Math.max(mx, Number(m[1]))
      }, 0)

      const pubScope = () => {
        const from = Number(String(pubFromInput).replace(/[^0-9]/g, ''))
        const to = Number(String(pubToInput === '' ? pubMaxNo : pubToInput).replace(/[^0-9]/g, ''))
        return { id: detail.id, from: from > 0 ? from : 1, to: to > 0 ? to : pubMaxNo }
      }

      const pubRefresh = async () => {
        try {
          const s = await api('publish', { action: 'status' })
          setPubStatus(s)
          return s
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
          return null
        }
      }

      /** 只列该发哪些章（宿主跑 --dry，只读本地文件、不开浏览器、不碰站点）。 */
      const pubPlan = async () => {
        if (detail === null || pubBusy !== '') return
        setPubBusy('plan')
        setErr('')
        setPubMsg('正在列发布计划（只读本地章节，不会打开浏览器）…')
        try {
          const d = await api('publish', Object.assign({ action: 'plan' }, pubScope()))
          setPubResult(d)
          const planned = d.report !== null && d.report !== undefined && Array.isArray(d.report.planned) ? d.report.planned : []
          if (d.code === 0) {
            setPubMsg('发布计划：共 ' + planned.length + ' 章（第 ' + pubScope().from + ' ~ ' + pubScope().to + '），逐章在番茄后台「新建章节 → 存草稿」。')
          } else {
            setPubMsg('计划生成失败（退出码 ' + d.code + '）：' + (d.stderr === '' ? '见下方输出' : String(d.stderr).slice(0, 300)))
          }
        } catch (e) {
          setPubMsg('')
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setPubBusy('')
        }
      }

      /** 真发：后台起 Python 发布器，逐章存草稿（不点发布）。 */
      const pubStart = async () => {
        if (detail === null || pubBusy !== '') return
        if (boot.publish === undefined || boot.publish.ready !== true) {
          setErr('还没配置番茄登录态目录：到「设置」页的「番茄小说登录态」卡片填上目录（例如 O:/DeepSeek Plugin/fanqie-data/writer-profile）并点「保存番茄配置」，再点「登录番茄」扫码即可')
          return
        }
        const sc = pubScope()
        const ok = window.confirm('将从第 ' + sc.from + ' 章发到第 ' + sc.to + ' 章，逐章在番茄后台新建草稿（只存草稿，不会点发布）。\n\n过程中会打开一个浏览器窗口，请勿关闭它；每章约 35~40 秒。\n\n确定开始？')
        if (ok === false) return
        setPubBusy('start')
        setErr('')
        try {
          const d = await api('publish', Object.assign({ action: 'start' }, sc))
          setPubResult(d)
          setPubMsg('发布已开始（pid ' + d.pid + '）。浏览器窗口打开后请勿关闭；进度见下方。')
          await pubRefresh()
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setPubBusy('')
        }
      }

      /** 只重新生成书名：宿主读定位稿 + 大纲摘录让模型起名，不写盘、不碰正文（番茄重名时用）。 */
      const genTitles = async () => {
        if (detail === null || titleBusy !== '') return
        setTitleBusy('gen')
        setErr('')
        setTitleMsg('正在按现有定位与大纲起名（不写盘、不改正文）…')
        try {
          const d = await api('title', { action: 'generate', id: detail.id, count: 4 })
          const list = Array.isArray(d.candidates) ? d.candidates : []
          setTitleCands(list)
          const usable = list.filter((x) => x.ok === true)
          setTitleMsg(
            usable.length === 0
              ? '模型没给出可用书名（超长或与现名重复），再点一次试试。'
              : '给了 ' + usable.length + ' 个可用书名：点「用这个名字」即改作品名（定位稿里的书名行一并同步，正文一个字不动）。' +
                (d.current === undefined || d.current === '' ? '' : '当前书名：' + d.current),
          )
        } catch (e) {
          setTitleCands(null)
          setTitleMsg('')
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setTitleBusy('')
        }
      }

      /** 应用书名：作品改名（目录 + meta.name）+ 同步定位稿的书名行，随后刷新详情。 */
      const applyTitle = async (c) => {
        if (detail === null || titleBusy !== '' || c.ok !== true) return
        setTitleBusy('apply')
        setErr('')
        try {
          const d = await api('title', { action: 'apply', id: detail.id, title: c.title })
          const fresh = await api('detail', { id: d.id })
          setDetail(fresh)
          setTitleCands(null)
          setTitleMsg('')
          flash('书名已改为「' + d.title + '」' + (d.draftUpdated === true ? '（定位稿里的书名行也已同步）' : '') + '：正文、大纲、人物一个字都没动')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setTitleBusy('')
        }
      }

      // 发布进行中每 3 秒回读一次进度（宿主返回日志尾巴 + 报告）
      React.useEffect(() => {
        if (pubStatus === null || pubStatus.running !== true) return undefined
        const t = setTimeout(() => { void pubRefresh() }, 3000)
        return () => clearTimeout(t)
      }, [pubStatus])

      const pubPickReport = () => {
        if (pubStatus !== null && pubStatus.report !== null && pubStatus.report !== undefined) return pubStatus.report
        if (pubResult !== null && pubResult.report !== null && pubResult.report !== undefined) return pubResult.report
        return null
      }

      const fastRun = async () => {
        if (busy === 'autowrite' || busy === 'autopolish') return
        if (detail === null) return
        setBusy('fast')
        setErr('')
        try {
          const data = await api('fast', { id: detail.id, templateId: detail.meta.templateId })
          const fresh = await api('detail', { id: detail.id })
          setDetail(fresh)
          const warns = data.results.filter((r) => r.warning !== '')
          flash(warns.length === 0 ? '快速成文完成，已逐步落盘' : '成文完成，但 ' + warns.length + ' 步被截断未落盘')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      const savePrompt = async (reset) => {
        if (detail === null) return
        setBusy('prompt')
        try {
          const body = { genre: detail.meta.genre, step: active.id, reset: reset === true }
          if (reset !== true && promptEdit !== null) {
            body.system = promptEdit.system
            body.user = promptEdit.user
          }
          const data = await api('prompt', body)
          const fresh = await api('detail', { id: detail.id })
          setDetail(fresh)
          setShowPrompt(false)
          setPromptEdit(null)
          flash(reset === true ? '已恢复内置提示词' : '提示词已保存（只对这个步骤生效）')
          void data
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      /** 选用某个候选：改名为所选书名，定位产物只保留该候选（未选候选删除），并刷新详情。 */
      const adoptTitle = async (c) => {
        if (detail === null || c.name === '') return
        setBusy('rename')
        setErr('')
        try {
          const data = await api('adopt', { id: detail.id, name: c.name, keep: c.body })
          const fresh = await api('detail', { id: data.id })
          setDetail(fresh)
          if (draft !== null && draft.stepId === 'positioning') {
            setDraft(Object.assign({}, draft, { text: c.body, chars: c.body.replace(/\s/g, '').length }))
          }
          flash('已选用「' + c.title + '」：定位只保留该候选（未选候选已删除），项目已改名')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      // ---- 没有打开作品：按顶栏类型看已生成列表，或进入「创建作品」 ----
      if (detail === null) {
        const filteredProjects = boot.projects.filter((p) => String(p.genre || '') === activeGenre)
        const genreHint = (boot.genres.find((g) => g.id === activeGenre) || boot.genres[0] || {}).hint || ''

        const projectList = h(
          'div',
          { style: Object.assign({}, S.scroll, viewModeHome === 'list' ? { flex: 1 } : { width: 340, borderRight: '1px solid ' + C.line, flexShrink: 0 }) },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, listTitle || '已生成的作品'),
          h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 10, lineHeight: 1.6 } },
            genreHint + ' · 共 ' + filteredProjects.length + ' 个'),
          filteredProjects.length === 0
            ? h('div', { style: S.dim }, '还没有这类作品。点顶部「创建作品」建第一个。')
            : filteredProjects.map((p) =>
                h(
                  'div',
                  {
                    key: p.id,
                    style: Object.assign({}, S.step, { marginBottom: 4, cursor: 'default' }),
                  },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    h('div', {
                      style: { flex: 1, minWidth: 0, cursor: 'pointer' },
                      title: '打开「' + p.name + '」',
                      onClick: () => void openProject(p.id),
                    },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                        h('span', { style: { fontWeight: 500 } }, p.name),
                        h(Chip, null, p.genreLabel),
                        p.styleId === undefined || p.styleId === ''
                          ? null
                          : h(Chip, null, '风格：' + ((p.styleName === undefined || p.styleName === '') ? p.styleId : p.styleName)),
                        h('span', { style: { flex: 1 } }),
                        h('span', { style: { color: C.faint, fontSize: 11 } }, p.updatedAt.slice(0, 10)),
                      ),
                      h('div', { style: { color: C.faint, fontSize: 11, marginTop: 2 } },
                        '已完成 ' + (p.done === undefined ? 0 : p.done.length) + ' 步 · ' + p.updatedAt.slice(0, 16).replace('T', ' ')),
                    ),
                    confirmDel === p.id
                      ? h('div', { style: { display: 'flex', gap: 4, flexShrink: 0 } },
                          h(Btn, {
                            variant: 'primary',
                            style: { background: C.err, borderColor: C.err, padding: '3px 8px', fontSize: 11.5 },
                            disabled: busy === 'delete',
                            onClick: () => void deleteProject(p),
                          }, busy === 'delete' ? '删除中…' : '确认删除'),
                          h(Btn, {
                            variant: 'ghost',
                            style: { padding: '3px 8px', fontSize: 11.5 },
                            onClick: () => setConfirmDel(''),
                          }, '取消'),
                        )
                      : h(Btn, {
                          variant: 'ghost',
                          title: '删除这个作品（会连 vault 里的镜像一起清掉）',
                          style: { flexShrink: 0, padding: '3px 8px', fontSize: 12.5 },
                          onClick: () => setConfirmDel(p.id),
                        }, '🗑'),
                  ),
                ),
              ),
          h('div', { style: { marginTop: 14, color: C.faint, fontSize: 11.5, lineHeight: 1.7 } },
            '点作品名打开；🗑 删除作品目录（vault 里的镜像一并清理）。',
            h('br'),
            '落盘根目录：',
            h('br'),
            h('code', { style: { fontFamily: monoStack, wordBreak: 'break-all' } }, boot.root),
          ),
        )

        if (viewModeHome === 'list') {
          return h('div', { style: Object.assign({}, S.main, { flexDirection: 'row' }) }, projectList)
        }

        return h(
          'div',
          { style: Object.assign({}, S.main, { flexDirection: 'row' }) },
          h(
            'div',
            { style: S.scroll },
            h('div', { style: S.card },
              h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, '创建作品 · ' + ((boot.genres.find((g) => g.id === form.genre) || {}).label || '')),
              form.genre !== 'novel'
                ? h(Field, { label: '作品名（同时是书名，也是目录名）' },
                    h(Input, { value: form.name, placeholder: '例如：长夜将明', onChange: (v) => setForm(Object.assign({}, form, { name: v })) }),
                  )
                : null,
              h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 10, lineHeight: 1.6 } },
                genre.hint + '（共 ' + genre.steps.length + ' 步）。写作类型由顶部「小说 / 公众号 / 小红书」切换。'),
              form.genre === 'novel'
                ? h('div', { style: { marginBottom: 10 } },
                    h('div', { style: { color: C.sub, fontSize: 12, fontWeight: 600, marginBottom: 8 } },
                      '小说属性（用于第一步「作品定位」生成候选）'),
                    h(Field, { label: '频道' },
                      h('div', { style: S.row },
                        ...(boot.novelOptions !== undefined ? boot.novelOptions.channels : []).map((c) =>
                          h(Btn, {
                            key: c.id,
                            variant: form.channel === c.id ? 'primary' : undefined,
                            onClick: () => setForm(Object.assign({}, form, { channel: c.id })),
                          }, c.label),
                        ),
                      ),
                    ),
                    h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
                      h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '类型（可选，也可自定义）' },
                        h(Input, {
                          list: 'novel-type-options',
                          value: form.type,
                          placeholder: '选一个或直接输入自定义类型',
                          onChange: (v) => setForm(Object.assign({}, form, { type: v })),
                        }),
                        h('datalist', { id: 'novel-type-options' },
                          ...(boot.novelOptions !== undefined ? boot.novelOptions.types : []).map((t) => h('option', { key: t, value: t })),
                        ),
                      )),
                      h('div', { style: { flex: '1 1 170px' } }, h(Field, { label: '小说总长度（字数）' },
                        h(Input, {
                          value: form.totalWords > 0 ? String(form.totalWords) : '',
                          placeholder: '例如 800000',
                          onChange: (v) => setForm(Object.assign({}, form, { totalWords: Number(String(v).replace(/[^0-9]/g, '')) || 0 })),
                        }))),
                      h('div', { style: { flex: '0 1 110px' } }, h(Field, { label: '候选数量' },
                        h(Input, {
                          value: form.count > 0 ? String(form.count) : '',
                          placeholder: '3',
                          onChange: (v) => {
                            const n = Number(String(v).replace(/[^0-9]/g, '')) || 0
                            setForm(Object.assign({}, form, { count: n > 0 ? Math.min(Math.max(n, 1), 6) : 3 }))
                          },
                        }))),
                    ),
                    h(Field, { label: '标签（多选，可空，可自定义）' },
                      form.tags.length > 0
                        ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 } },
                            ...form.tags.map((t) =>
                              h(Btn, {
                                key: 'sel-' + t,
                                variant: 'primary',
                                style: { padding: '4px 10px', fontSize: 12 },
                                title: '点一下移除',
                                onClick: () => setForm(Object.assign({}, form, { tags: form.tags.filter((x) => x !== t) })),
                              }, t),
                            ),
                          )
                        : null,
                      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                        ...(boot.novelOptions !== undefined ? boot.novelOptions.tags : []).filter((t) => !form.tags.includes(t)).map((t) =>
                          h(Btn, {
                            key: 'add-' + t,
                            style: { padding: '4px 10px', fontSize: 12 },
                            onClick: () => setForm(Object.assign({}, form, { tags: form.tags.concat([t]) })),
                          }, t),
                        ),
                      ),
                      h('div', { style: { display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' } },
                        h(Input, {
                          value: tagInput,
                          placeholder: '输入自定义标签，回车或点「添加」',
                          style: { flex: 1 },
                          onChange: setTagInput,
                          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } },
                        }),
                        h(Btn, { disabled: tagInput.trim() === '', onClick: addTag }, '添加'),
                      ),
                      h('div', { style: { color: C.faint, fontSize: 11.5, marginTop: 6 } },
                        form.tags.length === 0 ? '未选择标签，作品定位会从题材 / 受众 / 调性推断' : '已选 ' + form.tags.length + ' 个'),
                    ),
                  )
                : null,
              form.genre !== 'novel'
                ? h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
                    h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '内容方向 · 题材' },
                      h(Input, { value: form.theme, placeholder: '例如：末世悬疑 / 职场沟通', onChange: (v) => setForm(Object.assign({}, form, { theme: v })) }))),
                    h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '内容方向 · 受众' },
                      h(Input, { value: form.audience, placeholder: '例如：25-35 岁通勤女性', onChange: (v) => setForm(Object.assign({}, form, { audience: v })) }))),
                    h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '内容方向 · 调性' },
                      h(Input, { value: form.tone, placeholder: '例如：冷峻克制 / 亲切口语', onChange: (v) => setForm(Object.assign({}, form, { tone: v })) }))),
                  )
                : null,
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } },
                h('div', { style: { flex: '1 1 240px' } }, h(Field, { label: '结构模版（可选，也可稍后在模版页套）' },
                  h('select', {
                    style: Object.assign({}, S.input, { cursor: 'pointer' }),
                    value: form.templateId,
                    onChange: (e) => setForm(Object.assign({}, form, { templateId: e.target.value })),
                  },
                    h('option', { value: '' }, '不使用模版'),
                    ...boot.templates
                      .filter((t) => t.genre === '' || t.genre === form.genre)
                      .map((t) => h('option', { key: t.id, value: t.id }, t.name + (t.source === 'builtin' ? '' : '（自定义）'))),
                  ))),
                form.genre === 'novel'
                  ? h('div', { style: { flex: '1 1 240px' } }, h(Field, { label: '风格画像（可选，学习小说风格后套用）' },
                      h('select', {
                        style: Object.assign({}, S.input, { cursor: 'pointer' }),
                        value: form.styleId,
                        onChange: (e) => setForm(Object.assign({}, form, { styleId: e.target.value })),
                      },
                        h('option', { value: '' }, '不使用风格画像'),
                        ...sortStylesByTags(boot.styles, form.tags).map((s) => h('option', { key: s.id, value: s.id }, s.name)),
                      )))
                  : null,
                h('div', { style: { flex: '0 1 200px' } }, h(Field, { label: genre.wordsLabel },
                  h(Input, {
                    value: form.words > 0 ? String(form.words) : '',
                    placeholder: genre.requireWords === true ? '必填，例如 ' + genre.defaultWords : '留空 = ' + genre.defaultWords,
                    onChange: (v) => setForm(Object.assign({}, form, { words: Number(String(v).replace(/[^0-9]/g, '')) || 0 })),
                  }))),
              ),
              h(Field, { label: '参考笔记（Obsidian 知识库，可选）' },
                boot.vault !== undefined && boot.vault.available !== true
                  ? h('div', { style: { color: C.faint, fontSize: 11.5 } }, '未检测到 Obsidian 知识库：请先在 Obsidian 里打开/注册一个 vault')
                  : null,
                boot.vault !== undefined && Array.isArray(boot.vault.vaults) && boot.vault.vaults.length > 0
                  ? h(Field, { label: '选择 Obsidian 知识库（vault）' },
                      h('select', {
                        style: Object.assign({}, S.input, { cursor: 'pointer' }),
                        value: boot.vault.selected === null || boot.vault.selected === undefined ? '' : boot.vault.selected,
                        onChange: (e) => { if (e.target.value !== '') void selectVault(e.target.value) },
                      },
                        ...boot.vault.vaults.map((v) =>
                          h('option', { key: (v.id !== undefined && v.id !== '') ? v.id : v.path, value: v.path },
                            v.name + (v.open === true ? '（已打开）' : '')),
                        ),
                      ),
                    )
                  : null,
                boot.vault !== undefined && boot.vault.available === true
                  ? h('div', { style: { marginBottom: 8 } },
                      h(Btn, {
                        variant: 'primary',
                        disabled: busy === 'autocreate',
                        title: '读取当前 vault 全部笔记 → 学习风格 + 推断题材 → 自动建立作品',
                        onClick: () => void autoCreate(),
                      }, busy === 'autocreate' ? '学习中并建作品中…' : '自动学习并建立作品'),
                      h('div', { style: { color: C.faint, fontSize: 11.5, marginTop: 4, lineHeight: 1.6 } },
                        '选好上方 vault 后点这里：自动读库里的笔记，学习文风、推断题材与书名，并直接建立一个作品（笔记作为参考素材）。'),
                    )
                  : null,
                boot.vault !== undefined && boot.vault.available === true && boot.library !== undefined
                  ? h('div', { style: { border: '1px solid ' + C.line, borderRadius: 6, padding: '8px 10px', marginBottom: 8 } },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' } },
                        h('span', { style: { fontWeight: 600 } }, '📚 Obsidian 库'),
                        h(Chip, null, '提示词 ' + boot.library.prompts + ' 篇'),
                        h(Chip, null, '风格画像 ' + boot.library.styles + ' 份'),
                      ),
                      h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 6, lineHeight: 1.7 } },
                        '提示词与风格画像都存在 vault 的 dsh-writer-m/ 下：**在 Obsidian 里直接改这些笔记，下一次生成立刻生效**（vault 版本优先于插件内置与本地覆盖）。'),
                      boot.library.promptErrors !== undefined && boot.library.promptErrors.length > 0
                        ? h('div', { style: { color: C.warn, fontSize: 11.5, marginBottom: 6, lineHeight: 1.7 } },
                            '有 ' + boot.library.promptErrors.length + ' 篇提示词笔记没有 system / user 段，已忽略：' + boot.library.promptErrors.join('、'))
                        : null,
                      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                        h(Btn, { disabled: busy === 'library', title: '把每一步的提示词写成 vault 笔记（dsh-writer-m/提示词/<类型>-<步骤>.md）', onClick: () => void exportLibrary('prompts') }, busy === 'library' ? '导出中…' : '导出提示词'),
                        h(Btn, { disabled: busy === 'library', title: '把本地风格画像写成 vault 笔记（dsh-writer-m/风格画像/<id>.md）', onClick: () => void exportLibrary('styles') }, '导出风格画像'),
                        h(Btn, { variant: 'ghost', disabled: busy === 'library', title: '提示词 + 风格画像一起导出', onClick: () => void exportLibrary('all') }, '全部导出'),
                        h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, color: C.sub, fontSize: 11.5 } },
                          h('input', { type: 'checkbox', checked: overwriteNotes, onChange: (e) => setOverwriteNotes(e.target.checked) }),
                          '覆盖已有笔记',
                        ),
                      ),
                    )
                  : null,
                h('div', { style: { display: 'flex', gap: 6, marginBottom: 6 } },
                  h(Input, {
                    value: vaultQuery,
                    placeholder: '搜索笔记标题 / 正文关键词',
                    style: { flex: 1 },
                    onChange: setVaultQuery,
                    onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); void searchVault() } },
                  }),
                  h(Btn, { disabled: (boot.vault !== undefined && boot.vault.available !== true), onClick: () => void searchVault() }, '搜索'),
                  h(Btn, { variant: 'ghost', disabled: (boot.vault !== undefined && boot.vault.available !== true), onClick: () => void listVault() }, '列出全部'),
                ),
                form.vaultNotes.length > 0
                  ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 } },
                      ...form.vaultNotes.map((p) =>
                        h(Btn, {
                          key: 'vn-' + p,
                          variant: 'primary',
                          style: { padding: '4px 10px', fontSize: 12 },
                          title: '点一下移除',
                          onClick: () => setForm(Object.assign({}, form, { vaultNotes: form.vaultNotes.filter((x) => x !== p) })),
                        }, p),
                      ),
                    )
                  : null,
                vaultResults.length > 0
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto', border: '1px solid ' + C.line, borderRadius: 6, padding: 6 } },
                      ...vaultResults.map((n) =>
                        h('button', {
                          key: n.path,
                          type: 'button',
                          style: Object.assign({}, S.step, { textAlign: 'left', padding: '6px 8px' }),
                          onClick: () => toggleVaultNote(n.path),
                        },
                          h('span', { style: { fontWeight: form.vaultNotes.includes(n.path) ? 600 : 400 } }, (form.vaultNotes.includes(n.path) ? '✓ ' : '') + (n.title || n.path))),
                      ),
                    )
                  : null,
              ),
              h('div', { style: S.row },
                h(Btn, { variant: 'primary', disabled: busy === 'create', onClick: () => void create() },
                  busy === 'create' ? '建立中…' : '建立作品'),
                h('span', { style: { color: C.faint, fontSize: 11.5 } },
                  form.genre === 'novel'
                    ? '建立后第一步生成候选书名，选定即自动命名'
                    : '目录：' + boot.root + '\\' + (form.name.trim() === '' ? '（作品名）' : form.name.trim())),
              ),
            ),
          ),
        )
      }

      // ---- 已打开作品：左步骤 + 右工作区 ----
      const doneCount = detail.steps.filter((s) => s.done).length
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: S.steps },
          h(Btn, {
            variant: 'ghost',
            onClick: () => {
              setStepId('')
              if (typeof onBackToList === 'function') onBackToList()
              else setDetail(null)
            },
            style: { marginBottom: 8 },
          }, '← 作品列表'),
          h('div', { style: { color: C.faint, fontSize: 11, padding: '0 9px 8px' } },
            '进度 ' + doneCount + ' / ' + detail.steps.length + ' 步'),
          ...detail.steps.map((s) =>
            h(
              'button',
              {
                key: s.id,
                type: 'button',
                style: Object.assign({}, S.step, active.id === s.id ? S.stepActive : {}),
                onClick: () => setStepId(s.id),
              },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { color: s.done ? C.ok : C.faint, fontSize: 11, width: 12 } }, s.done ? '●' : '○'),
                h('span', { style: { fontWeight: active.id === s.id ? 600 : 400 } }, s.no + '. ' + s.label),
                s.overridden ? h(Chip, { style: { padding: '0 5px', fontSize: 10 } }, '改') : null,
              ),
              h('div', { style: { color: C.faint, fontSize: 11, marginTop: 2, paddingLeft: 18 } }, stepStat(s)),
            ),
          ),
        ),
        h(
          'div',
          { style: S.main },
          viewMode === 'final'
            ? h(FinalView, { detail, setErr, flash, onBack: () => setViewMode('step') })
            : h(
                React.Fragment,
                null,
                h(
                  'div',
                  { style: Object.assign({}, S.topbar, { background: 'transparent', borderBottom: '1px solid ' + C.line }) },
            h('span', { style: { fontWeight: 600 } }, '第 ' + active.no + ' 步 · ' + active.label),
            h('span', { style: { color: C.sub, fontSize: 12 } }, active.goal),
            h('div', { style: { flex: 1 } }),
            h(Btn, { variant: showPrompt ? 'primary' : undefined, onClick: () => {
              setShowPrompt(!showPrompt)
              setPromptPreview(true)
              if (promptEdit === null) setPromptEdit({ system: active.system, user: active.user })
            } }, '提示词'),
            h(Btn, { variant: 'primary', disabled: busy === 'run', title: active.id === 'positioning'
              ? (posHasExisting ? '按已有设定重写定位：以已写下的大纲/人物/卷大纲为准，不会另起新故事（第一次点只做确认）' : '按频道/类型/总长度/标签生成若干个定位候选')
              : undefined, onClick: () => void runStep() },
              busy === 'run' ? '生成中…' : (active.id === 'positioning' && posHasExisting ? '按已有设定重写' : '生成草稿')),
            active.id === 'chapter-outline' && coCount > 0
              ? h(Btn, { variant: 'ghost', disabled: busy === 'run', title: '读已保存的细纲，从第 ' + (coCount + 1) + ' 章接着往下补（不重新生成前面的章）', onClick: () => void runStep({ continue: true }) },
                  busy === 'run' ? '补写中…' : '继续补齐（已存 ' + coCount + ' 章）')
              : null,
            h(Btn, { variant: 'ghost', disabled: busy === 'cover', title: '上传 jpg/png 图片作为封面（≤5MB）', onClick: () => void pickCover() },
              busy === 'cover' ? '上传封面中…' : '📤 上传封面'),
            isNovel
              ? h(Btn, { variant: 'ghost', onClick: () => setViewMode('final'), title: '查看每章最终定稿（润色稿 → 原文）' }, '📖 最终定稿')
              : null,
            detail !== null && detail.meta.genre !== 'novel'
              ? h(Btn, { variant: 'ghost', disabled: busy === 'fast', onClick: () => void fastRun() },
                  busy === 'fast' ? '成文中…' : '快速成文')
              : null,
          ),
          h('input', { id: 'cover-file-input', type: 'file', accept: 'image/jpeg,image/png', style: { display: 'none' }, onChange: (ev) => void onCoverFile(ev) }),
          h(
            'div',
            { style: S.scroll },
            cover !== null
              ? h('div', { style: S.card },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                    h('span', { style: { fontWeight: 600 } }, '📕 封面'),
                    h(Chip, null, cover.rel),
                    h('div', { style: { flex: 1 } }),
                    h(Btn, { onClick: () => void downloadCover() }, '下载封面'),
                    h(Btn, { variant: 'ghost', onClick: () => setCover(null) }, '收起'),
                  ),
                  h('img', {
                    src: cover.url,
                    alt: '封面预览',
                    style: { width: '100%', maxWidth: 300, display: 'block', margin: '0 auto', borderRadius: 8, border: '1px solid ' + C.line },
                  }),
                )
              : null,
            // 篇幅：单章目标字数 / 全书总长度，可随时改（用户 m02810：新建时把 300000 填进了
            // 「单章目标字数」，之后没有任何入口能改回来，单章生成永远提示「未达目标 300000 字」）。
            detail === null || detail.meta.genre !== 'novel'
              ? null
              : h('div', { style: S.card },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
                    h('span', { style: { fontWeight: 600 } }, '📏 篇幅'),
                    h(Chip, null, '单章目标 ' + detail.meta.words + ' 字'),
                    detail.meta.totalWords > 0 ? h(Chip, null, '全书 ' + detail.meta.totalWords + ' 字') : null,
                    h('div', { style: { flex: 1 } }),
                    h(Btn, {
                      variant: wordsPick.words === detail.meta.words && wordsPick.totalWords === (detail.meta.totalWords ?? 0) ? 'ghost' : 'primary',
                      disabled: wordsSaving,
                      title: '只改作品设置：改完对之后生成的每一步生效，已写下的稿子不动',
                      onClick: () => void saveProjectWords(),
                    }, wordsSaving ? '保存中…' : '保存篇幅'),
                  ),
                  h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                    '单章目标字数建议 ' + (wordsRange === null ? 2500 : wordsRange.min) + '–' + (wordsRange === null ? 4000 : wordsRange.max) +
                    ' 字：它同时是正文步「写够才算完」的目标，填成全书总字数会让单章一直提示「未达目标」。'),
                  h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
                    h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '单章目标字数' },
                      h(Input, {
                        value: wordsPick.words > 0 ? String(wordsPick.words) : '',
                        placeholder: '例如 3000',
                        onChange: (v) => setWordsPick(Object.assign({}, wordsPick, { words: Number(String(v).replace(/[^0-9]/g, '')) || 0 })),
                      }))),
                    h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '全书总长度（字数，可选）' },
                      h(Input, {
                        value: wordsPick.totalWords > 0 ? String(wordsPick.totalWords) : '',
                        placeholder: '例如 800000',
                        onChange: (v) => setWordsPick(Object.assign({}, wordsPick, { totalWords: Number(String(v).replace(/[^0-9]/g, '')) || 0 })),
                      }))),
                  ),
                ),
            // 风格画像：给「已有的作品」换绑定（新建时选过一次之后，这是唯一的改法）
            detail === null
              ? null
              : h('div', { style: S.card },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                    h('span', { style: { fontWeight: 600 } }, '🎨 风格画像'),
                    h(Chip, null, detail.meta.styleId === undefined || detail.meta.styleId === ''
                      ? '未绑定'
                      : ((boot.styles.find((s) => s.id === detail.meta.styleId) ?? { name: detail.meta.styleId }).name)),
                    (boot.styles.find((s) => s.id === detail.meta.styleId) ?? {}).source === 'vault'
                      ? h(Chip, null, '来自 Obsidian')
                      : null,
                    h('div', { style: { flex: 1 } }),
                    h(Btn, {
                      variant: stylePick === (detail.meta.styleId ?? '') ? 'ghost' : 'primary',
                      disabled: styleSaving || stylePick === (detail.meta.styleId ?? ''),
                      title: '改完立刻对之后生成的「大纲 / 卷大纲 / 章节 / 润色」生效',
                      onClick: () => void saveProjectStyle(),
                    }, styleSaving ? '保存中…' : (stylePick === (detail.meta.styleId ?? '') ? '已是最新' : '保存绑定')),
                  ),
                  h('select', {
                    style: Object.assign({}, S.input, { cursor: 'pointer' }),
                    value: stylePick,
                    onChange: (e) => setStylePick(e.target.value),
                  },
                    h('option', { value: '' }, '（不指定风格画像）'),
                    ...sortStylesByTags(boot.styles, detail.meta.tags).map((s) => h('option', { key: s.id, value: s.id }, s.name + '（' + s.id + (s.source === 'vault' ? ' · Obsidian' : '') + '）')),
                  ),
                  h('div', { style: { color: C.faint, fontSize: 11.5, marginTop: 6 } },
                    '共 ' + boot.styles.length + ' 份画像可选（含 Obsidian vault 里 dsh-writer-m/风格画像/ 的笔记，vault 版本优先）。换风格只影响之后生成的步骤，已经写好的稿子不会自动重写。'),
                ),
            // 提示词面板：可见、可改、可还原 —— 这是与现有插件的主要差异点
            showPrompt && promptEdit !== null
              ? h('div', { style: S.card },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                    h('span', { style: { fontWeight: 600 } }, '本步提示词'),
                    active.overridden ? h(Chip, null, '已改过内置默认') : h(Chip, null, '内置默认'),
                    active.fromVault === true ? h(Chip, null, '来自 Obsidian 笔记') : null,
                    h('div', { style: { flex: 1 } }),
                    h(Btn, {
                      variant: injectOpen ? 'primary' : 'ghost',
                      disabled: injectBusy,
                      title: injectOpen
                        ? '切回占位符模版（含 {{style}} / {{vault}} 等未渲染内容）'
                        : '查看本步实际发给模型的提示词（占位符已渲染）；会隐藏占位符模版',
                      onClick: () => void loadInject(),
                    }, injectBusy ? '读取中…' : (injectOpen ? '占位符模版' : '本步实际注入')),
                    h(Btn, { onClick: () => setPromptEdit({ system: active.defaultSystem, user: active.defaultUser }) }, '载入内置默认'),
                    injectOpen
                      ? null
                      : h(Btn, { variant: 'ghost', onClick: () => setPromptPreview(!promptPreview) }, promptPreview ? '编辑' : '预览'),
                    h(Btn, { disabled: busy === 'prompt' || injectOpen, onClick: () => void savePrompt(false) }, '保存'),
                    h(Btn, { variant: 'ghost', disabled: busy === 'prompt' || injectOpen, onClick: () => void savePrompt(true) }, '还原内置'),
                  ),
                  // 两种互斥视图：实际注入 ↔ 占位符模版（点「本步实际注入」切换）
                  injectOpen
                    ? h('div', null,
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' } },
                          h('span', { style: { fontWeight: 600 } }, '本步实际注入'),
                          h(Chip, null, injectData === null
                            ? '读取中…'
                            : (injectData.styleApplied === true ? ('风格：' + (injectData.styleName !== '' && injectData.styleName !== undefined ? injectData.styleName : injectData.styleId)) : '未绑定风格画像')),
                          injectData !== null && injectData.styleAppended === true ? h(Chip, null, '无 {{style}} → 已补到 system 末尾') : null,
                          injectData !== null && injectData.vaultApplied === true ? h(Chip, null, '参考笔记 ' + injectData.vaultNotes.length + ' 篇') : null,
                          injectData !== null && injectData.vaultAppended === true ? h(Chip, null, '无 {{vault}} → 已补到 user 末尾') : null,
                          injectData !== null && injectData.fanqieApplied === true ? h(Chip, null, '番茄上架信息清单已注入') : null,
                          injectData !== null && injectData.fanqieAppended === true ? h(Chip, null, '无 {{fanqieTags}} → 已补到 user 末尾') : null,
                          injectData !== null && injectData.existingApplied === true
                            ? h(Chip, null, '已有设定 ' + fmtChars(injectData.existingChars === undefined ? 0 : injectData.existingChars) + '（大纲/人物/卷大纲/章节标题）')
                            : null,
                          injectData !== null && injectData.existingAppended === true ? h(Chip, null, '无 {{existing}} → 已补到 user 末尾') : null,
                          injectData !== null ? h(Chip, null, '前序上下文 ' + fmtChars(injectData.contextChars)) : null,
                        ),
                        h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                          '这就是点「生成草稿」时真正发给模型的那份内容（这里不发模型调用）：占位符已按本作品当前的模版 / 风格画像 / 参考笔记 / 前序产物渲染完。再点按钮「占位符模版」可切回带 {{style}} 的原文。'),
                        injectData === null
                          ? null
                          : h(React.Fragment, null,
                              h('div', { style: { color: C.sub, fontSize: 11.5, marginBottom: 4 } }, '风格画像块 = {{style}} 在这一步的实际内容'),
                              h('pre', { style: S.pre }, injectData.styleBlock === '' ? '（这本没有绑定风格画像）' : injectData.styleBlock),
                              injectData.vaultApplied === true
                                ? h(React.Fragment, null,
                                    h('div', { style: { color: C.sub, fontSize: 11.5, margin: '10px 0 4px' } }, '参考笔记块 = {{vault}} 在这一步的实际内容'),
                                    h('pre', { style: S.pre }, injectData.vaultBlock))
                                : null,
                              injectData.fanqieApplied === true && typeof injectData.fanqieBlock === 'string' && injectData.fanqieBlock !== ''
                                ? h(React.Fragment, null,
                                    h('div', { style: { color: C.sub, fontSize: 11.5, margin: '10px 0 4px' } }, '番茄上架信息块 = {{fanqieTags}} 在这一步的实际内容'),
                                    h('pre', { style: S.pre }, injectData.fanqieBlock))
                                : null,
                              injectData.existingApplied === true && typeof injectData.existingBlock === 'string' && injectData.existingBlock !== ''
                                ? h(React.Fragment, null,
                                    h('div', { style: { color: C.sub, fontSize: 11.5, margin: '10px 0 4px' } }, '已有设定块 = {{existing}} 在这一步的实际内容（把已写下的大纲/人物/卷大纲/章节标题喂回定位步，防止重跑时另起新故事）'),
                                    h('pre', { style: S.pre }, injectData.existingBlock))
                                : null,
                              h('div', { style: { color: C.sub, fontSize: 11.5, margin: '10px 0 4px' } }, 'system（最终 · 角色与约束）'),
                              h('pre', { style: S.pre }, injectData.system),
                              h('div', { style: { color: C.sub, fontSize: 11.5, margin: '10px 0 4px' } }, 'user（最终 · 本次任务）'),
                              h('pre', { style: S.pre }, injectData.user)),
                      )
                    : h(React.Fragment, null,
                        h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                          '上面的「内置默认 / 已改过内置默认」只说明这份提示词文本有没有被改过，与「这一步做没做、润色有没有跑」无关；实际生效的来源是 vault 笔记优先。'),
                        h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                          '可用占位符：{{title}} {{genre}} {{theme}} {{audience}} {{tone}} {{words}} {{channel}} {{type}} {{totalWords}} {{tags}} {{count}} {{volume}} {{extra}} {{template}} {{style}} {{vault}} {{fanqieTags}} {{context}}。未知占位符会渲染成空串（{{fanqieTags}} 只在「作品定位」步有内容，是番茄官方标签清单）。'),
                        h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                          '这一步的提示词在 vault 里的笔记：' + (active.fromVault === true && active.vaultPath !== '' ? active.vaultPath : ('dsh-writer-m/提示词/' + detail.meta.genre + '-' + active.id + '.md')) + '。保存 / 还原会同步写 / 删这篇笔记（在 Obsidian 里改它同样生效）。'),
                        heldPlaceholder(promptEdit, '{{style}}')
                          ? null
                          : h('div', { style: { color: C.warn, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                              '这份提示词没有 {{style}} 占位符：生成时插件会把该作品挂的风格画像自动补到 system 末尾，不会被丢掉；想自己控制位置就把 {{style}} 插进去。'),
                        heldPlaceholder(promptEdit, '{{vault}}')
                          ? null
                          : h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                              '这份提示词没有 {{vault}} 占位符：参考笔记会在生成时自动补到 user 末尾。'),
                        active.id === 'positioning' && !heldPlaceholder(promptEdit, '{{fanqieTags}}')
                          ? h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                              '这份提示词没有 {{fanqieTags}} 占位符：生成时插件会把番茄官方标签清单 + 上架信息格式自动补到 user 末尾，上架信息不会被丢掉（只影响它在提示词里的位置）。')
                          : null,
                        active.id === 'positioning' && !heldPlaceholder(promptEdit, '{{existing}}')
                          ? h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                              '这份提示词没有 {{existing}} 占位符：定位步生成时插件会把这部作品已写下的大纲 / 人物 / 卷大纲 / 章节标题作为「已有设定」自动补到 user 末尾，避免重跑时把主角和剧情换成另一套。')
                          : null,
                        promptPreview
                          ? h(React.Fragment, null,
                              h('div', { style: { marginBottom: 10 } },
                                h('div', { style: { color: C.sub, fontSize: 11.5, marginBottom: 4 } }, 'system（角色与约束 · 占位符模版）'),
                                h('div', { style: { background: C.panel2, border: '1px solid ' + C.line, borderRadius: 6, padding: '10px 12px' } }, renderMarkdown(promptEdit.system))),
                              h('div', null,
                                h('div', { style: { color: C.sub, fontSize: 11.5, marginBottom: 4 } }, 'user（本次任务 · 占位符模版）'),
                                h('div', { style: { background: C.panel2, border: '1px solid ' + C.line, borderRadius: 6, padding: '10px 12px' } }, renderMarkdown(promptEdit.user))))
                          : h(React.Fragment, null,
                              h(Field, { label: 'system（角色与约束）' },
                                h(Area, { value: promptEdit.system, minHeight: 110, onChange: (v) => setPromptEdit(Object.assign({}, promptEdit, { system: v })) })),
                              h(Field, { label: 'user（本次任务）' },
                                h(Area, { value: promptEdit.user, minHeight: 220, onChange: (v) => setPromptEdit(Object.assign({}, promptEdit, { user: v })) }))),
                      ),
                )
              : null,

            // 前序产物提示
            h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
              '这一步会把**已完成**的前序产物自动带进上下文（上限约 12000 字，避免长篇把自己的草稿吃满窗口）。'),

            active.id === 'positioning'
              ? h('div', { style: { marginBottom: 10 } },
                  h('div', { style: { color: C.sub, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                    '按「频道 / 类型 / 总长度 / 标签」生成多个候选，每个候选含：作品定位（书名、核心卖点、目标读者、核心情绪公式、贯穿全书设定）、主角人设（人名、大概年纪、表层、深层）、重要配角（人名、大概年纪、描述）。'),
                  posHasExisting
                    ? h('div', { style: { color: C.warn, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                        '检测到这部作品已经写下：' + posExistingHint + '。重新生成定位（「按已有设定重写」）会把这些内容作为「已有设定」发给模型，人物姓名与身份、地名阵营、金手指、主线走向要求与它们一致，不会另起新故事；定位稿本身仍会被覆盖（覆盖前自动留一份 .bak），已写章节正文不受影响。')
                    : null,
                  posHasExisting && !posConfirmed
                    ? h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                        '第一次点「按已有设定重写」只做确认，不会立刻生成；再点一次才真正重跑。')
                    : null,
                  posHasExisting
                    ? null
                    : h(Field, { label: '候选数量（留空 = 建项目时的设定；选完候选后，未选候选会删除，章节生成前可重新生成）' },
                        h(Input, {
                          value: positionCount > 0 ? String(positionCount) : '',
                          placeholder: String(detail.meta.count > 0 ? detail.meta.count : 3),
                          onChange: (v) => setPositionCount(Math.min(Math.max(Number(String(v).replace(/[^0-9]/g, '')) || 0, 0), 6)),
                        })))
              : null,

            active.id === 'positioning' && posCandidates.length > 0
              ? h('div', { style: { marginBottom: 10 } },
                  h('div', { style: { color: C.sub, fontSize: 11.5, marginBottom: 6 } },
                    '生成完成。点「选用书名」选定某个候选：项目改名为所选书名，定位只保留该候选（未选候选删除）。'),
                  ...posCandidates.map((c, i) =>
                    h('div', { key: i, style: Object.assign({}, S.row, { alignItems: 'center', marginBottom: 6 }) },
                      h('span', { style: { color: C.faint, fontSize: 11.5, width: 56, flexShrink: 0 } }, c.title),
                      h('span', { style: { flex: 1, fontWeight: 500 } }, c.name === '' ? '（未识别出书名）' : c.name),
                      h(Btn, {
                        variant: 'primary',
                        disabled: busy === 'rename' || c.name === '' || c.name === detail.meta.name,
                        onClick: () => void adoptTitle(c),
                      }, c.name === detail.meta.name ? '已选用' : '选用书名'),
                    ),
                  ),
                )
              : null,

            // 番茄上架信息核对卡：解析结论来自宿主 route('fanqieTags')，客户端只渲染
            active.id === 'positioning' && fanqieReports !== null && fanqieReports.length > 0
              ? h(FanqieListingCard, { reports: fanqieReports, limits: fanqieLimits, source: '草稿', flash })
              : null,

            isVolumeOutline
              ? h(Field, { label: '为哪一卷生成章节大纲（一次只写一卷）' },
                  volumes.length === 0
                    ? h('div', { style: S.dim }, '还没拆卷。请先完成「卷大纲」这一步。')
                    : h('select', {
                        style: Object.assign({}, S.input, { cursor: 'pointer' }),
                        value: volumeSel,
                        onChange: (e) => setVolumeSel(e.target.value),
                      },
                      ...volumes.map((v) => h('option', { key: v.key, value: v.key }, volLabel(v))),
                    ))
              : null,

            isPolish && hasChapters
              ? h(Field, { label: '处理哪一章（润色只针对这一章正文）' },
                  h('select', {
                    style: Object.assign({}, S.input, { cursor: 'pointer' }),
                    value: chapterSel,
                    onChange: (e) => setChapterSel(e.target.value),
                  },
                  ...chapterFiles.map((f) => h('option', { key: f, value: f },
                    f + (polishedSet.has(f.replace(/\.md$/i, '')) ? '（已有润色稿）' : ''))),
                ))
              : null,

            isPolish && hasChapters
              ? h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 10, lineHeight: 1.7 } },
                  '润色进度：本作品共 ' + chapterFiles.length + ' 章正文，已有润色稿 ' + polishFiles.length + ' 章；' +
                  (noPolishYet.length === 0
                    ? '全部已润色。'
                    : '还没润色的 ' + noPolishYet.length + ' 章：' + noPolishYet.map((x) => x.replace(/\.md$/i, '')).join('、') + '。') +
                  ' 润色稿是独立文件（第NNN章-润色.md），不会自动覆盖原章；确认满意后要按「批量定稿」才会用润色稿替换原章（原稿备份为 .bak）。')
              : null,

            isPolish && hasChapters
              ? h(Field, { label: '整卷自动润色（对每一章原文生成润色稿并落盘，跳过已有润色稿）' },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h(Btn, { disabled: busy !== '', onClick: () => void autoPolish() },
                      busy === 'autopolish' ? '整卷润色中…' : '整卷自动润色'),
                    busy === 'autopolish' && autoProgress !== null
                      ? h('span', { style: { color: C.sub, fontSize: 12 } },
                          autoProgress.index + ' / ' + autoProgress.total + ' 章' +
                          (autoProgress.current === '' ? '' : ' · 正在润色 ' + autoProgress.current) +
                          (autoProgress.fail.length > 0 ? ' · 失败 ' + autoProgress.fail.length + ' 章' : ''))
                      : null,
                  ),
                )
              : null,

            isPolish && hasChapters
              ? h(Field, { label: '批量定稿（确认润色 OK 后，用润色稿替换原章，原稿备份为 .bak）' },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h(Btn, { variant: 'primary', disabled: busy !== '', onClick: () => void finalizeAll() },
                      busy === 'finalize' ? '定稿中…' : '批量定稿（润色稿 → 原稿）'),
                  ),
                )
              : null,

            active.produces === 'chapter'
              ? h(Field, { label: '选要写的这一章（必选）＋本章细纲（选中后自动填入、可改）' },
                  volumes.length > 0
                    ? h('select', {
                        style: Object.assign({}, S.input, { marginBottom: 6, cursor: 'pointer' }),
                        value: volumeSel,
                        onChange: (e) => setVolumeSel(e.target.value),
                      },
                      ...volumes.map((v) => h('option', { key: v.key, value: v.key }, volLabel(v))),
                    )
                    : null,
                  outlineBlocks.length > 0
                    ? h('select', {
                        style: Object.assign({}, S.input, { marginBottom: 6, cursor: 'pointer' }),
                        value: outlineSel,
                        onChange: (e) => {
                          const v = e.target.value
                          setOutlineSel(v)
                          const b = outlineBlocks.find((x) => x.title === v)
                          if (b !== undefined) {
                            setExtra(b.body)
                            const no = chapterNoFromTitle(b.title)
                            if (no !== null) setChapterName('第' + String(chapterOffset + no).padStart(3, '0') + '章')
                          }
                        },
                      },
                      h('option', { value: '' }, '—— 请先选择要写的这一章 ——'),
                      ...outlineBlocks.map((b) => h('option', { key: b.title, value: b.title }, b.title)),
                    )
                    : null,
                  outlineSel !== ''
                    ? h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 6 } },
                        '将落盘为 chapters/' + (chapterNo !== null ? '第' + String(chapterNo).padStart(3, '0') + '章' : '（自动递增）') + '.md')
                    : null,
                  h(Area, { value: extra, minHeight: 120, placeholder: '### 第 1 章 章名\n- 场景：…\n- 冲突：…\n- 结尾钩子：…', onChange: setExtra }))
              : h(Field, { label: '本次额外要求（可选：这一次想特别强调什么）' },
                  h(Area, { value: extra, minHeight: 64, placeholder: '例如：这一章多写一点环境，别写心理活动', onChange: setExtra })),

            active.produces === 'chapter'
              ? h(Field, { label: '整卷自动生成（按所选卷的大纲顺序逐章写正文并落盘，跳过已有章节）' },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h(Btn, { disabled: busy !== '' || outlineBlocks.length === 0, onClick: () => void autoWriteVolume() },
                      busy === 'autowrite' ? '整卷生成中…' : '整卷自动生成'),
                    busy === 'autowrite' && autoProgress !== null
                      ? h('span', { style: { color: C.sub, fontSize: 12 } },
                          autoProgress.index + ' / ' + autoProgress.total + ' 章' +
                          (autoProgress.current === '' ? '' : ' · 正在写 ' + autoProgress.current) +
                          (autoProgress.fail.length > 0 ? ' · 失败 ' + autoProgress.fail.length + ' 章' : ''))
                      : null,
                  ),
                )
              : null,

            active.produces === 'chapter' && hasChapters
              ? h(Field, { label: '规整已落盘章节的首行标题（统一成「第NNN章 章名」，编号与文件名对齐）' },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h(Btn, { disabled: busy !== '', onClick: () => void normalizeChapters() },
                      busy === 'normalize' ? '规整中…' : '规整章节标题'),
                    h('span', { style: { color: C.faint, fontSize: 11.5 } },
                      '模型有时自带「第 N 章 标题」、有时完全不写，编号还常是卷内局部号；点这里把已落盘的 ' + chapterFiles.length + ' 章一次对齐（每个文件先备份 .bak）。'),
                  ),
                )
              : null,

            isNovel && hasChapters
              ? h('div', { style: S.card },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
                    h('span', { style: { fontWeight: 600 } }, '发布到番茄小说'),
                    h(Chip, null, '只存草稿'),
                    ...(() => {
                      const fq = boot.fanqie === undefined ? {} : boot.fanqie
                      if (boot.publish === undefined || boot.publish.ready !== true) {
                        return [h(Chip, { style: { borderColor: C.err, color: C.err } }, '未配置登录态目录')]
                      }
                      if (fq.running === true) return [h(Chip, null, fq.jobAction === 'login' ? '等待扫码登录中…' : '检查登录态中…')]
                      if (fq.loggedIn === true) {
                        const left = fq.expiresInDays === null || fq.expiresInDays === undefined ? '' : '（剩 ' + Number(fq.expiresInDays).toFixed(1) + ' 天）'
                        return [h(Chip, { style: { borderColor: C.ok, color: C.ok } }, '已登录' + (fq.authorName === undefined || fq.authorName === '' ? '' : ' · ' + fq.authorName) + left)]
                      }
                      if (fq.loggedIn === false) {
                        return [h(Chip, { style: { borderColor: C.err, color: C.err } }, '登录态已失效' + (fq.reason === undefined || fq.reason === '' ? '' : '：' + fq.reason))]
                      }
                      return [h(Chip, null, '登录态未检查')]
                    })(),
                  ),
                  h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 } },
                    '按**文件名编号**重编号（正文里的卷内局部号会被纠正），章名取正文首行或章节大纲的 ### 块，站点标题写成「第NNN章 章名」。默认跳过站点已有同编号的章与草稿箱里已有的同编号草稿，重复点也不会发两遍。' +
                    '登录态显示的是**最近一次检查结论**；要重新探活 / 扫码登录 / 保活续期，去「设置」页的「番茄小说登录态」卡片。'),
                  h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
                    h('span', { style: { color: C.sub, fontSize: 12 } }, '从第'),
                    h('div', { style: { width: 68 } }, h(Input, { value: pubFromInput, onChange: setPubFromInput })),
                    h('span', { style: { color: C.sub, fontSize: 12 } }, '章 到第'),
                    h('div', { style: { width: 68 } }, h(Input, { value: pubToInput, placeholder: String(pubMaxNo), onChange: setPubToInput })),
                    h('span', { style: { color: C.sub, fontSize: 12 } }, '章（本地共 ' + chapterFiles.length + ' 章）'),
                  ),
                  // 书名（修用户 m01329）：番茄站内已有同名书时换个书名——只改书名，正文/大纲/人物都不动
                  (() => {
                    const cur = detail.meta === undefined || detail.meta.name === undefined ? detail.id : detail.meta.name
                    const forced = boot.config !== undefined && boot.config.publishBookName !== undefined && String(boot.config.publishBookName) !== ''
                    return h('div', { style: { borderTop: '1px solid ' + C.line, paddingTop: 8, marginBottom: 8 } },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                        h('span', { style: { color: C.sub, fontSize: 12 } }, '发布用书名：'),
                        h('span', { style: { fontWeight: 600 } }, forced ? String(boot.config.publishBookName) : cur),
                        forced ? h(Chip, { style: { borderColor: C.warn, color: C.warn } }, '来自设置页「番茄站点书名」，会盖住作品名') : null,
                        h(Btn, { disabled: titleBusy !== '' || pubBusy !== '', onClick: () => void genTitles() }, titleBusy === 'gen' ? '起名中…' : '重新生成书名'),
                      ),
                      h('div', { style: { color: C.faint, fontSize: 11.5, marginTop: 4, lineHeight: 1.7 } },
                        '番茄站内已经有同名书、发布时提示「该名字已存在」时用这里：模型按现有定位与大纲**只**起新书名，不重写正文、大纲、人物。点「用这个名字」即改作品名（定位稿里的「书名：」行一并同步，磁盘上的章节一个字不动）。'),
                      titleMsg === '' ? null : h('div', { style: { color: C.sub, fontSize: 11.5, marginTop: 6, lineHeight: 1.7 } }, titleMsg),
                      Array.isArray(titleCands) && titleCands.length > 0
                        ? h('div', { style: { marginTop: 6 } },
                            titleCands.map((c, i) => h('div', {
                              key: 'titlerow-' + i,
                              style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 0', borderTop: i === 0 ? 'none' : '1px solid ' + C.line },
                            },
                              h('span', { style: { minWidth: 120, fontWeight: c.ok === true ? 600 : 400, color: c.ok === true ? C.text : C.faint } }, c.title),
                              h(Chip, { style: c.ok === true ? undefined : { borderColor: C.err, color: C.err } }, c.chars + ' 字' + (c.same === true ? '（与现名重复）' : c.ok === true ? '' : '（超 15 字）')),
                              c.localConflict === true ? h(Chip, { style: { borderColor: C.warn, color: C.warn } }, '本地已有同名作品') : null,
                              c.reason === '' ? null : h('span', { style: { color: C.faint, fontSize: 11.5 } }, c.reason),
                              h(Btn, { disabled: c.ok !== true || titleBusy !== '', onClick: () => void applyTitle(c) }, titleBusy === 'apply' ? '改名中…' : '用这个名字'),
                            )),
                          )
                        : null,
                    )
                  })(),
                  h('div', { style: S.row },
                    h(Btn, { disabled: pubBusy !== '', onClick: () => void pubPlan() }, pubBusy === 'plan' ? '列计划中…' : '预览发布计划'),
                    h(Btn, { variant: 'primary', disabled: pubBusy !== '', onClick: () => void pubStart() }, pubBusy === 'start' ? '启动中…' : '开始发布（存草稿）'),
                    h(Btn, { disabled: pubBusy !== '', onClick: () => void pubRefresh() }, '刷新进度'),
                  ),
                  pubMsg === '' ? null : h('div', { style: { color: C.sub, fontSize: 11.5, marginTop: 8, lineHeight: 1.7 } }, pubMsg),
                  pubStatus === null
                    ? null
                    : h('div', { style: { color: pubStatus.running === true ? C.warn : C.sub, fontSize: 11.5, marginTop: 6, lineHeight: 1.7 } },
                        pubStatus.running === true
                          ? '发布中 · 已跑 ' + pubStatus.seconds + ' 秒（每章约 35~40 秒）'
                          : (pubStatus.exitCode === 0 ? '上一次发布已结束' : '上一次发布已结束（退出码 ' + pubStatus.exitCode + '）'),
                        pubStatus.error !== '' && pubStatus.error !== undefined ? ' · ' + pubStatus.error : '',
                      ),
                  ...(() => {
                    const rep = pubPickReport()
                    if (rep === null) return []
                    const planned = Array.isArray(rep.planned) ? rep.planned : []
                    const items = Array.isArray(rep.items) ? rep.items : []
                    const rows = []
                    if (planned.length > 0) {
                      rows.push(h('div', { key: 'plan-title', style: { color: C.sub, fontSize: 11.5, margin: '8px 0 4px' } },
                        '计划发布 ' + planned.length + ' 章（编号以文件名为真源）'))
                      rows.push(h('div', { key: 'plan-list', style: { maxHeight: 200, overflowY: 'auto', border: '1px solid ' + C.line, borderRadius: 6, padding: '6px 8px' } },
                        ...planned.map((x, i) => h('div', { key: 'p' + i, style: { fontSize: 11.5, lineHeight: 1.8 } },
                          '第' + x.no + '章 ' + (x.title === '' ? '（正文无标题，也没能从大纲补名）' : x.title) + ' · ' + x.chars + ' 字'))))
                    }
                    if (items.length > 0) {
                      const saved = items.filter((x) => x.status === 'draft_saved').length
                      rows.push(h('div', { key: 'item-title', style: { color: C.sub, fontSize: 11.5, margin: '8px 0 4px' } },
                        '站点结果：已存草稿 ' + saved + ' / ' + items.length + ' 章'))
                      rows.push(h('div', { key: 'item-list', style: { maxHeight: 220, overflowY: 'auto', border: '1px solid ' + C.line, borderRadius: 6, padding: '6px 8px' } },
                        ...items.map((x, i) => h('div', { key: 'i' + i, style: { fontSize: 11.5, lineHeight: 1.8, color: x.status === 'draft_saved' ? C.ok : (x.status === 'already_on_site' || x.status === 'draft_exists' ? C.faint : C.warn) } },
                          '第' + x.no + '章 ' + (x.title === undefined || x.title === '' ? (x.name === undefined ? '' : x.name) : x.title) + ' · ' +
                          (x.status === 'draft_saved'
                            ? '已存草稿 ' + (x.editor_chars === undefined ? '' : x.editor_chars + ' 字') + '（item ' + (x.item_id === undefined ? '' : x.item_id) + '）'
                            : (x.status === 'already_on_site' ? '站点已有，跳过' : (x.status === 'draft_exists' ? '草稿箱已有，跳过' : String(x.status) + (x.error === undefined ? '' : '：' + x.error))))))))
                    }
                    if (rows.length === 0) return []
                    return [h('div', { key: 'rep' }, ...rows)]
                  })(),
                  pubStatus !== null && Array.isArray(pubStatus.tail) && pubStatus.tail.length > 0
                    ? h('div', null,
                        h('div', { style: { color: C.sub, fontSize: 11.5, margin: '10px 0 4px' } }, '发布日志尾部（完整日志 ' + pubStatus.logPath + '）'),
                        h('pre', { style: S.pre }, pubStatus.tail.join('\n')))
                    : null,
                  pubResult !== null && pubResult.stdout !== undefined && pubResult.stdout !== ''
                    ? h('div', null,
                        h('div', { style: { color: C.sub, fontSize: 11.5, margin: '10px 0 4px' } }, '计划命令输出（' + (pubResult.code === 0 ? '成功' : '退出码 ' + pubResult.code) + '）'),
                        h('pre', { style: S.pre }, pubResult.stdout))
                    : null,
                )
              : null,

            busy === 'run'
              ? h('div', { style: S.dim }, '正在调用模型（' + (boot.llm.route === null ? '未配置路由' : boot.llm.route.provider + ' / ' + boot.llm.route.model) + '）…长篇章节通常需要几十秒到几分钟。')
              : null,

            draft !== null && draft.stepId === active.id
              ? h('div', { style: S.card },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                    h('span', { style: { fontWeight: 600 } }, '草稿'),
                    h(Chip, null, fmtChars(draft.chars)),
                    draft.templateId === '' ? null : h(Chip, null, '套模版：' + draft.templateId),
                    draft.styleId === undefined || draft.styleId === ''
                      ? null
                      : h(Chip, null, '风格：' + ((draft.styleName === undefined || draft.styleName === '') ? draft.styleId : draft.styleName)),
                    draft.batchCount > 1 ? h(Chip, null, '分批生成 ' + draft.batchCount + (draft.stepId === 'positioning' ? ' 个候选' : ' 段')) : null,
                    draft.rounds > 1 ? h(Chip, null, '分 ' + draft.rounds + ' 轮生成（自动续写 ' + (draft.rounds - 1) + ' 次）') : null,
                    draft.targetChars > 0 && draft.reachedTarget === false
                      ? h(Chip, { style: { borderColor: C.warn, color: C.warn } }, '未达目标 ' + draft.targetChars + ' 字')
                      : null,
                    h('div', { style: { flex: 1 } }),
                    h(Btn, { onClick: () => void copyText(draft.text).then((ok) => flash(ok ? '已复制' : '复制失败，请手动选中')) }, '复制'),
                    h(Btn, { variant: 'primary', disabled: busy === 'save', onClick: () => void saveDraft() }, '保存落盘'),
                    h(Btn, { variant: 'ghost', onClick: () => setDraft(null) }, '丢弃'),
                  ),
                  draft.warning === '' ? null : h('div', { style: S.warn }, draft.warning),
                  h('div', { style: { color: C.faint, fontSize: 11.5, marginBottom: 8 } },
                    '落盘位置：' + (
                      draft.artifact === 'chapters'
                        ? draft.stepId === 'polish'
                          ? 'chapters/' + String(draft.chapter ?? '').replace(/\.md$/i, '') + '-润色.md'
                          : 'chapters/' + chapterFileName(chapterNo, chapterName, chapterFiles) + '.md'
                        : (draft.artifact === 'chapter-outlines'
                          ? 'chapter-outlines/' + (typeof draft.volume === 'string' && draft.volume !== '' ? draft.volume : volumeSel) + '.md'
                          : draft.artifact)
                    ) + '　·　模型输出不会被自动写盘，看过再存。'),
                  draft.stepId === 'chapter'
                    ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                        h('span', { style: { color: C.sub, fontSize: 11.5, whiteSpace: 'nowrap' } }, '章名（可选；编号已按所选章节锁定）'),
                        h(Input, { value: chapterName, onChange: setChapterName }))
                    : null,
                  h('textarea', {
                    style: Object.assign({}, S.area, { minHeight: 380 }),
                    value: draft.text,
                    spellCheck: false,
                    onChange: (e) => setDraft(Object.assign({}, draft, { text: e.target.value, chars: e.target.value.replace(/\s/g, '').length })),
                  }),
                )
              : null,

            // 已有产物预览
            h(ArtifactView, { detail, step: active, setErr, flash }),
          ),
        ),
        ),
      )
    }

    /** 最终定稿视图：连续阅读全书定稿，每章自动取最新版本（润色稿 → 原文）。 */
    function FinalView(props) {
      const { detail, setErr, flash, onBack } = props
      const [items, setItems] = useState([])
      const [loading, setLoading] = useState(true)
      const [copying, setCopying] = useState(false)
      // 目录默认展开：用户报过「最终定稿只能一章一章看、没有目录快速定位」。
      const [showNav, setShowNav] = useState(true)
      const [curIdx, setCurIdx] = useState(0)
      const scrollRef = React.useRef(null)

      const chapterStep = detail.steps.find((s) => s.id === 'chapter')
      const polishFiles = (detail.steps.find((s) => s.id === 'polish') || {}).files || []
      const bases = chapterStep === undefined ? [] : chapterStep.files

      /** 正文首行的章标题（规整后每章自带）；复制/阅读都拿它当标题，否则退回文件名编号。 */
      const splitHead = (t) => {
        const src = String(t ?? '')
        const m = /^[ \t]*#{0,6}[ \t]*(第[ \t]*[0-9零〇一二三四五六七八九十百千两]+[ \t]*章[^\n]*)/.exec(src)
        if (m === null) return { head: '', body: src.trim() }
        return { head: m[1].trim(), body: src.replace(m[0], '').replace(/^\s+/, '') }
      }


      useEffect(() => {
        let alive = true
        setLoading(true)
        setItems([])
        if (bases.length === 0) { setLoading(false); return () => { alive = false } }
        ;(async () => {
          const out = []
          for (const f of bases) {
            const stem = f.replace(/\.md$/i, '')
            const isPolish = polishFiles.indexOf(stem + '-润色.md') >= 0
            const path = isPolish ? stem + '-润色.md' : f
            try {
              const d = await api('read', { id: detail.id, path: 'chapters/' + path })
              const raw = d.text || ''
              const cut = splitHead(raw)
              out.push({ stem, path, kind: isPolish ? 'polish' : 'base', text: raw, head: cut.head, body: cut.body, chars: String(raw).replace(/\s/g, '').length, err: '' })
            } catch (e) {
              out.push({ stem, path, kind: isPolish ? 'polish' : 'base', text: '', head: '', body: '', chars: 0, err: e instanceof Error ? e.message : String(e) })
            }
          }
          if (alive) { setItems(out); setLoading(false) }
        })()
        return () => { alive = false }
      }, [detail, bases.length, polishFiles.length])

      const kindLabel = (k) => (k === 'polish' ? '润色稿' : '原文')
      const kindColor = (k) => (k === 'polish' ? C.warn : C.faint)

      const copyAll = async () => {
        setCopying(true)
        try {
          const parts = []
          for (const it of items) parts.push('## ' + (it.head === '' ? it.stem : it.head) + '\n\n' + it.body)
          const ok = await copyText(parts.join('\n\n'))
          flash(ok ? '已复制全书定稿（' + items.length + ' 章）' : '复制失败，请手动选中')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setCopying(false)
        }
      }

      // 目录高亮判据的容差：scrollIntoView({block:'start'}) 会把目标章停在 scrollMarginTop(=12) 处，
      // 容差必须大于它；否则目标章「还没跨过顶部」，高亮会被判给前一章（用户报「点目录后高亮还停在第 1 章」）。
      const NAV_TOP_TOLERANCE = 24
      // 点击跳转后、平滑滚动还在动画中时，滚动事件读到的仍是**旧**位置（第 1 章还在顶部），会把高亮拉回第一章；
      // 因此跳转后先锁住高亮，等目标章真的滚到位（或连续忽略过多次、元素已不在）才把控制权交回滚动监听。
      // 用「连续忽略计数」而不是时间戳，避免依赖平滑滚动的时长 / 动画帧率。
      const NAV_IGNORE_LIMIT = 200
      const pendingRef = React.useRef({ idx: -1, skips: 0 })

      const jump = (idx) => {
        if (idx < 0 || idx >= items.length) return
        pendingRef.current = { idx: idx, skips: 0 }
        setCurIdx(idx)
        const el = document.getElementById('final-ch-' + idx)
        if (el !== null) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }

      /** 滚动时把「当前章」对齐到视野里最靠上的那一章，供上一章 / 下一章定位。 */
      const onScroll = () => {
        const box = scrollRef.current
        if (box === null || items.length === 0) return
        const top = box.getBoundingClientRect().top
        const pend = pendingRef.current
        if (pend.idx >= 0) {
          const tel = document.getElementById('final-ch-' + pend.idx)
          if (tel !== null && Math.abs(tel.getBoundingClientRect().top - top) <= NAV_TOP_TOLERANCE) {
            // 目标章已滚到位：解除锁定并保持它的高亮（动画收尾事件不再改写）
            pendingRef.current = { idx: -1, skips: 0 }
            setCurIdx((prev) => (prev === pend.idx ? prev : pend.idx))
            return
          }
          if (tel === null || pend.skips >= NAV_IGNORE_LIMIT) {
            pendingRef.current = { idx: -1, skips: 0 } // 元素没了或忽略太多次：放弃锁定，按实际位置判定
          } else {
            pendingRef.current = { idx: pend.idx, skips: pend.skips + 1 }
            return // 平滑滚动进行中：忽略中间态，保持点击的那一章高亮
          }
        }
        let best = 0
        for (let i = 0; i < items.length; i++) {
          const el = document.getElementById('final-ch-' + i)
          if (el !== null && el.getBoundingClientRect().top - top <= NAV_TOP_TOLERANCE) best = i
        }
        setCurIdx((prev) => (prev === best ? prev : best))
      }

      return h(React.Fragment, null,
        h('div', { style: Object.assign({}, S.topbar, { background: 'transparent', borderBottom: '1px solid ' + C.line }) },
          h('span', { style: { fontWeight: 600 } }, '📖 最终定稿'),
          h('span', { style: { color: C.sub, fontSize: 12 } },
            '连续阅读 · 每章取最新版（润色稿 → 原文）' + (items.length === 0 ? '' : ' · 当前第 ' + (curIdx + 1) + ' / ' + items.length + ' 章')),
          h('div', { style: { flex: 1 } }),
          h(Btn, { variant: showNav ? 'primary' : undefined, disabled: items.length === 0, onClick: () => setShowNav(!showNav) }, showNav ? '收起目录' : '章节目录'),
          h(Btn, { disabled: copying || items.length === 0, onClick: () => void copyAll() }, copying ? '复制中…' : '复制全书定稿'),
          h(Btn, { variant: 'primary', onClick: onBack }, '← 返回步骤'),
        ),
        h('div', { style: S.scroll, ref: scrollRef, onScroll: onScroll },
          loading
            ? h('div', { style: S.dim }, '加载中…')
            : bases.length === 0
              ? h('div', { style: S.dim }, '还没有章节正文。先完成「章节内容」步骤（选章 → 生成 → 保存落盘），这里就会出现每一章的最终定稿。')
              : h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
                  showNav
                    ? h('div', { style: Object.assign({}, S.card, { flex: '0 0 210px', width: 210, position: 'sticky', top: 0, maxHeight: '76vh', overflowY: 'auto' }) },
                        h('div', { style: { fontWeight: 600, marginBottom: 8, fontSize: 12.5 } }, '章节目录（' + items.length + '）'),
                        ...items.map((it, idx) =>
                          h('button', {
                            key: 'nav-' + idx,
                            type: 'button',
                            title: it.path,
                            onClick: () => jump(idx),
                            style: {
                              display: 'block', width: '100%', textAlign: 'left', marginBottom: 3, padding: '3px 7px',
                              fontSize: 12, lineHeight: 1.5, cursor: 'pointer', borderRadius: 6,
                              border: '1px solid ' + (idx === curIdx ? C.line : 'transparent'),
                              background: idx === curIdx ? C.line : 'transparent', color: 'inherit',
                            },
                          }, (idx === curIdx ? '▸ ' : '') + (it.head === '' ? it.stem : it.head)),
                        ),
                        h('div', { style: { color: C.faint, fontSize: 11, marginTop: 6, lineHeight: 1.6 } },
                          '点章节名跳到那一章；每章底部也有「上一章 / 下一章」。'),
                      )
                    : null,
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    ...items.map((it, idx) =>
                      h('div', { key: it.stem, id: 'final-ch-' + idx, style: Object.assign({}, S.card, { scrollMarginTop: 12 }) },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid ' + C.line } },
                          h('span', { style: { fontWeight: 600, fontSize: 15 } }, it.head === '' ? it.stem : it.head),
                          h('span', { style: { color: kindColor(it.kind), fontSize: 11 } }, kindLabel(it.kind)),
                          h('div', { style: { flex: 1 } }),
                          h(Chip, null, fmtChars(it.chars)),
                        ),
                        it.err !== ''
                          ? h('div', { style: { color: C.err, fontSize: 12 } }, '读取失败：' + it.err)
                          : renderMarkdown(it.body),
                        h('div', { style: Object.assign({}, S.row, { marginTop: 12, justifyContent: 'space-between' }) },
                          h(Btn, { disabled: idx === 0, onClick: () => jump(idx - 1) }, '← 上一章'),
                          h('span', { style: { color: C.faint, fontSize: 11 } }, (idx + 1) + ' / ' + items.length),
                          h(Btn, { disabled: idx === items.length - 1, onClick: () => jump(idx + 1) }, '下一章 →'),
                        ),
                      ),
                    ),
                  ),
                ),
        ),
      )
    }

    /** 已落盘产物的只读预览 + 跳转编辑（章节步列出全部章节）。 */
    function ArtifactView(props) {
      const { detail, step, setErr, flash } = props
      const [text, setText] = useState('')
      const [openPath, setOpenPath] = useState('')
      const [editing, setEditing] = useState(null)
      // 定位步的「已落盘稿」也做上架信息核对：老作品打开就能看到缺哪一节（不必重新生成）
      const [fqReports, setFqReports] = useState(null)
      const [fqLimits, setFqLimits] = useState(null)
      const [fqBusy, setFqBusy] = useState(false)

      const rel = (step.artifact === 'chapters' || step.artifact === 'chapter-outlines') ? '' : step.artifact
      useEffect(() => {
        setOpenPath('')
        setEditing(null)
        setText('')
        if (rel === '') return
        let alive = true
        api('read', { id: detail.id, path: rel })
          .then((data) => {
            if (alive) setText(data.text)
          })
          .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
        return () => {
          alive = false
        }
      }, [detail.id, rel, setErr])

      useEffect(() => {
        if (step.id !== 'positioning' || rel === '' || text === '') {
          setFqReports(null)
          setFqLimits(null)
          return undefined
        }
        const cands = parsePositionCandidates(text)
        if (cands.length === 0) {
          setFqReports(null)
          setFqLimits(null)
          return undefined
        }
        let alive = true
        api('fanqieTags', {
          action: 'parse',
          texts: cands.map((x) => x.body),
          titles: cands.map((x) => x.name),
        })
          .then((r) => {
            if (!alive) return
            setFqReports(Array.isArray(r.reports) ? r.reports : [])
            setFqLimits(r.limits === undefined ? null : r.limits)
          })
          .catch(() => {
            if (!alive) return
            setFqReports(null)
            setFqLimits(null)
          })
        return () => { alive = false }
      }, [step.id, rel, text])

      // 「只补写上架信息」：老书的定位稿是按旧提示词生成的、没有「### 四、上架信息」，
      // 而作品已有章节时定位步的「生成草稿」被禁用（怕重跑定位推翻已写正文）。
      // 这里只让模型补那一节：逐候选过一次模型，插在该候选末尾，前面的定位正文不动（宿主侧先备份 .bak）。
      const fillListing = async () => {
        setFqBusy(true)
        try {
          const r = await api('fanqieListing', { id: detail.id, action: 'start' })
          flash(r.updated > 0 ? ('已补上架信息：' + r.updated + ' 个候选') : '每个候选都已有上架信息，无需补写')
          const d = await api('read', { id: detail.id, path: rel })
          setText(d.text)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setFqBusy(false)
        }
      }

      const save = async () => {
        try {
          await api('save', { id: detail.id, path: editing.path, text: editing.text })
          flash('已保存：' + editing.path)
          setEditing(null)
          if (editing.path === rel) setText(editing.text)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      }

      if (step.artifact === 'chapters' || step.artifact === 'chapter-outlines') {
        const isChapters = step.artifact === 'chapters'
        const dirLabel = !isChapters ? '卷章大纲' : (step.id === 'polish' ? '润色稿' : '章节正文')
        const emptyHint = !isChapters
          ? '还没有卷章大纲。为某一卷生成并保存后，这里就会出现。'
          : step.id === 'polish'
            ? '还没有润色稿。选中一章、生成润色草稿并「保存落盘」，这里就会出现「第NNN章-润色.md」。'
            : '还没有章节正文。写完一章、点「保存落盘」，这里就会出现。'
        const openIdx = openPath === '' ? -1 : step.files.indexOf(openPath)
        const openOne = (file) => {
          if (file === undefined || file === openPath) {
            setOpenPath('')
            return
          }
          setOpenPath(file)
          setEditing(null)
          api('read', { id: detail.id, path: step.artifact + '/' + file })
            .then((d) => setText(d.text))
            .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
        }
        return h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '已落盘' + dirLabel + '（' + step.chapters + '）'),
          step.chapters === 0
            ? h('div', { style: S.dim }, emptyHint)
            : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                ...step.files.map((f) =>
                  h(Btn, { key: f, variant: openPath === f ? 'primary' : undefined, onClick: () => openOne(f) },
                    (openPath === f ? '▾ ' : '') + f.replace(/\.md$/i, '')),
                ),
              ),
          step.chapters === 0
            ? null
            : h('div', { style: { color: C.faint, fontSize: 11.5, marginTop: 8, lineHeight: 1.6 } },
                '点上面任意一章即可在下方打开阅读 / 编辑，一次一篇；打开后可用「上一章 / 下一章」顺序翻。'),
          openPath !== ''
            ? h('div', { style: { marginTop: 8 } },
                h('div', { style: S.row },
                  h(Btn, { disabled: openIdx <= 0, onClick: () => openOne(step.files[openIdx - 1]) }, '← 上一章'),
                  h(Btn, { disabled: openIdx < 0 || openIdx >= step.files.length - 1, onClick: () => openOne(step.files[openIdx + 1]) }, '下一章 →'),
                  h('span', { style: { color: C.faint, fontSize: 11 } }, (openIdx + 1) + ' / ' + step.files.length),
                  h('div', { style: { flex: 1 } }),
                  h(Btn, { onClick: () => setEditing({ path: step.artifact + '/' + openPath, text }) }, '编辑'),
                  h(Chip, null, step.artifact + '/' + openPath),
                ),
                editing !== null && editing.path === step.artifact + '/' + openPath
                  ? h('div', null,
                      h(Area, { value: editing.text, minHeight: 320, onChange: (v) => setEditing(Object.assign({}, editing, { text: v })) }),
                      h('div', { style: Object.assign({}, S.row, { marginTop: 8 }) },
                        h(Btn, { variant: 'primary', onClick: () => void save() }, '保存'),
                        h(Btn, { variant: 'ghost', onClick: () => setEditing(null) }, '取消')),
                    )
                    : h('div', { style: { marginTop: 8 } }, renderMarkdown(text)),
              )
            : null,
        )
      }

      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('span', { style: { fontWeight: 600 } }, '已落盘产物'),
          h(Chip, null, rel),
          h('div', { style: { flex: 1 } }),
          step.done
            ? h(Btn, { onClick: () => setEditing(editing === null ? { path: rel, text } : null) }, editing === null ? '编辑' : '取消编辑')
            : null,
        ),
        !step.done
          ? h('div', { style: S.dim }, '这一步还没有产物。生成草稿后点「保存落盘」，或直接点「编辑」手写。' +
              (editing === null ? '' : ''))
          : null,
        !step.done && editing === null
          ? h(Btn, { onClick: () => setEditing({ path: rel, text: '' }) }, '手写这一步')
          : null,
        editing !== null && editing.path === rel
          ? h('div', null,
              h(Area, { value: editing.text, minHeight: 320, onChange: (v) => setEditing(Object.assign({}, editing, { text: v })) }),
              h('div', { style: Object.assign({}, S.row, { marginTop: 8 }) },
                h(Btn, { variant: 'primary', onClick: () => void save() }, '保存'),
                h(Btn, { variant: 'ghost', onClick: () => setEditing(null) }, '取消')),
            )
            : (step.done ? h('div', { style: { marginTop: 8 } }, renderMarkdown(text)) : null),
        step.id === 'positioning' && fqReports !== null && fqReports.length > 0
          ? h('div', { style: { marginTop: 10 } },
              h(FanqieListingCard, {
                reports: fqReports,
                limits: fqLimits,
                source: '已落盘稿',
                flash,
                fixHint: '这个候选没有输出「### 四、上架信息」小节（旧稿）：点右边的「只补写上架信息」只补这一节，前面的定位正文一个字都不动（本作品已有章节，所以定位步的「生成草稿」是禁用的）。',
                hint: '这是作品目录里已落盘的定位稿：标签名只能用站点官方清单里的名字，模型自创的会标黄。',
                actions: h(Btn, { variant: 'primary', disabled: fqBusy, onClick: () => void fillListing() }, fqBusy ? '补写中…' : '只补写上架信息'),
              }),
              h('div', { style: { color: C.faint, fontSize: 11.5, marginTop: 6, lineHeight: 1.7 } },
                '「只补写上架信息」只给缺这一节的候选补上：逐个候选过一次模型，插在该候选末尾，前面的定位正文不动；写盘前自动把「' + rel + '」备份成 .bak，并镜像到 Obsidian。'),
              )
          : null,
      )
    }