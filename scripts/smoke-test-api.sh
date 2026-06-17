#!/usr/bin/env bash
#
# Smoke test for the public read API (app/api/v1/*) against a RUNNING instance.
# Proves the real wiring: API-key auth, scope gating, the Redis rate limiter,
# the Redis response cache (X-Cache MISS→HIT), and ETag/304 revalidation.
#
# Prerequisites:
#   - The app is running (npm run dev) and reachable at $BASE_URL.
#   - Redis is up and migration 033 (api_keys) is applied.
#   - You have a valid API key. Mint one for testing without an admin JWT by
#     inserting a row directly (note the LOW rate limit so the limiter trips):
#
#       node -e 'const c=require("crypto");
#         const raw="qir_live_"+c.randomBytes(24).toString("base64url");
#         const h=c.createHash("sha256").update(raw).digest("hex");
#         console.log("KEY:",raw);
#         console.log("prefix:",raw.slice(0,12),"hash:",h);'
#
#       insert into api_keys (station_id,name,key_prefix,key_hash,scopes,rate_limit_per_min)
#       values ((select id from stations where slug='kpfk'),'smoke','<prefix>','<hash>',
#               array['qir','episodes','transcripts','shows','usage'], 5);
#
# Usage:
#   BASE_URL=http://localhost:3000 KEY=qir_live_xxx RPM=5 ./scripts/smoke-test-api.sh
#
# Optional:
#   KEY_NO_USAGE=qir_live_yyy   # a key WITHOUT the 'usage' scope → tests 403
#   EPISODE_ID=1                # an episode id to exercise detail/transcript

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RPM="${RPM:-5}"
EPISODE_ID="${EPISODE_ID:-1}"

if [[ -z "${KEY:-}" ]]; then
  echo "ERROR: set KEY=<raw api key>. See the header of this script to mint one." >&2
  exit 2
fi

pass=0
fail=0
green=$'\e[32m'; red=$'\e[31m'; dim=$'\e[2m'; reset=$'\e[0m'

# check <label> <expected> <actual>
check() {
  if [[ "$2" == "$3" ]]; then
    echo "${green}PASS${reset} $1 ${dim}($3)${reset}"; ((pass++))
  else
    echo "${red}FAIL${reset} $1 — expected $2, got $3"; ((fail++))
  fi
}

# status <url> [extra curl args...]
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
auth=(-H "Authorization: Bearer $KEY")

echo "== Auth =="
check "no key → 401" 401 "$(status "$BASE_URL/api/v1/qir")"
check "valid key → 200" 200 "$(status "${auth[@]}" "$BASE_URL/api/v1/qir")"

echo "== Response cache (X-Cache) =="
hdr() { curl -sD- -o /dev/null "${auth[@]}" "$1" | tr -d '\r'; }
# Use a distinct, stable resource so the first hit is a cold MISS where possible.
xc1=$(hdr "$BASE_URL/api/v1/shows" | awk -F': ' 'tolower($1)=="x-cache"{print $2}')
xc2=$(hdr "$BASE_URL/api/v1/shows" | awk -F': ' 'tolower($1)=="x-cache"{print $2}')
echo "  first=$xc1 second=$xc2"
check "repeat hit → HIT" "HIT" "$xc2"

echo "== ETag / 304 =="
etag=$(hdr "$BASE_URL/api/v1/shows" | awk -F': ' 'tolower($1)=="etag"{print $2}')
echo "  etag=$etag"
check "If-None-Match → 304" 304 \
  "$(status "${auth[@]}" -H "If-None-Match: $etag" "$BASE_URL/api/v1/shows")"

echo "== Captions =="
ct=$(hdr "$BASE_URL/api/v1/episodes/$EPISODE_ID/transcript?format=vtt" \
     | awk -F': ' 'tolower($1)=="content-type"{print $2}')
echo "  transcript content-type=$ct (200=VTT served, 404=no transcript for ep $EPISODE_ID)"

echo "== Scope gating =="
if [[ -n "${KEY_NO_USAGE:-}" ]]; then
  check "key without 'usage' → 403" 403 \
    "$(status -H "Authorization: Bearer $KEY_NO_USAGE" "$BASE_URL/api/v1/usage")"
else
  echo "  ${dim}skipped (set KEY_NO_USAGE to test)${reset}"
fi

echo "== Rate limit (key limit = $RPM/min) =="
codes=""
for _ in $(seq 1 $((RPM + 3))); do
  codes+="$(status "${auth[@]}" "$BASE_URL/api/v1/qir") "
done
echo "  codes: $codes"
if [[ "$codes" == *"429"* ]]; then
  echo "${green}PASS${reset} burst produced a 429"; ((pass++))
else
  echo "${red}FAIL${reset} no 429 seen — is the key's rate_limit_per_min low enough (RPM=$RPM)?"; ((fail++))
fi

echo
echo "Results: ${green}${pass} passed${reset}, ${red}${fail} failed${reset}"
[[ $fail -eq 0 ]]
