# shims: cat head tail tac nl wc sort uniq cut od xxd base64 cksum shasum md5sum
# shims: file stat realpath readlink du
# real-binary: required

# shellcheck shell=bash
# Every non-flag argument to these is a file, so the shim can test existence
# without parsing a grammar. `grep`, `sed`, `awk` and `jq` are deliberately
# absent: their first non-flag argument is a pattern, and a wrong guess would
# invent a hole for a file nobody named.
#
# Passes through when every named file is there, and holes only on genuine
# absence — a file that is in the clone stays real, which is the point of the
# clone. A `@file` fill never reaches the hole, because materialization put
# the file on disk before the run started.
#
# The `_bashle_*` names are the values and helpers from _preamble.sh, which
# runs before this file in every generated shim.

_bashle_missing=
_bashle_skip_next=
for _bashle_arg in "$@"; do
  if [[ -n $_bashle_skip_next ]]; then _bashle_skip_next=; continue; fi
  case "$_bashle_arg" in
    -|--) continue ;;
    # A lone short flag is the shape that takes a separate value, so whatever
    # follows it is not a filename. Skipping it can miss a hole; not skipping
    # it would invent one for a value like the 2 in "head -n 2", and a false
    # hole is the worse failure by far.
    -[a-zA-Z]) _bashle_skip_next=1; continue ;;
    -*) continue ;;
  esac
  [[ -e $_bashle_arg ]] || { _bashle_missing=$_bashle_arg; break; }
done

if [[ -z $_bashle_missing ]]; then
  exec "$_bashle_real" "$@"
fi

_bashle_request=$_bashle_missing
_bashle_open_hole file
