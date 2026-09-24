# Changelog

## Unreleased

- Files with more than one probe now show one probe's output at a time, so annotations from
  different probes no longer stack on the same line. In VS Code a lens above each `# @probe`
  switches between them; in Vim it is `:BashleProbe` (`<Leader>bn` to cycle, a number to pick
  one, `all` for every probe). Switching repaints from the last run and never re-runs the script.
- `proofs/`: the holes semantics formalized in Lean 4 — the small-step rules, an executable
  `step?` that mirrors them, and the theorems from `docs/semantics.md` stated over them. Lean
  checks the rules are internally coherent, not that they describe bash.
- Packaging: `proofs/` and `coverage/` no longer ship inside the extension.

- `.bashleignore`: exclude paths from the scratch clone using `.gitignore` syntax, negation included.
  `.git` and `node_modules` are now skipped by default — a `!node_modules` line wins them back.
- `maxCloneBytes` now measures only the files that will actually be copied, so a large `node_modules`
  no longer pushes a workspace over the limit.

## 0.1.0

First release.

- Inline annotations on save: the expanded command bash actually ran, exit-code badges, iteration
  counts, and the values of variables each line mentions.
- Hover a line for every execution of it, numbered, with its own expansion and variables.
- Panel with **Files** (created, modified and deleted, with diffs), **Trace** and **Output** tabs.
- `# @probe` comments, with `@env` and `@stdin` modifiers and `=> exit N` / `=> "text"` expectations.
  Probes attach to the file or to a single function.
- Containment in three layers: a copy-on-write clone of the workspace, a redirected `HOME` and
  `TMPDIR`, and kernel enforcement — `sandbox-exec` on macOS, bubblewrap on Linux — denying writes
  outside the clone, the network, and `sudo`. When kernel enforcement is unavailable the run still
  happens and says so rather than claiming containment it does not have.
