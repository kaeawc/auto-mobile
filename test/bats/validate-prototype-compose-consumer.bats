#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# Unit coverage for the helpers in
# scripts/android/validate-prototype-compose-consumer.sh (issue #13727).
#
# The full script publishes the renderer and builds a minified consumer in CI;
# these tests pin the sources-jar, POM and version-catalog parsing against
# hand-built fixtures so it stays correct without a Gradle publish.

SCRIPT="scripts/android/validate-prototype-compose-consumer.sh"

setup() {
  # shellcheck disable=SC1090 # Sourcing exposes only the helper functions (the
  # orchestration is guarded behind a BASH_SOURCE == $0 check).
  source "${SCRIPT}"
  FIX="$(mktemp -d)"
}

teardown() {
  rm -rf "${FIX}"
}

write_pom() {
  cat >"${FIX}/lib.pom" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>dev.jasonpearson.auto-mobile</groupId>
  <artifactId>auto-mobile-prototype-compose</artifactId>
  <version>1.0</version>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>androidx.compose</groupId>
        <artifactId>compose-bom</artifactId>
        <version>2026.09.00</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>dev.jasonpearson.auto-mobile</groupId>
      <artifactId>auto-mobile-protocol</artifactId>
      <version>1.0</version>
      <scope>compile</scope>
    </dependency>
    <dependency>
      <groupId>androidx.compose.ui</groupId>
      <artifactId>ui</artifactId>
      <scope>compile</scope>
    </dependency>
    $1
  </dependencies>
</project>
XML
}

@test "sources_jar_missing_files is empty when the jar carries every source" {
  mkdir -p "${FIX}/src/a/b" "${FIX}/jar/a/b"
  : >"${FIX}/src/a/b/One.kt"
  : >"${FIX}/src/a/Two.kt"
  : >"${FIX}/jar/a/b/One.kt"
  : >"${FIX}/jar/a/Two.kt"
  (cd "${FIX}/jar" && zip -q -r ../sources.jar a)

  run sources_jar_missing_files "${FIX}/sources.jar" "${FIX}/src"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "sources_jar_missing_files names each source absent from the jar" {
  mkdir -p "${FIX}/src/a/b" "${FIX}/jar/a"
  : >"${FIX}/src/a/b/One.kt"
  : >"${FIX}/src/a/Two.kt"
  : >"${FIX}/src/a/Three.java"
  : >"${FIX}/jar/a/Two.kt"
  (cd "${FIX}/jar" && zip -q -r ../sources.jar a)

  run sources_jar_missing_files "${FIX}/sources.jar" "${FIX}/src"
  [ "$status" -eq 0 ]
  [ "$output" = $'a/Three.java\na/b/One.kt' ]
}

@test "sources_jar_missing_files ignores a same-named file in another package" {
  mkdir -p "${FIX}/src/a/b" "${FIX}/jar/a/c"
  : >"${FIX}/src/a/b/One.kt"
  : >"${FIX}/jar/a/c/One.kt"
  (cd "${FIX}/jar" && zip -q -r ../sources.jar a)

  run sources_jar_missing_files "${FIX}/sources.jar" "${FIX}/src"
  [ "$output" = "a/b/One.kt" ]
}

@test "pom_artifact_id reads the project's own artifactId, not a dependency's" {
  write_pom ""
  run pom_artifact_id "${FIX}/lib.pom"
  [ "$status" -eq 0 ]
  [ "$output" = "auto-mobile-prototype-compose" ]
}

@test "pom_dependencies lists group:artifact:version:scope" {
  write_pom "<dependency><groupId>g</groupId><artifactId>a</artifactId><version>2</version></dependency>"
  run pom_dependencies "${FIX}/lib.pom"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "dev.jasonpearson.auto-mobile:auto-mobile-protocol:1.0:compile" ]
  [ "${lines[1]}" = "androidx.compose.ui:ui::compile" ]
  # A missing scope is Maven's default, compile.
  [ "${lines[2]}" = "g:a:2:compile" ]
}

@test "pom_unresolvable_dependencies accepts BOM-managed versionless dependencies" {
  write_pom ""
  run pom_unresolvable_dependencies "${FIX}/lib.pom"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "pom_unresolvable_dependencies flags a versionless dependency no BOM covers" {
  write_pom "<dependency><groupId>com.example</groupId><artifactId>loose</artifactId><scope>runtime</scope></dependency>"
  run pom_unresolvable_dependencies "${FIX}/lib.pom"
  [ "$output" = "com.example:loose::runtime" ]
}

@test "pom_unresolvable_dependencies does not treat a group-name prefix as BOM coverage" {
  write_pom "<dependency><groupId>androidx.composer</groupId><artifactId>x</artifactId></dependency>"
  run pom_unresolvable_dependencies "${FIX}/lib.pom"
  [ "$output" = "androidx.composer:x::compile" ]
}

@test "pom_unresolvable_dependencies flags a leaked unspecified project dependency" {
  write_pom "<dependency><groupId>auto-mobile</groupId><artifactId>control-proxy</artifactId><version>unspecified</version></dependency>"
  run pom_unresolvable_dependencies "${FIX}/lib.pom"
  [ "$output" = "auto-mobile:control-proxy:unspecified:compile" ]
}

@test "catalog_version reads a [versions] entry and is empty for an unknown key" {
  cat >"${FIX}/libs.versions.toml" <<'TOML'
[versions]
build-android-agp = "9.4.1"   # trailing comment
androidx-compose-bom = "2026.09.00"

[libraries]
build-android-agp = { module = "x:y", version = "0" }
TOML
  run catalog_version "${FIX}/libs.versions.toml" build-android-agp
  [ "$output" = "9.4.1" ]
  run catalog_version "${FIX}/libs.versions.toml" missing-key
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "the script rejects an unknown argument with a usage exit" {
  run bash "${SCRIPT}" --bogus
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown argument: --bogus"* ]]
}
