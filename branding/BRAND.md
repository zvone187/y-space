# Y Space — Brand Guide

> Status: implementation brand · Updated 2026-08-28 · Supersedes the Lightcode and Poracode product surfaces.

## 1. At a glance

- **Product name:** **Y Space**
- **Spoken name:** “why space”
- **Descriptor:** A local desktop workspace for running coding agents with shared browser and app capabilities.
- **Voice:** calm, precise, direct, and builder-oriented.

Y Space should feel calm, native, and approachable: a white canvas, warm-neutral surfaces, compact controls, excellent keyboard support, and one warm accent used sparingly.

## 2. Logo and icon

The mark is a bold geometric **Y** with a single orbit dot. The Y represents the product initial and a branching agent workflow; the dot provides a small spatial motif and channel accent.

| Variant            | Internal source file        | Use                                     |
| ------------------ | --------------------------- | --------------------------------------- |
| Primary white tile | `poracode-icon.svg`         | Stable app icon and default product art |
| White tile alias   | `poracode-icon-light.svg`   | Compatibility source for light contexts |
| Glyph only         | `poracode-glyph.svg`        | In-app and monochrome contexts          |
| Nightly            | `poracode-icon-nightly.svg` | Nightly builds installed beside stable  |
| Wordmark           | `poracode-wordmark.svg`     | Marketing and wide lockups              |

The historical filenames are intentionally retained as internal packaging compatibility boundaries. They are not user-facing product names.

### Rules

- Keep clearspace at least the diameter of the orbit dot.
- Preserve the Y geometry and the dot’s relative position.
- Do not add shadows, bevels, or extra planets/dots.
- Do not place provider trademarks in the product mark.

## 3. Color

| Token       | Hex       | Role                                  |
| ----------- | --------- | ------------------------------------- |
| Canvas      | `#FFFFFF` | Main canvas and stable icon tile      |
| Surface     | `#FBFBFA` | Sidebar and quiet raised surfaces     |
| Ink         | `#181816` | Primary text and Y glyph              |
| Dim         | `#73716C` | Secondary text                        |
| Hairline    | `#EEEDE9` | Borders and separators                |
| Orange      | `#FF5A1F` | Focus, primary actions, and orbit dot |
| Orange lift | `#FF9B73` | Dark-mode accent                      |
| Ice         | `#5EE6E0` | Nightly channel accent                |

The UI is white-first and intentionally restrained. Orange indicates focus or a primary action; it is not a panel background. Bright-orange fills use ink-colored labels for readable contrast. Explicit dark mode remains supported and uses the lifted orange accent.

## 4. Typography

Use the native platform sans stack for product UI and headings: San Francisco on Apple platforms, Segoe UI on Windows, then `system-ui`. This keeps the product quiet and familiar instead of reading like a code editor. Use **Geist Mono** or the configured terminal monospace only for code, commands, paths, IDs, diffs, and terminals.

Pale surfaces never reduce semantic contrast: readable secondary text and placeholders stay at 4.5:1, enabled control boundaries and focus indicators stay at 3:1, and text-bearing glass keeps a contrast-safe theme scrim over the system material.

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

The generator stages canonical renders under `branding/assets/out/` and also
synchronizes the committed production copies in `build/`, `public/icons/`, and
`website/public/`. A successful run therefore leaves those destinations
byte-identical to their corresponding staged files.

Regenerate committed Capacitor assets with:

```sh
node branding/assets/build-native-assets.mjs
```

Regenerate committed social artwork with:

```sh
node branding/assets/build-social-assets.mjs
```

## 7. Compatibility boundaries

User-facing names, packaging product names, documentation, and artwork use Y Space. Existing application IDs, protocols, data directories, updater compatibility names, migrations, and selected internal symbols remain unchanged so existing installations continue to upgrade safely.
