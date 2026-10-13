/**
 * novel-batch-agent 入口：组装独立宿主，再把原插件 apply() 挂上去。
 *
 * 原插件版权：alycat-lee/dsh-writer-m（MIT）
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { loadConfig, createConfigEditor, publicConfig } from './config.js'
import { createLlm } from './llm-adapter.js'
import { createWebServer, listenAddr } from './http.js'
import { createFacade } from './ctx-facade.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const clientJs = join(PACKAGE_DIR, 'lib', 'client.js')
if (existsSync(clientJs) === false) {
  const built = spawnSync(process.execPath, [join(PACKAGE_DIR, 'scripts', 'build-client.mjs')], {
    cwd: PACKAGE_DIR,
    stdio: 'inherit',
  })
  if (built.status !== 0) {
    console.error('无法拼接工作台前端 lib/client.js，请先运行 npm run build:client')
    process.exit(1)
  }
}

const cfgState = { current: null }

const llm = createLlm(() => cfgState.current)

const webServer = createWebServer()

const config = await loadConfig()
cfgState.current = config

const editor = createConfigEditor(config, (next) => {
  cfgState.current = next
})

const agentDefaultModel = {
  currentSelection() {
    const c = cfgState.current ?? config
    return { provider: c.provider, model: c.model }
  },
}

const skills = {
  register() {
    return () => {}
  },
}

const facade = createFacade({
  llm,
  webServer,
  configEditor: editor,
  agentDefaultModel,
  skills,
})

await apply(facade.ctx, publicConfig(cfgState.current))

const { host, port } = listenAddr()
await webServer.listen(host, port)

const url = `http://${host}:${port}/`
console.log(`novel-batch-agent 工作台：${url}`)
console.log(`API：${url}dsh-writer-m/api/state`)
console.log(`落盘根目录：${cfgState.current.root}`)
if (process.env.MOCK_LLM === '1' || process.env.MOCK_LLM === 'true') {
  console.log('MOCK_LLM=1：不发网络请求，按目标字数生成假正文')
}

const shutdown = async () => {
  facade.dispose()
  try { await webServer.close() } catch { /* 已经关了 */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', (error) => {
  console.error('uncaughtException', error)
})
process.on('unhandledRejection', (error) => {
  console.error('unhandledRejection', error)
})
