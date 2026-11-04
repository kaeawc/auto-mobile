package dev.jasonpearson.automobile.buildlogic.robolectric

import java.io.StringReader
import java.util.Properties

object RobolectricSdkPins {
  private val versionCodes =
    mapOf(
      "P" to 28,
      "O" to 26,
      "O_MR1" to 27,
      "N" to 24,
      "N_MR1" to 25,
      "M" to 23,
      "Q" to 29,
      "R" to 30,
      "S" to 31,
      "TIRAMISU" to 33,
      "UPSIDE_DOWN_CAKE" to 34,
      "VANILLA_ICE_CREAM" to 35,
      "BAKLAVA" to 36,
    )

  private sealed interface SdkRef {
    data class Level(val sdk: Int) : SdkRef

    data class UnknownVersionCode(val name: String) : SdkRef

    data class ConfigConstant(val name: String) : SdkRef
  }

  private fun sdkRefs(sourceText: String): Sequence<SdkRef> = sequence {
    val text = sourceText.replace(Regex("(?s)/\\*.*?\\*/|//[^\\n]*"), " ")
    val annotations = Regex("@(?:[\\w.]+\\.)?Config\\s*\\((.*?)\\)", RegexOption.DOT_MATCHES_ALL)
    // Kotlin `sdk = [a, b]`, Java `sdk = {a, b}`, or a single value.
    val sdkArgs =
      Regex("\\bsdk\\s*=\\s*(\\[[^]]*]|\\{[^}]*}|[A-Za-z0-9_.]+)", RegexOption.DOT_MATCHES_ALL)
    val entries = Regex("Build\\.VERSION_CODES\\.([A-Z][A-Z0-9_]*)|(?<![\\w.])(\\d+)")
    for (annotation in annotations.findAll(text)) {
      for (arg in sdkArgs.findAll(annotation.groupValues[1])) {
        val items = arg.groupValues[1].trim().trim('[', ']', '{', '}').split(',')
        for (item in items.map { it.trim() }.filter { it.isNotEmpty() }) {
          if (item.startsWith("Config.")) {
            yield(SdkRef.ConfigConstant(item.removePrefix("Config.")))
            continue
          }
          for (entry in entries.findAll(item)) {
            val name = entry.groupValues[1]
            val sdk =
              if (name.isNotEmpty()) versionCodes[name] else entry.groupValues[2].toIntOrNull()
            yield(if (sdk == null) SdkRef.UnknownVersionCode(name) else SdkRef.Level(sdk))
          }
        }
      }
    }
  }

  fun sourceViolations(sourceText: String, filePath: String, maxSupportedSdk: Int): List<String> =
    sdkRefs(sourceText)
      .mapNotNull { ref ->
        when (ref) {
          is SdkRef.ConfigConstant ->
            if (ref.name in setOf("NEWEST_SDK", "ALL_SDKS", "TARGET_SDK")) {
              "$filePath: @Config sdk=${ref.name} floats with the SDK or targetSdk; use a numeric literal."
            } else {
              null
            }
          is SdkRef.UnknownVersionCode ->
            "$filePath: unknown SDK version code ${ref.name}; use a numeric literal."
          is SdkRef.Level ->
            if (ref.sdk > maxSupportedSdk) {
              "$filePath: explicit Robolectric SDK ${ref.sdk} exceeds supported maximum $maxSupportedSdk."
            } else {
              null
            }
        }
      }
      .toList()

  /**
   * SDK levels a test source asks Robolectric for through `@Config(sdk = ...)`. `Config.OLDEST_SDK`
   * maps to [oldestSdk]; the floating constants are rejected by [sourceViolations] and skipped.
   */
  fun sourceSdks(sourceText: String, oldestSdk: Int): Set<Int> =
    sdkRefs(sourceText)
      .mapNotNull { ref ->
        when (ref) {
          is SdkRef.Level -> ref.sdk
          is SdkRef.ConfigConstant -> if (ref.name == "OLDEST_SDK") oldestSdk else null
          is SdkRef.UnknownVersionCode -> null
        }
      }
      .toSet()

  /** The numeric `sdk=` pin in a robolectric.properties file, or null when it has none. */
  fun propertiesSdk(propertiesText: String): Int? =
    Properties()
      .apply { load(StringReader(propertiesText)) }
      .getProperty("sdk")
      ?.trim()
      ?.toIntOrNull()

  fun propertiesViolations(
    propertiesText: String,
    filePath: String,
    minSdk: Int,
    maxSupportedSdk: Int,
    primary: Boolean,
  ): List<String> {
    val pin =
      Properties()
        .apply { load(StringReader(propertiesText)) }
        .getProperty("sdk")
        ?.trim()
        ?.toIntOrNull()
        ?: return listOf("$filePath: robolectric.properties must contain a numeric sdk= line.")
    return buildList {
      if (pin > maxSupportedSdk)
        add("$filePath: pinned Robolectric SDK $pin exceeds supported maximum $maxSupportedSdk.")
      if (primary && pin < minSdk)
        add("$filePath: pinned Robolectric SDK $pin is below minSdk $minSdk.")
    }
  }

  fun violations(
    propertiesText: String?,
    targetSdk: Int?,
    minSdk: Int,
    includeAndroidResources: Boolean,
    maxSupportedSdk: Int,
  ): List<String> {
    val requiresPin = includeAndroidResources || targetSdk != null
    if (propertiesText == null) {
      val violations = mutableListOf<String>()
      if (requiresPin)
        violations += "A numeric sdk= pin is required in src/test/resources/robolectric.properties."
      if (targetSdk != null && targetSdk > maxSupportedSdk) {
        violations +=
          "targetSdk $targetSdk exceeds the highest SDK Robolectric supports ($maxSupportedSdk); pin sdk=<=$maxSupportedSdk in robolectric.properties"
      }
      return violations
    }

    val properties = Properties().apply { load(StringReader(propertiesText)) }
    val rawPin = properties.getProperty("sdk")?.trim()
    val pin = rawPin?.toIntOrNull()
    if (pin == null) {
      return listOf("robolectric.properties must contain a numeric sdk= line.")
    }

    return buildList {
      if (pin > maxSupportedSdk)
        add("Pinned Robolectric SDK $pin exceeds the highest supported SDK ($maxSupportedSdk).")
      if (pin < minSdk)
        add(
          "Pinned Robolectric SDK $pin is below minSdk $minSdk, which the merged manifest rejects.",
        )
    }
  }
}
