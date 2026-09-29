# shims: hostname whoami uuidgen
# fills: cmd

# shellcheck shell=bash
# Answered from a fixed default so they do not drown the list of real
# unknowns. A `@cmd` fill still wins.
#
# The `_bashle_*` names are the values and helpers from _preamble.sh, which
# runs before this file in every generated shim.

_bashle_command_request "$@"
_bashle_answer_from_fills cmd
_bashle_record cmd "$_bashle_request" 0 prefilled
case $_bashle_name in
  hostname|whoami) printf '%s\n' bashle ;;
  uuidgen) printf '%s\n' 00000000-0000-4000-8000-000000000000 ;;
esac
exit 0
