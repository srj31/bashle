# Using bashle in a real repository

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
