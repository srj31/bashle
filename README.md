<p align="center">
  <img src="media/banner.png" alt="bashle — a live programming environment for bash scripts" width="100%">
</p>

<p align="center">
  <em>Stop reading diffs and running tests to find out what your shell script does.<br>
  Watch it run, line by line, expansion by expansion — without letting it touch your machine.</em>
</p>

<p align="center">
  <a href="https://github.com/srj31/bashle/actions/workflows/ci.yml"><img src="https://github.com/srj31/bashle/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/srj31/bashle/actions/workflows/ci.yml"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fsrj31%2F5d384b7a71e1d079d23a2cf984cd2def%2Fraw%2Fbashle-coverage.json" alt="coverage"></a>
  <a href="https://open-vsx.org/extension/srj31/bashle"><img src="https://img.shields.io/open-vsx/v/srj31/bashle?label=Open%20VSX" alt="Open VSX"></a>
</p>

---


A bash script's bugs are almost never logic bugs. They're **expansion bugs**: an empty variable,
an unquoted word that split into three, a glob that matched nothing. `shellcheck` catches some
statically. A test tells you *that* something failed. Neither shows you what bash actually ran.

Bashle does, on the line, the moment you save:

```bash
dest=                              dest=''
for f in $files; do                ×3  f='my report.txt'
  cp "$f" "$dest/"                 cp 'my report.txt' '/'  ✗1
done
```

It runs the script for real, in a throwaway copy-on-write clone of your workspace, with the
network denied and writes outside the clone blocked by the kernel.

## Install

**Requires** bash ≥ 4.1 (macOS ships 3.2 — `brew install bash` and bashle finds it), macOS or
Linux, and on Linux `bubblewrap` for kernel containment (`apt install bubblewrap`).

```bash
git clone https://github.com/srj31/bashle && cd bashle
npm install && npm run package
code --install-extension bashle-0.1.0.vsix     # VS Code ≥ 1.85, or cursor --install-extension
```

