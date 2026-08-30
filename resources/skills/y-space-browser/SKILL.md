---
name: y-space-browser
description: Control Y Space's embedded multi-tab browser to open, find, reuse, inspect, interact with, and verify web pages or local apps. Use whenever a task needs rendered page state, an existing tab, visual QA, screenshots, console evidence, or network evidence.
---

# Y Space Browser

Use the `browser` MCP for every agent-controlled browser task. It operates the embedded browser panel that the user can see and shares its tab inventory with the current Y Space task.

## Start with the tab inventory

1. Call `browser.enable` once at the start of an uninterrupted browsing session.
2. Call `browser.list_tabs` before opening anything. Search returned titles and URLs for a relevant tab.
3. Reuse a matching tab with `browser.activate_tab`. Create a new one with `browser.new_tab` only when no existing tab fits the request.
4. Call `browser.api` if the needed operation or input shape is unclear.

If the user says “the tab,” “a tab I opened,” or names a page without an ID, inspect the inventory and resolve the most likely tab from title and URL. If more than one tab is genuinely ambiguous, state the candidates and ask which one.

## Interact and verify

1. Establish state with `browser.get_url` and `browser.snapshot` or `browser.find`.
2. Prefer accessible roles, names, and returned `@e` refs over coordinates or brittle selectors.
3. Use `browser.fill` to replace field contents and `browser.type` only to append.
4. Interactive tools automatically present the exact global browser tab and move Y Space's visible
   orange cursor to the real target before the action. Use one meaningful tool call per intended
   action; do not add ornamental hovers or clicks just to manufacture cursor motion. Passive tab
   inventory and inspection stay in the background until an interaction is required.
5. After navigation or any state-changing action, wait for the expected URL, text, or element and inspect the resulting state.
6. For web-app testing, check relevant console errors and failed network requests. Capture a screenshot when appearance matters.
7. Call `browser.disable` before pausing for user input, waiting on an external event, or finishing.

## Browser boundary

Do not open or control an external browser. Chrome, Brave, Edge, Firefox, and Safari are cookie sources only; the user imports selected cookies into the embedded browser from Y Space settings. If a page needs a login that is not present, tell the user which domain needs cookies and direct them to the cookie-import control. Never ask the user to paste cookie values.

Do not inspect cookies or page storage unless the task requires it and the user authorized that access. Pause before purchases, submissions, messages, deletions, or other irreversible external actions unless the user explicitly authorized the exact action.

## Report

State which embedded tab and URL you used, what flow you exercised, the final observed state, and the visual, console, or network evidence that supports the result.
