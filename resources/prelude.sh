: "${_BASHLE_FD:=9}"
: "${_BASHLE_MAX_RECORDS:=50000}"
: "${_BASHLE_WATCH:=}"

_bashle_emitted=0

_bashle_debug() {
  set +x
  local _bashle_status=$1 _bashle_line=$2 _bashle_source=$3
  shift 3
  local _bashle_command=$*
  if (( _bashle_emitted >= _BASHLE_MAX_RECORDS )); then
    trap - DEBUG
    printf '\036T\037%s' "$_bashle_emitted" >&"$_BASHLE_FD"
    return 0
  fi
  _bashle_emitted=$(( _bashle_emitted + 1 ))
  {
    printf '\036D\037%s\037%s\037%s\037%s\037%s\037%s\037' \
      "$_bashle_source" "$_bashle_line" "$BASH_SUBSHELL" "${FUNCNAME[1]-}" \
      "$_bashle_status" "$_bashle_command"
    if [[ -n $_BASHLE_WATCH ]]; then
      declare -p $_BASHLE_WATCH 2>/dev/null
    fi
  } >&"$_BASHLE_FD"
  set -x
}

unset BASH_ENV
PS4=$'\036X\037${BASH_SOURCE}\037${LINENO}\037${BASH_SUBSHELL}\037${FUNCNAME[0]-}\037'
export BASH_XTRACEFD="$_BASHLE_FD"
trap '_bashle_debug "$?" "$LINENO" "${BASH_SOURCE[0]}" "$BASH_COMMAND"' DEBUG
set -T
set -x
