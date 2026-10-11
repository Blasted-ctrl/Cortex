---
status: ready
---

# Plan: Keyboard resizing for workbench and editor panels

## Context

The Markdown backlog identifies keyboard splitter resizing as the next local
navigation gap after More tools. Cortex has four pointer-operated separators:
sidebar, bottom panel, shared Agent/Datasheets dock and the editor's two panes.
Make these usable from the keyboard without adding instructional banners or
changing the compact embedded-IDE layout. Preserve existing pointer resizing,
panel visibility, saved preferences and editor selection/undo ownership.

This is one desktop user's local layout, not a multi-writer service. Existing
geometry owners already fit saved preferences to measured space; a displayed
dock can be smaller than its saved minimum or have no adjustable range. The
accessible values and keyboard endpoints must describe this displayed layout,
not blindly copy persisted limits. No dependencies, new persistence entities,
collapse state or global key listeners are needed. The user chose arrows and
Home/End with hiding left on the existing controls, not Enter-to-hide. Full
native acceptance is pending; the diagnostic below is not that desktop gate.

## Acceptance Criteria

- Each visible splitter is reachable by Tab, has visible keyboard focus, a
  distinct primary-pane name and a stable relationship to the actual controlled
  wrapper. Hidden editor/bottom surfaces add no visible Tab stops.
- A focused vertical splitter moves left/right with unmodified Left/Right;
  a horizontal splitter moves up/down with unmodified Up/Down. One ordinary key
  event requests a ten-CSS-pixel move through the existing geometry owner.
  Right/bottom pane sizes therefore decrease when their divider moves right/down.
- Home/End moves to the primary pane's current reachable minimum/maximum. Its
  announced current value and finite ordered limits use the same owner policy,
  contain the actual displayed extent and remain accurate after fitting, resizing,
  panel switches and each adjustment. Pixel and editor-percentage units are clear.
- Tiny or zero-size layouts have truthful equal endpoints when adjustment is
  impossible. Their focusable handle is marked disabled; keys do not rewrite
  preferences or create NaN/negative sizes. A later measurable layout recovers.
- Keyboard changes retain focus on the handle, do not select a sidebar/file,
  hide a panel, alter document content, or scroll the workbench. Modified keys,
  unrelated keys and the wrong axis are not intercepted. Tab/ShiftTab exits
  normally without a trap. Pointer capture/movement/cancel behavior stays intact.
- Automatic fitting still does not persist preferences. Deliberate changes use
  the existing rounded/clamped store setters; editor split ratio remains local.

## Pattern Survey

### Analogous Features

- `src/renderer/src/App.tsx:289` - Sidebar splitter: vertical separator, current extent `horizontalLayout.sidebarWidth`; positive pointer-X delta grows the sidebar. It exists only while the sidebar is visible.
- `src/renderer/src/App.tsx:307` - Bottom splitter: horizontal separator, current extent `panelLayout.height`; positive pointer-Y delta shrinks the bottom panel. It is mounted with the bottom panel inside the editor column, which remains mounted but hidden in Settings/Simulator.
- `src/renderer/src/App.tsx:321` - Right-dock splitter: vertical separator, current extent `horizontalLayout.rightWidth`; positive pointer-X delta shrinks the right dock. Agent and Datasheets share this one splitter and preference.
- `src/renderer/src/components/EditorArea.tsx:342` - Editor splitter: vertical separator, local left-pane ratio initially `0.5`, clamped to `0.2-0.8`; positive pointer-X delta grows the left pane by `delta / container.clientWidth`. No width means no adjustment. Unlike docks, its ratio is not persisted.
- `src/renderer/src/components/Splitter.tsx:20` - All four use one incremental pointer-delta component with pointer capture and cancellation cleanup. It already supplies `role="separator"` and axis-correct orientation, but has no keyboard handler, tab stop, value properties or controlled-pane relationship.
- `src/renderer/src/components/EditorArea.tsx:39` - Existing `useId`, labelled tab relationships and local modified-key guards provide reusable accessibility conventions without global keyboard interception.
- [W3C Window Splitter Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/) - Design-only reference: named primary pane, current/minimum/maximum values, controlled-pane relationship and axis-direction arrows. The pattern explicitly remains under review; this is not evidence of Cortex native behavior or full conformance.

