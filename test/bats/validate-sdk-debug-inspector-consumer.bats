#!/usr/bin/env bats
#
# Unit coverage for the parsing helpers in
# scripts/android/validate-sdk-debug-inspector-consumer.sh (issue #5714).
#
# The full script publishes the SDK and asserts against the real published
# artifacts in CI; these tests pin the pure helpers against hand-built fixtures
# so the manifest / classes.jar / module-metadata parsing stays correct without
# a gradle publish.

SCRIPT="scripts/android/validate-sdk-debug-inspector-consumer.sh"
DB_PROVIDER="dev.jasonpearson.automobile.sdk.database.DatabaseInspectorProvider"
SP_PROVIDER="dev.jasonpearson.automobile.sdk.storage.SharedPreferencesInspectorProvider"
DB_CLASS="dev/jasonpearson/automobile/sdk/database/DatabaseInspectorProvider.class"
SP_CLASS="dev/jasonpearson/automobile/sdk/storage/SharedPreferencesInspectorProvider.class"

setup() {
  # shellcheck disable=SC1090 # Sourcing exposes only the helper functions (the
  # orchestration is guarded behind a BASH_SOURCE == $0 check).
  source "${SCRIPT}"

  FIX="$(mktemp -d)"

  cat >"${FIX}/debug-manifest.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.jasonpearson.automobile.sdk">
  <application>
    <provider android:name="${DB_PROVIDER}" android:authorities="\${applicationId}.automobile.database" android:exported="true" />
    <provider android:name="${SP_PROVIDER}" android:authorities="\${applicationId}.automobile.sharedprefs" android:exported="true" />
  </application>
</manifest>
XML

  cat >"${FIX}/release-manifest.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.jasonpearson.automobile.sdk">
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
</manifest>
XML

  # A debug AAR carrying a classes.jar with both provider classes.
  local work="${FIX}/work"
  mkdir -p "${work}/dev/jasonpearson/automobile/sdk/database" \
           "${work}/dev/jasonpearson/automobile/sdk/storage"
  : >"${work}/${DB_CLASS}"
  : >"${work}/${SP_CLASS}"
  ( cd "${work}" && zip -q -r classes.jar dev )
  ( cd "${work}" && zip -q "${FIX}/debug.aar" classes.jar )

  # A release AAR whose classes.jar has neither provider class.
  local relwork="${FIX}/relwork"
  mkdir -p "${relwork}/dev/jasonpearson/automobile/sdk/database"
  : >"${relwork}/dev/jasonpearson/automobile/sdk/database/DatabaseInspector.class"
  ( cd "${relwork}" && zip -q -r classes.jar dev )
  ( cd "${relwork}" && zip -q "${FIX}/release.aar" classes.jar )

  cat >"${FIX}/sdk.module" <<'JSON'
{
  "formatVersion": "1.1",
  "component": { "group": "dev.jasonpearson.auto-mobile", "module": "auto-mobile-sdk", "version": "1.2.3" },
  "variants": [
    {
      "name": "debugVariantMavenRuntimePublication",
      "attributes": {
        "com.android.build.api.attributes.BuildTypeAttr": "debug",
        "org.gradle.category": "library",
        "org.gradle.usage": "java-runtime"
      },
      "files": [ { "name": "auto-mobile-sdk-1.2.3-debug.aar" } ]
    },
    {
      "name": "releaseVariantMavenRuntimePublication",
      "attributes": {
        "com.android.build.api.attributes.BuildTypeAttr": "release",
        "org.gradle.category": "library",
        "org.gradle.usage": "java-runtime"
      },
      "files": [ { "name": "auto-mobile-sdk-1.2.3-release.aar" } ]
    }
  ]
}
JSON

  # Same graph, but the debug runtime variant declares a NON-default capability,
  # so a plain coordinate dependency cannot select it.
  cat >"${FIX}/hostile-capability.module" <<'JSON'
{
  "formatVersion": "1.1",
  "component": { "group": "dev.jasonpearson.auto-mobile", "module": "auto-mobile-sdk", "version": "1.2.3" },
  "variants": [
    {
      "name": "debugVariantMavenRuntimePublication",
      "attributes": {
        "com.android.build.api.attributes.BuildTypeAttr": "debug",
        "org.gradle.category": "library",
        "org.gradle.usage": "java-runtime"
      },
      "capabilities": [ { "group": "hostile", "name": "other", "version": "1.2.3" } ],
      "files": [ { "name": "auto-mobile-sdk-1.2.3-debug.aar" } ]
    }
  ]
}
JSON

  # Two indistinguishable default-capability debug runtime variants: Gradle
  # cannot choose between them, so the coordinate is unresolvable.
  cat >"${FIX}/ambiguous.module" <<'JSON'
{
  "formatVersion": "1.1",
  "component": { "group": "dev.jasonpearson.auto-mobile", "module": "auto-mobile-sdk", "version": "1.2.3" },
  "variants": [
    {
      "name": "debugVariantMavenRuntimePublication",
      "attributes": {
        "com.android.build.api.attributes.BuildTypeAttr": "debug",
        "org.gradle.category": "library",
        "org.gradle.usage": "java-runtime"
      },
      "files": [ { "name": "auto-mobile-sdk-1.2.3-debug.aar" } ]
    },
    {
      "name": "debugVariantMavenRuntimePublicationDup",
      "attributes": {
        "com.android.build.api.attributes.BuildTypeAttr": "debug",
        "org.gradle.category": "library",
        "org.gradle.usage": "java-runtime"
      },
      "files": [ { "name": "auto-mobile-sdk-1.2.3-debug.aar" } ]
    }
  ]
}
JSON
}

