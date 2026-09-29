#!/bin/sh
# Prints the folder of every worker a change touches, one per line: `changed-workers.sh BASE [HEAD]`.
# Every worker when the change touches what they are all built from (core/, the root package or
# tsconfig) or how they are shipped (the ci workflow, this script), and every worker when BASE is
# empty or unknown — a first push, or a run by hand.
set -eu
base=${1:-}
head=${2:-HEAD}
every() { for d in workers/*/; do [ -f "${d}wrangler.json" ] && echo "${d%/}"; done; }
if [ -z "$base" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then every; exit 0; fi
files=$(git diff --name-only "$base...$head")
if printf '%s\n' "$files" | grep -qE '^(core/|package(-lock)?\.json$|tsconfig|\.github/workflows/ci\.yml$|scripts/changed-workers\.sh$)'; then every; exit 0; fi
# A deleted worker's folder shows up in the diff too; only folders that still hold one count.
printf '%s\n' "$files" | sed -n 's|^\(workers/[^/]*\)/.*|\1|p' | sort -u |
  while read -r d; do if [ -f "$d/wrangler.json" ]; then echo "$d"; fi; done
