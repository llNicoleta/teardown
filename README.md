# teardown

`teardown` removes a finished git worktree together with the Docker Compose stack that was started from it.
It deletes the containers, networks, volumes and the images that were built for that stack, then the worktree folder.
It never deletes branches or images that were pulled from a registry, such as `postgres:18`.

It knows nothing about any specific project.
It finds the stack of a worktree from the Docker Compose labels on the containers.
When a stack has no containers left, it matches the stack by name, for example the project `app-feature-x-7e37f4dfb8` belongs to the folder `feature-x`.

## Remove one worktree

```sh
teardown [path] [--dry-run] [--force] [--yes]
```

The path defaults to the current folder.
`teardown` first prints every container, network, volume, image and the folder, each with its size, and then asks before it deletes anything.

When the stack is still running, the worktree has uncommitted changes, or its last commit is not on any remote branch, `teardown` names what would be lost in the question it asks before it deletes.
With `--yes` or in a script there is nobody to ask, so it refuses such a worktree unless you pass `--force`.
It also refuses the main checkout of a repository, because it only removes linked worktrees.

## Sweep the machine

```sh
teardown sweep [filter] [--dry-run] [--force] [--yes] [--no-fetch] [--keep-build-cache]
```

`sweep` looks for repositories under the folders in `TEARDOWN_ROOTS` (separated by colons, default `~/Dev`) and for the folders that existing stacks were started from.
It shows a checklist of linked worktrees and leftover stacks, each with a verdict and a size.

Rows that start as `[x]` are worktrees whose branch is merged and stacks whose folder is gone.
Move with the Up and Down keys, press Space to select or unselect a row, press Enter to continue, or press `q` to cancel.
For every selected row that is running, dirty or unpushed, `sweep` says what would be lost and asks about that row.
Then it asks once more for the whole selection before it deletes.
`--yes` removes the `[x]` rows without asking, and it never frees the build cache.
When the output is not a terminal, `sweep` prints a numbered table and reads the row numbers from a line of input.

At the end, `sweep` shows how much Docker build cache could be freed and offers to free it, unless you pass `--keep-build-cache`.

## Verdicts

| Verdict | Meaning | Marked | Extra question |
| --- | --- | --- | --- |
| running | a container of the stack is running | no | yes |
| dirty | the worktree has uncommitted changes | no | yes |
| unpushed | the last commit is not on any remote branch | no | yes |
| merged | the branch is in the remote default branch, or GitHub shows a merged pull request for this exact commit | yes | no |
| open | clean and pushed, not merged | no | no |
| folder gone | the folder the stack was started from no longer exists | yes | no |
| folder unknown | the stack has no containers and no folder matches its name | no | no |

A worktree with no commits of its own counts as merged, because its last commit is already in the default branch.
Files that git ignores, such as `.env`, do not make a worktree dirty, and they are deleted with the folder.
A stack with no containers whose name fits two or more folders is not listed at all, because its owner cannot be told.

## Tests

The tests use real git and real Docker.
Every Docker resource they create has a project name that starts with `tdtest-`, and they remove those resources at the end.

```sh
node --test test/e2e.test.js
```
