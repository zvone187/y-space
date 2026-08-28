/** "Y Space on host" → "host"; brand prefixes are noise inside the app.
 *  Legacy Poracode and Lightcode labels are stripped too. */
export function desktopTitle(label: string): string {
  const stripped = label.replace(/^(?:Y Space|Poracode|Lightcode)\s+on\s+/i, "");
  return stripped || label;
}
