/** Exact standard-library owners, not guesses based on a class's spelling. */
const headerSymbols: Record<string, readonly string[]> = {
  thread: ['thread', 'jthread', 'this_thread'],
  mutex: ['mutex', 'recursive_mutex', 'timed_mutex', 'recursive_timed_mutex', 'lock_guard', 'unique_lock', 'scoped_lock', 'once_flag', 'call_once', 'lock', 'try_lock', 'defer_lock', 'try_to_lock', 'adopt_lock'],
  shared_mutex: ['shared_mutex', 'shared_timed_mutex', 'shared_lock'],
  condition_variable: ['condition_variable', 'condition_variable_any', 'cv_status', 'notify_all_at_thread_exit'],
  atomic: ['atomic', 'atomic_flag', 'atomic_ref', 'memory_order', 'memory_order_relaxed', 'memory_order_acquire', 'memory_order_release', 'memory_order_acq_rel', 'memory_order_seq_cst'],
  future: ['future', 'shared_future', 'promise', 'packaged_task', 'async', 'launch', 'future_status'],
  chrono: ['chrono'],
  vector: ['vector'],
  array: ['array', 'to_array'],
  deque: ['deque'],
  list: ['list'],
  forward_list: ['forward_list'],
  map: ['map', 'multimap'],
  set: ['set', 'multiset'],
  unordered_map: ['unordered_map', 'unordered_multimap'],
  unordered_set: ['unordered_set', 'unordered_multiset'],
  stack: ['stack'],
  queue: ['queue', 'priority_queue'],
  string: ['string', 'wstring', 'u8string', 'u16string', 'u32string', 'basic_string', 'to_string', 'to_wstring', 'stoi', 'stol', 'stoll', 'stof', 'stod', 'stold'],
  string_view: ['string_view', 'wstring_view', 'u8string_view', 'u16string_view', 'u32string_view', 'basic_string_view'],
  iostream: ['cout', 'cin', 'cerr', 'clog', 'wcout', 'wcin', 'wcerr', 'wclog'],
  ostream: ['ostream', 'wostream', 'endl', 'flush'],
  istream: ['istream', 'wistream'],
  fstream: ['ifstream', 'ofstream', 'fstream', 'wifstream', 'wofstream', 'wfstream'],
  sstream: ['istringstream', 'ostringstream', 'stringstream', 'wistringstream', 'wostringstream', 'wstringstream'],
  iomanip: ['setw', 'setprecision', 'setfill', 'setbase', 'setiosflags', 'resetiosflags', 'quoted'],
  memory: ['unique_ptr', 'shared_ptr', 'weak_ptr', 'make_unique', 'make_shared', 'allocate_shared', 'enable_shared_from_this', 'allocator', 'default_delete'],
  utility: ['move', 'forward', 'swap', 'pair', 'make_pair', 'exchange', 'as_const', 'declval'],
  tuple: ['tuple', 'make_tuple', 'tie', 'tuple_cat', 'apply', 'make_from_tuple'],
  optional: ['optional', 'nullopt', 'nullopt_t', 'make_optional', 'bad_optional_access'],
  variant: ['variant', 'monostate', 'visit', 'holds_alternative', 'get_if', 'bad_variant_access'],
  any: ['any', 'any_cast', 'make_any', 'bad_any_cast'],
  span: ['span', 'dynamic_extent', 'as_bytes', 'as_writable_bytes'],
  functional: ['function', 'bind', 'bind_front', 'ref', 'cref', 'reference_wrapper', 'invoke', 'mem_fn', 'hash'],
  algorithm: ['sort', 'stable_sort', 'find', 'find_if', 'find_if_not', 'count', 'count_if', 'all_of', 'any_of', 'none_of', 'copy', 'copy_if', 'transform', 'reverse', 'rotate', 'lower_bound', 'upper_bound', 'binary_search', 'min', 'max', 'minmax', 'clamp', 'min_element', 'max_element', 'for_each', 'fill'],
  numeric: ['accumulate', 'iota', 'inner_product', 'partial_sum', 'reduce', 'gcd', 'lcm', 'midpoint'],
  iterator: ['begin', 'end', 'cbegin', 'cend', 'rbegin', 'rend', 'size', 'empty', 'data', 'distance', 'advance', 'next', 'prev', 'back_inserter', 'front_inserter', 'inserter'],
  limits: ['numeric_limits'],
  type_traits: ['is_same', 'is_same_v', 'enable_if', 'enable_if_t', 'decay', 'decay_t', 'remove_reference', 'remove_reference_t', 'is_integral', 'is_integral_v', 'is_pointer', 'is_pointer_v'],
  stdexcept: ['runtime_error', 'logic_error', 'invalid_argument', 'out_of_range', 'length_error', 'domain_error', 'overflow_error', 'underflow_error'],
  exception: ['exception', 'exception_ptr', 'current_exception', 'rethrow_exception', 'make_exception_ptr', 'terminate'],
  filesystem: ['filesystem'],
  random: ['random_device', 'mt19937', 'mt19937_64', 'default_random_engine', 'uniform_int_distribution', 'uniform_real_distribution', 'normal_distribution', 'bernoulli_distribution'],
  regex: ['regex', 'wregex', 'smatch', 'cmatch', 'regex_match', 'regex_search', 'regex_replace', 'sregex_iterator'],
  format: ['format', 'format_to', 'vformat', 'format_error', 'make_format_args'],
  print: ['print', 'println'],
  numbers: ['numbers'],
  semaphore: ['counting_semaphore', 'binary_semaphore'],
  latch: ['latch'],
  barrier: ['barrier'],
  stop_token: ['stop_token', 'stop_source', 'stop_callback'],
  expected: ['expected', 'unexpected', 'bad_expected_access']
}

