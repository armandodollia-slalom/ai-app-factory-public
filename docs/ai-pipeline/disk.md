# Disk use and `factory prune`

**Who reads this:** C (operators) running many tickets on one machine.

A pipeline run leaves a lot on disk: every ticket has a worktree (its build output, `bin`/`obj`, test results, a test-stack
state folder with the published services per stack slot), every stack build tags new images and leaves the previous
ones untagged, and every `factory upgrade --install` adds an engine install under `~/.ai-app-factory/versions`. On a busy
machine that can reach 90 GB of worktrees, 63 GB of unused Docker images and 28 old installs (7 GB) within a week.

The factory keeps this in bounds by itself:

- **At the start and the end of `implement run` / `resume`** it prunes what no run needs any more (below), then reads the
  free space of the main checkout's and the worktree folder's disks. A run that would start with less than
  `prune.minFreeGb` free **refuses to start** (exit 75) and says what to do.
- **Before each new ticket, bug group or verifier pair** of a running run it reads the free space again. Below
  `prune.minFreeGb` it prunes once more and, if that is not enough, **pauses** (logging every 10 minutes) until space is
  freed, instead of starting work that would die on a full disk.
- **`factory doctor`** shows the free space against `prune.minFreeGb`.
- **`factory prune [--dry-run] [--json]`** does the same prune by hand; `--dry-run` lists what would go, with sizes and
  the reason for each.

## What goes, and what never does

| Kind | Removed | Kept |
| --- | --- | --- |
| `build` | In each pipeline worktree (under `implement.worktreeDir`) that no run, no live stack-slot lease and no recent work uses: the folders in `prune.buildDirs` and every git-ignored folder named in `prune.buildDirNames` (outside `node_modules`, `.git`, `.factory`). The worktree itself stays. | A worktree a running run uses (its ticket record is running or queued, or the run touched it since it started: epic and group worktrees), one a live lease's process works in, one touched in the last `prune.idleSec`. A folder that holds tracked files. |
| `slot` | The build folders (`artifacts`, `build`, `build-partial`) of a stack slot in a checkout still in use (the main checkout included) when no live lease holds that slot and they are older than `prune.slotMaxAgeSec`, or, oldest first, while all slot build folders together hold more than `prune.slotMaxGb`. | A slot a live lease holds. The slot's `.env`, `images.ids` and `images.stamp`. |
| `image` | Stack images the pipeline built (recorded in `~/.ai-app-factory/teststack/<project>/images.jsonl` by every build, or listed in a slot's `images.ids`) that a rebuild left untagged, that no remaining slot records and no container (running or stopped) uses, older than `prune.imageMinAgeSec`. | Every tagged image (what a slot's tag points at now), images of other projects, anything when Docker cannot be reached. |
| `install` | Engine installs in `~/.ai-app-factory/versions` that no live branch pins, no running process uses, beyond the newest `prune.keepInstalls`. Live branches: the checked-out HEAD, the remote default branch, the branches of open pull requests, the branches of worktrees in use; the same for each repository in `prune.installRepos`. | Everything when a pin cannot be read (the open pull requests cannot be listed, git fails). The install running the prune. |
| `worktree` | A ticket's worktree and its subtask worktrees (`<worktree>--<subtask>`), `prune.worktreeDays` after its run finished, once its pull request is merged or closed (or, with no PR, its issue is closed and its head is on the base), with no uncommitted tracked change and a head equal to the PR's. The branch is kept. | A worktree in use (as for `build`), one with uncommitted or unpushed work, any whose PR or issue cannot be read. |

Untagged images from before this record existed cannot be told apart from another project's and are left alone; remove
them once by hand (`docker image prune`) if they are yours.

## After a delivery

**Alpha: off by default.** With `prune.afterDelivery: true`, a run removes what it made on this machine once that is
on the remote, and only that. Off (the default), nothing of a delivered run is removed: its worktrees, local branches
and a bug's before checkout stay until the age-based `worktree` prune above or a person removes them. When on and in
doubt, it keeps the item and says why in the run log; it never deletes something it cannot prove is safe to delete.

- **Only what the run recorded.** When a run creates a ticket's worktree (or an epic group's), it records the worktree's
  resolved path and, only when it created that branch itself, the local branch in its run record (the epic's state for a
  group); a branch that existed before is never recorded as the run's. A bug's before run notes the base checkout it
  added (`<stateDir>/demo-base/<sha>`) and every file it writes into it, with the file's contents (a hash). Nothing else
  is a candidate: no path or branch is found by its name. Once an item is removed its record goes too.
- **When.** A ticket's worktree and branch go at the end of the batch that delivered it (its PR open and past its CI
  wait, the board, ticket and records done), unless a ticket of the batch that did not deliver, or any saved run record
  that is not done (what a resume reads), starts from that branch or merges it: then they wait for that last consumer's
  run. An epic's delivered groups go when the whole epic run ends, unless a group that has not delivered is stacked on
  them. A before run's base checkout goes as soon as the before run ends, also after a failure. A later run that needs a
  removed branch (a stacked ticket, a reopened or joining one) starts from the remote branch it was delivered to, and a
  delivered ticket stays done.
