# Writing & UI style

## Copy rules
- **No em dashes.** Do not use the long dash character anywhere in product copy, docs, code
  comments, or UI strings. Use a comma, a period, or parentheses instead. If a dash is truly needed,
  use a short hyphen with spaces around it.
- **ASCII punctuation only.** No en dashes (write "C++11 to C++23", not a dash range) and no
  unicode ellipsis: three dots. Mixing both ellipsis forms in one UI is the visible failure.
- Prefer short, direct sentences. Avoid filler.
- Sentence case for buttons, labels, and headings (not Title Case).
- Use the exact product terms: Cortex, Simulator, Serial Monitor, Problems, Toolchains.

## Visual language (JetBrains + Arduino, low-level embedded)
Cortex should feel like Arduino IDE and CLion had a baby: approachable and friendly, but with the
depth and polish of a JetBrains IDE.

- **Dark, embedded vibe.** Deep navy/charcoal base, not pure black.
- **Multi-gradient accent system** in the spirit of JetBrains product themes (PyCharm uses a
  green/teal/yellow flow; CLion uses a red/purple/blue flow). Cortex uses a warm-to-cool embedded
  flow: moss green, amber/orange, and navy blue, applied consistently across the activity bar,
  status bar, focus rings, and hero surfaces.
- **Consistency first.** One accent gradient, reused. Do not introduce one-off colors per screen.
- Rounded corners, soft shadows, subtle motion (Anime.js / spring transitions). Motion should be
  quick and purposeful, never decorative-only.
- Respect `prefers-reduced-motion`.

The concrete palette and gradient tokens live in `tailwind.config.js` under the `ide` color scale
and are documented in [`THEME.md`](THEME.md).

## Bars must degrade, never disappear
Every horizontal bar (title bar, tab strip, toolbar) is eventually starved: the window shrinks, or
the sidebar and AI panel take their share. Three rules, learned from three real bugs found by
screenshotting the app at 1000x680 with every panel open:

1. **Labels yield, controls survive.** Give text `min-w-0 truncate` and control groups `shrink-0`.
   The simulator toolbar had this backwards: the filename was `shrink-0`, so it held its full width
   and pushed "Save layout" off the bar, where it was clipped rather than wrapped. The only way to
   save a circuit silently vanished.
2. **Never let a bar wrap.** Use `whitespace-nowrap` on its controls. Without it "Serial Monitor"
   wrapped to two lines and broke the fixed bar height.
3. **Scrolling is not an affordance.** A strip with a hidden scrollbar hides a control with nothing
   to say it is there. Use the `cq` / `cq-label` container-query pair (see `styles/index.css`): the
   bar sizes to its own container, and below the threshold labels drop so the icons carry the
   controls. Anything with a `cq-label` needs a `title` so the icon stays identifiable.

Panels size to their container, not the viewport, so a viewport media query is the wrong tool here.

## Enforcement
The punctuation rules above are enforced by `test/style.test.ts`, which scans
repository source/text files, including examples and plans. It excludes dependency
and build output, Git/editor metadata and `package-lock.json`; failures identify
the offending file and line. They are enforced because they drifted back
twice by hand: an em dash reached a UI string as a "no pin" placeholder, and the unicode ellipsis
spread to seven call sites while the rest of the app used three dots.
