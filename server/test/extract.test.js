import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv } from './helpers/setup.js'

prepareEnv()

// 动态 import：静态 import 会被提升，配置来不及生效
const { extractText } = await import('../extract.js')
const { htmlToText, extractHtmlTitle } = await import('../lib/html.js')

async function zip(files) {
  const JSZip = (await import('jszip')).default
  const z = new JSZip()
  for (const [name, content] of Object.entries(files)) z.file(name, content)
  return z.generateAsync({ type: 'nodebuffer' })
}

test('HTML 转文本：丢掉脚本/样式/导航，保留标题层级与列表', () => {
  const html = `<!doctype html>
<html><head><title>向量数据库入门 &amp; 选型</title>
<style>body{color:red}</style><script>window.x=1</script></head>
<body>
  <nav>首页 | 文档 | 关于</nav>
  <h1>向量数据库</h1>
  <p>HNSW 是一种分层可导航小世界图。</p>
  <script>console.log('不该出现')</script>
  <h2>选型</h2>
  <ul><li>LanceDB</li><li>Qdrant</li></ul>
  <footer>版权所有</footer>
</body></html>`

  const text = htmlToText(html, { keepTitle: true })
  assert.match(text, /^# 向量数据库入门 & 选型/)
  assert.match(text, /# 向量数据库/)
  assert.match(text, /## 选型/)
  assert.match(text, /- LanceDB/)
  assert.ok(!text.includes('color:red'), 'CSS 不能混进正文')
  assert.ok(!text.includes('不该出现'), '脚本内容不能混进正文')
  assert.ok(!text.includes('首页'), '导航块应被丢掉')
  assert.ok(!text.includes('版权所有'), '页脚应被丢掉')
  assert.ok(!text.includes('&amp;'), '实体必须解码')
})

test('HTML 实体：命名实体、十进制、十六进制都要能解', () => {
  assert.equal(htmlToText('<p>a&nbsp;b &lt;c&gt; &quot;d&quot; &#65; &#x42;</p>'), 'a b <c> "d" A B')
})

test('HTML 标题提取：没有 title 时返回空串而不是报错', () => {
  assert.equal(extractHtmlTitle('<html><body>hi</body></html>'), '')
  assert.equal(extractHtmlTitle('<title>  多余  空格 </title>'), '多余 空格')
})

test('上传 .html 文件：入的是正文而不是原始标签', async () => {
  const html = '<html><head><title>T</title><style>.a{}</style></head><body><p>正文内容</p><script>var a=1</script></body></html>'
  const result = await extractText({ name: 'page.html', mime: 'text/html', buffer: Buffer.from(html, 'utf8') })
  assert.equal(result.kind, 'html')
  assert.match(result.text, /正文内容/)
  assert.ok(!result.text.includes('<p>'), '不应保留标签')
  assert.ok(!result.text.includes('var a=1'), '不应保留脚本')
})

test('PPTX：按页抽文本，只取文本节点', async () => {
  const buffer = await zip({
    'ppt/slides/slide1.xml': `<p:sld xmlns:a="x"><a:p><a:r><a:t>第一页标题</a:t></a:r><a:r><a:t>要点一</a:t></a:r></a:p></p:sld>`,
    'ppt/slides/slide2.xml': `<p:sld xmlns:a="x"><a:p><a:r><a:t>第二页内容</a:t></a:r></a:p></p:sld>`,
    'ppt/slides/slide10.xml': `<p:sld xmlns:a="x"><a:p><a:r><a:t>第十页</a:t></a:r></a:p></p:sld>`,
  })
  const result = await extractText({ name: 'deck.pptx', buffer })
  assert.equal(result.kind, 'pptx')
  assert.match(result.text, /## 第 1 页[\s\S]*第一页标题 要点一/)
  assert.match(result.text, /## 第 2 页[\s\S]*第二页内容/)
  // 页序必须按数字排：slide10 要排在 slide2 后面，而不是被当成第 3 页
  assert.ok(result.text.indexOf('第二页内容') < result.text.indexOf('第十页'), '幻灯片顺序应按数字排序')
})

test('PPTX：没有幻灯片时给可读错误', async () => {
  const buffer = await zip({ 'docProps/app.xml': '<x/>' })
  await assert.rejects(() => extractText({ name: 'bad.pptx', buffer }), /没有找到幻灯片/)
})

test('XLSX：共享字符串 + 多个工作表 → 每个表一张 Markdown 表格', async () => {
  const buffer = await zip({
    'xl/workbook.xml': `<workbook><sheets><sheet name="销售" sheetId="1" r:id="rId1"/><sheet name="库存" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/sharedStrings.xml': `<sst><si><t>月份</t></si><si><t>金额</t></si><si><t>一月</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1234.5</v></c></row>
    </sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>商品</t></is></c><c r="B1" t="inlineStr"><is><t>数量</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>键盘</t></is></c><c r="B2"><v>12</v></c></row>
    </sheetData></worksheet>`,
  })

  const result = await extractText({ name: 'data.xlsx', buffer })
  assert.equal(result.kind, 'xlsx')
  assert.match(result.text, /## 销售/)
  assert.match(result.text, /\| 月份 \| 金额 \|/)
  assert.match(result.text, /\| 一月 \| 1234.5 \|/)
  assert.match(result.text, /## 库存/)
  assert.match(result.text, /\| 键盘 \| 12 \|/)
})

test('XLSX：空表给可读错误而不是空字符串', async () => {
  const buffer = await zip({
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData></sheetData></worksheet>',
  })
  await assert.rejects(() => extractText({ name: 'empty.xlsx', buffer }), /没有可用数据/)
})

test('旧版 Office 格式给出可执行的建议，而不是「不支持」三个字', async () => {
  await assert.rejects(
    () => extractText({ name: 'a.ppt', buffer: Buffer.from('x') }),
    /另存为 \.pptx/
  )
  await assert.rejects(
    () => extractText({ name: 'a.xls', buffer: Buffer.from('x') }),
    /另存为 \.xlsx 或 CSV/
  )
})
