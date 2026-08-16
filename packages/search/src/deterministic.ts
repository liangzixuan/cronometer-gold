/** Locale-independent UTF-16 ordering for stable rebuilds, ranking, and cursor state. */
export function compareDeterministicText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
