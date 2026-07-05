package dev.jasonpearson.automobile.desktop.core

internal data class DeviceFilterState(
  val minApi: Int = 28,
  val maxApi: Int = 35,
  val googleApisOnly: Boolean = false,
  val minIos: Int = 16,
  val maxIos: Int = 26,
  val showIphone: Boolean = true,
  val showIpad: Boolean = true,
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
      )
    }
  } catch (_: Exception) {}
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
) {
  try {
    file.parentFile?.mkdirs()
    file.writeText(
      "{\"minApi\":$minApi,\"maxApi\":$maxApi,\"googleApisOnly\":$googleApisOnly,\"minIos\":$minIos,\"maxIos\":$maxIos,\"showIphone\":$showIphone,\"showIpad\":$showIpad}"
    )
  } catch (_: Exception) {}
}
