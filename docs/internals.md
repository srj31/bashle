# How bashle works

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

## Coverage

Bashle is being built out iteratively, starting with the constructs that carry most scripts:

**Working now** — assignments, simple commands, `for` / `while` / `until`, `if` / `case`,
functions, variable expansion and word splitting, redirections, exit codes, file manipulation.

**Not yet** — per-stage attribution inside pipelines (a pipeline is reported as one line), values
inside subshells and process substitution, `trap` handlers you install yourself (bashle's own
`DEBUG` and `EXIT` traps will be replaced by them), and scripts that re-enter bash as a child process.

The trace model already records subshell level and nesting depth, so widening coverage is additive.

**Vim** — shipped. See *Using it from Vim* below. Neovim is not covered: it implements
neither Vim's text properties nor `popup_create`, though it has equivalents, and the display
layer is isolated enough that a Neovim backend can be added without reworking the rest.
