#!/usr/bin/env bash
# find_domains.sh: find short, non-premium domains that you can register on
# Cloudflare Registrar, and rank them by renewal cost.
#
#   Step 1: DNS scan (free). Keep the names that return NXDOMAIN from 1.1.1.1.
#   Step 2: Cloudflare Registrar API domain-check (beta), at most 20 names per
#           request, one request every REQUEST_GAP seconds. Results are appended
#           to results.tsv, and names already there are never checked again.
#   Step 3: Report the cheapest standard-tier names, the tiers seen and the
#           unsupported endings, for the names in this run's scope.
#
# It NEVER registers anything. It only calls the read-only domain-check endpoint.
#
# Needs: bash, dig, jq, curl.
# Env:   CLOUDFLARE_ACCOUNT_ID (required)
#        CLOUDFLARE_API_TOKEN  (needs Registrar write permission; never printed)
#        OUT_DIR               (default ./domain-scan)
# Docs:  https://developers.cloudflare.com/registrar/registrar-api/

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: find_domains.sh [options] [report]

  With no options it scans every NAME_LENGTH-character name over CHARSET on
  every ending in ENDINGS (the defaults below). Options narrow or change that:

  -e "wtf dev"    endings to use (leading dots are fine: ".wtf .dev")
  -l 3            name length for generated names
  -c abc123       characters for generated names
  -m REGEX        keep only names matching this extended regex (grep -E),
                  e.g. '^4q' or '^[a-z]+$' (letters only) or '^(.)\1' (doubled start)
  -n "4q 2c fork" check these exact names instead of generating them; repeatable.
                  A name with a dot ("4q.wtf") is checked as-is, whatever -e says.
  -f FILE         like -n, one name per line (# starts a comment)
  -g SECONDS      gap between API requests (default 4)
  -x N            stop after N API requests this run (default 300); re-run to continue
  -a              report on everything in results.tsv, not just this run's scope
  -h              this help

  report          skip the scan and the API; just print the report for the scope

Examples:
  find_domains.sh -e wtf -l 3 -m '^[a-z]+$'   # all 3-letter .wtf names, letters only
  find_domains.sh -e "wtf dev" -n "4q 2c a4"  # three names on two endings
  find_domains.sh -n "4qq.wtf fork.wtf"       # two exact domains
  find_domains.sh -e wtf -l 3 -m '^4q' report # report only, for 4q?.wtf
EOF
}

# ---------------------------------------------------------------- defaults ---
ENDINGS="dev xyz wtf cc io ps co tv fm us"
NAME_LENGTH=2
CHARSET="abcdefghijklmnopqrstuvwxyz0123456789" # letters only: drop the digits
MATCH=""           # extended regex that generated or given names must match
NAMES=""           # explicit names (overrides NAME_LENGTH and CHARSET)
REQUEST_GAP=4      # seconds between API requests (domain-check hit HTTP 429 at ~0.7 req/s)
MAX_REQUESTS=300   # per run; the run stops cleanly and resumes next time
REPORT_ALL=0
OUT_DIR="${OUT_DIR:-./domain-scan}" # nx*.txt and results.tsv go here
DNS_SERVER=1.1.1.1
DNS_PARALLEL=8
BATCH_SIZE=20      # API maximum
TOP_N=30
# ------------------------------------------------------------------------------

while getopts 'e:l:c:m:n:f:g:x:ah' opt; do
  case $opt in
    e) ENDINGS="$OPTARG" ;;
    l) NAME_LENGTH="$OPTARG" ;;
    c) CHARSET="$OPTARG" ;;
    m) MATCH="$OPTARG" ;;
    n) NAMES="$NAMES $OPTARG" ;;
    f) NAMES="$NAMES $(sed 's/#.*//' "$OPTARG")" ;;
    g) REQUEST_GAP="$OPTARG" ;;
    x) MAX_REQUESTS="$OPTARG" ;;
    a) REPORT_ALL=1 ;;
    h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
MODE="${1:-scan}"
case $MODE in scan | report) ;; *) usage >&2; exit 2 ;; esac

