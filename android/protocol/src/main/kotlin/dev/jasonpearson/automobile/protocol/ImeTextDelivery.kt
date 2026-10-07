package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class ImeTextDelivery {
  @SerialName("commit") COMMIT,
  @SerialName("keyEvents") KEY_EVENTS,
  /**
   * Clear through the editor connection before realistic typing, preserving a rich-text composer's
   * response to keystrokes (autocomplete, markdown/autoformat shortcuts, and mention chips).
   */
  @SerialName("clearField") CLEAR_FIELD,
}
