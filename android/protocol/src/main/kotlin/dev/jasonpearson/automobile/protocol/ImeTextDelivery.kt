package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class ImeTextDelivery {
  @SerialName("commit") COMMIT,
  @SerialName("keyEvents") KEY_EVENTS,
}
