/**
 * dsh-writer-m — 文件与路径工具
 *
 * 唯一的硬约束：**任何写盘路径都必须先过 `resolveInside(root, ...)`**。
 * 插件允许用户在配置里指定落盘根目录，也允许项目名/章节名参与文件名，
 * 所以 `../../` 这类路径必须在进入 fs 之前被拒掉，而不是靠调用方自觉。
 */
import { readFile, writeFile, mkdir, readdir, stat, rename, rm } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path'

/**
 * 把 parts 解析到 root 之内，越界即抛错。
 * 判定用 relative 而不是字符串前缀比较：前缀比较会把 `C:\\a\\b2` 误判成在 `C:\\a\\b` 里。
 * @param {string} root 落盘根目录（绝对路径）
 * @param {...string} parts 相对片段
 * @returns {string} 绝对路径
 */
export function resolveInside(root, ...parts) {
  const base = resolve(root)
  const abs = resolve(base, ...parts)
  const rel = relative(base, abs)
  if (rel !== '' && (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))) {
    throw new Error(`路径越界：${abs} 不在落盘根目录 ${base} 内`)
  }
  return abs
}

/**
 * 目录名/文件名安全化：去掉 Windows 非法字符与分隔符，压掉首尾横线。
 *
 * 除了非法字符，还必须中和 `.` 序列：作品名可以来自用户输入，
 * 输入 `..` 或 `..\\..\\evil` 时若不处理，会得到一个名字里带 `..` 的目录，
 * 既不安全也不可读。这里把连续的点压成单个点，并拒绝「全是点」的结果。
 * 注意 `resolveInside` 仍是最后一道闸——slugify 只是让名字干净，不承担安全职责。
 */
export function slugify(text, fallback = 'untitled') {
  const s = String(text ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/^\.+|\.+$/g, '')
  return s === '' ? fallback : s
}

/** 去掉 UTF-8 BOM：记事本 / PowerShell 的 `Set-Content -Encoding UTF8` 都会加上 EF BB BF， */
/** 而 Node 的 readFile(..., 'utf8') 不会替你去掉 —— JSON.parse 会直接抛「无效的 JSON 基元」。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export async function readTextSafe(path) {
  try {
    return stripBom(await readFile(path, 'utf8'))
  } catch {
    return ''
  }
}

export async function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(stripBom(await readFile(path, 'utf8')))
  } catch {
    return fallback
  }
}

export async function statSafe(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/** 原子写：先写临时文件再 rename，避免半截文件被当成完成产物。 */
export async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, String(text ?? ''), 'utf8')
  await rename(tmp, path)
}

/** 二进制原子写：与 writeAtomic 同构，但不做 utf8 编码（封面图片等二进制产物）。 */
export async function writeBinary(path, buffer) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, buffer)
  await rename(tmp, path)
}

/** 读二进制文件；不存在时返回 null（封面预览用）。 */
export async function readBinary(path) {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

export async function writeJson(path, value) {
  await writeAtomic(path, JSON.stringify(value, null, 2) + '\n')
}

export async function listDirs(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch {
    return []
  }
}

/** 正文字数：去掉所有空白字符后的长度（中文场景下比 length 更接近「字数」直觉）。 */
/**
 * 删一个文件：不存在即静默成功（清理「另一种扩展名」的旧产物时不该因为本来就没有而报错）。
 * @param {string} path 绝对路径
 * @returns {Promise<boolean>} 是否真的删掉了
 */
export async function removeFileSafe(path) {
  try {
    await rm(path, { force: true })
    return true
  } catch {
    return false
  }
}

export function charCount(text) {
  return String(text ?? '').replace(/\s/g, '').length
}

/** 截断并显式标注，避免「以为读了全文」的错觉。 */
export function clip(text, max) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n…（已截断，原文共 ${s.length} 字符）`
}
