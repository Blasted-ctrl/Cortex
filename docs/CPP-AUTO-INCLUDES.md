# Automatic C++ includes

Cortex adds missing standard-library headers while you type, paste, or accept a
completion in a C++ file. No command or popup is required. For example, typing
`std::mutex my_mut;` near the bottom of a file adds `#include <mutex>` beside
the existing includes at the top.

## Try it

Open a `.cpp` file, start with `#include <iostream>`, and type or paste:

```cpp
int main() {
  std::mutex my_mut;
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
}
```

When pasted together, after a short typing pause (300 ms), the include block becomes:

```cpp
#include <iostream>
#include <chrono>
#include <mutex>
#include <thread>
```

Headers added together are sorted; existing headers are never reordered. The
caret stays beside your code, including with multiple cursors, and the viewport
stays anchored when the insertion is above it. Save, Save All and workflows
that save before running, debugging or uploading apply any pending include
edit first, whether invoked by shortcut, menu or toolbar. Generated includes are ordinary buffer
edits: they mark the tab dirty, reach diagnostics, and participate in Undo/Redo.
Removing or undoing a generated include does not immediately reinsert it.
Typing that symbol again can add it again. Merely opening a file does not
rewrite it.

`std::this_thread` is a namespace, not a type. Use a function such as
`std::this_thread::sleep_for(...)`; `std::this_thread myt;` is still invalid
C++. The [C++ draft's thread synopsis](https://eel.is/c++draft/thread.syn) and
[mutex synopsis](https://eel.is/c++draft/mutex.syn) show their owning headers.

## Supported symbols

Local detection uses an explicit owner map, works without clangd, and recognizes
qualified names such as these:

| Examples | Added header |
|---|---|
| `std::thread`, `std::jthread`, `std::this_thread` | `<thread>` |
| `std::mutex`, `std::lock_guard`, `std::unique_lock`, `std::scoped_lock` | `<mutex>` |
| `std::shared_mutex`, `std::shared_lock` | `<shared_mutex>` |
| `std::condition_variable`, `std::condition_variable_any` | `<condition_variable>` |
| `std::atomic`, `std::atomic_flag`, `std::atomic_ref` | `<atomic>` |
| `std::future`, `std::promise`, `std::async` | `<future>` |
| `std::chrono::milliseconds`, `std::chrono::steady_clock` | `<chrono>` |
| `std::vector`, `std::array`, `std::map`, `std::set`, `std::unordered_map` | Corresponding container header |
| `std::string`, `std::string_view` | `<string>`, `<string_view>` |
| `std::cout`, `std::cin`, `std::cerr` | `<iostream>` |
| `std::ifstream`, `std::ofstream`, `std::stringstream`, `std::setw` | `<fstream>`, `<sstream>`, `<iomanip>` |
| `std::unique_ptr`, `std::shared_ptr`, `std::make_unique`, `std::make_shared` | `<memory>` |
| `std::move`, `std::forward`, `std::pair` | `<utility>` |
| `std::tuple`, `std::optional`, `std::variant`, `std::any`, `std::span` | Corresponding utility header |
| `std::function`, `std::bind`, `std::ref` | `<functional>` |
| `std::sort`, `std::find`, `std::clamp` | `<algorithm>` |
| `std::accumulate`, `std::iota`, `std::gcd` | `<numeric>` |
| `std::begin`, `std::distance`, `std::back_inserter` | `<iterator>` |
| `std::numeric_limits`, `std::is_same_v` | `<limits>`, `<type_traits>` |
| `std::runtime_error`, `std::exception_ptr` | `<stdexcept>`, `<exception>` |
| `std::filesystem::path`, `std::mt19937`, `std::regex` | `<filesystem>`, `<random>`, `<regex>` |
| `std::format`, `std::println`, `std::numbers::pi` | `<format>`, `<print>`, `<numbers>` |
| `std::stop_token`, `std::latch`, `std::barrier`, `std::counting_semaphore` | Corresponding concurrency header |
| `std::expected`, `std::unexpected` | `<expected>` |

The exact map is in `src/shared/cppAutoInclude.ts`. clangd completions also
forward server-provided include edits, both immediately and when a completion
is resolved. This supports project and third-party headers when clangd can
identify them; Cortex does not guess arbitrary library names or install them.

## Safety and limitations

- Only C++ models are changed, including C++ headers and sketches; C files and
  other languages are not changed.
- Comments, ordinary strings, character literals, raw strings and unfinished
  literals do not trigger includes. Only a newly edited qualified symbol
  triggers detection, not every existing missing include in the file.
- Existing exact includes are reused, with either quoted or angle-bracket
  spelling. A custom path such as `custom/mutex` is not `<mutex>`.
- Leading license comments, a BOM, `#pragma once`, full-file `#ifndef`/`#define`
  header guards, configuration macros, continued directives/comments, and CRLF
  line endings are preserved. A conditional include
  does not suppress a needed unconditional include.
- This is lexical assistance, not a C++ parser or preprocessor. It does not
  evaluate conditional compilation, expand macros, infer names after
  `using namespace std`, resolve aliases, or infer ambiguous overload owners.
  C++ module units are left unchanged by the local insertion planner.
- Adding a header does not change the selected C++ standard, supply unsupported
  compiler facilities, enable embedded threading support, or fix invalid code.
  Build diagnostics remain authoritative.

## Verification

```bash
npx vitest run test/cppAutoInclude.test.ts test/cppAutoIncludePlacement.test.ts test/cppAutoIncludeEditor.test.ts test/lspCompletionEdits.test.ts
```

The tests cover symbol detection, safe placement, duplicate prevention,
non-code text, editor lifecycle and undo handling, and clangd completion edits.