For Vim, see [Vim](#vim) below.

## Quick start

Add a comment saying how the script should run, then save.

```bash
# @probe staging --dry-run
set -euo pipefail

target="$1"
mkdir -p "releases/$target"
echo "deploying to $target" > "releases/$target/log.txt"
```

You get expansions and exit codes inline, and a **Files** panel showing the run created
`releases/staging/log.txt` — in the clone, not your repo.

## Probes

`# @probe <shell words>`, interpreted against whatever it is attached to.

```bash
# @probe staging --dry-run          ← the script's "$@"
# @probe prod => exit 1             ← with an expected exit code

# @probe "a//b" => "a/b"            ← attached to a function: its args
normalize_path() { echo "${1//\/\//\/}"; }
```

Expectations are optional: `=> exit N` checks the status, `=> "text"` checks stdout. Modifiers
apply to every probe in the same comment block:

```bash
# @env DEPLOY_ENV=staging
# @stdin "yes"
# @probe --interactive
```

> **Function probes source your script.** Without a `[[ "${BASH_SOURCE[0]}" == "$0" ]]` guard,
> its top-level body runs first. Bashle says so rather than letting you wonder.

## Holes

External inputs — a network response, a daemon, a file that isn't there — are not failures.
They're **unknowns**, and bashle runs *past* them so you can see how far one reaches before you
know anything:

```bash
version=$(curl -s "$api/latest")   version='◇1'
dest="releases/$version"           dest='releases/◇1'
mkdir -p "$dest"                   mkdir -p releases/◇1
```

That run finished under `set -euo pipefail`, and the Files tab shows it created
`releases/◇1/notes.txt` — a file whose name nobody knows yet.

**Fill one** by naming what was requested:

```bash
# @net   GET https://api.example.com/latest => "1.4.2"
# @net   GET https://api.example.com/health => exit 22
# @cmd   docker ps => "no containers"
# @file  etc/deploy.conf => @fixtures/deploy.conf
# @clock 2026-01-15T09:30:00Z
# @probe staging
```

`=> "text"` sets stdout, `=> exit N` the status, `=> @path` reads a fixture, and a `<<'EOF'`
heredoc carries anything multi-line. A request with no fill is simply a hole — there is no
"mock not found" error anywhere in this.

Network calls, sandbox-escaping commands (`docker`, `systemctl`, `ssh`, `aws`, `kubectl`) and
reads of files absent from the clone become holes. A file that *is* in the clone stays real.
`date`, `hostname`, `whoami` and `uuidgen` are pre-filled with fixed values so two runs agree.

**A hole is never a way to hide a bug.** If the line reached an empty variable it is marked
`◇!n` and leads with the cause instead of the fill — `cat "$dest/x"` with an empty `$dest` is an
expansion bug, not a missing input. The warning stays even if you fill it.

> **Gaps.** `source f` and `read < f` are builtins, so a missing file read that way isn't
> discovered (a `@file` fill still works). An unquoted `$hole` that word-splits is treated as one
> word. A branch decided by an unfilled hole isn't recorded, so such a run may not represent
> every fill. All three are named in [the semantics](docs/semantics.md).

## Containment

Probe runs execute real commands, contained in three layers — and bashle always tells you which
are active (`⛨` for kernel enforcement, `⚠` for clone-only).

1. **Scratch clone.** Copy-on-write, so it is instant and costs no disk until something writes.
2. **Redirected environment.** `HOME` and `TMPDIR` point inside the clone.
3. **Kernel enforcement.** `sandbox-exec` on macOS, bubblewrap on Linux. Writes outside the
   clone denied, network denied, `sudo` blocked.

**What it does not protect you from:** a command doing its work in another process — `docker`,
`systemctl`, anything driving a daemon — is not stopped by a file sandbox. Bashle shims the
common ones into holes so they don't run at all, but treat probes on such scripts with the care
you'd treat running them.

## Commands

| macOS | Linux | |
|---|---|---|
| `⌘⌥R` | `Ctrl+Alt+R` | Run probes in this file |
| `⌘⌥I` | `Ctrl+Alt+I` | Inspect this line |

A file with more than one probe shows one probe's output at a time, so annotations
from different probes don't stack on the same line. In VS Code a lens above each
`# @probe` switches between them; in Vim it's `:BashleProbe`. Switching repaints
from the last run — it doesn't re-run the script.

Settings: `bashle.runOnSave`, `bashle.timeoutMs`, `bashle.enforceSandbox`, `bashle.bashPath`,
`bashle.maxRecords`, `bashle.maxCloneBytes`, `bashle.watchAllVariables`. Per-repo config goes in
`.vscode/settings.json`; see [using bashle in a real repository](docs/using-in-a-repository.md).

## Vim

Requires **Vim 9.0+** for virtual text. On 8.2 the panel and popup still work, without
end-of-line annotations.

```vim
Plug 'srj31/bashle'
```

```bash
cd ~/.vim/plugged/bashle && npm install && npm run build:cli
```

| | |
|---|---|
| `:BashleRun` · `<Leader>br` | Run probes for this file |
| `:BashleInspect` · `<Leader>bi` | Popup for the line under the cursor |
| `:BashlePanel` · `<Leader>bp` | Holes, files and output in a split |
| `:BashleProbe` · `<Leader>bn` | Show the next probe on its own — `:BashleProbe 2` picks one, `:BashleProbe all` shows every one |

Configure with `g:bashle_run_on_save`, `g:bashle_node`, `g:bashle_cli`; highlighting follows
`BashleOk` and `BashleFailed`. The plugin is only a front end — `node dist/cli.js --json <script>`
emits the whole report already rendered, so any editor can drive the same engine.

## More

- [Using bashle in a real repository](docs/using-in-a-repository.md) — `.bashleignore`, large
  repos, per-repo settings, working directory
- [How it works](docs/internals.md) — the tracer, the record format, what's covered
- [Contributing](CONTRIBUTING.md) — running it locally, the test suite
- [A semantics for holes](docs/semantics.md) — what a hole means, stated as rules, with the
  gaps named. The rules are also formalized in Lean 4 · [reading](readings/semantics.md)
- [The semantics, in Lean 4](proofs/README.md) — the rules as machine-checked definitions,
  with the theorems stated over them and proved a tier at a time. Lean checks the rules are
  coherent, not that they match bash.

## License

MIT
