# Themes (Cortex Dark and Light)

Cortex has Dark and Light themes with a shared navy/amber/moss identity and
restrained signature gradient. Dark uses a deep navy base rather than pure black;
Light uses light surfaces and darker semantic foregrounds. Changing the theme
updates both application chrome and Monaco and persists the preference.

The chrome palettes live in `src/renderer/src/styles/index.css` (`:root` and
`:root[data-theme='light']`). `tailwind.config.js` exposes those RGB variables
under `theme.extend.colors.ide`, including alpha-aware tokens. Monaco defines
`cortex-dark` and `cortex-light` in `src/renderer/src/components/CodeEditor.tsx`.
Keep the corresponding semantic values in sync rather than hardcoding dark
colors into theme-aware components.

## Dark base tokens

| Token | Hex | Use |
|---|---|---|
| `ide.bg` | `#0C1017` | editor background (elevation 0) |
| `ide.panel` | `#11161F` | side panels, tab bar (elevation 1) |
| `ide.bar` | `#171D28` | toolbars, activity bar, popovers (elevation 2) |
| `ide.border` | `#232B38` | borders, dividers |
| `ide.hover` | `#1B2230` | hover states |
| `ide.active` | `#1E3A5F` | selection (navy) |
| `ide.accent` | `#2E6FE0` | dominant chrome accent (buttons, focus) |
| `ide.text` | `#E6EBF4` | primary text |
| `ide.muted` | `#98A3B6` | secondary text |
| `ide.faint` | `#7D8899` | tertiary / placeholder text |

## Light base tokens

| Token | Hex | Use |
|---|---|---|
| `ide.bg` | `#F5F6F8` | editor/workspace background |
| `ide.panel` | `#FFFFFF` | side panels, tab bar |
| `ide.bar` | `#ECEFF3` | toolbars and popovers |
| `ide.accent` | `#1D5AD1` | chrome accent and focus |
| `ide.text` | `#1A2233` | primary text |
| `ide.muted` | `#566173` | secondary text |
| `ide.faint` | `#60697A` | tertiary / placeholder text |

## Dark identity hues and shared gradient

| Token | Hex |
|---|---|
| `ide.navy` | `#2E6FE0` |
| `ide.amber` | `#E8952B` |
| `ide.moss` | `#6FB65A` |

Signature gradient: `linear-gradient(115deg, #2E6FE0 0%, #E8952B 55%, #6FB65A 100%)`
(Tailwind: `bg-cortex-gradient`, vertical variant `bg-cortex-gradient-v`).
The gradient remains the shared brand treatment; semantic foreground hues use
darker light-theme equivalents where needed for contrast.

Reserve the gradient for one expressive moment per surface: the logo mark, the activity-bar active
rail, the status-bar build/flash progress line, and focus glow. Never loop it in the idle work area.
Respect `prefers-reduced-motion`.

## Syntax tokens (Monaco cortex-dark)

| Token | Hex | Note |
|---|---|---|
| keyword | `#E8952B` | amber, Arduino warmth / register feel |
| number | `#E8B44A` | amber-gold |
| string | `#8FBF6B` | moss |
| type | `#4FB8A8` | teal-moss |
| function | `#5B9DF0` | navy, a shade lighter than chrome accent |
| comment | `#7D8899` | faint, italic |
| macro / `#define` / register | `#C58BE6` | violet |

Monaco's bundled C++ grammar does not identify library class names on its own.
For headers covered by `src/shared/stdlib/cpp-libraries.json`, Cortex marks
their class names in live C++ code with `ide.amber` (orange), using a
header-gated decoration. It does not color matches inside comments, strings,
unrelated projects or foreign qualified symbols. Add new classes to the
library dictionary rather than a hardcoded color-name list.

`test/contrast.test.ts` checks designated chrome text/graphics, white accent-button
labels and supported tinted status surfaces in both themes. This is evidence for
those pairs, not a complete WCAG audit or a check of every syntax token. Preserve
the tested foreground/background contracts when changing a token.

See [`STYLE.md`](STYLE.md) for the copy and visual-language rules (including: no em dashes).
