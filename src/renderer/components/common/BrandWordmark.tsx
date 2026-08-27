/** The compact Y Space wordmark used across desktop and first-run surfaces. */
export function BrandWordmark({ className }: { className?: string | undefined }) {
  return (
    <span className={className} aria-label="Y Space">
      <span className="font-semibold tracking-[-0.055em]" aria-hidden="true">
        Y
      </span>
      <span className="ml-[0.22em] font-medium tracking-[-0.035em]" aria-hidden="true">
        Space
      </span>
    </span>
  );
}
