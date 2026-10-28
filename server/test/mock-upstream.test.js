import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMockUpstream } from './helpers/mock-upstream.js'

/**
 * 假上游分到的端口必须是 fetch 真能连的。
 *
 * 背景：`listen(0)` 拿到的是系统动态端口区间里的任意一个，而 fetch 规范屏蔽了一批端口
 * ——undici 在建 TCP 连接**之前**就抛 `TypeError: fetch failed` / cause `bad port`。
 * 本机动态区间是 1024–15000，里面正好有 17 个这种端口，于是每建一次假上游约有 0.12% 概率
 * 拿到一个「明明在监听、却永远连不上」的端口，表现为随机的「上游 hits=0、回答为空」，
 * 曾让 fallback / compact 等用例偶发失败（一次全量测试建几十个假上游，翻车概率约 6%）。
 */
const BLOCKED_IN_COMMON_RANGE = [
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]

test('随机分配的端口不会落在 fetch 屏蔽端口上', async () => {
  for (let i = 0; i < 60; i += 1) {
    const upstream = await startMockUpstream({ chunks: ['x'] })
    assert.ok(!BLOCKED_IN_COMMON_RANGE.includes(upstream.port), `分到了屏蔽端口 ${upstream.port}`)
    assert.equal(upstream.baseUrl, `http://127.0.0.1:${upstream.port}/v1`)
    await upstream.close()
  }
})

test('显式指定屏蔽端口时直接说清原因，而不是绑一个连不上的端口', async () => {
  await assert.rejects(() => startMockUpstream({ port: 10080 }), /屏蔽/)
})