ENDINGS=$(printf '%s\n' $ENDINGS | tr 'A-Z' 'a-z' | sed 's/^\.*//' | awk 'NF && !seen[$0]++' | tr '\n' ' ')
CHARSET=$(printf '%s' "$CHARSET" | tr 'A-Z' 'a-z')
[[ "$CHARSET" =~ ^[a-z0-9-]+$ ]] || { echo "CHARSET may only contain a-z, 0-9 and -." >&2; exit 2; }
[[ "$NAME_LENGTH" =~ ^[1-9][0-9]?$ ]] || { echo "Name length must be 1-99." >&2; exit 2; }

mkdir -p "$OUT_DIR"
NX="$OUT_DIR/nx.txt"             # NXDOMAIN names in this run's scope
SCOPE="$OUT_DIR/scope.txt"       # every candidate domain in this run's scope
RESULTS="$OUT_DIR/results.tsv"
API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID:-}/registrar/domain-check"

ending_of() { awk '{e=$0; sub(/^[^.]*\./,"",e); print e}'; }
only_ending() { awk -v t="$1" '{e=$0; sub(/^[^.]*\./,"",e)} e==t'; }
unsupported() { # has the API already said that ending $1 isn't supported?
  [ -f "$RESULTS" ] && awk -F'\t' -v t="$1" \
    '$6 ~ /^extension_not_supported/ {e=$1; sub(/^[^.]*\./,"",e); if (e==t) f=1} END{exit !f}' "$RESULTS"
}

# ------------------------------------------------------- build the scope ---
gen_names() { # every string of length $NAME_LENGTH over $CHARSET, via brace expansion
  local set expr
  set=$(printf '%s' "$CHARSET" | sed 's/./&,/g; s/,$//')
  expr=$(printf "{$set}%.0s" $(seq "$NAME_LENGTH"))
  eval "printf '%s\n' $expr" # safe: CHARSET is checked to be [a-z0-9-] above
}

labels=$(mktemp); fulls=$(mktemp); body=$(mktemp); resp=$(mktemp)
trap 'rm -f "$labels" "$fulls" "$body" "$resp"' EXIT

if [ -n "${NAMES// /}" ]; then
  printf '%s\n' $NAMES | tr 'A-Z' 'a-z' | grep -v '\.' > "$labels" || true
  printf '%s\n' $NAMES | tr 'A-Z' 'a-z' | grep '\.' > "$fulls" || true
else
  gen_names > "$labels"
fi
if [ -n "$MATCH" ]; then grep -E -- "$MATCH" "$labels" > "$labels.m" || true; mv "$labels.m" "$labels"; fi
# Valid DNS labels only: 1-63 of a-z 0-9 -, not starting or ending with a hyphen.
bad=$(grep -cvE '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' "$labels" || true)
[ "$bad" -eq 0 ] || echo "Dropping $bad invalid name(s)." >&2
grep -E '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' "$labels" > "$labels.v" || true; mv "$labels.v" "$labels"

{ for tld in $ENDINGS; do sed "s/\$/.$tld/" "$labels"; done; cat "$fulls"; } | awk 'NF' | sort -u > "$SCOPE"
# Endings in scan order: -e order first, then any that only the exact domains use.
# With only exact domains (no plain names), -e endings have nothing to scan, so leave them out.
SCAN_ENDINGS=$({ [ -s "$labels" ] && printf '%s\n' $ENDINGS; ending_of < "$fulls"; } | awk 'NF && !seen[$0]++' | tr '\n' ' ')
[ -s "$SCOPE" ] || { echo "Nothing to check: the options leave no names." >&2; exit 1; }

