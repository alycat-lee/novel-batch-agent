// -----------------------------------------------------------------------
    // 上部菜单入口图标（sidebar.panellist）
    // -----------------------------------------------------------------------

    /**
     * 上部菜单「写作」的图标。宿主把 { size, active } 传进来，这里只负责画图形；
     * 按钮、label、选中态都由侧栏自己负责（与插件管理 / 定时任务图标同一契约）。
     */
    function WriterIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h('span', { style: { fontSize: size, lineHeight: 1 } }, '✍️')
    }

    // -----------------------------------------------------------------------
    // 中列主面板（main）
    // -----------------------------------------------------------------------

    /**
     * 挂在 'main' 槽位（key='writer-m'）：点上部菜单「写作」时中列渲染它，
     * 点「✕ 返回」/ Esc 由注入的 close（= ctx.layout.selectPanel(null)）退回会话。
     * Esc 在这里统一处理：无论焦点在哪（含输入框），Esc 都直接退回会话，
     * 否则用户改 prompt / 正文后按 Esc 会被跳过，觉得「退不出去」。
     */
    function WriterPanel(props) {
      // Esc 由 Workbench 自己处理：先回当前类型首页列表，已在列表再退出。
      const close = props !== null && props !== undefined && typeof props.close === 'function' ? props.close : () => {}
      return h(Workbench, { close })
    }

    // -----------------------------------------------------------------------
    // 右侧栏「送进工作台改」
    // -----------------------------------------------------------------------

    /**
     * 挂在 sidebar.right.tab.document.actions 上：读文档时出现。
     * 组件收到宿主传的 { absolutePath }，点一下把路径塞进 pendingImport 并切到写作面板。
     */
    function DocumentSendAction(props) {
      const abs = props !== null && props !== undefined && typeof props.absolutePath === 'string' ? props.absolutePath : ''
      if (abs === '') return null
      return h(
        'button',
        {
          type: 'button',
          title: '把这篇文档送进写作工作台继续改（导入为草稿）',
          onClick: () => {
            pendingImport.set({ absolutePath: abs })
            if (typeof selectPanel === 'function') selectPanel('writer-m')
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            background: 'transparent',
            color: C.text,
            border: '1px solid ' + C.line,
            borderRadius: 6,
            padding: '4px 8px',
            cursor: 'pointer',
            fontFamily: fontStack,
            fontSize: 12,
          },
        },
        h('span', { style: { fontSize: 12 } }, '✍️'),
        h('span', null, '送进工作台改'),
      )
    }

    // -----------------------------------------------------------------------
    // 注册
    // -----------------------------------------------------------------------

    exports.name = NS
    exports.inject = ['slots', 'layout']
    /** 纯逻辑出口：浏览器端模块没法直接单测，这几个函数靠它跑断言。 */
    exports.__internals = { fmtChars, HOST_BASE, API, pendingImport }

    /** 模块级：apply 里从 ctx.layout 取 selectPanel，供右侧栏按钮切面板用。 */
    let selectPanel = null

    exports.apply = function (ctx) {
      selectPanel = (id) => ctx.layout.selectPanel(id)
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          { name: 'main', key: 'writer-m', inject: () => ({ close: () => ctx.layout.selectPanel(null) }) },
          WriterPanel,
        ),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'writer-m', order: 5, label: '写作' },
          WriterIcon,
        ),
      )
      ctx.slots.inject('sidebar.right.tab.document.actions', () =>
        ctx.slots.register(
          { name: 'sidebar.right.tab.document.actions', id: 'writer-m-send', order: 20 },
          DocumentSendAction,
        ),
      )
    }

    return module.exports
  },
})