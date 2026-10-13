# novel-batch-agent

批量小说写作 Agent。核心写作能力复刻自 **[alycat-lee/dsh-writer-m](https://github.com/alycat-lee/dsh-writer-m)**（MIT），去掉 DeepSeek Harness 宿主，改成可独立启动的本机 HTTP 服务，并加上**多本队列、断点续跑**。

原插件版权 © alycat-lee / dsh-writer-m，本仓库在其步骤链、prompt、续写刹车、路径拦截与工作台前端之上做独立宿主与批量引擎。

## 架构（文字版）

```
浏览器 / CLI
    │  HTTP  127.0.0.1:PORT
    ▼
server/http.js          精确路由 + 静态工作台（/ 与 /client.js）
    │
server/ctx-facade.js    get / inject(同步) / effect
    │
lib/index.js            原插件全部 API（/dsh-writer-m/api/*）
    │                   + 抽出的 runStep() + 追加的 batch/* 路由
    ├─ lib/core/llm.js          流式调用 + 自动续写（截断 / 字数 / 复读刹车 /「已写完」）
    ├─ lib/core/genres.js       小说7步 / 公众号5步 / 小红书5步 + prompt + 目标字数
    ├─ lib/core/workspace.js    作品目录、project.json、「有文件才算做过」
    ├─ lib/core/fsx.js          resolveInside 越界拦截、原子写
    ├─ lib/core/batch.js        任务队列、跳过已落盘步、指数退避
    └─ src-client/ → lib/client.js   原工作台前端（零修改）

server/llm-adapter.js   OpenAI 兼容 POST /chat/completions（SSE）
                        MOCK_LLM=1 时不联网，吐可分辨假正文
server/config.js        <root>/.agent-config.json + configEditor.edit 写盘
```

数据流：工作台或 CLI 发 `batch/create` → 任务落 `<root>/.batch/<id>.json` → 队列按 `batch.concurrency` 取书 → 每本调用与单本按钮相同的 `runStep` → 产物写进 `<root>/<书名>/`。重启后 `running` 会被收成 `queued`，已有非空文件的步骤自动跳过。

## 要求

- Node.js >= 20
- 无 npm 重型依赖（React 已 vendor 进 `server/vendor/`，仅工作台浏览器用）
- 真写需要 OpenAI 兼容接口（默认 DeepSeek）

## 配置

落盘文件：`<root>/.agent-config.json`（`root` 默认 `~/Documents/novel-batch-agent`，可用环境变量 `WRITER_ROOT` 覆盖）。

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `root` | `~/Documents/novel-batch-agent` | 作品落盘根目录 |
| `provider` / `model` | `deepseek` / `deepseek-chat` | 模型路由 |
| `apiKey` | `${DEEPSEEK_API_KEY}` | 支持 `${ENV_VAR}` 展开 |
| `baseURL` | `https://api.deepseek.com` | OpenAI 兼容基址 |
| `maxTokens` | `4500` | 单次最大输出 token |
| `vaultPath` | 空 | Obsidian 库（可选） |
| `enabled` | `true` | `false` 时 API 一律 503 |
| `batch.concurrency` | `1` | 同时写几本（1 = 串行） |
| `batch.retry` | `3` | 单步失败重试次数 |
| `batch.retryDelayMs` | `5000` | 重试起始间隔（指数退避） |

工作台「设置」里改 `maxTokens` / `root` / `provider` / `model` 会走 `configEditor.edit` **写盘**，重启后仍在。

```powershell
copy .env.example .env
# 编辑 .env 填 DEEPSEEK_API_KEY，或直接写进 .agent-config.json
```

## 启动

```powershell
node scripts/build-client.mjs   # 拼接 src-client/ → lib/client.js（改前端后必须再跑）
npm start                       # 监听 http://127.0.0.1:8787
```

离线验收（不消耗额度）：

```powershell
$env:MOCK_LLM=1; npm start
```

浏览器打开 http://127.0.0.1:8787 ，工作台与原插件相同（API 前缀仍是 `/dsh-writer-m/api/`）。

## 批量提交

`examples/books.json`：

```json
{
  "books": [
    {
      "bookName": "长夜将明",
      "genre": "novel",
      "channel": "male",
      "idea": "昆仑坊市杂役陈默捡到残破玉简，装弱打脸、凡人逆袭。",
      "targetChapters": 3,
      "chapterChars": 800
    }
  ]
}
```

```powershell
npm start
npm run batch -- submit --file examples/books.json
npm run batch -- list
npm run batch -- status <id>
npm run batch -- pause <id>
npm run batch -- resume <id>
```

每本书自动跑完小说 7 步：作品定位 → 大纲 → 人物 → 卷大纲 → 章节大纲 → 章节×N → 润色。  
产物约定与原插件一致：

```
<root>/<作品>/project.json
<root>/<作品>/steps/01-作品定位.md … 04-卷大纲.md
<root>/<作品>/chapter-outlines/第1卷.md
<root>/<作品>/chapters/第001章.md
<root>/<作品>/chapters/第001章-润色.md
```

## 断点续跑

- **步骤级**：执行前看磁盘，非空产物视为已做，直接跳过（与「有文件才算做过」相同）。
- **进程级**：启动时扫描 `.batch/`，把残留的 `running` 收成 `queued` 再泵。
- **手动**：`pause` 停下，`resume` 从断点继续；已落盘的定位/大纲/章节不会重写。

## 番茄发布（可选，原样保留）

与原插件相同，默认关闭。配置 `publishProfile`（Playwright 持久化登录态目录）后：

```powershell
python scripts/fanqie_login.py --profile <登录态目录>
python scripts/fanqie_publish.py --profile <登录态目录> ...
```

工作台「发布」页也可触发。请确认登录态无误后再点真发。

## 与原插件对照

| 能力 | dsh-writer-m | novel-batch-agent |
| --- | --- | --- |
| 小说 7 步 / 公众号 5 步 / 小红书 5 步 | ✓ | ✓ 原样 |
| 每步 prompt 可改、本步注入预览 | ✓ | ✓ |
| 自动续写（截断 / 字数 / 复读刹车 /「已写完」） | ✓ | ✓ `lib/core/llm.js` 未改行为 |
| 七维风格画像、结构模版 | ✓ | ✓ |
| 路径越界拦截 | ✓ | ✓ `lib/core/fsx.js` |
| 工作台 UI | dsh 侧栏插件 | 独立页 http://127.0.0.1:8787 |
| 模型调用 | dsh `ctx.get('llm')` | OpenAI 兼容 SSE / `MOCK_LLM` |
| 配置写盘 | dsh configEditor | `.agent-config.json` |
| 多本队列 / 断点续跑 / CLI | ✗ | ✓ `batch/*` + `scripts/batch-cli.mjs` |
| Obsidian 双库、番茄上架/发布 | ✓ | ✓ 保留 |

## 自检

```powershell
node scripts/build-client.mjs
node scripts/check-host.mjs
node scripts/check-client.mjs
node scripts/check-render.mjs
node scripts/check-vaultlib.mjs
$env:MOCK_LLM=1; node scripts/check-standalone.mjs
```

## License

MIT。写作引擎与工作台前端来自 [alycat-lee/dsh-writer-m](https://github.com/alycat-lee/dsh-writer-m)。
