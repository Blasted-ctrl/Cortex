// Preserve UTF-16 offsets and newlines, including in unfinished literals while
// typing. A single lexical pass avoids treating // inside a string as a comment.
export function maskCppNonCode(source: string, hideStrings = true): string {
  const pieces: string[] = []
  let plainStart = 0
  let i = 0
  const hide = (end: number): void => {
    pieces.push(source.slice(plainStart, i), source.slice(i, end).replace(/[^\r\n]/g, ' '))
    i = end
    plainStart = end
  }
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      let end = source.indexOf('\n', i + 2)
      while (end >= 0 && source[end - (source[end - 1] === '\r' ? 2 : 1)] === '\\') {
        end = source.indexOf('\n', end + 1)
      }
      hide(end < 0 ? source.length : end)
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      hide(end < 0 ? source.length : end + 2)
    } else if (source.startsWith('R"', i)) {
      const opening = /^R"([^\s()\\]{0,16})\(/.exec(source.slice(i, i + 20))
      if (!opening) { i++; continue }
      const close = `)${opening[1]}"`
      const end = source.indexOf(close, i + opening[0].length)
      const after = end < 0 ? source.length : end + close.length
      if (hideStrings) hide(after)
      else i = after
    } else if (source[i] === '"' || source[i] === "'") {
      // An apostrophe inside a numeric token is a C++ digit separator.
      if (source[i] === "'" && /[\da-fA-F]/.test(source[i - 1] ?? '') && /[\da-fA-F]/.test(source[i + 1] ?? '')) { i++; continue }
      const quote = source[i]
      let end = i + 1
      while (end < source.length && source[end] !== quote && source[end] !== '\n' && source[end] !== '\r') {
        if (source[end] === '\\') end += source[end + 1] === '\r' && source[end + 2] === '\n' ? 3 : 2
        else end++
      }
      if (source[end] === quote) end++
      if (hideStrings) hide(Math.min(end, source.length))
      else i = end
    } else i++
  }
  pieces.push(source.slice(plainStart))
  return pieces.join('')
}