report() {
  [ -s "$RESULTS" ] || { echo "No results yet in $RESULTS"; return; }
  local rows
  rows=$(mktemp)
  if [ "$REPORT_ALL" = 1 ]; then
    awk 'NR>1' "$RESULTS" > "$rows"
  else
    awk -F'\t' 'NR==FNR {s[$0]=1; next} FNR>1 && ($1 in s)' "$SCOPE" "$RESULTS" > "$rows"
  fi
  echo
  echo "Report on $(wc -l < "$rows") checked name(s) $([ "$REPORT_ALL" = 1 ] && echo "(all of results.tsv)" || echo "in this run's scope of $(wc -l < "$SCOPE")")."
  echo
  echo "== a) $TOP_N cheapest registrable, tier=standard, by renewal cost (USD) =="
  awk -F'\t' '$2=="true" && $3=="standard"' "$rows" \
    | sort -t$'\t' -k5,5g -k4,4g -k1,1 | head -n "$TOP_N" \
    | awk -F'\t' 'BEGIN{printf "%-20s %10s %10s\n","name","register","renew"}
                  {printf "%-20s %10s %10s\n",$1,$4,$5}'
  echo
  echo "== b) Distinct tier values seen (count; registrable=true / false) =="
  echo "   (the API sets tier on unavailable names too, so most 'standard' rows are not for sale)"
  awk -F'\t' '$3!="" {c[$3]++; if($2=="true") y[$3]++; else n[$3]++}
              END{for(t in c) printf "%s\t%d\t(%d / %d)\n",t,c[t],y[t],n[t]}' "$rows" | sort
  echo
  echo "== c) Endings that returned extension_not_supported_via_api =="
  awk -F'\t' '$6=="extension_not_supported_via_api" {n=$1; sub(/^[^.]*\./,"",n); print "."n}' "$rows" | sort -u
  echo
  echo "== All reasons seen, by ending =="
  awk -F'\t' '{n=$1; sub(/^[^.]*\./,"",n); r=($2=="true")?"registrable:"$3:$6; c[n"\t"r]++}
              END{for(k in c) printf "%s\t%d\n",k,c[k]}' "$rows" | sort
  rm -f "$rows"
}

if [ "$MODE" = report ]; then report; exit 0; fi

# ------------------------------------------------------------- pre-flight ---
for bin in dig jq curl; do
  command -v "$bin" >/dev/null || { echo "Missing $bin. Install it first (dig: dnsutils/bind-utils)." >&2; exit 1; }
done
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "CLOUDFLARE_ACCOUNT_ID is not set." >&2; exit 1; }
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "WARNING: CLOUDFLARE_API_TOKEN is not set. Requests will fail unless a proxy adds auth." >&2
fi
echo "Scope: $(wc -l < "$SCOPE") candidate domain(s) on: $SCAN_ENDINGS" >&2

# ------------------------------------------------- step 1: DNS NXDOMAIN scan ---
: > "$NX"
for tld in $SCAN_ENDINGS; do
  subset=$(only_ending "$tld" < "$SCOPE")
  [ -n "$subset" ] || continue
  # The cache is keyed on the exact list of names, so any change of options rescans.
  f="$OUT_DIR/nx_${tld}_$(printf '%s\n' "$subset" | cksum | cut -d' ' -f1).txt"
  if [ ! -f "$f" ]; then
    echo "DNS scan: .$tld ($(printf '%s\n' "$subset" | wc -l) names) ..." >&2
    printf '%s\n' "$subset" | xargs -P "$DNS_PARALLEL" -I{} sh -c \
      'dig +noall +comments +time=2 +tries=2 "$1" NS @"$2" | grep -q NXDOMAIN && echo "$1"; true' \
      _ {} "$DNS_SERVER" | sort -u > "$f.tmp"
    mv "$f.tmp" "$f"
  fi
  cat "$f" >> "$NX"
done
sort -u -o "$NX" "$NX"

echo "NXDOMAIN names per ending:"
for tld in $SCAN_ENDINGS; do
  printf '  .%-7s %s\n' "$tld" "$(only_ending "$tld" < "$NX" | wc -l)"
done

# ------------------------------------------ step 2: Registrar domain-check ---
[ -f "$RESULTS" ] || printf 'name\tregistrable\ttier\tregistration_cost\trenewal_cost\treason\n' > "$RESULTS"
todo_all=$(grep -vxF -f <(cut -f1 "$RESULTS") "$NX" || true)
for tld in $SCAN_ENDINGS; do # drop endings the API can't check, so the estimate is honest
  if unsupported "$tld"; then todo_all=$(printf '%s\n' "$todo_all" | awk -v t="$tld" '{e=$0; sub(/^[^.]*\./,"",e)} e!=t'); fi
