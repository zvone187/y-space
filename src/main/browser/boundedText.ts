/** Return a prefix that is no larger than maxBytes when encoded as UTF-8.
 * Iterating by code point prevents a truncated surrogate pair or multibyte
 * replacement character from exceeding the requested byte budget. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  let bytes = 0;
  let codeUnits = 0;
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    codeUnits += codePoint.length;
  }
  return value.slice(0, codeUnits);
}

export function utf8ByteLength(...values: Array<string | undefined>): number {
  return values.reduce((total, value) => total + Buffer.byteLength(value ?? "", "utf8"), 0);
}
