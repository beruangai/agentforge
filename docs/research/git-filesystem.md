# Git filesystem: what git and `s7cmd` do that AgentForge relies on

Read and spiked on **2026-10-24**: git 2.47.0 on macOS, and git 2.47.3 (`1:2.47.3-0+deb13u1`) from apt in the AgentForge image (Debian 13). Decision: [ADR 0024](../../adr/0024-git-filesystems-commit-onto-one-branch.md).

## A subtree as a mount's root, without a checkout

Spiked against a bare `file://` repository holding `vault/a`, `vault/b` and `README.md`:

- **Mount.** `git clone --bare --filter=blob:none -b main <url> <private>`, then, with `GIT_DIR=<private>`, `GIT_WORK_TREE=<mount>` and `GIT_INDEX_FILE=<private>/mount.index`, `git read-tree -u --reset <base>:vault/a`. The mount holds `vault/a`'s files at its root and nothing else.
- **Changes as a tree.** `git add -A` and `git write-tree` in that index give the subtree's new tree.
- **Splice.** In a second index: `read-tree <base>`, `rm -r --cached vault/a`, `read-tree --prefix=vault/a/ <subtree>`, `write-tree`. Then `commit-tree <tree> -p <base>`.
- **Push and reject.** `git push origin <commit>:refs/heads/main` is rejected `(fetch first)` once another writer has pushed.
- **Merge onto the new tip in memory.** After a fetch, `git merge-tree --write-tree --merge-base=<base> <tip> <commit>`:
  - With the other writer in `vault/b`, it exits 0 and the commit on the tip pushes. The branch then has both changes.
  - With both writers changing `vault/a/one.md`, it exits 1 and prints `CONFLICT (content)` naming the file.
  - It writes no work tree and no rebase state. `--merge-base` needs git ≥ 2.40.
- **Blobless clones locally.** A local bare repository serves a blobless clone only with `uploadpack.allowFilter`; without it git warns and clones whole.
- **zsh.** `$C:r…` in a refspec is a zsh modifier, not text. The kind spawns git with argument arrays, never a shell.

## `s7cmd` pulling over a kept copy

`s7cmd sync` without an update-checking flag, as a pull runs it, compares modification times. It copies an object only when the source's is newer than the target's, and copies a file missing at the target. So a pull over a kept copy:

- keeps a local file edited after the store's copy last changed;
- takes the store's file when the store changed after the local edit;
- restores a file the copy lacks.

Read from `s7cmd sync --help` (1.8.5), and **verified on 2026-10-24** by `integ/aws/filesystem-s3-sync` against a real bucket. Without `--delete`, a pull does not remove a local file the store no longer has.

## Removing a variable from the environment, on Bun

Probed 2026-10-24 on Bun 1.4.0: after `delete process.env.X`, a child started with `node:child_process` (`spawn`, `spawnSync`) does not see `X`. A child started with `Bun.spawn` or `Bun.spawnSync` and no explicit `env` still does: Bun hands it the environment the process started with. `Bun.spawn(…, { env: process.env })` does not. The git kind relies on the first. The `claude` kernel passes `env` explicitly, and Strands' shell tool passes `{ ...process.env }`, so both kernels' runs are covered.

## In the image

`apt-get install --no-install-recommends git` on the AgentForge image's Debian 13 adds about 29 MB (`/usr/lib/git-core`, `/usr/bin/git`, `/usr/share/git-core`). Built into the image on 2026-10-24: `git version 2.47.3`, run as `bun`.