### Reusable Utilities

- `src/renderer/src/store/useStore.ts:798` - `LAYOUT_LIMITS` - Persisted preferences are sidebar `180-560px`, right dock `260-620px`, bottom `120-640px`. Setters at `1572-1585` round, clamp and save to localStorage; these are **not necessarily rendered bounds**.
- `src/renderer/src/lib/useHorizontalPanelLayout.ts:25` - `useHorizontalPanelLayout` - Normalizes preferences, then fits both visible docks proportionally into `B = max(0, available - 16 - 17 * visibleDockCount - 320)`. Rendered widths are normalized preferences multiplied by `min(1, B / combinedPreference)`.
- `src/renderer/src/lib/useHorizontalPanelLayout.ts:42` - Existing adjustment ownership - Starts from actual dock rectangles. A single dock updates only its own preference; paired fitted docks redistribute their current total, while spare-space resizing clamps the selected preference. Sidebar-share limits are `180/800` and `560/820`, followed by paired rescaling into saved limits. Effective endpoints therefore belong here, not inside generic `Splitter`.
- `src/renderer/src/lib/useBottomPanelLayout.ts:8` - `fitPanel` - With `U = max(0, columnHeight - 17)`, reserves `min(120, max(0, U - 34))` for the editor and caps the panel to the remainder. A short column can render `34px` or `0px`, below the saved `120px` minimum.
- `src/renderer/src/lib/useBottomPanelLayout.ts:35` - `onDelta` - Uses actual rendered height minus pointer delta, preventing the saved-preference dead zone.
- `src/renderer/src/components/EditorArea.tsx:138` - `onSplitterDelta` - Owns percentage conversion and `20-80%` clamping. This existing ownership avoids forcing all callers into persisted pixels.
- `test/reactHost.ts:16` - `invoke` / `createHost` - Real React hooks, refs and controlled layout/focus observations are already available. Its explicit limitation is that it does not model native Tab navigation or a browser accessibility tree.

### Convention Anchors

- **Geometry stays with producers:** App consumes fitted hook values; SideBar, AiPanel, DatasheetsDock and BottomPanel apply those exact values to wrapper styles. Automatic fitting does not rewrite saved preferences.
- **Existing geometry regression coverage:** `test/horizontalPanelLayout.test.ts:124-305` covers visibility combinations, shared right-dock views, paired/single signed dragging, actual rectangles, extreme ratios, tiny zero-width fitting and observer cleanup. `test/bottomPanelLayout.test.ts:75-125` covers saved-versus-rendered heights, short columns, drag origins, hidden-view return and cleanup.
- **Editor coverage gap:** `test/editorAccessibility.test.ts:102` exercises split-pane tab focus, but no current editor test exercises splitter ratio adjustment or splitter keyboard behavior.
- **Focus styling gap:** `src/renderer/src/styles/index.css:146-152` gives focus rings to buttons/selects/inputs/textareas, not the splitter's `div`; making it focusable alone would not reuse that explicit ring.
- **Controlled-pane identity gap:** Dock wrappers currently lack stable IDs. EditorArea's existing IDs identify file tabs/panels, not the persistent left editor pane.
- **Tiny-layout invariant:** At zero horizontal budget both visible docks render zero and paired adjustment returns without writes. Bottom fitting similarly reaches zero. Accessible bounds must contain the actual rendered value, including equal endpoints where no adjustment is possible.

### Proposed Alignment

