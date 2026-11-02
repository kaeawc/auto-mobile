#!/usr/bin/env bats
#
# Guards the shared Robolectric android-all jar cache (#16396).
#
# Robolectric downloads one android-all-instrumented jar per SDK level into
# ~/.m2 at test time and tries once. With no cache, every Robolectric job
# fetched ~1.4 GB from Maven Central on every run, and one 429 failed the test
# class. gradle-task-run restores one shared cache of those jars; only the
# merge Kotlin Code Coverage job, which runs every Robolectric module, saves it.

SCRIPT="scripts/ci/robolectric-jar-cache.sh"
ACTION=".github/actions/gradle-task-run/action.yml"

write_catalog() {
  cat > "$BATS_TEST_TMPDIR/libs.versions.toml" <<EOF
[versions]
build-robolectric-maxSdk = "35"
robolectric = "$1"
roborazzi = "1.0"

[libraries]
robolectric = { module = "org.robolectric:robolectric", version.ref = "robolectric" }
EOF
}

@test "key names the Robolectric version from the version catalog" {
  write_catalog "4.17"
  run bash "$SCRIPT" key "$BATS_TEST_TMPDIR/libs.versions.toml"
  [ "$status" -eq 0 ]
  [ "$output" = "robolectric-android-all-v1-4.17" ]
}

@test "key changes when Robolectric is bumped" {
  write_catalog "4.18"
  run bash "$SCRIPT" key "$BATS_TEST_TMPDIR/libs.versions.toml"
  [ "$output" = "robolectric-android-all-v1-4.18" ]
}

@test "key fails when the catalog has no robolectric version" {
  printf '[versions]\nkotlin = "2.4.21"\n' > "$BATS_TEST_TMPDIR/libs.versions.toml"
  run bash "$SCRIPT" key "$BATS_TEST_TMPDIR/libs.versions.toml"
  [ "$status" -ne 0 ]
  [[ "$output" == *"no [versions] robolectric"* ]]
}

@test "key reads the real catalog" {
  run bash "$SCRIPT" key android/gradle/libs.versions.toml
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^robolectric-android-all-v1-[0-9][0-9.]*$ ]]
}

@test "fingerprint is 'none' for a missing or jar-less directory" {
  run bash "$SCRIPT" fingerprint "$BATS_TEST_TMPDIR/absent"
  [ "$status" -eq 0 ]
  [ "$output" = "none" ]
  mkdir -p "$BATS_TEST_TMPDIR/empty/sub"
  touch "$BATS_TEST_TMPDIR/empty/sub/readme.txt"
  run bash "$SCRIPT" fingerprint "$BATS_TEST_TMPDIR/empty"
  [ "$output" = "none" ]
}

@test "fingerprint is stable for the same jars and changes when a jar is added" {
  dir="$BATS_TEST_TMPDIR/jars"
  mkdir -p "$dir/11-robolectric-6757853-i7"
  printf 'eleven' > "$dir/11-robolectric-6757853-i7/android-all-instrumented-11-robolectric-6757853-i7.jar"
  first="$(bash "$SCRIPT" fingerprint "$dir")"
  second="$(bash "$SCRIPT" fingerprint "$dir")"
  [ "$first" != "none" ]
  [ "$first" = "$second" ]

  mkdir -p "$dir/14-robolectric-10818077-i7"
  printf 'fourteen' > "$dir/14-robolectric-10818077-i7/android-all-instrumented-14-robolectric-10818077-i7.jar"
  third="$(bash "$SCRIPT" fingerprint "$dir")"
  [ "$third" != "$first" ]
}

@test "fingerprint ignores non-jar files such as .pom and .sha1 siblings" {
  dir="$BATS_TEST_TMPDIR/jars"
  mkdir -p "$dir/v"
  printf 'jar' > "$dir/v/a.jar"
  before="$(bash "$SCRIPT" fingerprint "$dir")"
  printf 'pom' > "$dir/v/a.pom"
  [ "$(bash "$SCRIPT" fingerprint "$dir")" = "$before" ]
}