done
n_todo=$(printf '%s' "$todo_all" | grep -c . || true)
echo "Not yet checked: $n_todo name(s), about $(((n_todo + BATCH_SIZE - 1) / BATCH_SIZE)) request(s)," \
  "$(((n_todo + BATCH_SIZE - 1) / BATCH_SIZE * (REQUEST_GAP + 1) / 60)) min; this run stops after $MAX_REQUESTS." >&2

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
    echo "HTTP $code for request $requests. First name in the batch: $1. Response body:" >&2
    if [ -s "$resp" ]; then head -c 500 "$resp" >&2; echo >&2; else echo "(empty body)" >&2; fi
    # A single name that the API rejects as a bad request (seen for co.io) is recorded and
    # skipped, so that it can't block every re-run. Anything else stops the run.
    if [ "$code" = "400" ] && [ $# -eq 1 ]; then
      printf '%s\t\t\t\t\tapi_http_400\n' "$1" >> "$RESULTS"
      sleep "$REQUEST_GAP"; return 0
    fi
    echo "STOPPED." >&2
    [ "$code" = "429" ] && echo "Rate limited. Wait at least 5 minutes before re-running." >&2
    echo "Checked so far: $(($(wc -l < "$RESULTS") - 1)) names in $RESULTS. Re-run to resume." >&2
    exit 1
  fi
  jq -r '.result.domains[] | [.name, (.registrable|tostring), (.tier // ""),
         (.pricing.registration_cost // ""), (.pricing.renewal_cost // ""), (.reason // "")] | @tsv' \
    "$resp" >> "$RESULTS"
  # A name that the API silently leaves out of a 200 response gets retried on the next run
  # (co.io went missing this way, then returned HTTP 400 when sent alone).
  local missing
  missing=$(printf '%s\n' "$@" | grep -vxF -f <(jq -r '.result.domains[].name' "$resp") || true)
  [ -z "$missing" ] || echo "  (not returned by the API, retried next run: $(echo $missing))" >&2
  sleep "$REQUEST_GAP"
}

pooled=() # names from endings too small to fill a batch; checked together at the end
for tld in $SCAN_ENDINGS; do
  mapfile -t todo < <(printf '%s\n' "$todo_all" | only_ending "$tld")
  if unsupported "$tld"; then
    [ -z "$(only_ending "$tld" < "$NX")" ] ||
      echo ".$tld: not checked (extension not supported via API, per results.tsv); check the NXDOMAIN list by hand" >&2
    continue
  fi
  [ ${#todo[@]} -gt 0 ] || continue
  if [ ${#todo[@]} -lt "$BATCH_SIZE" ]; then pooled+=("${todo[@]}"); continue; fi
  echo ".$tld: ${#todo[@]} names to check" >&2
  for ((i = 0; i < ${#todo[@]}; i += BATCH_SIZE)); do
    if [ "$requests" -ge "$MAX_REQUESTS" ]; then
      echo >&2; echo "Reached $MAX_REQUESTS requests for this run. Re-run to continue." >&2
      break 2
    fi
    check_batch "${todo[@]:i:BATCH_SIZE}"
    printf '\r  %d/%d' "$((i + BATCH_SIZE < ${#todo[@]} ? i + BATCH_SIZE : ${#todo[@]}))" "${#todo[@]}" >&2
    # If the first batch shows the ending isn't supported, don't spend more requests on it.
    if [ "$i" -eq 0 ] && jq -e '[.result.domains[].reason] | all(. != null and startswith("extension_not_supported"))' "$resp" >/dev/null 2>&1; then
      echo "  -> extension not supported via API; skipping the rest of .$tld" >&2; break
    fi
  done
  echo >&2
done
# Small endings share batches, so checking one name on each of 300 endings costs 15 requests,
# not 300. (Per-ending "unsupported" detection doesn't apply here; results.tsv records it.)
if [ ${#pooled[@]} -gt 0 ] && [ "$requests" -lt "$MAX_REQUESTS" ]; then
  echo "Mixed endings: ${#pooled[@]} names to check" >&2
  for ((i = 0; i < ${#pooled[@]}; i += BATCH_SIZE)); do
    if [ "$requests" -ge "$MAX_REQUESTS" ]; then
      echo >&2; echo "Reached $MAX_REQUESTS requests for this run. Re-run to continue." >&2
      break
    fi
    check_batch "${pooled[@]:i:BATCH_SIZE}"
    printf '\r  %d/%d' "$((i + BATCH_SIZE < ${#pooled[@]} ? i + BATCH_SIZE : ${#pooled[@]}))" "${#pooled[@]}" >&2
  done
  echo >&2
fi
echo "API requests this run: $requests" >&2

# ----------------------------------------------------------- step 3: report ---
report