- **Only once the delivery remote confirms.** `origin` must be the repository the delivery pushed to (it fetches from
  where it pushes, and, when the PR bot pushed to the host's repository directly, it is that repository); otherwise
  everything stays. It is asked once, at that moment, with `git ls-remote`, before anything is removed: its head of the
  branch delivered on must contain both the worktree's and the branch's commits (a remote-tracking ref never counts). If
  it cannot be read, everything stays.
- **Never forced.** The path must resolve, with no link on it, to itself inside `implement.worktreeDir` (a base checkout:
  exactly `<stateDir>/demo-base/<sha>` of its ticket's checkout, every folder on the way a plain folder, the state folder
  inside the ticket; never the file system root or the home folder) and be a registered git worktree with the branch
  recorded checked out (a base checkout: detached at its commit). It stays, and its branch with it, when it is locked, a
  live stack-slot lease uses it, a Git operation is in progress (rebase, merge, cherry-pick, revert, bisect), a stash of
  its branch exists, a submodule is initialised in it, or it holds uncommitted or untracked work (in a ticket worktree,
  ignored files, the generated videos, frames, test results and evidence, go with it). A base checkout stays when it
  holds any changed, untracked or ignored file other than the exact files the before run wrote with the contents it
  wrote; those are put back first. Removal is `git worktree remove` without `--force` and a branch is deleted only if it
  still points where the remote was checked (`git update-ref -d` with its old value); anything Git refuses is kept and
  reported, never cleaned by hand.
- **Setting up the base checkout** (whatever this setting): the folder is checked from the ticket's checkout down before
  anything is changed (no link on the way, the state folder inside the ticket), and a folder already at the destination
  is used only when Git registered it as a checkout of this repository (an empty one included: it is never removed or
  replaced); anything else there is left as it is and the before run does not run. The ticket's scenarios are read
  without following links: a link anywhere in them (to a folder or a file), or anything but a plain folder or file,
  refuses the before run. Before anything is written into the checkout, every destination is checked too: its stack
  settings file, every scenario folder (empty ones included) and file, and every folder on their way, must be a plain
  path inside the checkout (no link, a tracked one included; a `teststack.scenariosDir` with `..` or absolute is refused),
  and an existing file there must have no other name (a hard link, which a write would change too). The scenarios are
  then copied file by file into those checked places, never by a recursive copy. A refusal means no before run for
  that bug, reported with the reason; nothing is written.
- **Not removed here: container images.** The images a run's stack built (the `-base-<sha>` images of a before run
  included) are not removed after a delivery: the stack keeps no record of which images belong to which run, and a tag
  can be shared by another checkout or project on the same Docker. Superseded images go by the `image` prune above; the
  `-base-<sha>` ones stay until removed by hand.
- **Keeping it for debugging.** `implement run --keep` keeps what that run and every resume of its batch made (the batch
  records it; `resume --keep`, also `--background`, sets it for a resumed batch); `prune.keepLocal: true` keeps it for
  every run. Neither stops the age-based `worktree` prune above (`prune.worktreeDays: null` does). `prune.enabled:
  false` and `FACTORY_PRUNE=0` turn the removal off with the rest of the automatic prune.

## Settings

`prune` in `.factory/config.json` (all optional; the defaults below):

```json
{
  "prune": {
    "enabled": true,
    "minFreeGb": 20,
    "idleSec": 3600,
    "buildDirs": [".factory/state/teststack", "artifacts", "test-results", "playwright-report"],
    "buildDirNames": ["bin", "obj"],
    "slotMaxAgeSec": 86400,
    "slotMaxGb": 4,
    "imageMinAgeSec": 10800,
    "worktreeDays": 7,
    "keepInstalls": 3,
    "installRepos": [],
    "afterDelivery": false,
    "keepLocal": false
  }
}
```

- `enabled: false` turns the automatic prune off; the free-space check at the start of a run and between tickets stays
  (`minFreeGb: null` turns that off too).
- `slotMaxGb: null` removes the size cap; `worktreeDays: null` never removes worktrees.
- `afterDelivery` (alpha, off by default): `true` removes what a delivered run made on this machine
  ([after a delivery](#after-a-delivery)); `false` removes nothing of it. `keepLocal: true` keeps it all even when it is
  on. Both must be `true` or `false`, or the config does not load (whichever command reads it first).
- `installRepos`: other repositories on this machine that use installs from `~/.ai-app-factory/versions`, so their pins
  are kept as well.
- `FACTORY_PRUNE=0` in the environment skips the automatic prune (the factory's own test runner sets it);
  `FACTORY_VERSIONS_DIR` points the install prune at another folder.
