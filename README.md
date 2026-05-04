# hardfork

An ppen-source CLI utility tool for having a beautiful interactive command line ui for hard-forking or nuking a repo. It also has a revert helper that give you an interactive ui to revert to specifc commit hashes.

### Requirement

- `git` must be installed and credentials configued.
  > it uses your own git cli and credentials under the hood.

## Usage

**One-off (no global install)**

```bash
bunx hardfork@latest
#or
npx hardfork@latest
```

Global install:

```bash
bun i -g hardfork@latest
npm i -g hardfork@latest
# then invoke `hardfork` directly (no bunx prefix)
hardfork -help
```

## Commands

### `hardfork` (default)

Clone a **source** repo, optionally point `origin` at a **new** empty repo, and push.

| Step           | Interactive                                       | Flags                                               |
| :------------- | :------------------------------------------------ | :-------------------------------------------------- |
| Source URL     | Prompt                                            | `--source <url>` or first positional argument       |
| Clone location | Normal vs temp dir                                | `--normal` (default) / `--temp`                     |
| History        | Full clone vs single new root commit (no lineage) | `--history` / `--no-history`                        |
| New remote     | Optional URL                                      | `--remote <url>` (`--temp` **requires** `--remote`) |
| Push           | Confirm                                           | `--push` / `--no-push`; temp mode always pushes     |

**Global options:** `-y`/`--yes` skip prompts (you must pass everything required), `-h`/`--help`, `-v`/`--version`.

**Normal clone:** `--dir <path>` sets the local folder (default under cwd from repo name); non-interactive `-y` defaults the dir name from the source slug.

**Temporary clone:** clones under the system temp dir, pushes, then deletes the clone.

If the destination remote rejects the first push (**non-fast-forward** / non-empty remote), interactive mode can:

- Pick a branch when multiple remote branches exist, or **nuke all branches** (force-push one primary branch `main`/`master`, delete the rest).
- **Preserve remote history:** either one new commit that replaces files with your fork’s tree, or **replay** the source’s commits on top (cleanup commit + linear replay with metadata).
- **Force overwrite:** force-push and replace remote history on that branch.

With `-y`, a rejected push exits with a hint to rerun without `-y` so you can choose a resolution.

---

### `hardfork nuke [repo]`

Make the repo **empty** (remove tracked files). Scope: one branch or **all** remote branches.

| Mode                 | Behavior                                                                     |
| :------------------- | :--------------------------------------------------------------------------- |
| **Preserve history** | New commit(s) that delete all files (history stays).                         |
| **Wipe history**     | Fresh orphan-style history per branch: force-push empty trees (destructive). |

**Options**

| Flag                     | Purpose                                                           |
| :----------------------- | :---------------------------------------------------------------- |
| `--preserve-history`     | Keep commits; empty tree in new commit(s).                        |
| `--wipe-history`         | Rewrite with fresh root / force-push (irreversible).              |
| `--branch <name>`        | Branch to nuke (default `main` when scope is single-branch).      |
| `--all-branches`         | Every branch on the remote.                                       |
| `-m`, `--message <text>` | Commit message for the nuke commit.                               |
| `-y`, `--yes`            | Skip prompts (repo URL and mode flags required where applicable). |

---

### `hardfork revert [repo] [commit]`

Move a branch to a given **commit** (7–40 hex).

| Mode                                | Behavior                                                                            |
| :---------------------------------- | :---------------------------------------------------------------------------------- |
| **Keep history** (`--keep-history`) | `git revert` each commit after the target (ancestor check); push (non-destructive). |
| **Destructive** (`--destructive`)   | `git reset --hard` to commit + force-push (rewrites remote branch).                 |

**Options:** `--branch <name>` (default: remote `HEAD` symref or `main`), `-y`/`--yes`.

---

## Examples

With **Bun** (`bunx` runs the published CLI without installing globally):

```bash
# Interactive hard fork
bunx hardfork

# Scripted: clone, collapse history, push to new repo, delete temp clone
bunx hardfork --source https://github.com/org/old.git \
  --remote git@github.com:you/new.git --temp --no-history -y

# Keep full history, normal folder, push
bunx hardfork --source https://gitlab.com/group/repo.git \
  --remote git@gitlab.com:you/fork.git --dir my-fork --history --push -y

# Empty one branch, keep history
bunx hardfork nuke https://github.com/you/repo.git --preserve-history --branch main -y

# Force-empty all branches (dangerous)
bunx hardfork nuke https://github.com/you/repo.git --wipe-history --all-branches -m "reset" -y

# Non-destructive revert (new commits)
bunx hardfork revert https://github.com/you/repo.git abc1234 --keep-history --branch main -y

# Rewind branch and force-push
bunx hardfork revert git@github.com:you/repo.git abc1234 --destructive -y
```

If you installed with `npm install -g hardfork`, drop the `bunx` prefix and run `hardfork` … instead.

## Tech stack

[![Bun](https://img.shields.io/badge/Bun-000000?style=flat&logo=bun&logoColor=white)](https://bun.com/) [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![@clack/prompts](https://img.shields.io/badge/%40clack%2Fprompts-CB3837?style=flat&logo=npm&logoColor=white)](https://github.com/bombshell-dev/clack) [![execa](https://img.shields.io/badge/execa-CB3837?style=flat&logo=npm&logoColor=white)](https://github.com/sindresorhus/execa) [![yargs](https://img.shields.io/badge/yargs-CB3837?style=flat&logo=npm&logoColor=white)](https://yargs.js.org/)

## Socials

- Website: [ardastroid.com](https://ardastroid.com)
- Email: [hello@ardastroid.com](mailto:hello@ardastroid.com)
- GitHub: [@ardzero](https://github.com/ardzero)

## License

MIT License

Copyright (c) 2026 Ard Astroid <ardastroid@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
