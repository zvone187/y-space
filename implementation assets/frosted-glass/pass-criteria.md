# Y Space frosted-glass revision — pass criteria

Status: implemented and verified on `y-space-frosted-glass` from `153af142`.

Final result: FG-01 through FG-11, FG-13, and FG-14 passed. FG-12 remains
explicitly inconclusive for long-horizon RSS trend: the earlier eight-tab live
cycle returned from six Browser guests to one, but its single post-cleanup RSS
sample was 20.5% above the warm baseline. No memory-leak absence is claimed.

## Material and hierarchy

- **FG-01 — Passed — Genuine native sidebar frost:** macOS uses Electron/AppKit vibrancy and Windows 11 uses acrylic only when frosting is enabled and the OS does not request reduced transparency. The visible sidebar tint allows clearly perceptible color diffusion instead of covering the native material with an 82–94% opaque scrim.
- **FG-02 — Passed — Bounded renderer frost:** the global workspace rail, composer, Connections surface, menus, popovers, and compact floating chrome use a material recipe with at least 28px blur and 160% saturation for full-size stable chrome, or at least 10px/130% for compact controls.
- **FG-03 — Passed — Honest pane chrome:** thread and Browser toolbars share the same milky tint, grain, edge light, and depth language but do not add per-pane filtered compositor surfaces or claim to blur live `<webview>` pixels.
- **FG-04 — Passed — Optical edge language:** shared glass has separate, noninteractive rim and lens layers with inherited curvature, subtle bright/dark edge concentration, and restrained warm reflection. It must read as frost, not a full-surface white gloss.
- **FG-05 — Passed — Content remains primary:** transcript, files, PDFs, spreadsheets, terminal, Browser content planes, browser guests, individual tabs, rows, and per-page hosts remain crisp and unfiltered.

## Native behavior and accessibility

- **FG-06 — Passed — Reliable macOS window:** macOS vibrancy uses `visualEffectState: "followWindow"` without Electron's fragile `transparent: true` window mode. Native window shadow, resizing, full-screen, and DevTools behavior remain normal.
- **FG-07 — Passed — Live material decision:** a pure platform/build/request/reduced-transparency decision covers macOS, Windows 11 22H2+, older Windows, and Linux. Runtime enable/disable applies or removes vibrancy/acrylic and reports whether native material is actually active.
- **FG-08 — Passed — Reduced transparency:** the OS preference disables native and CSS blur, hides lens/rim pseudo-elements, and paints opaque theme-safe surfaces without relaunch. Theme and appearance changes cannot reactivate blur while the preference remains set.
- **FG-09 — Passed — Contrast:** light and dark variants keep normal and muted text legible, focus rings/control boundaries visible, and the orange accent intentional over the least-opaque permitted material.
- **FG-10 — Passed — Interaction safety:** glass layers use `pointer-events: none`, never alter layout or focus order, and do not block tab selection, composer input, menus, Browser controls, drag regions, or resizing.

## Performance and regression

- **FG-11 — Passed — Bounded filters:** there is at most one filtered host per stable chrome region; opening more Browser/global tabs does not create a filter per tab, row, guest, or content plane.
- **FG-12 — Inconclusive — Persistent-session stability:** repeated tab switching, resizing, menu use, theme changes, Browser navigation, and frosting toggles preserve guest/renderer bounds. A longer multi-cycle soak is still required to establish a memory-growth trend.
- **FG-13 — Passed — Existing behavior:** the full automated suite, typecheck, standard/type-aware lint, formatting, localization, packaging, deep/strict ad-hoc codesign, browser-agent controls, and Pipedream behavior remain green.
- **FG-14 — Passed — Test-launch invariant:** all packaged UI QA uses one isolated process launched with the literal `--use-mock-keychain`, keeps that process open between cases, and leaves it open for user testing. Ordinary releases never auto-enable the mock keychain.

## Required end-to-end evidence

- **YS-FROST-E2E-001:** side-by-side frosting proof over a deterministic striped/checkerboard background in light and dark mode, with frosting on/off captures showing measurable detail diffusion while text and content planes stay crisp.
- **YS-FROST-E2E-002:** live Reduce Transparency transition in the same app process, proving immediate opaque fallback and clean restoration without a translucent flash or relaunch.
- **YS-FROST-E2E-003:** long-session global-tab/Browser/composer/menu exercise with renderer/guest/filter counts sampled before peak, at peak, and after cleanup.

Evidence status on the exact reviewed package:

- **YS-FROST-E2E-001 — Core visual matrix passed:** matched light and dark translucency on/off, composer, and sharp embedded-Browser captures are recorded. The deterministic checkerboard/pixel-detail ledger was not run, so no numerical blur-strength claim is made.
- **YS-FROST-E2E-002 — Passed:** Appearance, composer, Connections, and menu states changed live to the opaque fallback and restored in PID 67151 without relaunch; macOS Reduce Transparency was restored to off.
- **YS-FROST-E2E-003 — Partial:** the bounded-filter and Browser guest contracts pass, but the earlier one-cycle RSS sample remains inconclusive and is not presented as proof that memory cannot leak.

The material implementation is complete and packaged. The remaining evidence work
is a quantitative blur fixture and a longer memory soak rather than more material
code.
