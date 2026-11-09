#!/usr/bin/env bats

# Backticks below are literal Markdown in the expected summary rows.
# shellcheck disable=SC2016

setup() {
  export FIX="$BATS_TEST_TMPDIR"
  export PATH="$FIX:$PATH"
  export GITHUB_REPOSITORY=kaeawc/auto-mobile MAC_RUNNER_READ_TOKEN=fake
  export GITHUB_OUTPUT="$FIX/output" GITHUB_STEP_SUMMARY="$FIX/summary"
  # Stubbed GitHub API: records its arguments and token, serves runners.json.
  cat > "$FIX/gh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIX/calls"
printf '%s\n' "$GH_TOKEN" >> "$FIX/tokens"
if [[ -f "$FIX/fail" ]]; then exit 1; fi
cat "$FIX/runners.json"
FAKE
  chmod +x "$FIX/gh"
}

# JSON fixtures are constructed with jq, not hand-written strings.
# Each argument is "<status>:<label>".
runners() {
  local spec items='[]'
  for spec in "$@"; do
    items="$(jq -c --arg status "${spec%%:*}" --arg label "${spec#*:}" \
      '. + [{name: "r\(length)", status: $status, busy: false,
        labels: [{name: "self-hosted"}, {name: "macOS"}, {name: $label}]}]' <<< "$items")"
  done
  jq -n --argjson items "$items" '{total_count: ($items | length), runners: $items}' > "$FIX/runners.json"
}

route() {
  grep -E "^$1=" "$FIX/output" | cut -d= -f2-
}

@test "online pools stay self-hosted and the API is read with the runner-read token" {
  runners online:automobile-mac offline:automobile-mac online:automobile-mac-heavy
  run bash scripts/ci/mac-pool-routing.sh
  [ "$status" -eq 0 ]
  [ "$(route small)" = self-hosted ]
  [ "$(route heavy)" = self-hosted ]
  grep -Fx 'api --paginate /repos/kaeawc/auto-mobile/actions/runners?per_page=100' "$FIX/calls"
  grep -Fx fake "$FIX/tokens"
  grep -F '| `automobile-mac` | 1 of 2 | self-hosted |' "$FIX/summary"
  if grep -qF 'Hosted fallback costs' "$FIX/summary"; then return 1; fi
}

@test "an offline pool routes only that pool to hosted macOS" {
  runners online:automobile-mac offline:automobile-mac-heavy
  run bash scripts/ci/mac-pool-routing.sh
  [ "$status" -eq 0 ]
  [ "$(route small)" = self-hosted ]
  [ "$(route heavy)" = hosted ]
  [[ "$output" == *"No online runner in automobile-mac-heavy (1 registered)"* ]]
  grep -F '| `automobile-mac-heavy` | 0 of 1 | hosted |' "$FIX/summary"
  grep -F 'Hosted fallback costs about 18-20 macOS minutes' "$FIX/summary"
}

@test "a pool with no registered runner routes to hosted macOS" {
  runners online:automobile-mac-heavy
  run bash scripts/ci/mac-pool-routing.sh
  [ "$status" -eq 0 ]
  [ "$(route small)" = hosted ]
  [ "$(route heavy)" = self-hosted ]
}

@test "labels match exactly, so a heavy runner does not keep the small pool online" {
  runners offline:automobile-mac online:automobile-mac-heavy online:automobile-mac-extra
  run bash scripts/ci/mac-pool-routing.sh
  [ "$status" -eq 0 ]
  [ "$(route small)" = hosted ]
  [ "$(route heavy)" = self-hosted ]
}

@test "paginated responses are combined across pages" {
  runners offline:automobile-mac
  local page1
  page1="$(cat "$FIX/runners.json")"
  runners online:automobile-mac online:automobile-mac-heavy
  printf '%s\n%s\n' "$page1" "$(cat "$FIX/runners.json")" > "$FIX/runners.json"
  run bash scripts/ci/mac-pool-routing.sh
  [ "$status" -eq 0 ]
  [ "$(route small)" = self-hosted ]
  grep -F '| `automobile-mac` | 1 of 2 | self-hosted |' "$FIX/summary"
}

@test "missing secret fails open to self-hosted without calling the API and says so" {
  runners offline:automobile-mac offline:automobile-mac-heavy
  unset MAC_RUNNER_READ_TOKEN
  run bash scripts/ci/mac-pool-routing.sh
  [ "$status" -eq 0 ]
  [ "$(route small)" = self-hosted ]
  [ "$(route heavy)" = self-hosted ]
  [ ! -e "$FIX/calls" ]
  [[ "$output" == *"::warning title=Mac pool routing::The MAC_RUNNER_READ_TOKEN secret is not set"* ]]
  grep -F '**Failing open to self-hosted.** The MAC_RUNNER_READ_TOKEN secret is not set' "$FIX/summary"
}

@test "API failure fails open to self-hosted and says so" {
  runners offline:automobile-mac offline:automobile-mac-heavy
  touch "$FIX/fail"
  run bash scripts/ci/mac-pool-routing.sh
  [ "$status" -eq 0 ]
  [ "$(route small)" = self-hosted ]
  [ "$(route heavy)" = self-hosted ]
  grep -F '**Failing open to self-hosted.** The runners API call failed or timed out' "$FIX/summary"
}

@test "unreadable API response fails open to self-hosted" {
  local body
  for body in 'not json' '{"message":"Resource not accessible"}' '{"runners":[{"status":"online"}]}'; do
    printf '%s' "$body" > "$FIX/runners.json"
    rm -f "$FIX/output" "$FIX/summary"
    run bash scripts/ci/mac-pool-routing.sh
    [ "$status" -eq 0 ]
    [ "$(route small)" = self-hosted ]
    [ "$(route heavy)" = self-hosted ]
    grep -F 'The runners API returned an unreadable response.' "$FIX/summary"
  done
}

@test "a stalled API call is bounded and fails open" {
  cat > "$FIX/gh" <<'FAKE'
#!/usr/bin/env bash
exec sleep 30
FAKE
  chmod +x "$FIX/gh"
  if ! timeout --help 2>&1 | grep -q -- '--foreground'; then
    skip 'needs GNU coreutils timeout'
  fi
  run env MAC_POOL_ROUTING_TIMEOUT_SECONDS=1 bash scripts/ci/mac-pool-routing.sh
  [ "$status" -eq 0 ]
  [ "$(route small)" = self-hosted ]
  grep -F 'The runners API call failed or timed out' "$FIX/summary"
}

@test "invalid timeout fails open without calling the API" {
  run env MAC_POOL_ROUTING_TIMEOUT_SECONDS=0 bash scripts/ci/mac-pool-routing.sh
  [ "$status" -eq 0 ]
  [ "$(route heavy)" = self-hosted ]
  [ ! -e "$FIX/calls" ]
}
