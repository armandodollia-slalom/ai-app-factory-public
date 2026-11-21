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
| `build` | In each pipeline worktree (under `implement.worktreeDir`) that no run, no live stack-slot lease and no recent work uses: the folders in `prune.buildDirs` and every git-ignored folder named in `prune.buildDirNames` (outside `node_modules`, `.git`, `.factory`). The worktree itself stays. | A worktree a running run uses (its ticket record is running or queued, or the run touched it since it started: epic and group worktrees), one a live lease's process works in, one touched in the last `prune.idleMinutes`. A folder that holds tracked files. |
| `slot` | The build folders (`artifacts`, `build`, `build-partial`) of a stack slot in a checkout still in use (the main checkout included) when no live lease holds that slot and they are older than `prune.slotMaxAgeHours`, or, oldest first, while all slot build folders together hold more than `prune.slotMaxGb`. | A slot a live lease holds. The slot's `.env`, `images.ids` and `images.stamp`. |
| `image` | Stack images the pipeline built (recorded in `~/.ai-app-factory/teststack/<project>/images.jsonl` by every build, or listed in a slot's `images.ids`) that a rebuild left untagged, that no remaining slot records and no container (running or stopped) uses, older than `prune.imageMinAgeHours`. | Every tagged image (what a slot's tag points at now), images of other projects, anything when Docker cannot be reached. |
| `install` | Engine installs in `~/.ai-app-factory/versions` that no live branch pins, no running process uses, beyond the newest `prune.keepInstalls`. Live branches: the checked-out HEAD, the remote default branch, the branches of open pull requests, the branches of worktrees in use; the same for each repository in `prune.installRepos`. | Everything when a pin cannot be read (the open pull requests cannot be listed, git fails). The install running the prune. |
| `worktree` | A ticket's worktree and its subtask worktrees (`<worktree>--<subtask>`), `prune.worktreeDays` after its run finished, once its pull request is merged or closed (or, with no PR, its issue is closed and its head is on the base), with no uncommitted tracked change and a head equal to the PR's. The branch is kept. | A worktree in use (as for `build`), one with uncommitted or unpushed work, any whose PR or issue cannot be read. |

Untagged images from before this record existed cannot be told apart from another project's and are left alone; remove
them once by hand (`docker image prune`) if they are yours.

## Settings

`prune` in `.factory/config.json` (all optional; the defaults below):

```json
{
  "prune": {
    "enabled": true,
    "minFreeGb": 20,
    "idleMinutes": 60,
    "buildDirs": [".factory/state/teststack", "artifacts", "test-results", "playwright-report"],
    "buildDirNames": ["bin", "obj"],
    "slotMaxAgeHours": 24,
    "slotMaxGb": 4,
    "imageMinAgeHours": 3,
    "worktreeDays": 7,
    "keepInstalls": 3,
    "installRepos": []
  }
}
```

- `enabled: false` turns the automatic prune off; the free-space check at the start of a run and between tickets stays
  (`minFreeGb: null` turns that off too).
- `slotMaxGb: null` removes the size cap; `worktreeDays: null` never removes worktrees.
- `installRepos`: other repositories on this machine that use installs from `~/.ai-app-factory/versions`, so their pins
  are kept as well.
- `FACTORY_PRUNE=0` in the environment skips the automatic prune (the factory's own test runner sets it);
  `FACTORY_VERSIONS_DIR` points the install prune at another folder.
