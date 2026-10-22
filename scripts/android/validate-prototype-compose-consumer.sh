#!/usr/bin/env bash
#
# Published-consumer check for the Compose prototype renderer (issue #13727).
#
# Publishes :protocol and :prototype-compose to a local Maven repository, then
# asserts against the published files -- not the in-repo project() path -- that
#
#   AC1  the release AAR (with its consumer R8 rules), sources jar and POM are
#        published,
#   AC2  the sources jar carries every renderer source file under src/main,
#   AC3  the POM names the artifact, depends on the published auto-mobile-protocol
#        artifact and carries no unpublished or unversioned dependency, and
#   AC4  an Android app resolving the artifact from that repository (with no
#        Compose BOM of its own) compiles a call to AutoMobilePrototype into a
#        minified (R8) release APK. Nothing runs the APK.
#
# Usage:
#   validate-prototype-compose-consumer.sh [--skip-publish] [--skip-consumer]
#                                          [--repo <dir>]
#
#   --skip-publish   Assert against an already-published local repo (CI publishes
#                    with the cached gradle-task-run action in a prior step).
#   --skip-consumer  Check the published files only; skip the consumer app build.
#   --repo <dir>     Local Maven repository root (default: ~/.m2/repository).
#
# Logs and the generated consumer live under scratch/prototype-compose-consumer/.
#
# Exit codes: 0 all assertions pass; 1 an assertion or build failed;
#             2 usage / environment error.
set -euo pipefail

ARTIFACT_ID="auto-mobile-prototype-compose"
PROTOCOL_ARTIFACT_ID="auto-mobile-protocol"

# --- pure, sourceable helpers (unit-tested by BATS) -------------------------

# Echo, one per line, each Kotlin/Java source under <src_root> (as a path
# relative to it) that is missing from <sources_jar>. Empty output means the jar
# carries every source. The entry list is captured first and matched with a
# here-string rather than piped into grep, so an early-exiting grep cannot
# SIGPIPE unzip under pipefail.
sources_jar_missing_files() {
  local sources_jar="$1" src_root="$2" entries relative
  entries="$(unzip -Z1 "$sources_jar")"
  while IFS= read -r relative; do
    [ -n "$relative" ] || continue
    if ! grep -qxF "$relative" <<<"$entries"; then
      echo "$relative"
    fi
  done < <(cd "$src_root" && find . -type f \( -name '*.kt' -o -name '*.java' \) | sed 's|^\./||' | LC_ALL=C sort)
}

# Echo the POM's dependencies as "groupId:artifactId:version:scope", one per
# line (scope defaults to compile). Parsed with python3's namespace-aware
# ElementTree, never with line regexes.
pom_dependencies() {
  python3 - "$1" <<'PY'
import sys, xml.etree.ElementTree as ET
ns = {"m": "http://maven.apache.org/POM/4.0.0"}
root = ET.parse(sys.argv[1]).getroot()
for dep in root.findall("m:dependencies/m:dependency", ns):
    text = lambda tag, default="": (dep.findtext("m:" + tag, default, ns) or default).strip()
    print(":".join([text("groupId"), text("artifactId"), text("version"), text("scope", "compile")]))
PY
}

# Echo the POM's own artifactId.
pom_artifact_id() {
  python3 - "$1" <<'PY'
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
print((root.findtext("{http://maven.apache.org/POM/4.0.0}artifactId") or "").strip())
PY
}

# Echo each POM dependency that a consumer could not resolve from Maven: an
# empty group/artifact or an "unspecified" version (what a leaked project()
# dependency looks like), or no version without an imported BOM whose group
# covers it (Compose libraries take their versions from compose-bom).
pom_unresolvable_dependencies() {
  python3 - "$1" <<'PY'
import sys, xml.etree.ElementTree as ET
ns = {"m": "http://maven.apache.org/POM/4.0.0"}
root = ET.parse(sys.argv[1]).getroot()
def text(node, tag, default=""):
    return (node.findtext("m:" + tag, default, ns) or default).strip()
bom_groups = [
    text(dep, "groupId")
    for dep in root.findall("m:dependencyManagement/m:dependencies/m:dependency", ns)
    if text(dep, "scope") == "import" and text(dep, "type") == "pom" and text(dep, "version")
]
for dep in root.findall("m:dependencies/m:dependency", ns):
    group, artifact, version = text(dep, "groupId"), text(dep, "artifactId"), text(dep, "version")
    managed = any(group == bom or group.startswith(bom + ".") for bom in bom_groups)
    if not group or not artifact or version == "unspecified" or (not version and not managed):
        print(":".join([group, artifact, version, text(dep, "scope", "compile")]))
PY
}

# Echo the version of a [versions] key in a Gradle version catalog.
catalog_version() {
  python3 - "$1" "$2" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as handle:
    print(tomllib.load(handle).get("versions", {}).get(sys.argv[2], ""))
PY
}

# --- orchestration ----------------------------------------------------------

fail() {
  echo "error: $*" >&2
  exit 1
}

usage_error() {
  echo "error: $*" >&2
  exit 2
}

