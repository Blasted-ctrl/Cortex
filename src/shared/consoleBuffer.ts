/** Keep a recent console tail bounded by text size as well as entry count.
 * UTF-16 code units are used here: 524288 units retain at most 1 MiB of text.
 * The marker makes display truncation explicit; it is not a test-report limit.
 */
export const CONSOLE_TEXT_LIMIT = 512 * 1024
export const OMITTED_OUTPUT = '[Earlier console output omitted]\n'

export function appendConsoleEntry<T extends { text: string }>(entries: readonly T[], entry: T, maxEntries: number): T[] {
  const source = [...entries, entry]
  const retained: T[] = []
  let remaining = CONSOLE_TEXT_LIMIT - OMITTED_OUTPUT.length
  let omitted = false
  for (let i = source.length - 1; i >= 0; i--) {
    if (retained.length >= maxEntries || remaining === 0) { omitted = true; break }
    const candidate = source[i]
    if (candidate.text.length > remaining) {
      let start = candidate.text.length - remaining
      // Do not cut a surrogate pair in half at the retained tail boundary.
      if (start > 0 && /[\uDC00-\uDFFF]/.test(candidate.text[start]) && /[\uD800-\uDBFF]/.test(candidate.text[start - 1])) start++
      retained.push({ ...candidate, text: candidate.text.slice(start) })
      omitted = true
      break
    }
    retained.push(candidate)
    remaining -= candidate.text.length
  }
  retained.reverse()
  if (omitted && retained.length) {
    const first = retained[0]
    const text = first.text.startsWith(OMITTED_OUTPUT) ? first.text.slice(OMITTED_OUTPUT.length) : first.text
    retained[0] = { ...first, text: OMITTED_OUTPUT + text }
  }
  return retained
}
