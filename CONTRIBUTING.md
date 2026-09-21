# Contributing

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
