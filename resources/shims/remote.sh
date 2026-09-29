# shims: nc docker systemctl launchctl ssh aws kubectl
# fills: cmd

# shellcheck shell=bash
# These do their work in another process, which a file sandbox cannot
# contain, so they never run for real. The request is the whole command line.
#
# The `_bashle_*` names are the values and helpers from _preamble.sh, which
# runs before this file in every generated shim.

_bashle_command_request "$@"
_bashle_answer_from_fills cmd
_bashle_open_hole cmd
