/**
 * Playwright 解析（可移植）。
 *
 * 之前每个 e2e 脚本都写死 `createRequire('C:/Users/<用户名>/...')`，
 * 换一台机器直接 Module Not Found —— 测试基础设施不该绑定某台电脑的目录结构。
 *
 * 解析顺序：
 * 1. 项目本地依赖（`npm i -D playwright` 之后可直接跑）
 * 2. 托管 workspace（本机开发环境），可用 PLAYWRIGHT_REQUIRE 指向任意已安装目录
 * 3. 只装了 playwright-core 也能跑：它不带浏览器二进制，启动时改用系统 Chrome
 */
import { createRequire } from 'node:module'
import os from 'node:os'

const requireLocal = createRequire(import.meta.url)
const fallbackRoot =
  process.env.PLAYWRIGHT_REQUIRE ||
  `${os.homedir().replace(/\\/g, '/')}/.workbuddy-ai/binaries/node/workspace/`

function tryRequire(name) {
  try {
    return requireLocal(name)
  } catch {
    /* 本地没装，继续找托管目录 */
  }
  try {
    const req = createRequire(fallbackRoot.endsWith('/') ? fallbackRoot : `${fallbackRoot}/`)
    return req(name)
  } catch {
    return null
  }
}

const full = tryRequire('playwright')
const core = full ? null : tryRequire('playwright-core')
const mod = full || core

if (!mod?.chromium) {
  throw new Error(
    '找不到 playwright / playwright-core。请先 `npm i -D playwright`，' +
      '或用 PLAYWRIGHT_REQUIRE 指向已安装目录（例如托管 workspace）。'
  )
}

export const chromium = mod.chromium

/** 只装了 playwright-core 时必须显式用系统 Chrome：它不带浏览器二进制 */
export const useSystemChrome = !full

/**
 * 默认启动参数。
 * 本机 shell 注入过 http_proxy，Chromium 会把 127.0.0.1 也送进代理，
 * 表现成「服务明明起来了却连不上」，所以默认关代理。
 */
export const launchOptions = {
  ...(useSystemChrome ? { channel: 'chrome' } : {}),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--proxy-bypass-list=<-loopback>'],
}
