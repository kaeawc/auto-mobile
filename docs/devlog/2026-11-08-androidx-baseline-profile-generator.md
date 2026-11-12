# AndroidX baseline profile tooling for CtrlProxy

- Kind: decision
- Date: 2026-11-08
- Source: moved from docs/decisions/androidx-baseline-profile-generator.md (added in #17439)

Status: accepted for #17417.

Dependencies: the `androidx.baselineprofile` Gradle plugin
(`androidx.benchmark:benchmark-baseline-profile-gradle-plugin`, on the `build-logic` classpath),
`androidx.benchmark:benchmark-macro-junit4` (only in the device-only
`:control-proxy-baselineprofile` test module), and `androidx.profileinstaller:profileinstaller`
(declared directly in `control-proxy`; it was already on the release classpath through Compose).

## Decision

CtrlProxy's release APK packages a baseline profile. The hand-authored rules cover the known hot
paths, and the AndroidX tooling records exact rules on a device: the plugin wires a Macrobenchmark
producer module to the app, adds the release-like build types the producer needs, and writes
recorded rules into the `generated/baselineProfiles/` directory of the app's `main` source set. `profileinstaller` is declared directly
because CtrlProxy is installed with `adb install`, where only that library hands the packaged
profile to ART; relying on Compose to bring it in transitively would silently drop it if that
dependency changed.

## Alternatives checked

| Alternative                                 | Why not                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Hand-authored rules only                    | Already shipped; wildcard rules cannot show which methods actually run, and nothing could refresh them. |
| Hand-rolled `com.android.test` + `pm` dumps | Re-implements build-type matching, profile extraction and rule rewriting that the plugin already owns.  |
| Generating during release builds            | Needs a device on every release build; `automaticGenerationDuringBuild` stays off.                      |
| Relying on Compose's transitive installer   | Works today, but nothing in CtrlProxy's build would notice it disappearing.                             |
