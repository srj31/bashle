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
- Fixed: a `=> @path` fixture on a `@net` or `@cmd` fill was ignored, so the command answered with
  nothing and the hole was still reported as filled. Fixtures now work for every fill, and one that
  can't be read gives a warning and leaves the hole open. ([#9](https://github.com/srj31/bashle/issues/9))
- Fixed: `@stdin` sent its text without a trailing newline, so `read` failed at end of input and a
  script under `set -e` stopped there. It is now one line of input, like bash's `<<<`.
- A line that runs more than once no longer shows a `×N` count. Each variable on it lists every
  value it had, in order, like `f=a.txt · b.txt · c.txt` on a loop, so you can see what the loop
  went through. On the line that sets a variable, like `for f in …` or `total=$((total + 1))`, those
  are the values it was set to. A long list ends with `… +N more`.
- Fixed: a line with a command substitution, like `x=$(echo hi)`, counted as three executions, and
  took a failed status from the command before it. It is now one run, with its own exit status.
  ([#6](https://github.com/srj31/bashle/issues/6))
- Variables assigned partway along a line, like `v` in `for i in 1 2; do v=$(echo $i); done`, are
  now recorded, not only those assigned at the start of one.
- Fixed: a heredoc opener with mismatched quotes, like `<<'EOF`, was taken as the fill's literal
  value with no error. It is now reported on its line, and the fill is dropped.
  ([#8](https://github.com/srj31/bashle/issues/8))
- Docs: a shorter README that shows the problem first, and a new [guide](docs/guide.md) to using bashle.
- Docs: installing for VS Code now points only to Open VSX.

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