const symbolHeaders = new Map(Object.entries(headerSymbols).flatMap(([header, symbols]) => symbols.map((symbol) => [symbol, header] as const)))

export interface CppChangedRange { start: number; end: number }
export interface CppIncludeEdit { offset: number; text: string; headers: string[] }

// Preserve UTF-16 offsets and newlines, including in unfinished literals while
// typing. A single lexical pass avoids treating // inside a string as a comment.
function maskNonCode(source: string, hideStrings = true): string {
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

/** Only symbols actually touched by an insertion/replacement trigger edits. */
export function cppHeadersForChanges(source: string, changes: readonly CppChangedRange[]): string[] {
  const headers = new Set<string>()
  const code = maskNonCode(source)
  for (const match of code.matchAll(/\bstd\s*::\s*([A-Za-z_]\w*)\b/g)) {
    const start = match.index!
    const end = start + match[0].length
    const header = symbolHeaders.get(match[1])
    if (header && changes.some((change) => change.start < end && change.end > start)) headers.add(header)
  }
  return [...headers].sort()
}

interface SourceLine { start: number; end: number; code: string; directive: string }

function conditionalEnd(lines: readonly SourceLine[], start: number): { end: number; hasBranch: boolean } | null {
  let depth = 0
  let hasBranch = false
  for (let line = start; line < lines.length; line++) {
    if (/^#\s*(?:if|ifdef|ifndef)\b/.test(lines[line].code)) depth++
    else if (/^#\s*endif\b/.test(lines[line].code) && --depth === 0) return { end: line, hasBranch }
    else if (depth === 1 && /^#\s*(?:else|elif)\b/.test(lines[line].code)) hasBranch = true
  }
  return null
}

/** Plan one insertion; never rewrite/reorder the user's existing headers. */
export function planCppAutoIncludes(source: string, requestedHeaders: readonly string[]): CppIncludeEdit | null {
  const required = new Set(cppHeadersForChanges(source, [{ start: 0, end: source.length }]))
  const code = maskNonCode(source)
  if (/^\s*(?:export\s+)?module(?:\s|;|:)/m.test(code)) return null
  const commentsMasked = maskNonCode(source, false)
  const lines: SourceLine[] = []
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0
  while (offset < source.length) {
    let newline = source.indexOf('\n', offset)
    let end = newline < 0 ? source.length : newline + 1
    while (newline >= 0 && source[newline - (source[newline - 1] === '\r' ? 2 : 1)] === '\\') {
      newline = source.indexOf('\n', end)
      end = newline < 0 ? source.length : newline + 1
    }
    lines.push({ start: offset, end, code: code.slice(offset, end).replace(/\\\r?\n/g, '').trim(), directive: commentsMasked.slice(offset, end).replace(/\\\r?\n/g, '').trim() })
    offset = end
  }
  let first = 0
  while (first < lines.length && !lines[first].code) first++
  if (/^#\s*pragma\s+once\b/.test(lines[first]?.code ?? '')) {
    first++
    while (first < lines.length && !lines[first].code) first++
  }
  let guardDepth = 0
  const guard = /^#\s*ifndef\s+(\w+)\s*$/.exec(lines[first]?.code ?? '')
  if (guard) {
    let define = first + 1
    while (define < lines.length && !lines[define].code) define++
    const closing = conditionalEnd(lines, first)
    const coversFile = closing && !closing.hasBranch && lines.slice(closing.end + 1).every((line) => !line.code)
    if (coversFile && lines[define]?.code.match(/^#\s*define\s+(\w+)\s*$/)?.[1] === guard[1]) {
      first = define + 1
      guardDepth = 1
      while (first < lines.length && !lines[first].code) first++
    }
  }
  const existing = new Set<string>()
  let depth = guardDepth
  for (const line of lines.slice(first)) {
    if (/^#\s*(?:if|ifdef|ifndef)\b/.test(line.code)) depth++
    else if (/^#\s*endif\b/.test(line.code)) depth--
    else if (depth === guardDepth && /^#\s*include\b/.test(line.code)) {
      const include = /^#\s*include\s*[<"]([^>"\r\n]+)[>"]/.exec(line.directive)
      if (include) existing.add(include[1])
    }
  }
  const headers = [...new Set(requestedHeaders)].filter((header) => required.has(header) && !existing.has(header)).sort()
  if (!headers.length) return null
  let insertion = lines[first]?.start ?? source.length
  let hasInclude = false
  for (let line = first; line < lines.length; line++) {
    if (!lines[line].code) continue
    if (!hasInclude && /^#\s*(?:define|undef)\b/.test(lines[line].code)) {
      insertion = lines[line].end
      continue
    }
    if (!hasInclude && /^#\s*(?:if|ifdef|ifndef)\b/.test(lines[line].code)) {
      const closing = conditionalEnd(lines, line)
      if (closing && lines.slice(line + 1, closing.end).every((inner) => !inner.code || /^#\s*(?:define|undef|if|ifdef|ifndef|else|elif|endif)\b/.test(inner.code))) {
        insertion = lines[closing.end].end
        line = closing.end
        continue
      }
    }
    if (!/^#\s*include\b/.test(lines[line].code)) break
    insertion = lines[line].end
    hasInclude = true
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const prefix = insertion > 0 && source[insertion - 1] !== '\n' && source.charCodeAt(insertion - 1) !== 0xfeff ? eol : ''
  const suffix = !hasInclude && insertion < source.length && source[insertion] !== '\r' && source[insertion] !== '\n' ? eol : ''
  return { offset: insertion, text: prefix + headers.map((header) => `#include <${header}>${eol}`).join('') + suffix, headers }
}
