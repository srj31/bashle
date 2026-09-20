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

## The problem

A bash script's bugs are almost never logic bugs. They're **expansion bugs**: an empty variable, an
unquoted word that split into three, a glob that matched nothing. `shellcheck` catches some of them
statically. A test tells you *that* something failed. Neither shows you the thing you actually need:

```bash
cp "$f" "$dest/$(date +%F)/"
```

What did bash *run*? With bashle, the answer is on the line, the moment you save:

```bash
dest=                              dest=''
for f in $files; do                ×3  f='my report.txt'
  cp "$f" "$dest/"                 cp 'my report.txt' '/'  ✗1
done
```

`$dest` was empty, and you can see it in the command that ran. No test run, no guessing.

## Requirements

| | |
|---|---|
| **bash ≥ 4.1** | For `BASH_XTRACEFD`. Every current Linux distribution ships 5.x. macOS ships bash **3.2**, which will not work — `brew install bash` and bashle finds it automatically. |
| **macOS or Linux** | Kernel containment is `sandbox-exec` on macOS and [bubblewrap](https://github.com/containers/bubblewrap) on Linux — `apt install bubblewrap`, `dnf install bubblewrap`, `pacman -S bubblewrap`. Without it bashle still runs, and says on every run that only the clone is containing it. |
| **VS Code ≥ 1.85** | |

## Install

Not on the Marketplace yet, so build the `.vsix` and install it:

```bash
git clone https://github.com/srj31/bashle && cd bashle
npm install
npm run package
code --install-extension bashle-0.1.0.vsix     # or: cursor --install-extension ...
```

On Linux, install bubblewrap too — it is what enforces containment there:

```bash
sudo apt install bubblewrap        # or dnf / pacman / zypper
```

Reload the window. Bashle activates on any file VS Code recognises as `shellscript`.

## Quick start

1. Open a `.sh` file.
2. Add a probe comment saying how to run it.
3. Save.

```bash
# @probe staging --dry-run
set -euo pipefail

target="$1"
mkdir -p "releases/$target"
echo "deploying to $target" > "releases/$target/log.txt"
```

On save you get expansions and exit codes inline, and a **Files** panel showing that the run created
`releases/staging/` and `releases/staging/log.txt` — in a throwaway clone, not in your repo.

## Probes

A probe is a comment. One rule: `# @probe <shell words>`, interpreted against whatever it is attached to.

```bash
# @probe staging --dry-run          ← attached to the file: the script's "$@"
# @probe prod => exit 1             ← with an expected exit code

# @probe "a//b" => "a/b"            ← attached to a function: the function's args
normalize_path() {
  echo "${1//\/\//\/}"
}
```

**Modifiers** apply to every probe in the same comment block:

```bash
# @env DEPLOY_ENV=staging
# @stdin "yes"
# @probe --interactive
```

**Expectations** are optional. `=> exit N` checks the exit code; `=> "text"` checks stdout with the
trailing newline ignored. Without one you just get the observed values, no verdict.

Several probes can share a target — each runs in its own clean clone:

```bash
# @probe 2 3 => "5"
# @probe -1 1 => "0"
add() { echo $(( $1 + $2 )); }
```

> **Function probes source your script.** If it has no `[[ "${BASH_SOURCE[0]}" == "$0" ]]` guard
> around its main body, that body runs first. Bashle detects this and says so rather than letting you
> wonder where the extra output came from.

## What you get

**Inline** — the expanded command, an `✗N` badge on a nonzero exit, `×N` when a line ran more than
once, and the values of variables that line mentions.

**On hover** — every execution of that line, numbered, with its own expansion, exit code and variables.

**In the panel** — three tabs:

- **Files** *(default)* — what the run created, modified and deleted, with diffs. For a file-manipulation
  script this is the real output.
- **Trace** — every executed line in order: line number, iteration, the command as bash ran it, exit code, variables.
- **Output** — the script's own stdout and stderr, kept separate from the trace.

## Containment

Probe runs execute real commands. Bashle contains them in three layers, and tells you which ones are active.

1. **Scratch clone.** Your workspace is cloned copy-on-write — `cp -c` (APFS clonefile) on macOS,
   `cp --reflink=auto` (btrfs, xfs) on Linux — so it is instant and consumes no disk until something
   writes; on a filesystem without copy-on-write it falls back to a plain copy. The script runs with
   its cwd there, so relative paths hit the clone, and they hit files that genuinely exist.
2. **Redirected environment.** `HOME` and `TMPDIR` point inside the clone, so `~/.config/...` and
   `mktemp` are contained too.
3. **Kernel enforcement.** All writes outside the clone are denied, the network is denied outright,
   and `sudo` cannot be executed. A blocked write fails visibly instead of silently succeeding.
   On macOS this is a `sandbox-exec` profile; on Linux it is bubblewrap, which binds the whole
   filesystem read-only, rebinds only the clone writable, and puts the run in its own network and
   PID namespaces.

Afterwards the clone is diffed against your pristine workspace to produce the Files tab, then deleted.

**What this does not protect you from.** A command that does its work in another process — `docker`,
`launchctl`, `systemctl`, anything talking to a system daemon — is not stopped by a file sandbox.
Treat probes on scripts like those with the same care you'd treat running them.

**If the sandbox is unavailable**, bashle does not refuse to run and does not pretend. The status bar
shows `⛨` when kernel enforcement is on and `⚠` when only layers 1–2 are, so you are never guessing
about which you have, and every degraded run carries a warning naming what is missing — bubblewrap not
installed, unprivileged user namespaces disabled, or a kernel that refused a network namespace (some
container runtimes do, and the run is then contained on disk but can still reach the network).

## Using it in a real repository

**Probes live in your scripts.** They're comments, so they commit with the code and travel with the
repo. A teammate without bashle installed just sees a comment saying how the script is meant to be run
— which is documentation you probably wanted anyway.

**The working directory is the workspace root**, not the script's directory. A script at
`scripts/build.sh` that reads `data.txt` gets the `data.txt` at your repo root. If your script expects
to run from its own directory, anchor it the usual way:

```bash
cd "$(dirname "$0")"
```

Paths in the **Files** tab are relative to the workspace root too, so they read the same as `git status`.

**Per-repo settings** go in `.vscode/settings.json` and commit with the repo:

```json
{
  "bashle.runOnSave": false,
  "bashle.timeoutMs": 15000,
  "bashle.maxCloneBytes": 2147483648
}
```

`runOnSave: false` is worth considering for a repo whose scripts are slow or heavy — you then drive it
with `⌘⌥R` / `Ctrl+Alt+R` when you actually want a run.

**On a large repo**, the clone itself is instant on a copy-on-write filesystem (no disk used until
something writes), but bashle measures what it is about to copy and refuses above `maxCloneBytes`
(512 MB by default). `.git` and `node_modules` are not copied at all, so they count against neither the
limit nor the diff. To skip more, put a `.bashleignore` beside your scripts:

```gitignore
# Same syntax as .gitignore, including negation.
vendor/
*.tar.gz
fixtures/**/*.bin

# The two built-in defaults can be won back if a script really needs them:
# !node_modules
```

Only the `.bashleignore` at the workspace root is read; `.gitignore` is deliberately *not* consulted, so
build output a script under test reads — `dist/`, `.env` — still reaches the sandbox.

**Before you probe a script with real side effects**, know exactly what the sandbox covers. Writes
outside the clone, network access and `sudo` are blocked by the kernel. Commands that do their work in
*another* process — `docker`, `launchctl`, anything driving a system daemon — are not, because the file
sandbox only constrains the process it wrapped. For scripts like those, keep `runOnSave` off and read
the trace before you trust it.

## Supported today

Bashle is being built out iteratively, starting with the constructs that carry most scripts:

**Working now** — assignments, simple commands, `for` / `while` / `until`, `if` / `case`,
functions, variable expansion and word splitting, redirections, exit codes, file manipulation.

**Not yet** — per-stage attribution inside pipelines (a pipeline is reported as one line), values
inside subshells and process substitution, `trap` handlers you install yourself (bashle's own
`DEBUG` and `EXIT` traps will be replaced by them), and scripts that re-enter bash as a child process.

The trace model already records subshell level and nesting depth, so widening coverage is additive.

**Planned — Vim** — a Vim 8.2+ plugin is planned. The core is already editor-agnostic: only
`src/extension.ts`, `src/decorations.ts` and `src/panel.ts` import `vscode`, and `src/cli.ts`
already runs probes headlessly. The plugin will drive that CLI in a machine-readable mode over
`job_start`, then render annotations as `prop_add` virtual text, per-line drill-down in a
`popup_create` window, and the panel in a split scratch buffer. Neovim is not covered by that plan —
it implements neither text properties nor `popup_create` — but the display layer will be isolated so
a Neovim backend can be added without reworking the rest.

## Settings

| Setting | Default | |
|---|---|---|
| `bashle.bashPath` | *(auto)* | Path to a bash ≥ 4.1. Auto-discovers Homebrew on macOS, `/usr/bin/bash` on Linux, then `PATH`. |
| `bashle.runOnSave` | `true` | Run probes on save. Turn off to drive it with `⌘⌥R` / `Ctrl+Alt+R` only. |
| `bashle.timeoutMs` | `5000` | Kill a probe run after this long. The partial trace is kept. |
| `bashle.enforceSandbox` | `true` | Kernel enforcement — `sandbox-exec` on macOS, bubblewrap on Linux. Turning it off leaves only the clone containing the run. |
| `bashle.maxRecords` | `50000` | Stop tracing after this many events and mark the trace truncated. |
| `bashle.maxCloneBytes` | `512 MB` | Refuse to clone a workspace larger than this, counting only what `.bashleignore` keeps. |
| `bashle.watchAllVariables` | `false` | Snapshot every variable instead of only those the script names. Slower. |

## Commands

| macOS | Linux | |
|---|---|---|
| `⌘⌥R` | `Ctrl+Alt+R` | Run probes in this file |
| `⌘⌥I` | `Ctrl+Alt+I` | Inspect this line (opens the Trace tab) |
| — | — | Bashle: Show panel · Bashle: Clear annotations |

## How it works

No source rewriting — your file is never modified. The tracer is injected through `BASH_ENV`, which
bash sources before a non-interactive script:

- `PS4` is set to emit a structured record with `BASH_SOURCE`, `LINENO` and `BASH_SUBSHELL`, and
  `set -x` writes it to **file descriptor 9** via `BASH_XTRACEFD` — so the trace never collides with
  your script's own stdout or stderr.
- A `DEBUG` trap with `set -T` records the unexpanded command, the previous command's exit status,
  and a `declare -p` snapshot of the variables your script actually names.
- Records are `\x1f`-delimited fields in `\x1e`-delimited records, which bash emits with a single
  `printf` and no quoting hazards.

Pairing those two streams is less obvious than it sounds — `for` loops emit their xtrace line
*before* the `DEBUG` trap fires, so the parser matches in either order and attributes each exit code
to the command that actually preceded it.

## Running it locally

```bash
npm install
```

### In the terminal, without VS Code

The fastest loop. `npm run probe` runs every probe in a file through the real engine — same tracer,
same sandbox — and prints the annotations inline.

```bash
npm run probe -- examples/deploy.sh
```

```
 15   mkdir -p "$dest"                    mkdir -p releases/staging  dest=releases/staging
 17   for artifact in app.js styles.css readme md; do   ×4  ✗1  artifact=readme
 18     cp "artifacts/$artifact" "$dest/"  ×4  cp artifacts/md releases/staging/  ✗1  artifact=md

 files changed in the sandbox
   + releases/staging/app.js
   + releases/staging/status.txt
   + releases/staging/styles.css
 exit 0 · ⛨ sandboxed
```

`examples/deploy.sh` has a deliberate bug: `readme md` is unquoted, so it splits into two words and
the loop runs **four** times instead of three. You can see it in the iteration count, in the failing
`cp artifacts/md`, and in the Files list where `readme md` was never copied — and your real
`examples/` directory is untouched.

### In VS Code

1. Open this folder in VS Code.
2. Press **F5** (*Run Bashle in a new VS Code window*). It builds first, then opens a second window
   with the extension loaded and `examples/` as its workspace.
3. Open `examples/deploy.sh` in that window and hit **⌘S** / **Ctrl+S**.

Annotations appear at end of line, hover a line for every execution of it, and `⌘⌥I` / `Ctrl+Alt+I`
opens the panel. Edit and save again to watch it update. Extension logs go to the *Debug Console* of
the first window; reload the second window after changing extension code.

### Tests

```bash
npm test              # 156 tests, including end-to-end runs against real bash and a real sandbox
npm run test:coverage # the same run, plus coverage/ (open coverage/lcov-report/index.html)
npm run build         # bundle to dist/extension.js
npm run typecheck
```

The containment tests are adversarial on purpose: scripts that try to write to `/tmp`, to an absolute
path back inside the real workspace, to delete real files, and to open a socket must each be blocked
*and* reported. They run against whichever sandbox the host has, so the suite is the check that the
port holds on both platforms.

## License

MIT