teardown() {
  rm -rf "${FIX}"
}

@test "manifest_provider_count finds each declared exported provider" {
  [ "$(manifest_provider_count "${FIX}/debug-manifest.xml" "$DB_PROVIDER")" = "1" ]
  [ "$(manifest_provider_count "${FIX}/debug-manifest.xml" "$SP_PROVIDER")" = "1" ]
}

@test "manifest_provider_count returns 0 when the release manifest omits providers" {
  [ "$(manifest_provider_count "${FIX}/release-manifest.xml" "$DB_PROVIDER")" = "0" ]
}

@test "manifest_provider_count rejects a provider declared exported=false" {
  # AC1/AC3 hinge on the exported attribute: a non-exported provider is not a
  # reachable inspection endpoint and must not count.
  cat >"${FIX}/not-exported.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.jasonpearson.automobile.sdk">
  <application>
    <provider android:name="${DB_PROVIDER}" android:authorities="x" android:exported="false" />
  </application>
</manifest>
XML
  [ "$(manifest_provider_count "${FIX}/not-exported.xml" "$DB_PROVIDER")" = "0" ]
}

@test "manifest_named_provider_count reports each inspection provider by name" {
  [ "$(manifest_named_provider_count "${FIX}/debug-manifest.xml" "$DB_PROVIDER")" = "1" ]
  [ "$(manifest_named_provider_count "${FIX}/debug-manifest.xml" "$SP_PROVIDER")" = "1" ]
  [ "$(manifest_named_provider_count "${FIX}/release-manifest.xml" "$DB_PROVIDER")" = "0" ]
}

@test "manifest_named_provider_count ignores an unrelated provider in the release manifest" {
  # AC3 must not fail if the SDK later ships a legitimate release-safe provider:
  # the check is scoped to the two inspection providers by name.
  cat >"${FIX}/release-with-other.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.jasonpearson.automobile.sdk">
  <application>
    <provider android:name="androidx.startup.InitializationProvider" android:authorities="x" android:exported="false" />
  </application>
</manifest>
XML
  [ "$(manifest_named_provider_count "${FIX}/release-with-other.xml" "$DB_PROVIDER")" = "0" ]
  [ "$(manifest_named_provider_count "${FIX}/release-with-other.xml" "$SP_PROVIDER")" = "0" ]
}

@test "aar_class_present detects provider classes in the debug AAR" {
  [ "$(aar_class_present "${FIX}/debug.aar" "$DB_CLASS")" = "1" ]
  [ "$(aar_class_present "${FIX}/debug.aar" "$SP_CLASS")" = "1" ]
}

@test "aar_class_present rejects provider classes absent from the release AAR" {
  [ "$(aar_class_present "${FIX}/release.aar" "$DB_CLASS")" = "0" ]
  [ "$(aar_class_present "${FIX}/release.aar" "$SP_CLASS")" = "0" ]
}

@test "aar_class_present does not partial-match a longer class name" {
  [ "$(aar_class_present "${FIX}/debug.aar" "dev/jasonpearson/automobile/sdk/database/DatabaseInspector.class")" = "0" ]
}

@test "module_runtime_aar_for_build_type routes each build type to its AAR" {
  [ "$(module_runtime_aar_for_build_type "${FIX}/sdk.module" debug)" = "auto-mobile-sdk-1.2.3-debug.aar" ]
  [ "$(module_runtime_aar_for_build_type "${FIX}/sdk.module" release)" = "auto-mobile-sdk-1.2.3-release.aar" ]
}

@test "module_runtime_aar_for_build_type rejects a variant with a non-default capability" {
  # A build-type match is not enough: a variant a plain coordinate dependency
  # cannot select (non-default capability) must not count as satisfying AC4.
  [ -z "$(module_runtime_aar_for_build_type "${FIX}/hostile-capability.module" debug)" ]
}

@test "module_runtime_aar_for_build_type rejects ambiguous duplicate variants" {
  # Two indistinguishable matching variants make the coordinate unresolvable;
  # returning the first would overstate AC4.
  [ -z "$(module_runtime_aar_for_build_type "${FIX}/ambiguous.module" debug)" ]
}
