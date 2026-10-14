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

  fun sourceViolations(sourceText: String, filePath: String, maxSupportedSdk: Int): List<String> {
    val text = sourceText.replace(Regex("(?s)/\\*.*?\\*/|//[^\\n]*"), " ")
    val violations = mutableListOf<String>()
    val annotations = Regex("@Config\\s*\\((.*?)\\)", RegexOption.DOT_MATCHES_ALL)
    val sdkArgs = Regex("\\bsdk\\s*=\\s*(\\[[^]]*]|[A-Za-z0-9_.]+)", RegexOption.DOT_MATCHES_ALL)
    val entries = Regex("Build\\.VERSION_CODES\\.([A-Z][A-Z0-9_]*)|(?<![\\w.])(\\d+)")
    for (annotation in annotations.findAll(text)) {
      for (arg in sdkArgs.findAll(annotation.groupValues[1])) {
        val value = arg.groupValues[1].trim().removePrefix("[").removeSuffix("]")
        if (value.startsWith("Config.")) {
          val constant = value.removePrefix("Config.")
          if (constant in setOf("NEWEST_SDK", "ALL_SDKS", "TARGET_SDK")) {
            violations +=
              "$filePath: @Config sdk=$constant floats with the SDK or targetSdk; use a numeric literal."
          }
          continue
        }
        for (entry in entries.findAll(value)) {
          val name = entry.groupValues[1]
          val sdk =
            if (name.isNotEmpty()) versionCodes[name] else entry.groupValues[2].toIntOrNull()
          if (sdk == null) {
            violations += "$filePath: unknown SDK version code $name; use a numeric literal."
          } else if (sdk > maxSupportedSdk) {
            violations +=
              "$filePath: explicit Robolectric SDK $sdk exceeds supported maximum $maxSupportedSdk."
          }
        }
      }
    }
    return violations
  }

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
