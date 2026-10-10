# Projects and local files

Cortex edits files in a folder on your computer. Projects are not stored in a
browser sandbox or an account, and you can open the same folder in another editor.

## Open, create, save, and return

1. Choose **File > Open Folder...**, **Open folder** on Welcome, or Ctrl+O.
   Pick your existing project folder. Cancelling the picker changes nothing.
2. Use the Explorer's **New file** or **New folder** button, or its context menu,
   to create an entry in that folder. Enter confirms; Escape cancels. Names must
   be individual names, not paths. To create a file in a subfolder, select that
   folder first. Existing files are never replaced by creation or rename.
3. Edit a file and press Ctrl+S, or choose **File > Save All** for open files.
   The tab's dirty indicator clears only after its write succeeds. Files that
   fail remain open and dirty, with an error explaining the problem.
4. Choose **File > Open Recent: ...** to return to a project without closing your
   current one first. The full path is available on hover. Welcome also shows
   recent project names and paths. Cortex remembers the eight most recent
   folders locally and reopens the last folder on launch.
5. **File > Close Folder** saves open edits and an edited circuit before returning
   to Welcome. Opening another folder also saves first. If a save fails, the
   current project stays open. Closing the application has the same protection.

New sketch creates `blink/blink.ino` in the selected folder, with the sketch and
folder names matching the Arduino build convention. An existing sketch is opened
without replacing its contents. This convenience does not prevent opening a
project that contains your own firmware, headers, scripts, and configuration.

## When something changes outside Cortex

An editor save checks the disk contents against the version the tab originally
loaded. If another program changed or deleted that file, Cortex refuses to
overwrite it. The unsaved editor buffer and the external disk version are kept.

To adopt the disk version, choose **File > Reload from disk** or the matching
command in Ctrl+Shift+P. If you have unsaved edits, **Keep editing** cancels;
**Discard and reload** explicitly discards only that tab's unsaved edits. Reload
does not write to the saved file. Copy any edits you want to merge before
discarding them. A reload that fails, or during which you type new edits, does
not replace your buffer.

Recent folders that cannot be opened show an error and stay in the list so a
temporarily disconnected drive is not forgotten. Use Open folder to locate a
moved project, or the X on Welcome to remove an unwanted recent entry. If the
last folder cannot be reopened at application startup, Cortex returns to Welcome.

## Saving before Run, Verify, and Upload

These actions save the active file first. If saving fails, no launch is sent.
Stop also cancels a launch that is still waiting for its save. Changing the
project, active file, board target, or upload port during preparation cancels
that preparation; run the action again for your new selection. Edits made while
the save is pending are kept, and unsaved newer bytes are never silently run.

Upload uses the explicitly selected port, or exactly one detected board matching
the chosen target. Two matching boards require a port selection; Cortex does not
guess which one to flash. An open serial monitor is closed only after the sketch
has saved. Automatic monitor reopening is limited to the original project and
port; selecting another port does not open it as a side effect of an old upload.
Late native serial callbacks cannot replace a newer connection. Opening a port
has a 15-second callback timeout; closing has a 10-second timeout and reports
failure rather than proceeding with an upload that might still hold the port.
UTF-8 serial text is decoded across incoming chunk boundaries.
Hardware uploads still need validation on intentionally selected physical boards.

## Safety and current limits

- Saves stage UTF-8 bytes beside the destination, flush them, and replace the
  file only after staging succeeds. A failed replacement leaves the previous
  file intact. Overlapping editor saves for one file run in order.
- Project settings in `.cortex/config.json` also merge in order and use staged
  replacement. Malformed/unreadable configuration and linked metadata entries
  are not overwritten. A save failure shows an error: the selected setting stays
  active for the session, but the previous disk configuration remains unchanged.
- Rapid file switching handles Monaco's delayed word-highlight cancellation
  through a narrow upstream backport. Highlighting stays enabled and unrelated
  errors remain visible; no global error filter is installed.
- Explorer watches metadata without waiting for file contents to stabilize, so
  a rapid external rename followed by delete still removes the listed entry.
  Stale directory reads cannot restore deleted entries or replace a new project's
  tree. An unreadable/missing project root reports restoration advice while
  preserving open edits and the last known list. Watcher updates do not
  automatically overwrite an open editor buffer.
- Desktop Output and simulator Serial retain a recent tail of at most 524288
  UTF-16 code units, in addition to their entry-count caps. An explicit omission
  marker appears when older display text is dropped; use firmware JSON reports
  for bounded, reproducible test evidence instead of treating a live console as
  an archival log.
- UTF-8 BOMs and existing editor line endings are preserved. Binary files,
  invalid UTF-8, and files larger than 8 MB open as read-only placeholders.
  Other encodings are not yet editable; convert a copy with an appropriate tool.
- File creation, writes, rename, and delete require an open project. Paths and
  symlink or junction targets must stay inside that project. The workspace root
  itself cannot be renamed or deleted through the Explorer.
- Delete is permanent and requires confirmation. Use Git or another backup
  system for recovery; Cortex is not a backup service.
- Recent history persists locally, not across computers. Open editor tabs are
  not restored across application launches yet.
- Atomic replacement is per file, not a transaction across Save All. A sudden
  crash can leave a staging file. Network filesystems, hardware power loss,
  filesystem permissions and ACL behavior, and hostile concurrent changes to
  the filesystem are outside a guarantee of durable storage. External-change
  checks reduce accidental overwrites but are not a cross-process file lock.

Regression coverage uses real temporary filesystem fixtures and the production
editor store in `test/filePersistence.test.ts`, `test/fileRead.test.ts`, and
`test/projectPersistenceStore.test.ts`. Launch-preparation races use mocked APIs
in `test/runLifecycleStore.test.ts`, without compiling or flashing hardware.
Native serial lifecycle and timeout regressions use mocked ports in
`test/serialLifecycle.test.ts`.
Hardware and platform release testing
remain part of the [production readiness checklist](PRODUCTION-READINESS.md).