Keep clamping, persistence, sign conversion and fitted endpoints in the existing hooks/EditorArea; let `Splitter` remain the shared local input and semantics boundary. The smallest coherent contract is an axis, explicit pane name/ID, finite current/effective minimum/maximum values with units, and caller-owned delta/endpoint adjustment; axis arrows must preserve existing physical direction, so right/bottom pane values decrease when the separator moves right/down. Home/End can use the same owner-defined endpoints, while collapse behavior, zero-range focus policy and genuine native keyboard/focus validation remain explicit planning decisions rather than assumed capabilities.

## Implementation Steps

1. **Pin missing behavior with actual components and producers**
   - Add new `test/splitterAccessibility.test.ts` for real Splitter input, focus,
     relationships, modifier/axis ownership and pointer lifecycle. Extend
     `test/horizontalPanelLayout.test.ts`, `test/bottomPanelLayout.test.ts` and
     `test/editorAccessibility.test.ts` to exercise real keyboard callbacks into
     the actual hooks/store or local editor ratio, not a scripted resize result.
   - Cover single/paired docks, Agent/Datasheets switches, fitted and spare space,
     truthful bounds, endpoints, saved preferences, tiny/zero layout recovery,
     hidden views, absent width, repeated keys and unchanged pointer outcomes.
   - Extend the existing real App fixtures to assert the declared frame contract
     for all four dock wrappers: suppress the border below a two-pixel owned
     width/height, restore the ordinary frame at two pixels and on growth, and
     retain fitted dimensions and saved preferences. These host style assertions
     do not model computed CSS rectangles; native measurements supply that proof.
   - Add configurable measured `clientWidth` to the owned React host's element
     fixture. Exercise the actual EditorArea handler and local ratio; assert the
     left pane's rendered flex percentage after keyboard moves and endpoints,
     at zero width, and after measurable-width recovery. Do not stub the splitter
     or substitute a callback-only ratio expectation for these results.

2. **Expose geometry-owned keyboard ranges and endpoints**
   - In `useHorizontalPanelLayout.ts`, keep the existing resizing calculation as
     the sole sizing policy. Share a pure calculation if needed to preview the
     reachable endpoints without store writes, including final store rounding,
     normalization and proportional fitting. Do not invent a second bound formula
     from persisted limits. Endpoint execution must reach its advertised value.
   - In `useBottomPanelLayout.ts`, derive effective range through `fitPanel` and
     existing store limits; preserve actual-rectangle adjustment and preference
     ownership. In `EditorArea.tsx`, retain `onSplitterDelta` and its local ratio,
     with owner-provided percentage endpoints and zero-width adjustment guarding.
   - Pass new required named-pane/relationship/value/input information to
     `Splitter.tsx` from all three App callers and the EditorArea caller. Use
     stable IDs on actual wrappers in `SideBar.tsx`, `AiPanel.tsx`,
     `DatasheetsDock.tsx`, `BottomPanel.tsx` and the left editor pane. Update all
     affected component callers/tests; do not leave pointer-only holdouts.
   - Keep normal one-pixel dock borders, but suppress their width when the owned
     panel extent is below two pixels. A real border-box cannot fit both borders
     into a smaller box. This wrapper-only correction preserves fitting,
     endpoint preview and pointer policies; do not add a new frame allocation
     floor, DPI state or guessed browser quantization epsilon.

3. **Add local keyboard semantics and focus styling**
   - In `Splitter.tsx`, add a normal Tab stop, named separator/value relationships,
     units and zero-range disabled state. Handle only owned unmodified axis keys
     and Home/End; prevent default scrolling only for handled adjustments.
     Delegate sizing to the caller and retain pointer capture/cancel logic.
   - In `styles/index.css`, apply existing theme focus tokens to focused separators
     without widening the normal one-pixel visual rule or adding visible help.
     Keep collapse/visibility on existing controls under the default scope above.

4. **Document completed behavior and limits**
   - Update `docs/FEATURES.md`, `docs/ARCHITECTURE.md`, `docs/TASK-AUDIT.md`,
     `tasks/plan.md`, `tasks/todo.md` and `docs/RELEASE-VALIDATION.md` only after
     verified behavior. Separate host React, actual native keyboard/geometry and
     unrun assistive-technology evidence; preserve release blockers.
   - These are thin feature/evidence and backlog updates required by the user's
     explicit instruction to document every feature and work through Markdown
     tasks. They do not add release approval, certification or unrelated cleanup.

