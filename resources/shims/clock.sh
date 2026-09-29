# shims: date
# fills: cmd
# real-binary: required

# shellcheck shell=bash
# The real `date`, pinned to one instant so two runs agree while formatting
# still works. GNU date takes `-d @epoch`; BSD date takes `-r epoch`.
#
# The `_bashle_*` names are the values and helpers from _preamble.sh, which
# runs before this file in every generated shim.

_bashle_command_request "$@"
_bashle_answer_from_fills cmd
_bashle_record clock "$_bashle_request" 0 prefilled
"$_bashle_real" -d "@$_bashle_epoch" "$@" 2>/dev/null || "$_bashle_real" -r "$_bashle_epoch" "$@"
