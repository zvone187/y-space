# Popup frost pass criteria

## Product intent

Desktop popup menus must look like genuinely frosted material: the scene behind them is strongly diffused, warm color blooms remain visible through the material, the optical edge reads as glass, and popup text and controls stay crisp. The model search menu is the primary acceptance surface, while the implementation belongs to the shared responsive-menu primitive so the same material reaches project, branch, worktree, effort, add, option, and review menus.

## Required outcomes

- Opening **Select model** applies a dedicated `poracode-frosted-popover` material to the portaled desktop surface.
- Background words and edges behind the popup are no longer readable as sharp shapes through it.
- The popup uses at least 48px of backdrop blur and 185% saturation, plus a restrained three-bloom orange/neutral color field and fine grain.
- A non-interactive refractive rim and optical lens sit below the popup content; search, rows, scrolling, favorites, keyboard navigation, and dismissal remain usable.
- Foreground text and controls remain unfiltered and sharp.
- The implementation is bounded to one filtered compositor surface per open popup and is removed when the popup unmounts.
- macOS Reduce Transparency changes the same open popup to an opaque overlay with no blur, grain, or optical layers, and restoring the preference restores frost without relaunching.
- Embedded Browser guests, content planes, and individual workspace tabs remain unfiltered.

## Manual QA

1. Launch the exact packaged Y Space app with the literal `--use-mock-keychain` flag and keep one PID open throughout the test run.
2. Place the composer over visible text and colored controls, open **Select model**, and capture the same geometry before and after this revision.
3. Type in **Search models**, scroll, favorite a result, and select a model; confirm all interactions work and foreground content stays sharp.
4. Open at least two other responsive menus and confirm the same material language.
5. With the model picker open, enable and disable macOS Reduce Transparency; confirm the live opaque/frost transitions in the same process.
6. Open an embedded Browser peer and confirm web content remains pixel-sharp outside the popup.

## Automated verification

- Fail-first popup material contract suite.
- Existing frosted-glass boundary and accessibility suites.
- Typecheck, lint, formatting, focused renderer tests, and complete Vitest suite.
- Production desktop build and unsigned ARM64 package verification.
