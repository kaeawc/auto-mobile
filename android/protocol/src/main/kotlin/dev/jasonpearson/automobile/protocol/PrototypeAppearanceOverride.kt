package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * What a show takes as the system appearance: the device's own setting, or a fixed mode. Kept out
 * of WebSocketRequest.kt, whose `@SerialName`s are read as the request-type set.
 */
@Serializable
enum class PrototypeAppearanceOverride {
  @SerialName("device") DEVICE,
  @SerialName("light") LIGHT,
  @SerialName("dark") DARK,
}
