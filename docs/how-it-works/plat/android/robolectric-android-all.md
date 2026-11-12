# Robolectric android-all runtime jars

Robolectric runs each test against an `org.robolectric:android-all-instrumented` jar for the
test's SDK level. Left to itself, Robolectric downloads that jar from Maven Central at test time:
one attempt, outside Gradle's dependency cache and retries, so a single repository blip fails
every Robolectric class at `classMethod` with `AssertionError at MavenArtifactFetcher.java`.

## How the jars are resolved

Every Robolectric module applies `automobile.robolectric-sdk-pin`, which applies
`automobile.robolectric-android-all`. That convention:

1. Works out the module's SDK levels from its `src/test*` sources: every `@Config(sdk = ...)`
   level (`Config.OLDEST_SDK` counts as Robolectric's oldest SDK), every `robolectric.properties`
   `sdk=` pin, and Robolectric's oldest SDK when there is no primary pin, since that is its default
   without a manifest. This is a configuration-cache `ValueSource`, so editing a test's SDK list
   invalidates the cached configuration.
2. Resolves those jars through one non-transitive `robolectricAndroidAll<sdk>` configuration per
   SDK (every jar is a version of the same module, so one configuration would conflict-resolve
   them down to the newest). They come from Gradle's dependency cache and its HTTP retries (and,
   in CI, `run-gradle-with-retry.sh`).
3. Writes `build/robolectric/robolectric-deps.properties` (`writeRobolectricDeps`), mapping each
   jar's `group:artifact:version` to its path, and passes it to every `Test` task as
   `-Drobolectric-deps.properties`. With that property set Robolectric resolves only from the file
   and never contacts Maven Central.

The test task tracks the jars by file name, not the properties file, whose absolute paths are
machine-specific, so test results stay relocatable in the build cache.

## Invariants

- `RobolectricAndroidAll` lists the jar version per SDK for one Robolectric release, copied from
  that release's `DefaultSdkProvider`. Configuration fails when `libs.versions.toml` pins a
  different Robolectric version, so a Robolectric bump must refresh the table.
- An SDK the scan cannot see (for example a `@Config` level held in a constant other than
  `Config.OLDEST_SDK`) is missing from the properties file, and Robolectric fails with
  "no artifacts found" for it. Write SDK levels as numeric literals or `Build.VERSION_CODES` names.
