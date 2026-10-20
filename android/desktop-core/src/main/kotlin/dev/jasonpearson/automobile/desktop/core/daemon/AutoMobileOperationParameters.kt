package dev.jasonpearson.automobile.desktop.core.daemon

data class TapInput(
  val x: Double,
  val y: Double,
  val platform: String = "android",
  val deviceId: String? = null,
  val duration: Int? = null,
  val frameContext: String? = null,
)

data class SwipeInput(
  val startX: Double,
  val startY: Double,
  val endX: Double,
  val endY: Double,
  val platform: String = "android",
  val deviceId: String? = null,
  val durationMs: Int? = null,
  val frameContext: String? = null,
)

data class TextInput(
  val text: String,
  val platform: String = "android",
  val deviceId: String? = null,
  val submit: Boolean? = null,
  val append: Boolean = false,
  val frameContext: String? = null,
)

data class SetKeyValueRequest(
  val deviceId: String,
  val appId: String,
  val fileName: String,
  val key: String,
  val value: String?,
  val type: String,
  val platform: String = "android",
  val sessionUuid: String? = null,
)

data class RemoveKeyValueRequest(
  val deviceId: String,
  val appId: String,
  val fileName: String,
  val key: String,
  val platform: String = "android",
  val sessionUuid: String? = null,
)