# Run a command with output captured to a log; on failure print the Gradle
# "What went wrong" block and the log tail.
run_logged() {
  local log_file="$1" exit_code
  shift
  if "$@" >"$log_file" 2>&1; then
    return 0
  else
    exit_code=$?
  fi
  {
    echo "Command failed; diagnostics from ${log_file}:"
    awk '/^\* What went wrong:/ { found = 1 } found { print; if (++count >= 40) exit }' "$log_file"
    tail -n 150 "$log_file"
  } >&2
  return "$exit_code"
}

write_consumer_project() {
  local consumer_dir="$1" repo="$2" coordinate="$3" catalog="$4"
  local agp kotlin activity compile_sdk min_sdk
  agp="$(catalog_version "$catalog" build-android-agp)"
  kotlin="$(catalog_version "$catalog" build-kotlin)"
  activity="$(catalog_version "$catalog" androidx-activity-compose)"
  compile_sdk="$(catalog_version "$catalog" build-android-compileSdk)"
  min_sdk="$(catalog_version "$catalog" build-android-minSdk)"
  for value in "$agp" "$kotlin" "$activity" "$compile_sdk" "$min_sdk"; do
    [ -n "$value" ] || usage_error "could not read consumer versions from ${catalog}"
  done

  local source_dir="${consumer_dir}/src/main/kotlin/dev/jasonpearson/automobile/prototypeconsumer"
  mkdir -p "$source_dir"

  cat >"${consumer_dir}/settings.gradle.kts" <<GRADLE_SETTINGS
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    // Only the published AutoMobile artifacts come from here; never a project().
    maven { url = uri("${repo}") }
    google()
    mavenCentral()
  }
}

rootProject.name = "prototype-compose-consumer"
GRADLE_SETTINGS

  cat >"${consumer_dir}/build.gradle.kts" <<GRADLE_BUILD
plugins {
  id("com.android.application") version "${agp}"
  id("org.jetbrains.kotlin.plugin.compose") version "${kotlin}"
}

android {
  namespace = "dev.jasonpearson.automobile.prototypeconsumer"
  compileSdk = ${compile_sdk}

  defaultConfig {
    applicationId = "dev.jasonpearson.automobile.prototypeconsumer"
    minSdk = ${min_sdk}
    targetSdk = ${compile_sdk}
    versionCode = 1
    versionName = "1"
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
    }
  }

  buildFeatures { compose = true }
}

dependencies {
  implementation("${coordinate}")
  implementation("androidx.activity:activity-compose:${activity}")
}
GRADLE_BUILD

  printf 'android.useAndroidX=true\norg.gradle.jvmargs=-Xmx2g\n' >"${consumer_dir}/gradle.properties"

  mkdir -p "${consumer_dir}/src/main"
  cat >"${consumer_dir}/src/main/AndroidManifest.xml" <<'MANIFEST'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:label="Prototype consumer">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
MANIFEST

  cat >"${source_dir}/MainActivity.kt" <<'KOTLIN'
package dev.jasonpearson.automobile.prototypeconsumer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import dev.jasonpearson.automobile.prototype.PrototypeAssets
import dev.jasonpearson.automobile.prototype.PrototypeNetwork
import dev.jasonpearson.automobile.prototype.PrototypeStorage

private const val SPEC =
  """{"id":"consumer","motion":"none","window":{"placement":{"type":"fullscreen"}},""" +
    """"root":{"type":"column","children":[{"type":"text","text":"Hello"},""" +
    """{"type":"icon","name":"chevron_right"}]}}"""

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    check(AutoMobilePrototype.capabilities.isNotEmpty())
    setContent {
      AutoMobilePrototype(
        spec = SPEC,
        assets = PrototypeAssets.None,
        storage = PrototypeStorage.fileBacked(this),
        network = PrototypeNetwork(),
        onDismiss = { finish() },
      )
    }
  }
}
KOTLIN

  if [ -n "${ANDROID_HOME:-}" ]; then
    printf 'sdk.dir=%s\n' "$ANDROID_HOME" >"${consumer_dir}/local.properties"
  elif [ -f "${PROJECT_ROOT}/android/local.properties" ]; then
    cp "${PROJECT_ROOT}/android/local.properties" "${consumer_dir}/local.properties"
  else
    usage_error "set ANDROID_HOME or create android/local.properties for the consumer build"
  fi
}

