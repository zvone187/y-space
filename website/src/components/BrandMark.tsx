/**
 * Y Space brand marks for the marketing site.
 *
 * - `YSpaceGlyph` — the geometric Y + orbit dot (inherits currentColor;
 *                   the dot stays indigo). Master: branding/assets/poracode-glyph.svg.
 * - `YSpaceIconTile` — the glyph on the dark brand tile (the app-icon lockup).
 * - `BrandWordmark` — the `Y Space` logotype.
 */

export function YSpaceGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true">
      <path fill="currentColor" d="M302 286H442L512 410L582 286H722L576 536V738H448V536L302 286Z" />
      <circle cx="690" cy="690" r="42" fill="#8B7BFF" />
    </svg>
  );
}

export function YSpaceIconTile({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[26%] bg-tile ring-1 ring-white/10 ${
        className ?? ""
      }`}
    >
      <YSpaceGlyph className="h-[62%] w-[62%] text-moon [filter:drop-shadow(0_0_8px_rgba(139,123,255,0.35))]" />
    </span>
  );
}

export function BrandWordmark({
  className,
  pulse = false,
}: {
  className?: string;
  pulse?: boolean;
}) {
  return (
    <span
      role="img"
      className={`inline-flex items-baseline ${className ?? ""}`}
      aria-label="Y Space"
    >
      <span
        className={`relative font-bold tracking-[-0.02em] text-moon ${pulse ? "pora-pulse" : ""}`}
        aria-hidden="true"
      >
        Y
        <span className="absolute -right-[0.13em] bottom-[0.08em] h-[0.13em] w-[0.13em] rounded-full bg-accent [filter:drop-shadow(0_0_6px_rgba(139,123,255,0.6))]" />
      </span>
      <span className="font-semibold tracking-[-0.02em] text-moon" aria-hidden="true">
        Space
      </span>
    </span>
  );
}

/** Icon tile + wordmark, the standard horizontal lockup. */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <YSpaceIconTile className="h-8 w-8" />
      <BrandWordmark className="text-xl" />
    </span>
  );
}

/**
 * The lowercase Geist-Mono technical lockup `y.space` — the page's recurring
 * signature. Its dot uses the brand accent.
 */
export function MonoLockup({ className }: { className?: string }) {
  return (
    <span
      role="img"
      className={`inline-flex items-baseline font-mono ${className ?? ""}`}
      aria-label="y.space"
    >
      <span aria-hidden="true" className="text-dim">
        y
      </span>
      <svg
        viewBox="0 0 24 100"
        aria-hidden="true"
        className="mx-[0.05em] inline-block h-[1em] w-[0.26em] overflow-visible align-baseline [filter:drop-shadow(0_0_5px_rgba(139,123,255,0.6))]"
      >
        <circle cx="12" cy="92" r="9.5" fill="#8B7BFF" />
      </svg>
      <span aria-hidden="true" className="text-dim">
        space
      </span>
    </span>
  );
}

/**
 * The headline full-stop rendered as the live indigo Y Space dot — the page's
 * signature gesture ("it's time."). Replaces a text gradient as the only accent.
 */
export function DotPeriod({ pulse = true }: { pulse?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 100"
      aria-hidden="true"
      className={`ml-[0.04em] inline-block h-[0.7em] w-[0.34em] overflow-visible align-baseline [filter:drop-shadow(0_0_8px_rgba(139,123,255,0.55))] ${
        pulse ? "pora-pulse" : ""
      }`}
    >
      <circle cx="12" cy="88" r="11" fill="#8B7BFF" />
    </svg>
  );
}
