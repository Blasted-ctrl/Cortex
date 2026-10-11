# Source Control

Cortex uses your installed Git executable. Your project files and local commits stay on your laptop. It never initializes a repository, contacts a remote, pushes, or changes branches automatically.

## Start tracking a project

1. Open your project folder, then open Source Control.
2. Choose **Initialize repository** and confirm. Cortex creates a local repository with a `main` branch. Nothing is uploaded.
3. Save your editor changes. Source Control compares and stages the files on disk, not unsaved editor buffers.
4. Review a file's diff, choose **Stage**, enter a commit message, and choose **Commit**.

Configure your Git name and email in the terminal before your first commit if they are not already configured:

```sh
git config user.name "Your name"
git config user.email "you@example.com"
```

These commands configure only the open repository. Git identity, signing, hooks, filters, and credentials continue to use your Git configuration. Only run Git operations in repositories you trust.

## Review changes

- **Staged changes** compares the previous commit with the index. Only staged content is committed.
- **Changes** compares the index with the working file. A file can have both staged content and newer working edits.
- **Untracked** shows files Git does not yet track. Ignored files do not appear.
- **Conflicts** identifies unmerged files. Resolve their conflict markers, save, and stage the resolved files before committing.

Unstage changes without discarding the working file. Renames unstage both the original and new paths. The same behavior works before the first commit.

Text diff previews are limited to 4 MB per side. Binary files, large files, and inaccessible paths are not rendered as empty text changes. Symbolic links are previewed as their link target, not by reading the destination file.

## Branches and synchronization

Open the branch selector to switch to an existing local branch or enter a new branch name. Save or discard unsaved editor changes first. Cortex does not force a switch over conflicting changes.

After switching, creating a branch or pulling, clean editor tabs reload from
disk while Source Control remains busy. Dirty buffers are left alone. A reload
belongs to the original clean tab and project session: closing/reopening a tab,
editing/saving it, changing projects (even away and back), or starting a newer
reload invalidates the older response. A confirmed missing file closes only
its still-owned clean tab; other read failures preserve it and show an error.
Waiting for a save before closing a tab cannot close a replacement tab.

Git actions also retain their original project session through confirmations,
requests and reconciliation. A late response cannot refresh a replacement
project, clear its drafts or announce success there. This does not undo a Git
operation already executed against its captured repository.

Use **Fetch remote changes** to update remote-tracking references without changing working files. Fetching requires confirmation. After fetching, **Pull** appears when the branch is behind its upstream.

Pull requires a clean working tree, including no untracked files, and no unsaved editor changes. It fast-forwards only. It does not create merge commits, rebase local commits, or overwrite a divergent branch. Handle divergent history or advanced conflict resolution in your Git tool or Cortex's terminal.

**Push** asks for confirmation and publishes only the current branch to its configured upstream. Cortex specifies that destination explicitly, even if your Git defaults would otherwise push multiple matching branches. It never force-pushes.

Configure a remote and upstream through the terminal before synchronizing a new repository. Remote creation, cloning, commit history, stash management, merge/rebase tools, and a conflict editor are not yet provided in the Source Control panel.

## Project boundaries and failures

If you open a subfolder of a larger repository, file lists and staging are limited to that subfolder. Commit, branch changes, and remote synchronization require opening the repository root: those operations can affect files or commits outside the smaller project view.

Cortex passes file names literally to Git, without a shell or wildcard/pathspec expansion. It rejects paths outside the project, Git metadata, directory staging requests, and paths through directory links that leave the project. Inherited repository or index environment overrides cannot redirect operations to another repository.

Read operations stop after 15 seconds; mutations stop after 60 seconds. Errors are shown in the panel or a notification, rather than appearing as a clean repository or a successful operation. Credentials are not collected by Cortex; Git uses your configured credential helper. If authentication fails, authenticate with your Git tool and retry. After a timed-out push, verify the remote before trying again, since network interruption does not prove that the remote received no update.

## Verification

Run the focused checks with:

```sh
npx vitest run test/gitService.test.ts test/gitCommandSafety.test.ts test/gitStatus.test.ts test/gitTabReconciliation.test.ts test/vcsOperationOwnership.test.ts
```

Integration tests create fresh temporary repositories and a local bare remote. They cover staging, partial edits, first-commit unstaging, renames, literal and unusual names, project confinement, linked directories, environment overrides, branch validation, fetch, fast-forward and divergent pulls, and current-branch-only pushes. They do not modify Cortex's own repository or contact an external remote. Newline/backslash filename integration is POSIX-only because Windows cannot create those names.

Separate deferred store/component tests exercise project/tab ownership and
post-operation busy state, with Git IPC outcomes substituted. These are race
regressions, not proof of remote credentials or native timing on every platform.
