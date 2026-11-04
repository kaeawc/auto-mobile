package dev.jasonpearson.automobile.buildlogic.robolectric

import java.io.File

/**
 * The android-all-instrumented runtime jars Robolectric loads per SDK level.
 *
 * Robolectric downloads these from Maven Central at test time with a single attempt, outside
 * Gradle's dependency cache, so one Maven Central blip fails every Robolectric class (#16802). The
 * `automobile.robolectric-android-all` convention resolves them through Gradle instead (cached,
 * retried, and covered by run-gradle-with-retry.sh in CI) and hands Robolectric their paths in a
 * `robolectric-deps.properties` file, which makes Robolectric resolve offline.
 *
 * The versions mirror Robolectric's `DefaultSdkProvider` for [ROBOLECTRIC_VERSION]: each jar is
 * `org.robolectric:android-all-instrumented:<android>-robolectric-<build>-i<preinstrumented>`.
 */
object RobolectricAndroidAll {
  /** The Robolectric release [versions] was read from; a catalog bump must refresh the table. */
  const val ROBOLECTRIC_VERSION = "4.17"

  const val GROUP = "org.robolectric"
  const val ARTIFACT = "android-all-instrumented"

  private const val PREINSTRUMENTED_VERSION = "i7"

  private val androidVersions =
    sortedMapOf(
      23 to ("6.0.1_r3" to "r1"),
      24 to ("7.0.0_r1" to "r1"),
      25 to ("7.1.0_r7" to "r1"),
      26 to ("8.0.0_r4" to "r1"),
      27 to ("8.1.0" to "4611349"),
      28 to ("9" to "4913185-2"),
      29 to ("10" to "5803371"),
      30 to ("11" to "6757853"),
      31 to ("12" to "7732740"),
      32 to ("12.1" to "8229987"),
      33 to ("13" to "9030017"),
      34 to ("14" to "10818077"),
      35 to ("15" to "13954326"),
      36 to ("16" to "13921718"),
      37 to ("17" to "15733970"),
    )

  /** Robolectric's oldest SDK: `Config.OLDEST_SDK`, and the default when nothing pins one. */
  val OLDEST_SDK: Int = androidVersions.firstKey()

  val versions: Map<Int, String> = androidVersions.mapValues { (_, value) ->
    "${value.first}-robolectric-${value.second}-$PREINSTRUMENTED_VERSION"
  }

  /** The Maven coordinate of [sdk]'s jar, or null when this Robolectric has no such SDK. */
  fun coordinate(sdk: Int): String? = versions[sdk]?.let { "$GROUP:$ARTIFACT:$it" }

  /** Fails when the catalog's Robolectric version is not the one [versions] was read from. */
  fun requireCatalogVersion(catalogVersion: String) {
    check(catalogVersion == ROBOLECTRIC_VERSION) {
      "libs.versions.toml pins Robolectric $catalogVersion, but RobolectricAndroidAll lists the " +
        "android-all-instrumented jars of $ROBOLECTRIC_VERSION. Copy the SDK table from that " +
        "release's DefaultSdkProvider and update ROBOLECTRIC_VERSION."
    }
  }

  /**
   * The SDK levels a module's Robolectric tests run on: every `@Config(sdk = ...)` level in
   * [sources], every robolectric.properties pin in [propertiesFiles], and [OLDEST_SDK] when the
   * module has no primary pin, since that is Robolectric's default without a manifest
   * (verifyRobolectricSdkPin requires a pin whenever a manifest targetSdk would apply instead).
   */
  fun moduleSdks(
    sources: List<String>,
    propertiesFiles: List<String>,
    hasPrimaryPin: Boolean,
  ): Set<Int> = buildSet {
    sources.forEach { addAll(RobolectricSdkPins.sourceSdks(it, OLDEST_SDK)) }
    propertiesFiles.forEach { text -> RobolectricSdkPins.propertiesSdk(text)?.let { add(it) } }
    if (!hasPrimaryPin) add(OLDEST_SDK)
  }

  /**
   * The robolectric-deps.properties content mapping each resolved jar's Robolectric short name
   * (`group:artifact:version`) to its absolute path. [jars] maps a version to its file.
   */
  fun depsProperties(jars: Map<String, File>): String =
    jars.entries
      .sortedBy { it.key }
      .joinToString(separator = "\n", postfix = "\n") { (version, file) ->
        "${escape("$GROUP:$ARTIFACT:$version")}=${escape(file.absolutePath)}"
      }

  // java.util.Properties escaping for the characters these keys and paths can contain.
  private fun escape(value: String): String =
    value
      .replace("\\", "\\\\")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
      .replace(":", "\\:")
      .replace("=", "\\=")
      .replace(" ", "\\ ")
}
