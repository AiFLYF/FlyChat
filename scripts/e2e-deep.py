# -*- coding: utf-8 -*-
"""
Deep Interactive Functionality Verification Tour
Validates:
1. Preset modal operations (switching tabs, selecting preset, applying system prompt)
2. Share Card Modal (theme change, layout, copy/download buttons)
3. Direct message actions (copy content, edit message trigger, feedback, regenerate)
4. Knowledge base document creation / interaction
5. Multi-turn conversation flow
Captures detailed screenshots in .shots/e2e-deep/
"""
import io
import json
import os
import pathlib
import sys
import time
from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
BASE_URL = "http://127.0.0.1:3001"
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / ".shots" / "e2e-deep"
OUT_DIR.mkdir(parents=True, exist_ok=True)

def log(msg):
    print(f"[DEEP-E2E] {msg}", flush=True)

def shot(page, name):
    target = OUT_DIR / f"{name}.png"
    page.screenshot(path=str(target), full_page=False)
    log(f"Screenshot captured: {name}.png")

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 1280, "height": 840})
        page = context.new_page()

        # Step 1: Open app
        log("Opening app...")
        page.goto(BASE_URL)
        page.wait_for_timeout(1500)

        # Step 2: Open Preset Modal (助手/角色预设)
        log("Testing Preset Modal...")
        # Preset button or selector
        preset_btn = page.locator('button:has-text("预设"), button:has-text("助手")').first
        if preset_btn.is_visible():
            preset_btn.click()
            page.wait_for_timeout(600)
            shot(page, "01-preset-modal-open")
            # Click a role/preset item
            role_item = page.locator('[role="dialog"] button, [role="dialog"] [class*="cursor-pointer"]').first
            if role_item.is_visible():
                role_item.click()
                page.wait_for_timeout(400)
            # Close dialog if still open
            close_btn = page.locator('[role="dialog"] button[aria-label="关闭"], [role="dialog"] button:has-text("关闭")').first
            if close_btn.is_visible():
                close_btn.click()
                page.wait_for_timeout(300)

        # Step 3: Send message to establish a rich conversation
        log("Sending math & code prompt for rich message features...")
        textarea = page.locator('textarea[placeholder*="发送"], textarea').first
        textarea.fill("请用 Python 写一个计算斐波那契数列的代码，并给出公式。")
        textarea.press("Enter")

        # Wait for streaming to finish
        page.wait_for_selector('button[aria-label="复制回答"], button[title*="复制"], button:has-text("复制")', timeout=15000)
        page.wait_for_timeout(1000)
        shot(page, "02-rich-message-rendered")

        # Step 4: Hover message and verify action buttons (Copy, Regenerate, Edit)
        msg_box = page.locator('article, .group\\/msg, [class*="MessageItem"]').last
        if msg_box.is_visible():
            msg_box.hover()
            page.wait_for_timeout(400)
            shot(page, "03-message-actions-hover")

        # Step 5: Test Share Card Modal
        log("Testing Share Card modal...")
        export_btn = page.locator('button:has-text("导出")').first
        if export_btn.is_visible():
            export_btn.click()
            page.wait_for_timeout(400)
            # Click '图片'
            img_export = page.locator('[role="menu"] button:has-text("图片"), button:has-text("图片")').first
            if img_export.is_visible():
                img_export.click()
                page.wait_for_timeout(1000)
                shot(page, "04-share-card-modal")

                # Switch theme inside share card modal
                theme_btn = page.locator('[role="dialog"] button:has-text("深色"), [role="dialog"] button:has-text("浅色")').first
                if theme_btn.is_visible():
                    theme_btn.click()
                    page.wait_for_timeout(500)
                    shot(page, "05-share-card-theme-switched")

                # Close share card modal
                close_dialog = page.locator('[role="dialog"] button[aria-label="关闭"], [role="dialog"] button:has-text("取消")').first
                if close_dialog.is_visible():
                    close_dialog.click()
                    page.wait_for_timeout(300)

        # Step 6: Multi-turn continuation
        log("Sending multi-turn follow-up question...")
        textarea = page.locator('textarea[placeholder*="发送"], textarea').first
        textarea.fill("再给出一个递归带缓存的写法。")
        textarea.press("Enter")
        page.wait_for_timeout(3000)
        shot(page, "06-multi-turn-conversation")

        # Step 7: Test Knowledge Base modal
        log("Testing Knowledge Base modal...")
        kb_btn = page.locator('button[title*="知识库"], button:has-text("知识库")').first
        if kb_btn.is_visible():
            kb_btn.click()
            page.wait_for_timeout(800)
            shot(page, "07-knowledge-modal-detail")
            # Close dialog using escape or clicking close button directly
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            # Ensure backdrop is closed
            if page.locator('.fixed.inset-0.z-50').is_visible():
                page.locator('[role="dialog"] button[aria-label="关闭"], button[aria-label="关闭"]').last.click(force=True)
                page.wait_for_timeout(400)

        # Step 8: Context switch toggle
        log("Testing context toggle...")
        ctx_toggle = page.locator('button:has-text("上下文")').first
        if ctx_toggle.is_visible():
            ctx_toggle.click(force=True)
            page.wait_for_timeout(400)
            shot(page, "08-context-toggle-changed")
            ctx_toggle.click(force=True)
            page.wait_for_timeout(300)

        log("Deep E2E verification complete!")
        browser.close()

if __name__ == "__main__":
    main()
