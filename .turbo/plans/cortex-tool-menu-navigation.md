---
status: ready
---

# Plan: Keyboard navigation for More tools

## Context

The production-readiness backlog identifies the activity rail's More tools menu
as a keyboard gap. Its buttons currently expose menu roles but leave focus on
the trigger when opened, lack arrow navigation, and dismiss Escape through a
window-wide listener without returning focus. Boards Manager, Library Manager
and Debug must be reachable naturally without adding instructional clutter.
Preserve the compact visual layout and the existing sidebar toggle behavior.

This is a single desktop user's local navigation surface, with three fixed
actions and no concurrent writers or persistent menu state. Customer-release
rigor requires real keyboard verification and regression coverage; this slice
does not claim whole-IDE accessibility or production-release readiness. Keyboard
splitters, the long-filename review badge and a larger settings redesign remain
separate backlog items in `tasks/todo.md`. A fresh PyCharm reference launch reached
a cross-installation data-sharing prompt; no privacy choice was made and no
settings reference has yet been captured.

## Acceptance Criteria

- The More tools trigger exposes its menu relationship and expanded state. Click,
  Enter, Space or unmodified ArrowDown opens the menu with its first item focused;
  unmodified ArrowUp opens it with its last item focused.
- While an item is focused, unmodified Up/Down wraps among the three items and
  Home/End focuses the first/last item without changing the selected sidebar.
  Unmodified B/L/D focuses the correspondingly named item without activation.
- Click, Enter or Space on an item invokes the existing `setSidebar` action once,
  closes the menu and returns focus to the trigger. Selecting the visible current
  sidebar still hides it; selecting another or a hidden tool shows that tool.
- Escape closes the focused menu and returns focus to the trigger. Tab/ShiftTab
  closes it and continues native tab navigation outside the menu, forward/backward
  from the trigger, without a trap or lost focus. Neither action changes a tool.
- Outside-pointer dismissal closes the menu without forcibly focusing the trigger.
  Closed-menu, unrelated-surface and modified shortcuts are not intercepted. No
  window-wide Escape listener remains for this menu; unmount leaves no listeners
  or delayed focus callbacks behind.
- The trigger and focused item have visible keyboard focus in the actual desktop.
  The menu retains readable labels, the selected-tool visual indicator and its
  current compact placement at supported window sizes, without tutorial text.

## Pattern Survey

### Analogous Features

- `src/renderer/src/components/EditorArea.tsx`: its tab refs and keyboard handling
  separate focus movement from activation, guard modified shortcuts and restore
  focus after close. Follow these local React patterns, not a global key listener.
- `src/renderer/src/components/FileExplorer.tsx`: its context menu focuses its
  first button and returns focus on Escape. Preserve similarly local ownership.
- `src/renderer/src/components/ActivityBar.tsx`: the existing MORE entries, rail
  button presentation and `setSidebar` calls define the three actions and styling.
- `src/renderer/src/components/MenuBar.tsx`: outside-pointer dismissal is analogous,
  but its incomplete menu keyboard support is not evidence of correct navigation.

### Reusable Utilities

- `useStore` in `src/renderer/src/store/useStore.ts` owns sidebar selection and
  visibility. Its existing `setSidebar` behavior must remain the action producer.
- `test/reactHost.ts` mounts real React hooks and refs and records focus. It does
  not emulate native Tab, button key activation or a browser accessibility tree.
- `src/renderer/src/styles/index.css` already gives native buttons a focus-visible
  ring using theme tokens. Reuse it rather than adding a menu-only focus system.

### Convention Anchors

- `test/editorAccessibility.test.ts` and `test/explorerAccessibility.test.ts` use
  the real rendered components and explicit focus/activation assertions.
- `test/horizontalPanelLayout.test.ts` and `test/bottomPanelLayout.test.ts` mock
  ActivityBar, so they are layout regressions, not menu-navigation evidence.
- The official WAI-ARIA menu-button and menu patterns describe focus on opening,
  menu relationships, directional keys, Escape and leaving with Tab. These are
  interaction references, not a claim of complete APG or assistive-tech conformance.

### Proposed Alignment

Extract only this fixed menu into new `MoreTools.tsx`, used by ActivityBar. Keep
its state, refs and event handlers together; do not introduce a generic menu
framework, persistence or dependencies. Reuse real store actions and existing
button styling. Keep tests on the real ActivityBar and new child component.