@test "unknown subcommands fail with usage" {
  run bash "$SCRIPT" bogus
  [ "$status" -eq 2 ]
  [[ "$output" == *"Usage:"* ]]
}

# Reads the action and workflows with js-yaml (a repo dependency), so a step's
# `if:` is checked as the parsed field, not as text a comment could also hold.
yaml_query() {
  bun -e '
    const yaml = require("js-yaml");
    const fs = require("fs");
    const [query] = process.argv.slice(1);
    const load = (p) => yaml.load(fs.readFileSync(p, "utf8"));
    if (query === "action") {
      const steps = load(".github/actions/gradle-task-run/action.yml").runs.steps;
      const index = (name) => steps.findIndex((s) => s.name === name);
      const step = (name) => steps[index(name)] || {};
      console.log(JSON.stringify({
        restore: index("Restore Robolectric jar cache"),
        gradle: index("Run Tasks via Gradle"),
        save: index("Save Robolectric jar cache"),
        saveIf: String(step("Save Robolectric jar cache").if || ""),
        restoreKey: String((step("Restore Robolectric jar cache").with || {}).key || ""),
        saveKey: String((step("Save Robolectric jar cache").with || {}).key || ""),
      }));
    } else {
      const rows = [];
      for (const file of fs.readdirSync(".github/workflows")) {
        if (!/\.ya?ml$/.test(file)) continue;
        const wf = load(".github/workflows/" + file) || {};
        for (const [job, def] of Object.entries(wf.jobs || {})) {
          for (const s of def.steps || []) {
            const mode = s.with && s.with["robolectric-jar-cache"];
            if (mode) rows.push(file + " " + job + " " + mode);
          }
        }
      }
      console.log(rows.sort().join("\n"));
    }
  ' "$1"
}

@test "gradle-task-run restores the jar cache before Gradle and saves it only from a main push" {
  # The restore must run before the Gradle step, and the save must be limited
  # to save mode on a main push, or every PR job would write a ~1.4 GB entry.
  run yaml_query action
  [ "$status" -eq 0 ]
  json="$output"
  field() { printf '%s' "$json" | bun -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>console.log(JSON.parse(r)[process.argv[1]]))' "$1"; }
  [ "$(field restore)" -ge 0 ]
  [ "$(field save)" -ge 0 ]
  [ "$(field restore)" -lt "$(field gradle)" ]
  [ "$(field save)" -gt "$(field gradle)" ]
  save_if="$(field saveIf)"
  [[ "$save_if" == *"inputs.robolectric-jar-cache == 'save'"* ]]
  [[ "$save_if" == *"github.ref == 'refs/heads/main'"* ]]
  [[ "$save_if" == *"github.event_name == 'push'"* ]]
}

@test "the jar-cache key includes the run attempt, so a re-run can save a fuller set" {
  # github.run_id is unchanged on a re-run and a saved entry is immutable, so a
  # key without the attempt would keep a failed attempt's partial jar set.
  run yaml_query action
  [ "$status" -eq 0 ]
  [[ "$output" == *'"restoreKey":"${{ steps.robolectric-jar-cache-key.outputs.prefix }}-${{ github.run_id }}-${{ github.run_attempt }}"'* ]]
  [[ "$output" == *'"saveKey":"${{ steps.robolectric-jar-cache-key.outputs.prefix }}-${{ github.run_id }}-${{ github.run_attempt }}"'* ]]
}

@test "only the merge Kotlin Code Coverage job saves the jar cache" {
  run yaml_query workflows
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | grep -c ' save$')" -eq 1 ]
  printf '%s\n' "$output" | grep -qx 'merge.yml kotlin-code-coverage save'
  printf '%s\n' "$output" | grep -qx 'pull_request.yml kotlin-code-coverage restore'
}
