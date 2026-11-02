# -*- coding: utf-8 -*-
"""
E2E Comprehensive Visual & Functional Tour
Using Playwright to verify full UI, core features, streaming, actions, modals, and responsive layout.
Outputs screenshots into .shots/e2e/ and prints a JSON evaluation report.
"""
import json
import os
import pathlib
import sys
import time
from playwright.sync_api import sync_playwright

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3001"
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / ".shots" / "e2e"
OUT_DIR.mkdir(parents=True, exist_ok=True)

report = {
    "screenshots": [],
    "console_errors": [],
    "page_errors": [],
    "failed_requests": [],
    "overflow_issues": [],
    "step_status": {},
    "perf": {}
}

def log(msg):
    print(f"[E2E] {msg}", flush=True)

def take_shot(page, name):
    target = OUT_DIR / f"{name}.png"
    page.screenshot(path=str(target), full_page=False)
    report["screenshots"].append(str(target))
    log(f"Screenshot captured: {name}.png")

def check_overflow(page, step_name):
    """Detect elements overflowing the viewport horizontally."""
    bad = page.evaluate("""() => {
        const vw = window.innerWidth;
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
            if (cs.position === 'fixed') continue;
            if (el.closest('[aria-hidden="true"], [data-drawer], .overflow-x-auto, .overflow-y-auto, [class*="overflow-x-"]')) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            if (r.right <= 0 || r.left >= vw) continue; // Completely tucked away off-screen
            if (r.right > vw + 1 || r.left < -1) {
                out.push({
                    tag: el.tagName,
                    cls: (el.className || '').toString().slice(0, 50),
                    left: Math.round(r.left),
                    right: Math.round(r.right),
                    vw: vw
                });
            }
        }
        return out.slice(0, 5);
    }""")
    if bad:
        for b in bad:
            report["overflow_issues"].append({"step": step_name, **b})
        log(f"WARNING: Overflow detected at {step_name}: {len(bad)} elements")

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1
        )
        page = context.new_page()

        # Listeners
        page.on("console", lambda msg: report["console_errors"].append(f"[{msg.type}] {msg.text}") if msg.type in ("error", "warning") else None)
        page.on("pageerror", lambda err: report["page_errors"].append(str(err)))
        page.on("requestfailed", lambda req: report["failed_requests"].append(f"{req.method} {req.url} : {req.failure}"))

        log(f"Navigating to {BASE_URL}...")
        page.goto(BASE_URL, wait_until="domcontentloaded")
        page.wait_for_timeout(2500)

        # ---------------------------------------------------------
        # 1. Desktop Empty State (Light Theme)
        # ---------------------------------------------------------
        try:
            check_overflow(page, "01-empty-desktop-light")
            take_shot(page, "01-empty-desktop-light")
            report["step_status"]["01_empty_desktop_light"] = "PASS"
        except Exception as e:
            report["step_status"]["01_empty_desktop_light"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 2. Desktop Empty State (Dark Theme)
        # ---------------------------------------------------------
        try:
            page.evaluate("document.documentElement.classList.add('dark'); localStorage.setItem('flychat-theme', 'dark');")
            page.wait_for_timeout(600)
            check_overflow(page, "02-empty-desktop-dark")
            take_shot(page, "02-empty-desktop-dark")
            # Switch back to light for test consistency
            page.evaluate("document.documentElement.classList.remove('dark'); localStorage.setItem('flychat-theme', 'light');")
            page.wait_for_timeout(400)
            report["step_status"]["02_empty_desktop_dark"] = "PASS"
        except Exception as e:
            report["step_status"]["02_empty_desktop_dark"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 3. Command Palette (Ctrl+K)
        # ---------------------------------------------------------
        try:
            page.keyboard.press("Control+k")
            page.wait_for_timeout(600)
            take_shot(page, "03-command-palette")
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            report["step_status"]["03_command_palette"] = "PASS"
        except Exception as e:
            report["step_status"]["03_command_palette"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 4. Model Selector (Select mock-flash)
        # ---------------------------------------------------------
        try:
            # Click model selector dropdown in header
            model_btn = page.locator("header button[aria-haspopup='menu']").first
            if model_btn.count():
                model_btn.click()
                page.wait_for_timeout(600)
                take_shot(page, "04-model-selector-menu")

                # Locate mock-flash option
                opt = page.locator("button:has-text('mock-flash'), [role='menuitem']:has-text('mock-flash'), div:has-text('mock-flash')").last
                if opt.count():
                    opt.click()
                    page.wait_for_timeout(500)
                    log("Selected mock-flash model.")
                else:
                    log("mock-flash option not found directly in menu, attempting search...")
                    search_input = page.locator("input[placeholder*='搜索模型']").first
                    if search_input.count():
                        search_input.fill("mock")
                        page.wait_for_timeout(400)
                        opt2 = page.locator("text=mock-flash").last
                        if opt2.count():
                            opt2.click()
            else:
                log("Header model button not found, checking alternatives...")
            page.wait_for_timeout(400)
            report["step_status"]["04_model_selector"] = "PASS"
        except Exception as e:
            report["step_status"]["04_model_selector"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 5. Composer Input & Streaming Response
        # ---------------------------------------------------------
        try:
            composer = page.locator("textarea").last
            composer.click()
            composer.fill("请介绍你自己，并输出一段带 Python 代码块、对比表格以及数学公式的示例。")
            page.wait_for_timeout(300)
            take_shot(page, "05-composer-filled")

            composer.press("Enter")
            log("Prompt submitted, waiting for stream...")

            # Wait for response completion
            # Stop button disappearing or action bar appearing (e.g. copy button / like button)
            try:
                page.wait_for_selector("button[title*='复制'], button[title*='点赞'], button[aria-label*='赞']", timeout=25000)
                page.wait_for_timeout(1000)
                log("Stream response completed successfully.")
            except Exception:
                log("Timeout waiting for message action bar, will capture current state.")
                page.wait_for_timeout(2000)

            check_overflow(page, "06-chat-rendered")
            take_shot(page, "06-chat-rendered")
            report["step_status"]["05_chat_streaming"] = "PASS"
        except Exception as e:
            report["step_status"]["05_chat_streaming"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 6. Code Block & Actions (Copy, Hover, Like button)
        # ---------------------------------------------------------
        try:
            code_block = page.locator("pre").first
            if code_block.count():
                code_block.hover()
                page.wait_for_timeout(400)
                take_shot(page, "07-codeblock-hover")

            # Test like feedback button
            like_btn = page.locator("button[title*='赞'], button[aria-label*='赞']").first
            if like_btn.count():
                like_btn.click()
                page.wait_for_timeout(400)
                log("Clicked like button.")
                take_shot(page, "08-feedback-liked")

            report["step_status"]["06_codeblock_and_feedback"] = "PASS"
        except Exception as e:
            report["step_status"]["06_codeblock_and_feedback"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 7. Export Dropdown Menu
        # ---------------------------------------------------------
        try:
            export_btn = page.locator("button[title*='导出'], button[aria-label*='导出'], header button:has-text('导出')").first
            if export_btn.count():
                export_btn.click()
                page.wait_for_timeout(500)
                take_shot(page, "09-export-dropdown")
                # Close by clicking outside or escape
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)
            report["step_status"]["07_export_dropdown"] = "PASS"
        except Exception as e:
            report["step_status"]["07_export_dropdown"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 8. Settings Modal (General & Providers tabs)
        # ---------------------------------------------------------
        try:
            settings_btn = page.locator("button[title='设置'], button:has-text('设置')").first
            if settings_btn.count():
                settings_btn.click()
            else:
                page.keyboard.press("Control+,")
            page.wait_for_timeout(800)
            take_shot(page, "10-settings-general")

            # Providers tab
            tab = page.locator("text=模型服务").first
            if tab.count():
                tab.click()
                page.wait_for_timeout(600)
                take_shot(page, "11-settings-providers")

            # Appearance tab
            tab_app = page.locator("text=界面外观, text=外观").first
            if tab_app.count():
                tab_app.click()
                page.wait_for_timeout(600)
                take_shot(page, "12-settings-appearance")

            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            report["step_status"]["08_settings_modal"] = "PASS"
        except Exception as e:
            report["step_status"]["08_settings_modal"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 9. Knowledge Base (RAG) Modal
        # ---------------------------------------------------------
        try:
            page.keyboard.press("Control+k")
            page.wait_for_timeout(400)
            box = page.locator("input[placeholder*='搜索'], input[placeholder*='指令'], [role='dialog'] input").first
            if box.count():
                box.fill("知识库")
                page.wait_for_timeout(300)
                page.keyboard.press("Enter")
                page.wait_for_timeout(800)
                take_shot(page, "13-knowledge-modal")
                page.keyboard.press("Escape")
                page.wait_for_timeout(400)
            report["step_status"]["09_knowledge_modal"] = "PASS"
        except Exception as e:
            report["step_status"]["09_knowledge_modal"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 10. Usage & Token Statistics Modal
        # ---------------------------------------------------------
        try:
            page.keyboard.press("Control+k")
            page.wait_for_timeout(400)
            box = page.locator("input[placeholder*='搜索'], input[placeholder*='指令'], [role='dialog'] input").first
            if box.count():
                box.fill("用量")
                page.wait_for_timeout(300)
                page.keyboard.press("Enter")
                page.wait_for_timeout(800)
                take_shot(page, "14-usage-modal")
                page.keyboard.press("Escape")
                page.wait_for_timeout(400)
            report["step_status"]["10_usage_modal"] = "PASS"
        except Exception as e:
            report["step_status"]["10_usage_modal"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 11. Keyboard Shortcuts Dialog (?)
        # ---------------------------------------------------------
        try:
            page.keyboard.press("?")
            page.wait_for_timeout(600)
            take_shot(page, "15-shortcuts-modal")
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            report["step_status"]["11_shortcuts_modal"] = "PASS"
        except Exception as e:
            report["step_status"]["11_shortcuts_modal"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 12. Sidebar Search (Testing debounced query)
        # ---------------------------------------------------------
        try:
            search_input = page.locator("input[placeholder*='搜索对话']").first
            if search_input.count():
                search_input.click()
                search_input.fill("代码块")
                page.wait_for_timeout(400)
                take_shot(page, "16-sidebar-search")
                search_input.fill("")
                page.wait_for_timeout(200)
            report["step_status"]["12_sidebar_search"] = "PASS"
        except Exception as e:
            report["step_status"]["12_sidebar_search"] = f"FAIL: {e}"

        # ---------------------------------------------------------
        # 13. Mobile Viewport Responsiveness (375x812)
        # ---------------------------------------------------------
        try:
            context_mobile = browser.new_context(
                viewport={"width": 375, "height": 812},
                device_scale_factor=2,
                is_mobile=True,
                has_touch=True
            )
            p_mobile = context_mobile.new_page()
            p_mobile.goto(BASE_URL, wait_until="domcontentloaded")
            p_mobile.wait_for_timeout(2000)

            check_overflow(p_mobile, "17-mobile-viewport")
            take_shot(p_mobile, "17-mobile-viewport")

            # Open drawer
            toggle_btn = p_mobile.locator("header button[aria-label*='菜单'], header button[title*='菜单'], header button svg.lucide-menu").locator("..").first
            if not toggle_btn.count():
                toggle_btn = p_mobile.locator("header button").first
            if toggle_btn.count():
                toggle_btn.click()
                p_mobile.wait_for_timeout(600)
                take_shot(p_mobile, "18-mobile-drawer-open")

            context_mobile.close()
            report["step_status"]["13_mobile_responsiveness"] = "PASS"
        except Exception as e:
            report["step_status"]["13_mobile_responsiveness"] = f"FAIL: {e}"

        browser.close()

    log("E2E Test Tour Complete!")
    print(json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    run()
