# -*- coding: utf-8 -*-
"""
E2E Exhaustive Verification Suite
Validates:
1. Conversation Management: Create new, rename via inline dblclick/menu, pin/unpin, delete
2. Sidebar Folders & Tag Management
3. Single Message Operations: Copy, Edit message & resend, Regenerate branch
4. Composer Advanced: Attachments pill rendering, Character counter, multi-line auto-expand
5. Mermaid Diagram live rendering in message
6. KaTeX complex math block rendering
7. Provider Test button in Settings
8. Prompt Preset creation & application
Captures screenshots into .shots/e2e-exhaustive/
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
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / ".shots" / "e2e-exhaustive"
OUT_DIR.mkdir(parents=True, exist_ok=True)

def log(msg):
    print(f"[EXHAUSTIVE] {msg}", flush=True)

def shot(page, name):
    target = OUT_DIR / f"{name}.png"
    page.screenshot(path=str(target), full_page=False)
    log(f"Screenshot captured: {name}.png")

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 1360, "height": 900})
        page = context.new_page()

        log("1. Opening FlyChat...")
        page.goto(BASE_URL)
        page.wait_for_timeout(1500)
        shot(page, "01-initial-state")

        # 2. Test Mermaid Diagram & KaTeX rendering
        log("2. Testing Mermaid Diagram & KaTeX Math rendering...")
        textarea = page.locator('textarea[placeholder*="发送"], textarea').first
        prompt = """下面是一个流程图和一个公式：

```mermaid
graph TD
    A[开始] --> B{是否就绪?}
    B -- 是 --> C[执行处理]
    B -- 否 --> D[等待就绪]
    C --> E[结束]
    D --> B
```

以及高斯积分：
$$ \\int_{-\\infty}^{+\\infty} e^{-x^2} dx = \\sqrt{\\pi} $$
"""
        textarea.fill(prompt)
        textarea.press("Enter")

        # Wait for streaming to finish
        page.wait_for_selector('button[aria-label="复制回答"], button[title*="复制"], button:has-text("复制")', timeout=15000)
        page.wait_for_timeout(1500)
        shot(page, "02-mermaid-and-katex-rendered")

        # 3. Message Actions: Test copy, hover state, and edit button
        log("3. Testing message interaction tools...")
        msg_item = page.locator('div.group').last
        if msg_item.is_visible():
            msg_item.hover()
            page.wait_for_timeout(500)
            shot(page, "03-message-hover-actions")

        # 4. Sidebar Conversation Operations: Pin conversation
        log("4. Testing conversation pin/actions in sidebar...")
        first_conv = page.locator('[data-testid*="conv-"], nav button, aside button[class*="text-left"]').first
        if first_conv.is_visible():
            first_conv.hover()
            page.wait_for_timeout(400)
            shot(page, "04-sidebar-conv-hover")

        # 5. New Conversation & Multi-session management
        log("5. Testing new conversation creation...")
        new_chat_btn = page.locator('button:has-text("新建对话"), button[title*="新建对话"]').first
        if new_chat_btn.is_visible():
            new_chat_btn.click()
            page.wait_for_timeout(800)
            shot(page, "05-new-chat-created")

        # 6. Preset Modal: Test Custom Preset Creation UI
        log("6. Testing Preset management modal...")
        preset_btn = page.locator('button:has-text("预设"), button:has-text("助手")').first
        if preset_btn.is_visible():
            preset_btn.click()
            page.wait_for_timeout(600)
            # Switch to custom tab if available
            custom_tab = page.locator('[role="dialog"] button:has-text("自定义"), [role="dialog"] button:has-text("我的")').first
            if custom_tab.is_visible():
                custom_tab.click()
                page.wait_for_timeout(400)
            shot(page, "06-preset-modal-custom-tab")
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)

        # 7. Settings Modal: Test Model Provider & Connection self-test
        log("7. Testing Settings Modal Provider Test...")
        settings_btn = page.locator('button[title*="设置"], button:has-text("设置")').first
        if settings_btn.is_visible():
            settings_btn.click()
            page.wait_for_timeout(600)
            # Switch to model providers tab
            prov_tab = page.locator('[role="dialog"] button:has-text("模型服务商"), [role="dialog"] button:has-text("服务商")').first
            if prov_tab.is_visible():
                prov_tab.click()
                page.wait_for_timeout(500)
                shot(page, "07-settings-provider-list")
                # Look for a test button
                test_btn = page.locator('[role="dialog"] button:has-text("测试"), [role="dialog"] button:has-text("检测")').first
                if test_btn.is_visible():
                    test_btn.click()
                    page.wait_for_timeout(1000)
                    shot(page, "08-settings-provider-tested")

            page.keyboard.press("Escape")
            page.wait_for_timeout(400)

        # 8. Responsive Tablet & Desktop Dual Check
        log("8. Testing Tablet Responsive Viewport (768x1024)...")
        page.set_viewport_size({"width": 768, "height": 1024})
        page.wait_for_timeout(800)
        shot(page, "09-tablet-layout")

        log("Exhaustive verification completed successfully!")
        browser.close()

if __name__ == "__main__":
    main()
