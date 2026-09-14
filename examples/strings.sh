#!/usr/bin/env bash

# @probe "a//b/../c" => "a/b/../c"
collapse_slashes() {
  echo "${1//\/\//\/}"
}

# @probe 2 3 => "5"
add() {
  echo $(( $1 + $2 ))
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  collapse_slashes "$@"
fi
