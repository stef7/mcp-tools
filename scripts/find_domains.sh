#!/usr/bin/env bash
# find_domains.sh: find short, non-premium domains that you can register on
# Cloudflare Registrar, and rank them by renewal cost.
#
#   Step 1: DNS scan (free). Keep the names that return NXDOMAIN from 1.1.1.1.
#   Step 2: Cloudflare Registrar API domain-check (beta), at most 20 names per
#           request and at most 1 request per second. Results are appended to
#           results.tsv and are resumable.
#   Step 3: Report the cheapest standard-tier names, the tiers seen and the
#           unsupported endings.
#
# It NEVER registers anything. It only calls the read-only domain-check endpoint.
#
# Needs: bash, dig, jq, curl.
# Env:   CLOUDFLARE_ACCOUNT_ID (required)
#        CLOUDFLARE_API_TOKEN  (needs Registrar write permission; never printed)
# Usage: ./find_domains.sh            # run the scan, then check, then report
#        ./find_domains.sh report     # only reprint the report from results.tsv
# Docs:  https://developers.cloudflare.com/registrar/registrar-api/

set -euo pipefail

# ---------------------------------------------------------------- settings ---
ENDINGS="dev xyz wtf cc io ps me co tv fm us"
NAME_LENGTH=2
CHARSET="abcdefghijklmnopqrstuvwxyz0123456789" # letters only: drop the digits
OUT_DIR="${OUT_DIR:-./domain-scan}"            # nx*.txt and results.tsv go here
DNS_SERVER=1.1.1.1
DNS_PARALLEL=8
BATCH_SIZE=20      # API maximum
REQUEST_GAP=1      # seconds between API requests (keeps us at or under 1 req/s)
TOP_N=30
# ------------------------------------------------------------------------------

mkdir -p "$OUT_DIR"
NX="$OUT_DIR/nx.txt"
RESULTS="$OUT_DIR/results.tsv"
API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID:-}/registrar/domain-check"

report() {
  [ -s "$RESULTS" ] || { echo "No results yet in $RESULTS"; return; }
  echo
  echo "== a) $TOP_N cheapest registrable, tier=standard, by renewal cost (USD) =="
  awk -F'\t' 'NR>1 && $2=="true" && $3=="standard"' "$RESULTS" \
    | sort -t$'\t' -k5,5g -k4,4g -k1,1 | head -n "$TOP_N" \
    | awk -F'\t' 'BEGIN{printf "%-16s %10s %10s\n","name","register","renew"}
                  {printf "%-16s %10s %10s\n",$1,$4,$5}'
  echo
  echo "== b) Distinct tier values seen (with counts) =="
  awk -F'\t' 'NR>1 && $3!="" {c[$3]++} END{for(t in c) printf "%s\t%d\n",t,c[t]}' "$RESULTS" | sort
  echo
  echo "== c) Endings that returned extension_not_supported_via_api =="
  awk -F'\t' 'NR>1 && $6=="extension_not_supported_via_api" {n=$1; sub(/^[^.]*\./,"",n); print "."n}' "$RESULTS" | sort -u
  echo
  echo "== All reasons seen, by ending =="
  awk -F'\t' 'NR>1 {n=$1; sub(/^[^.]*\./,"",n); r=($2=="true")?"registrable:"$3:$6; c[n"\t"r]++}
              END{for(k in c) printf "%s\t%d\n",k,c[k]}' "$RESULTS" | sort
}

if [ "${1:-}" = "report" ]; then report; exit 0; fi

# ------------------------------------------------------------- pre-flight ---
for bin in dig jq curl; do
  command -v "$bin" >/dev/null || { echo "Missing $bin. Install it first (dig: dnsutils/bind-utils)." >&2; exit 1; }
done
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "CLOUDFLARE_ACCOUNT_ID is not set." >&2; exit 1; }
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "WARNING: CLOUDFLARE_API_TOKEN is not set. Requests will fail unless a proxy adds auth." >&2
fi

