# shellcheck shell=bash
# Shared by every shim. It runs after the values bashle writes for this run:
#
#   _bashle_name           the command this shim stands in for
#   _bashle_real           the real binary, when the file asks for one
#   _bashle_epoch          the pinned clock, in seconds
#   _bashle_fill_requests  the fills of this file's kind, as parallel arrays:
#   _bashle_fill_bodies      the exact request, what to print, and the status
#   _bashle_fill_codes       to exit with
#
# Files starting with `_` are shared, not shims. Every other `*.sh` here opens
# with `# key: value` lines, which end at the first line that is not one:
#
#   # shims: <name> ...      the commands this file stands in for (repeatable)
#   # fills: net|cmd         which fills it answers from; none without this
#   # real-binary: required  resolve $_bashle_real, and skip a name without one

_bashle_token="$$.$RANDOM"

# Small enough to stay under PIPE_BUF (512 bytes on macOS), so it cannot
# interleave with the tracer's own writes to fd 9. The body never goes here.
_bashle_record() {
  local request=$2
  (( ${#request} > 400 )) && request="${request:0:400}…"
  printf '\036H\037%s\037%s\037%s\037%s\037%s\037' \
    "$1" "$request" "$_bashle_token" "$3" "$4" >&9 2>/dev/null || :
}

# For a command keyed on its whole argv: the name, then the arguments.
_bashle_command_request() {
  if (( $# )); then _bashle_request="$_bashle_name $*"; else _bashle_request=$_bashle_name; fi
}

# Answers from the first fill whose request matches, and exits; returns only
# when none does. The right-hand side is quoted, because a request containing
# `*`, `?` or `[` is otherwise a glob and would match the wrong thing.
# $1 is the kind to record; $2, when set, is a file to write the body to.
_bashle_answer_from_fills() {
  local i
  for i in "${!_bashle_fill_requests[@]}"; do
    [[ $_bashle_request == "${_bashle_fill_requests[i]}" ]] || continue
    _bashle_record "$1" "$_bashle_request" "${_bashle_fill_codes[i]}" filled
    if [[ -n ${2-} ]]; then printf '%s' "${_bashle_fill_bodies[i]}" > "$2"
    else printf '%s' "${_bashle_fill_bodies[i]}"; fi
    exit "${_bashle_fill_codes[i]}"
  done
}

# An unknown answers with the sentinel and succeeds, so `set -e` cannot end
# the run.
_bashle_open_hole() {
  _bashle_record "$1" "$_bashle_request" 0 open
  printf '\001h%s\001' "$_bashle_token"
  exit 0
}
