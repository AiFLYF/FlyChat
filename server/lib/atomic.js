import fs from 'node:fs'
import path from 'node:path'

/**
 * 原子写：先写同目录临时文件再 rename。
 * 直接 writeFileSync 覆盖时，进程被杀/断电会留下半截 JSON，
 * 下次启动就读不出配置——配置文件里存着 API Key，丢了很麻烦。
 */
export function writeFileAtomic(file, content) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 临时文件可能根本没创建成功 */
    }
    throw err
  }
}

export function writeJsonAtomic(file, data) {
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** 读取 JSON；文件缺失或损坏时返回 fallback，并把损坏文件留档便于排查 */
export function readJsonSafe(file, fallback, { onCorrupt } = {}) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* ignore */
    }
    onCorrupt?.(err)
    return fallback
  }
}
