# Changelog

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