## Review Decisions

- Round 1 structure finding: apply. The host currently has no `clientWidth`;
  Step 1 now names that measured fixture and real rendered-ratio assertions.
- Round 1 scope finding to cut documentation: skip. The user's explicit
  feature-documentation and Markdown-task instructions require those narrow
  updates. Step 4 now records that authority and limits its claims to evidence.
- Round 2: independent internal structure/scope reviews and the actual external
  read-only Codex review find no qualifying issues. The external receipt records
  unchanged reviewed bytes; its two criteria and overall verdict are ready.
- Implementation review: a native diagnostic at 948x604, zoom 2 and observed
  DPR 3 confirms two-pixel border floors despite a one-pixel paired budget.
  Trusted End changes saved widths from 190/620 to 560/260 while both actual
  rectangles and PNG bytes remain identical. Independent structural reviews
  prefer a sub-two-pixel border override over a new fitting policy or replacing
  every normal frame with outlines/padding. Ordinary zoom-out layouts remain
  spacious under the existing minimum window; this reasoning is not proof for
  every OS/DPI. Native acceptance and complete implementation review are pending.

## Verification

- The new behavior cases must genuinely fail before implementation. Green cases
  must assert actual producer results, announced endpoints and rendered styles,
  not only callback arguments. Retain all existing assertions/configuration,
  compiler prerequisites, case deadlines and skips. Deliberate direction/guard
  omissions in owned D: copies must produce specific assertion failures.
- Run both process type checks, production desktop/tools build, full regression
  and existing style checks serially in an owned physical source export, with
  pinned installed tooling. Record the exact reviewed bytes and source boundary.
- In the genuine built Electron desktop with an owned profile/project, use trusted
  keyboard/pointer inputs to Tab to each handle, move in both physical directions,
  use endpoints and exit forward/backward. Verify actual displayed pane geometry,
  finite accessible values, persistent versus local state, unchanged file bytes,
  no accidental tool/file activation and modifier/wrong-axis noninterception.
- Capture focused handles at normal/minimum windows, fitted paired docks, shared
  right-dock views, bottom panel and editor split. Check constrained/zoomed layout,
  hidden-view return and ordinary pointer dragging. Independently inspect PNGs;
  verify natural owned-process shutdown and unchanged source/runtime guards.
- Revisit the measured one-pixel paired budget after the frame fix: actual
  rectangles must track announced extents and move on a deliberate endpoint
  change. Check zero/sub-two/exact-threshold dimensions and frame restoration;
  do not substitute host styles for actual native geometry. Native window sizing
  requests must be recorded separately from the sizes Windows actually returns.
- No screen-reader/WCAG/APG certification, new remote-CI/installer acceptance,
  account/provider access, customer Git mutations or board flashing is implied.

## Context Files

- `CONSTRAINTS.md`: unchanged preservation and verification floor.
- `src/renderer/src/components/Splitter.tsx`: existing input boundary.
- `src/renderer/src/App.tsx`: three workbench callers and hidden-view ownership.
- `src/renderer/src/lib/useHorizontalPanelLayout.ts`: fitted paired sizing policy.
- `src/renderer/src/lib/useBottomPanelLayout.ts`: fitted bottom sizing policy.
- `src/renderer/src/components/EditorArea.tsx`: local ratio and fourth caller.
- `test/reactHost.ts`: real React host and explicit native limitations.
- `test/horizontalPanelLayout.test.ts` and `test/bottomPanelLayout.test.ts`:
  current producer/layout assertions to preserve.

## References

- [W3C window splitter pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/),
  including its explicit under-review status. This scope deliberately does not
  add Enter collapse or F6 pane cycling or claim complete pattern conformance.