run_validation() {
  local skip_publish=0 skip_consumer=0 repo="${HOME}/.m2/repository"
  while [ $# -gt 0 ]; do
    case "$1" in
      --skip-publish) skip_publish=1; shift ;;
      --skip-consumer) skip_consumer=1; shift ;;
      --repo) repo="${2:-}"; [ -n "$repo" ] || usage_error "--repo needs a dir"; shift 2 ;;
      -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) usage_error "unknown argument: $1" ;;
    esac
  done

  for tool in unzip python3; do
    command -v "$tool" >/dev/null 2>&1 || usage_error "required tool not found: $tool"
  done

  # Gradle resolves a relative -Dmaven.repo.local against its own directory, so
  # anchor --repo to the caller's cwd before either side sees it.
  case "$repo" in
    /*) : ;;
    *) repo="$(pwd)/$repo" ;;
  esac

  local script_dir android_dir scratch_dir log_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_ROOT="$(cd -- "${script_dir}/../.." && pwd)"
  android_dir="${PROJECT_ROOT}/android"
  scratch_dir="${PROTOTYPE_CONSUMER_SCRATCH_DIR:-${PROJECT_ROOT}/scratch/prototype-compose-consumer}"
  log_dir="${scratch_dir}/logs"
  rm -rf "$scratch_dir"
  mkdir -p "$log_dir"

  local group version
  group="$(sed -n 's/^GROUP=//p' "${android_dir}/gradle.properties" | head -n 1)"
  version="$(sed -n 's/^VERSION_NAME=//p' "${android_dir}/gradle.properties" | head -n 1)"
  if [ -z "$group" ] || [ -z "$version" ]; then
    usage_error "could not read GROUP and VERSION_NAME from android/gradle.properties"
  fi

  if [ "$skip_publish" -eq 0 ]; then
    ( cd "$android_dir" && run_logged "${log_dir}/publish.log" ./gradlew \
        :protocol:publishToMavenLocal :prototype-compose:publishToMavenLocal \
        --stacktrace -Dmaven.repo.local="$repo" )
  fi

  # AC1 -- the published files exist.
  local dir="${repo}/${group//.//}/${ARTIFACT_ID}/${version}"
  local aar="${dir}/${ARTIFACT_ID}-${version}.aar"
  local sources="${dir}/${ARTIFACT_ID}-${version}-sources.jar"
  local pom="${dir}/${ARTIFACT_ID}-${version}.pom"
  local protocol_jar="${repo}/${group//.//}/${PROTOCOL_ARTIFACT_ID}/${version}/${PROTOCOL_ARTIFACT_ID}-${version}.jar"
  [ -f "$aar" ] || fail "AC1: release AAR missing: ${aar} (did publishToMavenLocal run?)"
  [ -f "$sources" ] || fail "AC1: sources jar missing: ${sources}"
  [ -f "$pom" ] || fail "AC1: POM missing: ${pom}"
  [ -f "$protocol_jar" ] || fail "AC1: ${PROTOCOL_ARTIFACT_ID} jar missing: ${protocol_jar}"
  # Icons resolve by reflection; without the shipped keep rule R8 strips them silently.
  local aar_entries
  aar_entries="$(unzip -Z1 "$aar")"
  grep -qxF proguard.txt <<<"$aar_entries" || fail "AC1: AAR carries no proguard.txt consumer rules"

  # AC2 -- every renderer source is in the sources jar. Captured by assignment
  # so the helper never runs in a set -e-suppressed condition.
  local missing
  missing="$(sources_jar_missing_files "$sources" "${android_dir}/prototype-compose/src/main/kotlin")"
  [ -z "$missing" ] || fail "AC2: sources jar is missing renderer sources:"$'\n'"${missing}"

  # AC3 -- the POM is a consumable coordinate.
  local artifact dependencies unresolvable
  artifact="$(pom_artifact_id "$pom")"
  [ "$artifact" = "$ARTIFACT_ID" ] || fail "AC3: POM artifactId is '${artifact}', expected ${ARTIFACT_ID}"
  dependencies="$(pom_dependencies "$pom")"
  grep -qxF "${group}:${PROTOCOL_ARTIFACT_ID}:${version}:compile" <<<"$dependencies" \
    || fail "AC3: POM must depend on ${group}:${PROTOCOL_ARTIFACT_ID}:${version} at compile scope; found:"$'\n'"${dependencies}"
  unresolvable="$(pom_unresolvable_dependencies "$pom")"
  [ -z "$unresolvable" ] || fail "AC3: POM carries dependencies a consumer cannot resolve:"$'\n'"${unresolvable}"

  if [ "$skip_consumer" -eq 1 ]; then
    echo "Published ${ARTIFACT_ID} ${version}: AAR, complete sources jar and POM verified (consumer build skipped)."
    return 0
  fi

  # AC4 -- a minified release consumer resolves the artifact and builds.
  local consumer_dir="${scratch_dir}/consumer"
  write_consumer_project "$consumer_dir" "$repo" "${group}:${ARTIFACT_ID}:${version}" \
    "${android_dir}/gradle/libs.versions.toml"
  ( cd "$android_dir" && run_logged "${log_dir}/consumer.log" ./gradlew -p "$consumer_dir" \
      assembleRelease --stacktrace )
  local apk="${consumer_dir}/build/outputs/apk/release/prototype-compose-consumer-release-unsigned.apk"
  [ -f "$apk" ] || fail "AC4: consumer release APK missing: ${apk}"

  echo "Published ${ARTIFACT_ID} ${version}: AAR, complete sources jar and POM verified; a minified consumer compiled against it."
}

# Only orchestrate when executed; when sourced (BATS), expose the helpers only.
if [ "${BASH_SOURCE[0]:-}" = "${0}" ]; then
  run_validation "$@"
fi
