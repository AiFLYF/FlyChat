# -*- coding: utf-8 -*-
"""
UI 全面走查：截图 + 交互 + 越界检测 + 键盘可达 + 性能采集。

用法（需要 3001 后端与 mock-flash 上游在跑）：
    python scripts/audit-ui.py [base_url]

产出：
    .shots/audit/*.png     —— 各状态截图（人工/模型视审用）
    stdout JSON 报告        —— 越界元素、控制台错误、性能指标
"""
import json
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3001"
OUT = pathlib.Path(__file__).resolve().parent.parent / ".shots" / "audit"
OUT.mkdir(parents=True, exist_ok=True)

report = {"shots": [], "issues": [], "console_errors": [], "perf": {}}


def shot(page, name):
    path = OUT / f"{name}.png"
    page.screenshot(path=str(path), full_page=False)
    report["shots"].append(str(path))
    print(f"[shot] {name}")


def check_out_of_bounds(page, label):
    """所有可见元素必须在视口内（横向不许溢出，纵向允许滚动容器内部滚动）。"""
    bad = page.evaluate(
        """() => {
        const vw = window.innerWidth, vh = window.innerHeight
        const out = []
        for (const el of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(el)
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue
          const r = el.getBoundingClientRect()
          if (r.width < 2 || r.height < 2) continue
          if (r.right > vw + 1 || r.left < -1) {
            // 固定/绝对定位的浮层（菜单、toast）不算；滚动容器内也不算
            const pos = cs.position
            if (pos === 'fixed') continue
            out.push({tag: el.tagName, cls: (el.className||'').toString().slice(0,60), left: Math.round(r.left), right: Math.round(r.right), vw})
          }
        }
        return out.slice(0, 10)
    }"""
    )
    for b in bad:
        report["issues"].append({"type": "overflow", "where": label, **b})


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page = ctx.new_page()
        page.on("console", lambda m: report["console_errors"].append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: report["console_errors"].append(str(e)))

        # —— 1. 空态（亮色） ——
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        check_out_of_bounds(page, "empty-light")
        shot(page, "01-empty-light")

        # —— 2. 空态（暗色）：通过 localStorage 直切 ——
        page.evaluate("localStorage.setItem('flychat-theme','dark'); document.documentElement.classList.add('dark')")
        page.wait_for_timeout(600)
        shot(page, "02-empty-dark")
        page.evaluate("localStorage.setItem('flychat-theme','system'); document.documentElement.classList.remove('dark')")

        # —— 3. 发送一条消息（mock flash 流式） ——
        # 先在设置里选中闪测模型：默认选中的是 anthropic/space-bunny-free（上游不通），
        # 直接通过页面 UI 的模型选择器切换
        page.keyboard.press("Control+k")  # 快捷指令面板
        page.wait_for_timeout(600)
        shot(page, "03-command-palette")
        page.keyboard.press("Escape")

        # 打开模型选择器（顶栏 aria-haspopup 菜单按钮即 ModelSelector）
        page.click("header button[aria-haspopup='menu']")
        page.wait_for_timeout(700)
        shot(page, "04-model-selector")
        # 选闪测模型（面板里有搜索框，直接点包含 mock-flash 的选项）
        opt = page.locator("button:has-text('mock-flash'), [role='menuitem']:has-text('mock-flash'), div:has-text('mock-flash')").last
        try:
            opt.click(timeout=3000)
            page.wait_for_timeout(600)
        except Exception:
            report["issues"].append({"type": "model-select", "msg": "找不到 mock-flash 选项"})

        composer = page.locator("textarea").last
        composer.fill("介绍一下你自己，并给一个代码块示例")
        page.wait_for_timeout(300)
        shot(page, "05-composer-filled")
        composer.press("Enter")

        # 等流式结束（停止按钮消失 / 出现复制按钮）
        try:
            page.wait_for_selector("text=代码块高亮正常吗", timeout=20000)
            page.wait_for_timeout(1200)
        except Exception:
            report["issues"].append({"type": "chat", "msg": "20s 内没等到回复关键词"})
        shot(page, "06-conversation-light")
        check_out_of_bounds(page, "conversation-light")

        # 代码块悬停（复制按钮）
        block = page.locator("pre").first
        if block.count():
            block.hover()
            page.wait_for_timeout(400)
            shot(page, "07-codeblock-hover")

        # —— 4. 暗色对话 ——
        page.evaluate("document.documentElement.classList.add('dark')")
        page.wait_for_timeout(600)
        shot(page, "08-conversation-dark")
        page.evaluate("document.documentElement.classList.remove('dark')")

        # —— 5. 设置弹窗 ——
        page.keyboard.press("Escape")
        # 设置入口在侧栏底部
        for label in ["设置"]:
            btn = page.locator(f"button[title='{label}'], button:has-text('{label}')").first
            if btn.count():
                btn.click()
                break
        page.wait_for_timeout(900)
        shot(page, "09-settings")
        check_out_of_bounds(page, "settings")
        # 模型服务子面板
        tab = page.locator("text=模型服务").first
        if tab.count():
            tab.click()
            page.wait_for_timeout(700)
            shot(page, "10-settings-providers")
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

        # —— 6. 快捷键面板 ——
        page.keyboard.press("?")
        page.wait_for_timeout(700)
        shot(page, "11-shortcuts")
        page.keyboard.press("Escape")

        # —— 7. 用量弹窗：命令面板内搜索后回车进入 ——
        try:
            page.keyboard.press("Control+k")
            page.wait_for_timeout(500)
            box = page.locator("input[placeholder*='搜索'], input[placeholder*='指令'], [role='dialog'] input").first
            if box.count():
                box.fill("用量")
                page.wait_for_timeout(400)
                page.keyboard.press("Enter")
                page.wait_for_timeout(900)
                shot(page, "12-usage")
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)
        except Exception as e:
            report["issues"].append({"type": "usage-modal", "msg": str(e)[:120]})
            page.keyboard.press("Escape")

        # —— 8. 知识库弹窗 ——
        try:
            page.keyboard.press("Control+k")
            page.wait_for_timeout(400)
            box = page.locator("input[placeholder*='搜索'], input[placeholder*='指令'], [role='dialog'] input").first
            if box.count():
                box.fill("知识库")
                page.wait_for_timeout(400)
                page.keyboard.press("Enter")
                page.wait_for_timeout(900)
                shot(page, "13-knowledge")
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)
        except Exception as e:
            report["issues"].append({"type": "knowledge-modal", "msg": str(e)[:120]})
            page.keyboard.press("Escape")

        # —— 9. 键盘可达性：Tab 循环聚焦在视口内 ——
        page.keyboard.press("Escape")
        focused_out = page.evaluate(
            """() => {
            const out = []
            for (let i = 0; i < 30; i++) {
              const el = document.activeElement
              if (el && el !== document.body) {
                const r = el.getBoundingClientRect()
                if (r.right > window.innerWidth + 1 || r.left < -1) out.push(el.tagName + '.' + (el.className||'').toString().slice(0,40))
              }
              dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true}))
              const ev = new KeyboardEvent('keydown', {key: 'Tab'})
              document.activeElement && document.activeElement.dispatchEvent(ev)
            }
            return out
        }"""
        )
        for f in focused_out or []:
            report["issues"].append({"type": "focus-offscreen", "el": f})

        # —— 10. 性能采集 ——
        perf = page.evaluate(
            """async () => {
            const nav = performance.getEntriesByType('navigation')[0]
            const res = performance.getEntriesByType('resource')
            const js = res.filter(r => r.name.endsWith('.js'))
            const totalJs = js.reduce((s, r) => s + (r.transferSize || 0), 0)
            const mem = performance.memory ? {
              usedHeapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
              totalHeapMB: Math.round(performance.memory.totalJSHeapSize / 1048576),
            } : null
            // 长任务（阻塞主线程 >50ms）
            let longTasks = 0
            try {
              const obs = new PerformanceObserver(() => {})
              // 已发生的拿不到，只报内存与资源
            } catch {}
            return {
              domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
              loadMs: nav ? Math.round(nav.loadEventEnd) : null,
              jsFiles: js.length,
              jsTransferKB: Math.round(totalJs / 1024),
              largestJsKB: Math.round(Math.max(0, ...js.map(r => r.transferSize || 0)) / 1024),
              mem,
              nodeCount: document.querySelectorAll('*').length,
            }
        }"""
        )
        report["perf"] = perf

        # —— 11. reduced-motion 降级 ——
        ctx2 = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        p2 = ctx2.new_page()
        p2.goto(BASE, wait_until="domcontentloaded")
        p2.wait_for_timeout(2000)
        anims = p2.evaluate(
            """() => {
            let animated = 0
            for (const el of document.querySelectorAll('*')) {
              const cs = getComputedStyle(el)
              const an = cs.animationName
              if (an && an !== 'none' && cs.animationDuration !== '0s') animated++
            }
            return animated
        }"""
        )
        report["perf"]["reducedMotionAnimatedEls"] = anims
        shot(p2, "14-reduced-motion")
        ctx2.close()

        browser.close()

    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
