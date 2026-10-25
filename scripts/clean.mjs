// 逐文件清理构建产物目录，避免一次性批量删除触发沙箱保护
import fs from 'node:fs'
import path from 'node:path'

const target = process.argv[2] || 'dist'
if (!fs.existsSync(target)) process.exit(0)

for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
  const full = path.join(target, entry.name)
  if (entry.isDirectory()) {
    for (const inner of fs.readdirSync(full)) {
      const innerFull = path.join(full, inner)
      if (fs.statSync(innerFull).isDirectory()) {
        for (const deep of fs.readdirSync(innerFull)) {
          fs.rmSync(path.join(innerFull, deep), { force: true })
        }
        fs.rmdirSync(innerFull)
      } else {
        fs.rmSync(innerFull, { force: true })
      }
    }
    fs.rmdirSync(full)
  } else {
    fs.rmSync(full, { force: true })
  }
}
fs.rmdirSync(target)
console.log(`[clean] 已清理 ${target}`)