## Implementation Steps

1. **Pin the missing behavior on the existing rail**
   - Add `test/activityBarAccessibility.test.ts` (new), mounting real ActivityBar
     through `test/reactHost.ts` and the real store. Stub only browser/native API
     boundaries needed to mount it; do not replace `setSidebar` with a scripted
     outcome. Assert focus separately from sidebar selection and visibility.
   - Cover trigger relationships/opening, wrap/Home/End/typeahead, both dismissal
     paths, modifiers, every item, hidden/current sidebar toggles and unmount.
     Drive `onClick` for native button activation in this host; do not pretend
     that invoking a key callback proves browser-generated click behavior.

2. **Give the fixed menu local focus ownership**
   - Define new `MoreTools` in
     `src/renderer/src/components/MoreTools.tsx`. Move the three MORE entries,
     menu state and overflow presentation there from ActivityBar; ActivityBar
     renders the child in the same rail position and retains all other actions.
   - Use stable menu/trigger identifiers, native button refs, a labelled menu,
     expanded/menu relationship attributes and non-tabbable menu items. On opening,
     focus the requested first/last item after commit; directional and letter keys
     move focus only. Guard modified keys except ShiftTab's ordinary reverse exit.
   - Keep Enter/Space activation on native button `onClick`, not duplicate key and
     click paths. Invoke `setSidebar` exactly once, close, and focus the trigger.
     Handle Escape on the menu, not window; remove the old global listener.
   - For Tab/ShiftTab, focus the trigger before closing, without preventing the
     browser's default tab movement. This avoids tabbing from a detached item.
     This strategy is not yet observed in Chromium and must pass the native check;
     revise it if the browser does not continue from the trigger correctly.
   - Preserve outside-overlay dismissal without forced focus, current sidebar
     highlight, compact labels, dimensions and existing theme focus styling.
     Local handlers and synchronous refs require no timers or global listeners.

3. **Document the supported interaction and evidence**
   - Update the relevant workbench entries in `docs/FEATURES.md`,
     `docs/ARCHITECTURE.md`, `docs/TASK-AUDIT.md`, `tasks/plan.md` and `tasks/todo.md`.
     Record actual verification and remaining keyboard/supported-release gaps in
     `docs/RELEASE-VALIDATION.md`; do not declare the whole workbench accessible.

## Verification

- The new rendered-component suite must fail against the current ActivityBar on
  its real missing relationships/focus behavior, then pass on the implementation.
  Check all three action outcomes and exact focus/selection separation. Retain
  existing editor, explorer, welcome, horizontal and bottom-layout assertions.
- In an owned exported source fixture, run the new suite plus the named existing
  accessibility/layout suites using the pinned installed Vitest. Typecheck both
  processes, build the desktop, and run the existing regression/style gates without
  skipping cases, changing deadlines or weakening `CONSTRAINTS.md`.
- In the built actual Cortex desktop, use an owned temporary profile/project and
  trusted native/CDP keyboard and pointer input. Verify Enter/Space generate one
  action each, Down/Up open on the correct item, all movement keys change actual
  `document.activeElement` without selection, Escape restores trigger focus, and
  Tab/ShiftTab reaches outside controls from every item. Capture visible focus
  and menu geometry at supported normal/minimum window sizes; verify pointer
  activation/dismissal and selected-tool highlighting. No account, provider,
  customer repository, real board or user settings changes are needed.
- Keep source/runtime hashes and process ownership receipts for the desktop run;
  verify natural shutdown of owned processes. Distinguish test-host focus evidence,
  native keyboard evidence and any unrun screen-reader checks explicitly.

## Context Files

- `CONSTRAINTS.md`: non-negotiable release and data-preservation floor.
- `src/renderer/src/components/ActivityBar.tsx`: existing surface and all rail actions.
- `src/renderer/src/components/EditorArea.tsx`: local keyboard/focus convention.
- `test/reactHost.ts` and `test/editorAccessibility.test.ts`: real component test
  mechanism and its limits.
- `docs/TASK-AUDIT.md` and `tasks/todo.md`: current backlog and scope boundaries.

## References

- [WAI-ARIA menu button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/).
- [WAI-ARIA menu pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/).
