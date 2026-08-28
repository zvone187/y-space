# Y Space Cookie Import Changelog

## 1.0.0 - 2026-08-27

- Replaced the former external-browser automation bridge with cookie import only.
- Added mutually authenticated proof-based pairing, encrypted cookie transfer, exact-origin optional permissions, metadata preview, and preview-bound commit.
- Added durable permission cleanup across cancellation, timeout, disconnect, and Manifest V3 worker restarts without removing pre-existing grants.
- Added editable profile labels, browser-family detection, a 20-second WebSocket heartbeat, and a Chrome 120 minimum.
- Removed debugger, tab, tab-group, navigation, and page-inspection permissions and logic.

## 0.1.0 - 2026-07-06

- Initial companion extension for importing approved cookies into Y Space from a local Chrome-compatible browser.
- Relays tabs, tab groups, navigation, screenshots, DOM snapshots, and CDP commands through the desktop bridge.
