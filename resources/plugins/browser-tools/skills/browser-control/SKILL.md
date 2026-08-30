---
name: browser-control
description: Open, find, inspect, interact with, and verify websites or local web apps in Y Space's embedded multi-tab browser. Use for visible page state, navigation, screenshots, console or network evidence, and end-to-end UI testing; do not use it for semantic service operations when a purpose-built connector is available.
---

# Browser Control

Use Y Space's `browser` MCP when the task depends on a rendered page, visible interaction, or local web app. If the request is really about structured data or a service operation and a purpose-built connector is available, use that connector instead. An explicit request for the Y Space browser wins.

## Workflow

1. Call `browser.api` when you need the current API map, then call `browser.enable` once before the first browser action.
2. Inventory tabs with `browser.list_tabs`, search their titles and URLs, and activate a relevant match. Only create another tab when no existing tab fits. Open the exact URL the user supplied or the known local target; do not guess a remote site or substitute web search when authentication blocks the requested page.
3. Establish the baseline with the current URL plus `browser.snapshot` or `browser.find`. Prefer accessible roles, names, and returned element refs over brittle selectors or coordinates.
4. Perform the smallest meaningful action. Use `fill` when replacing a field and `type` only when appending is intended.
5. Interactive tools automatically present the exact global browser tab and move Y Space's visible
   orange cursor to the real target before the action. Use one meaningful tool call per intended
   action; do not add ornamental hovers or clicks just to manufacture cursor motion. Passive tab
   inventory and inspection stay in the background until an interaction is required.
6. After every navigation or state-changing action, wait for the expected URL, text, or element and inspect the resulting state. For web-app verification, also check relevant console errors and failed network requests.
7. Capture a screenshot when visual layout or appearance is part of the requirement.
8. Call `browser.disable` before asking the user for input, waiting on an external event, or finishing.

## Boundaries

- Do not open or control an external browser. External browser profiles are cookie sources only; selected cookies can be imported into the embedded browser through Y Space settings.
- Never inspect cookies or storage unless the task requires it and the user authorized that data access.
- A successful click is not proof of success. Verify the user-visible or application state it was meant to produce.
- Pause before purchases, submissions, messages, deletions, or other irreversible external actions unless the user explicitly authorized that exact action.

## Output

Report the tested URL and flow, the final observed state, and the evidence used. Separate visual, console, and network findings, and state any step that could not be verified.
