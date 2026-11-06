#!/usr/bin/env bash
# Print a bot commit message: one subject line, then git trailers, so scripts
# can read the metadata back without parsing prose:
#   git log --format='%(trailers:key=Issue,valueonly)'
#
#   commit-message.sh SUBJECT [Key=value ...]
#
# Each Key=value becomes a "Key: value" trailer, in order; a key may repeat.
# A pair with an empty value is left out. Newlines in the subject or a value
# (they come from issue forms) are folded to spaces.
set -euo pipefail

fold() { tr '\r\n' '  ' <<< "$1" | sed 's/ *$//'; }

subject=$(fold "$1")
shift
args=()
for kv in "$@"; do
  value=$(fold "${kv#*=}")
  [[ -n "$value" ]] && args+=(--trailer "${kv%%=*}: $value")
done
if (( ${#args[@]} )); then
  printf '%s\n' "$subject" | git interpret-trailers "${args[@]}"
else
  printf '%s\n' "$subject"
fi
