# Y Space — Brand Guide

> Status: implementation brand · Updated 2026-08-27 · Supersedes the Lightcode and Poracode product surfaces.

## 1. At a glance

- **Product name:** **Y Space**
- **Spoken name:** “why space”
- **Descriptor:** A local desktop workspace for running coding agents with shared browser and app capabilities.
- **Voice:** calm, precise, direct, and builder-oriented.

Y Space should feel like a focused native developer tool: dark, quiet surfaces; compact controls; excellent keyboard support; and one cool accent used sparingly.

## 2. Logo and icon

The mark is a bold geometric **Y** with a single orbit dot. The Y represents the product initial and a branching agent workflow; the dot provides a small spatial motif and channel accent.

| Variant           | Internal source file        | Use                                     |
| ----------------- | --------------------------- | --------------------------------------- |
| Primary dark tile | `poracode-icon.svg`         | Stable app icon and default product art |
| Light tile        | `poracode-icon-light.svg`   | Light-chip contexts                     |
| Glyph only        | `poracode-glyph.svg`        | In-app and monochrome contexts          |
| Nightly           | `poracode-icon-nightly.svg` | Nightly builds installed beside stable  |
| Wordmark          | `poracode-wordmark.svg`     | Marketing and wide lockups              |

The historical filenames are intentionally retained as internal packaging compatibility boundaries. They are not user-facing product names.

### Rules

- Keep clearspace at least the diameter of the orbit dot.
- Preserve the Y geometry and the dot’s relative position.
- Do not add shadows, bevels, or extra planets/dots.
- Do not place provider trademarks in the product mark.

## 3. Color

| Token  | Hex       | Role                          |
| ------ | --------- | ----------------------------- |
| Night  | `#070709` | Canvas background             |
| Tile   | `#0E0E14` | Icon tile and raised surfaces |
| Moon   | `#EAF0FB` | Primary text and Y on dark    |
| Dim    | `#9BA6BE` | Secondary text                |
| Indigo | `#8B7BFF` | Focus, links, and orbit dot   |
| Ice    | `#5EE6E0` | Nightly accent                |
| Ink    | `#0E0E14` | Y on light surfaces           |

The UI is dark-first and intentionally restrained. Accent colors indicate focus or state; they are not panel backgrounds.

## 4. Typography

Use **Geist Sans** for product UI and headings, with Inter and `system-ui` fallbacks. Use **Geist Mono** or the configured terminal monospace for code and technical labels.

- Product name in prose: `Y Space`
- Compact wordmark: `YSpace`
- Never write `Y-Space`, `Yspace`, or `Y SPACE` as the product name.

## 5. Product language

Prefer concrete nouns and verbs: “Open tab,” “Connect account,” “Import cookies,” and “Run agent.” Avoid hype and vague claims.

Provider names such as Codex, Claude Code, and OpenCode are integrations, never part of the Y Space product name.

## 6. Asset regeneration

The vector masters in `branding/assets/` are the source of truth. Regenerate desktop, website, and PWA assets with:

```sh
node branding/assets/build-icons.mjs
```

Regenerate committed Capacitor assets with:

```sh
node branding/assets/build-native-assets.mjs
```

## 7. Compatibility boundaries

User-facing names, packaging product names, documentation, and artwork use Y Space. Existing application IDs, protocols, data directories, updater compatibility names, migrations, and selected internal symbols remain unchanged so existing installations continue to upgrade safely.
