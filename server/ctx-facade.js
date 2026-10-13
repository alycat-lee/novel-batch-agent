/**
 * 给 lib/index.js 的 apply(ctx, config) 看的最小宿主门面。
 *
 * 只用到：
 *   ctx.get(name)
 *   ctx.inject(names, cb)  —— 立即同步回调
 *   ctx.effect(fn)         —— 退出时执行
 */
export function createFacade({ llm, webServer, configEditor, agentDefaultModel, skills }) {
  const services = {
    llm,
    webServer,
    configEditor,
    agentDefaultModel,
  }
  if (skills !== undefined) services.skills = skills

  const effects = []

  const ctx = {
    get(name) {
      return services[name]
    },
    inject(names, cb) {
      const list = Array.isArray(names) ? names : [names]
      const bag = {}
      for (const n of list) bag[n] = services[n]
      // 也把 ctx 上的 get 透出去，兼容 ready.webServer ?? ctx.get('webServer')
      Object.assign(bag, { get: ctx.get, inject: ctx.inject, effect: ctx.effect })
      if (typeof cb === 'function') cb(bag)
      return () => {}
    },
    effect(fn) {
      if (typeof fn === 'function') effects.push(fn)
      return () => {}
    },
  }

  return {
    ctx,
    dispose() {
      for (const fn of effects.splice(0).reverse()) {
        try { fn() } catch { /* 卸载失败不影响其余 */ }
      }
    },
  }
}
