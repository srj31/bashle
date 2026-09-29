# shims: curl wget
# fills: net

# shellcheck shell=bash
# The request is `<METHOD> <url>`. Only a known subset of flags is understood;
# anything else is skipped, and an invocation with no recognisable URL still
# produces a request rather than failing.
#
# The `_bashle_*` names are the values and helpers from _preamble.sh, which
# runs before this file in every generated shim.

_bashle_method=GET
_bashle_url=
_bashle_output=
while (( $# )); do
  case "$1" in
    -X|--request) _bashle_method="${2-}"; shift; shift 2>/dev/null || : ;;
    -d|--data|--data-raw|--data-binary|--data-urlencode)
      _bashle_method=POST; shift; shift 2>/dev/null || : ;;
    -o|--output) _bashle_output="${2-}"; shift; shift 2>/dev/null || : ;;
    http://*|https://*) _bashle_url="$1"; shift ;;
    *) shift ;;
  esac
done
_bashle_request="$_bashle_method $_bashle_url"

_bashle_answer_from_fills net "$_bashle_output"
_bashle_open_hole net
