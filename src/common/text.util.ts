/**
 * Truncate a string to `max` characters, appending an ellipsis and never splitting
 * a surrogate pair (so emoji at the cut point are dropped rather than corrupted).
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let sliced = text.slice(0, max - 3);
  const last = sliced.charCodeAt(sliced.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    sliced = sliced.slice(0, -1);
  }
  return `${sliced}...`;
}
