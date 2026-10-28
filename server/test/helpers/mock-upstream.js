import http from 'node:http'

/**
 * 假上游：在本地随机端口模拟 OpenAI / Anthropic 的流式接口。
 *
 * 有了它，测试不需要任何真实 API Key，也不花钱、不受网络影响；
 * 更重要的是可以精确复现「第一次 500 第二次成功」「吐了一半断线」这类
 * 真实上游偶发、但必须处理好的情况。
 */
/**
 * 确定性的假向量：按字符频次散列到固定维度。
 * 共享字符多的文本余弦相似度高，足够验证「检索能不能捞到对的块」，
 * 又不依赖任何真实 embedding 服务。
 */
function fakeEmbedding(text, dim = 96) {
  const vec = new Float32Array(dim)
  for (const ch of String(text)) {
    const code = ch.codePointAt(0)
    vec[code % dim] += 1
  }
  let norm = 0
  for (let i = 0; i < dim; i += 1) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i += 1) vec[i] /= norm
  return Array.from(vec)
}

/** 与服务端 KNOWN_DIMENSIONS 对齐的假维度表：已知模型必须按真实维度返回 */
const MOCK_EMBEDDING_DIMS = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'nomic-embed-text': 768,
}

export async function startMockUpstream(options = {}) {
  const {
    /** 依次返回的状态码；用完后返回 200 */
    statuses = [],
    /** 正常返回的文本分片 */
    chunks = ['你好', '，世界'],
    /**
     * 按请求内容动态决定分片（可选）。
     * 返回 null/undefined 时退回 chunks。给 dev 用的 mock-flash 按提示词切换回复用，
     * 这样一条命令就能同时演示「普通回复」和「HTML 构件」两条路径。
     */
    resolveChunks = null,
    /** usage 上报 */
    usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    /** 收到第 N 个请求时先吐一个分片再直接断开连接 */
    truncateAtRequest = 0,
    /** 每个分片之间等待的毫秒数 */
    delayMs = 0,
    /** 模型列表 */
    models = ['mock-model', 'mock-large'],
    /**
     * 多轮工具调用脚本：第 N 次请求用 toolPlan[N-1]。
     * 例：[{ toolCalls:[{name:'current_time',arguments:{}}] }, { text:'最终答案' }]
     */
    toolPlan = null,
    /** 图像接口返回什么：'url' 给链接，'b64' 给 base64，'both' 都给 */
    imageMode = 'url',
    /** 图像接口要返回的状态码（测错误分支） */
    imageStatus = 200,
  } = options

  const state = { hits: 0, lastBody: null, lastAuth: null, aborted: 0, imageHits: 0, lastImageBody: null }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
      return
    }

    // 图像生成：按 imageMode 返回 url / b64_json
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      state.imageHits += 1
      let raw = ''
      for await (const chunk of req) raw += chunk
      try {
        state.lastImageBody = JSON.parse(raw || '{}')
      } catch {
        state.lastImageBody = null
      }
      if (imageStatus !== 200) {
        res.writeHead(imageStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'image upstream error', type: 'invalid_request_error' } }))
        return
      }
      const one = (i) => {
        const item = {}
        if (imageMode === 'url' || imageMode === 'both') item.url = `https://img.example.com/${i + 1}.png`
        if (imageMode === 'b64' || imageMode === 'both') item.b64_json = 'iVBORw0KGgoAAAANSUhEUg=='
        if (i === 0) item.revised_prompt = 'revised prompt'
        return item
      }
      const count = Math.min(4, Math.max(1, Number(state.lastImageBody?.n) || 1))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          created: 1700000000,
          data: Array.from({ length: count }, (_, i) => one(i)),
        })
      )
      return
    }

    // 向量化：返回确定性的假向量。
    // 已知模型按真实维度返回：服务端会校验「返回维度与模型标称维度一致」，
    // 一律回 96 维会被当成上游异常拒掉。
    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      state.hits += 1
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw || '{}')
      state.lastBody = body
      const dim = MOCK_EMBEDDING_DIMS[body.model] || 96
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          model: body.model,
          data: inputs.map((text, index) => ({ index, embedding: fakeEmbedding(text, dim) })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        })
      )
      return
    }

    // 语音转写：只校验是不是 multipart，并把收到的字节数回报出来
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      state.hits += 1
      let size = 0
      const contentType = req.headers['content-type'] || ''
      for await (const chunk of req) size += chunk.length
      state.lastAudio = { size, contentType }
      if (!contentType.includes('multipart/form-data')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'expected multipart' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: '这是转写出来的文字', language: 'zh', duration: 1.5 }))
      return
    }

    // 语音合成：回一段假的 mp3 字节
    if (req.method === 'POST' && req.url === '/v1/audio/speech') {
      state.hits += 1
      let raw = ''
      for await (const chunk of req) raw += chunk
      state.lastBody = JSON.parse(raw || '{}')
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      res.end(Buffer.from([0xff, 0xfb, 0x90, 0x00]))
      return
    }

    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/v1/messages')) {
      state.hits += 1
      state.lastAuth = req.headers.authorization || req.headers['x-api-key'] || null

      let raw = ''
      for await (const chunk of req) raw += chunk
      try {
        state.lastBody = JSON.parse(raw)
      } catch {
        state.lastBody = null
      }

      const status = statuses[state.hits - 1] ?? 200
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock error ${status}` } }))
        return
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      const isAnthropic = req.url === '/v1/messages'
      const shouldTruncate = truncateAtRequest > 0 && state.hits === truncateAtRequest

      // —— 工具调用脚本：模拟「模型先要调工具，拿到结果后再作答」——
      const plan = toolPlan?.[state.hits - 1]
      if (plan?.toolCalls?.length) {
        if (isAnthropic) {
          res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n`)
          plan.toolCalls.forEach((call, i) => {
            res.write(
              `data: ${JSON.stringify({
                type: 'content_block_start',
                index: i,
                content_block: { type: 'tool_use', id: `call_${i}`, name: call.name, input: {} },
              })}\n\n`
            )
            res.write(
              `data: ${JSON.stringify({
                type: 'content_block_delta',
                index: i,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments || {}) },
              })}\n\n`
            )
            res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: i })}\n\n`)
          })
          res.write(
            `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })}\n\n`
          )
        } else {
          plan.toolCalls.forEach((call, i) => {
            // 故意把参数拆成两片，验证增量拼接
            const args = JSON.stringify(call.arguments || {})
            const mid = Math.ceil(args.length / 2)
            res.write(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: i, id: `call_${i}`, type: 'function', function: { name: call.name, arguments: args.slice(0, mid) } },
                      ],
                    },
                  },
                ],
              })}\n\n`
            )
            res.write(
              `data: ${JSON.stringify({
                choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args.slice(mid) } }] } }],
              })}\n\n`
            )
          })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
          // 真实上游在工具调用这一轮也会上报 usage，这里保持一致
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\n`)
          res.write('data: [DONE]\n\n')
        }
        res.end()
        return
      }

      const scriptedText = plan?.text
      const dynamicChunks = !scriptedText && resolveChunks ? resolveChunks(state.lastBody) : null
      const scriptedChunks = scriptedText ? [scriptedText] : dynamicChunks || chunks

      if (isAnthropic) {
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: { usage: { input_tokens: 12 } },
          })}\n\n`
        )
      }

      for (let i = 0; i < scriptedChunks.length; i += 1) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
        const text = scriptedChunks[i]
        const payload = isAnthropic
          ? { type: 'content_block_delta', delta: { type: 'text_delta', text } }
          : { choices: [{ delta: { content: text } }] }
        res.write(`data: ${JSON.stringify(payload)}\n\n`)

        if (shouldTruncate && i === 0) {
          // 先让这一片真的发出去，再断连接：
          // 模拟「用户已经看到半句话，然后上游挂了」这种最需要被正确处理的情况
          await new Promise((r) => setTimeout(r, 30))
          res.destroy()
          return
        }
      }

      if (isAnthropic) {
        res.write(
          `data: ${JSON.stringify({
            type: 'message_delta',
            usage: { output_tokens: usage.completion_tokens },
          })}\n\n`
        )
        res.write('data: [DONE]\n\n')
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\n`)
        res.write('data: [DONE]\n\n')
      }
      res.end()
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  server.on('clientError', (_err, socket) => socket.destroy())

  await new Promise((resolve) => server.listen(options.port || 0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      }),
  }
}
