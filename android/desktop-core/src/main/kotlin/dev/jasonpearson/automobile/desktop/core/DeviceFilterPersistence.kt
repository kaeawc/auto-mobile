package dev.jasonpearson.automobile.desktop.core

internal data class DeviceFilterState(
  val minApi: Int = 28,
  val maxApi: Int = 35,
  val googleApisOnly: Boolean = false,
  val minIos: Int = 16,
  val maxIos: Int = 26,
  val showIphone: Boolean = true,
  val showIpad: Boolean = true,
  val minIosVersion: String? = null,
  val maxIosVersion: String? = null,
)

internal fun loadDeviceFilter(file: java.io.File): DeviceFilterState {
  try {
    if (file.exists()) {
      val element = kotlinx.serialization.json.Json.parseToJsonElement(file.readText())
      val obj = element as? kotlinx.serialization.json.JsonObject ?: return DeviceFilterState()
      fun intField(key: String, default: Int) =
        (obj[key] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() ?: default
      fun boolField(key: String, default: Boolean) =
        (obj[key] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toBooleanStrictOrNull()
          ?: default
      return DeviceFilterState(
        minApi = intField("minApi", 28),
        maxApi = intField("maxApi", 35),
        googleApisOnly = boolField("googleApisOnly", false),
        minIos = intField("minIos", 16),
        maxIos = intField("maxIos", 26),
        showIphone = boolField("showIphone", true),
        showIpad = boolField("showIpad", true),
        minIosVersion =
          (obj["minIosVersion"] as? kotlinx.serialization.json.JsonPrimitive)?.content,
        maxIosVersion =
          (obj["maxIosVersion"] as? kotlinx.serialization.json.JsonPrimitive)?.content,
      )
    }
  } catch (e: Exception) {
    LOG.warn("Failed to load device filters from $file", e)
  }
  return DeviceFilterState()
}

internal fun saveDeviceFilter(
  file: java.io.File,
  minApi: Int,
  maxApi: Int,
  googleApisOnly: Boolean,
  minIos: Int,
  maxIos: Int,
  showIphone: Boolean,
  showIpad: Boolean,
  minIosVersion: String? = null,
  maxIosVersion: String? = null,
) {
  try {
    file.parentFile?.mkdirs()
    val json =
      kotlinx.serialization.json.buildJsonObject {
        put("minApi", kotlinx.serialization.json.JsonPrimitive(minApi))
        put("maxApi", kotlinx.serialization.json.JsonPrimitive(maxApi))
        put("googleApisOnly", kotlinx.serialization.json.JsonPrimitive(googleApisOnly))
        put("minIos", kotlinx.serialization.json.JsonPrimitive(minIos))
        put("maxIos", kotlinx.serialization.json.JsonPrimitive(maxIos))
        put("showIphone", kotlinx.serialization.json.JsonPrimitive(showIphone))
        put("showIpad", kotlinx.serialization.json.JsonPrimitive(showIpad))
        minIosVersion?.let { put("minIosVersion", kotlinx.serialization.json.JsonPrimitive(it)) }
        maxIosVersion?.let { put("maxIosVersion", kotlinx.serialization.json.JsonPrimitive(it)) }
      }
    file.writeText(json.toString())
  } catch (e: Exception) {
    LOG.warn("Failed to save device filters to $file", e)
  }
}
