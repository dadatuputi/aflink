#!/usr/bin/env bash
# Print the commit message for an AF Portal sync (portal_sync.yml,
# link_update_af.yml): the counts from af-import-stats.js in the subject, and
# one Portal-Source trailer per page, then any further trailers given.
#
#   sync-commit-message.sh STATS_FILE SOURCES [Key=value ...]
#
# SOURCES is the comma-separated page list (index:... or quicklinks:...).
set -euo pipefail

stats_file=$1 sources=$2
shift 2

# "1520 links total: 3 added, 0 changed, 2 deprecated, ..." -> "3 added, 2 deprecated"
counts=$(head -n1 "$stats_file" | sed 's/^[0-9]* links total: //' | tr ',' '\n' \
  | sed 's/^ *//' | grep -v '^0 ' | paste -sd, - | sed 's/,/, /g' || true)

IFS=, read -ra pages <<< "$sources"
n=${#pages[@]}
subject="Portal sync of $n page$([[ $n == 1 ]] || echo s): ${counts:-no link changes}"

trailers=()
for p in "${pages[@]}"; do trailers+=("Portal-Source=$p"); done
exec "$(dirname "$0")/commit-message.sh" "$subject" "${trailers[@]}" "$@"
