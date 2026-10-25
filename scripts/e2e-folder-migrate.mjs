/**
 * E2E：验证「服务端为空 + 本地有文件夹」时的迁移。
 *
 * 场景：用户升级前文件夹只存本地（IndexedDB）。新版挂载时若直接 setFolders([])，
 * 这些文件夹会被清空、会话全掉进「未分类」。期望：自动推送到服务端，并把本地 id 换成服务端 id。
 */
import { createRequire } from 'node:module'

const requireLocal = createRequire(import.meta.url)
let chromium
try {
  ;({ chromium } = requireLocal('playwright'))
} catch {
  // 本机通常只装了 playwright-core（托管 workspace 里），必须显式指定系统 Chrome
  const requireFallback = createRequire(
    (process.env.PLAYWRIGHT_REQUIRE || 'C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/') + '/'
  )
  ;({ chromium } = requireFallback('playwright-core'))
}

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = process.env.BASE_URL || process.argv[2] || 'http://127.0.0.1:5180'

const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

const seedResult = await page.evaluate(async () => {
  const openDb = () =>
    new Promise((res, rej) => {
      const r = indexedDB.open('keyval-store', 1)
      r.onupgradeneeded = () => {
        try {
          r.result.createObjectStore('keyval')
        } catch {
          /* 已存在 */
        }
      }
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })

  const readRaw = async () => {
    const db = await openDb()
    if (!db.objectStoreNames.contains('keyval')) return null
    return await new Promise((res, rej) => {
      const g = db.transaction('keyval', 'readonly').objectStore('keyval').get('flychat-store')
      g.onsuccess = () => res(g.result || null)
      g.onerror = () => rej(g.error)
    })
  }

  const raw = await readRaw()
  const parsed = raw ? JSON.parse(raw) : { state: {}, version: 0 }
  parsed.state = parsed.state || {}
  parsed.state.folders = [{ id: 'local-f1', name: '本地旧文件夹', emoji: '📁', createdAt: 1 }]
  parsed.state.conversations = [
    {
      id: 'e2e-conv-1',
      title: '旧会话',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      folderId: 'local-f1',
      usingContext: true,
    },
  ]

  const db = await openDb()
  await new Promise((res, rej) => {
    const tx = db.transaction('keyval', 'readwrite')
    tx.objectStore('keyval').put(JSON.stringify(parsed), 'flychat-store')
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
  return { seededFolders: parsed.state.folders.length }
})
console.log('SEED', JSON.stringify(seedResult))

await page.reload({ waitUntil: 'domcontentloaded' })
// 迁移是异步的（要串行 POST），给足时间
await page.waitForTimeout(6000)

const after = await page.evaluate(async () => {
  const raw = await new Promise((res, rej) => {
    const r = indexedDB.open('keyval-store', 1)
    r.onsuccess = () => {
      const g = r.result.transaction('keyval', 'readonly').objectStore('keyval').get('flychat-store')
      g.onsuccess = () => res(g.result || null)
      g.onerror = () => rej(g.error)
    }
    r.onerror = () => rej(r.error)
  })
  const p = raw ? JSON.parse(raw) : { state: {} }
  return {
    folders: (p.state.folders || []).map((f) => ({ id: f.id, name: f.name })),
    convs: (p.state.conversations || []).map((c) => ({ id: c.id, folderId: c.folderId })),
  }
})

console.log('AFTER_LOCAL', JSON.stringify(after))
console.log('CONSOLE_ERRORS', JSON.stringify(errors.slice(0, 5)))
await browser.close()
