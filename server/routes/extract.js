import { Router } from 'express'
import { config } from '../config.js'
import { badRequest, tooLarge } from '../lib/errors.js'
import { extractText } from '../extract.js'

const router = Router()

/**
 * 文档文本抽取：前端上传文档后先调用此接口拿到纯文本，避免每次对话重复解析。
 * 体积在这里先卡死，别指望上游库对超大 PDF 客气。
 */
router.post('/extract', async (req, res, next) => {
  const { name, mime, dataUrl } = req.body || {}
  if (!dataUrl) return next(badRequest('缺少文件数据', 'missing_file'))
  if (typeof dataUrl !== 'string' || typeof name !== 'string' || name.length > 300) {
    return next(badRequest('文件参数无效', 'invalid_file'))
  }
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  if (Math.ceil((b64.length * 3) / 4) > config.limits.bodyBytes) {
    return next(tooLarge(`文件过大（上限 ${Math.round(config.limits.bodyBytes / 1024 / 1024)}MB）`))
  }
  try {
    const result = await extractText({ name, mime, dataUrl })
    res.json(result)
  } catch (err) {
    next(badRequest(err?.message || '文件解析失败', 'extract_failed'))
  }
})

export default router
