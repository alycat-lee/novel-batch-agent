/**
 * 插件 HTTP API 的请求体读取。
 *
 * 为什么单独成模块：封面这类二进制接口只能走 base64，5 MB 图片 JSON 化后约 6.7 MB，
 * 远超默认上限；上限一旦被撞到，旧实现直接 `req.destroy()`，浏览器只看到
 * `TypeError: Failed to fetch`（连接被重置）——看不到原因，也没法自救。
 * 改成：超限 → 停止缓存、把剩余数据排空 → 正常回 413 JSON，客户端能把中文原因显示出来。
 */

/** 普通 JSON 接口的请求体上限：1 MiB（本机回环接口，够用且防止单个请求把内存吃光）。 */
export const JSON_BODY_LIMIT = 1024 * 1024

/**
 * 封面上传专用上限：12 MiB。
 * 5 MB 图片 base64 后约 6.7 MB，再加 JSON 包装仍有余量；5 MB 仍由路由自己复核。
 */
export const COVER_BODY_LIMIT = 12 * 1024 * 1024

/** 单个请求体的读取兜底超时：客户端中途不发完时别把连接永远挂住。 */
export const BODY_READ_TIMEOUT_MS = 60 * 1000

/**
 * 读一个 JSON 请求体。
 *
 * 返回的永远是对象：解析失败 / 超限 / 读错都会回 `{ __error, __status? }`，
 * 由调用方转成 HTTP 状态（**不要**在超限时 destroy socket——那正是
 * 「Failed to fetch」的成因）。
 *
 * @param req node:http 的 IncomingMessage
 * @param limit 字节上限，缺省 {@link JSON_BODY_LIMIT}
 */
export async function readJsonBody(req, limit = JSON_BODY_LIMIT) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : JSON_BODY_LIMIT
  return await new Promise((resolve) => {
    let size = 0
    let overflow = false
    let settled = false
    let timer = null
    const parts = []
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => finish({ __error: '读取请求体超时（客户端没把数据发完）', __status: 408 }), BODY_READ_TIMEOUT_MS)
    timer.unref?.()
    req.on('data', (chunk) => {
      size += chunk.length
      if (overflow) return
      if (size > max) {
        // 超限后只排空、不缓存：既不让超限体驻留内存，
        // 也不提前结束响应（请求没读完就回包，socket 会被重置）。
        overflow = true
        parts.length = 0
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => {
      if (overflow) return finish({ __error: `请求体超过上限 ${max} 字节`, __status: 413 })
      const raw = Buffer.concat(parts).toString('utf8').trim()
      if (raw === '') return finish({})
      try {
        const parsed = JSON.parse(raw)
        finish(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        finish({ __error: '请求体不是合法 JSON' })
      }
    })
    req.on('error', () => finish({ __error: '读取请求体失败' }))
    req.on('close', () => finish({ __error: '请求体还没读完连接就断开了' }))
  })
}