# ------------------------------------------------- step 1: DNS NXDOMAIN scan ---
gen_names() { # print every string of length $NAME_LENGTH over $CHARSET
  local -a cur=("") next
  local i s c
  for ((i = 0; i < NAME_LENGTH; i++)); do
    next=()
    for s in "${cur[@]}"; do
      for ((c = 0; c < ${#CHARSET}; c++)); do next+=("$s${CHARSET:c:1}"); done
    done
    cur=("${next[@]}")
  done
  printf '%s\n' "${cur[@]}"
}

tag="len${NAME_LENGTH}_$(printf '%s' "$CHARSET" | cksum | cut -d' ' -f1)"
for tld in $ENDINGS; do
  f="$OUT_DIR/nx_${tld}_${tag}.txt"
  if [ -f "$f" ]; then continue; fi # cached from an earlier run; delete it to rescan
  echo "DNS scan: .$tld ..." >&2
  gen_names | xargs -P "$DNS_PARALLEL" -I{} sh -c \
    'dig +noall +comments +time=2 +tries=2 "$1.$2" NS @"$3" | grep -q NXDOMAIN && echo "$1.$2"' \
    _ {} "$tld" "$DNS_SERVER" | sort -u > "$f.tmp"
  mv "$f.tmp" "$f"
done
for tld in $ENDINGS; do cat "$OUT_DIR/nx_${tld}_${tag}.txt"; done | sort -u > "$NX"

echo "NXDOMAIN names per ending:"
for tld in $ENDINGS; do
  printf '  .%-5s %s\n' "$tld" "$(grep -c "\.$tld\$" "$NX" || true)"
done

# ------------------------------------------ step 2: Registrar domain-check ---
[ -f "$RESULTS" ] || printf 'name\tregistrable\ttier\tregistration_cost\trenewal_cost\treason\n' > "$RESULTS"

body=$(mktemp); resp=$(mktemp)
trap 'rm -f "$body" "$resp"' EXIT

requests=0
check_batch() { # args: domain names. Appends to $RESULTS. Exits on any API error.
  jq -cn '{domains: $ARGS.positional}' --args "$@" > "$body"
  local code
  # The token goes to curl on stdin (-K -), so it never shows up in ps or in logs.
  code=$(
    { [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN"; true; } |
      curl -sS -K - -o "$resp" -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' --data-binary @"$body" "$API"
  ) || code="curl-failed"
  requests=$((requests + 1))
  if [ "$code" != "200" ] || [ "$(jq -r '.success' "$resp" 2>/dev/null)" != "true" ]; then
    echo >&2
    echo "STOPPED at request $requests (HTTP $code). First name in the batch: $1" >&2
    [ "$code" = "429" ] && echo "Rate limited. Wait at least 5 minutes before re-running." >&2
    jq -c '{errors, messages}' "$resp" 2>/dev/null >&2 || head -c 500 "$resp" >&2
    echo "Checked so far: $(($(wc -l < "$RESULTS") - 1)) names in $RESULTS. Re-run to resume." >&2
    exit 1
  fi
  jq -r '.result.domains[] | [.name, (.registrable|tostring), (.tier // ""),
         (.pricing.registration_cost // ""), (.pricing.renewal_cost // ""), (.reason // "")] | @tsv' \
    "$resp" >> "$RESULTS"
  sleep "$REQUEST_GAP"
}

for tld in $ENDINGS; do
  # Skip an ending that the API has already said it doesn't support.
  if awk -F'\t' -v t=".$tld" '$6 ~ /^extension_not_supported/ && substr($1, length($1)-length(t)+1) == t {f=1} END{exit !f}' "$RESULTS"; then
    echo ".$tld: skipped (extension not supported via API)" >&2; continue
  fi
  mapfile -t todo < <(grep "\.$tld\$" "$NX" | grep -vxF -f <(cut -f1 "$RESULTS") || true)
  [ ${#todo[@]} -gt 0 ] || continue
  echo ".$tld: ${#todo[@]} names to check" >&2
  for ((i = 0; i < ${#todo[@]}; i += BATCH_SIZE)); do
    check_batch "${todo[@]:i:BATCH_SIZE}"
    printf '\r  %d/%d' "$((i + BATCH_SIZE < ${#todo[@]} ? i + BATCH_SIZE : ${#todo[@]}))" "${#todo[@]}" >&2
    # If the first batch shows the ending isn't supported, don't spend more requests on it.
    if [ "$i" -eq 0 ] && jq -e '[.result.domains[].reason] | all(. != null and startswith("extension_not_supported"))' "$resp" >/dev/null; then
      echo "  -> extension not supported via API; skipping the rest of .$tld" >&2; break
    fi
  done
  echo >&2
done
echo "API requests this run: $requests" >&2

# ----------------------------------------------------------- step 3: report ---
report
