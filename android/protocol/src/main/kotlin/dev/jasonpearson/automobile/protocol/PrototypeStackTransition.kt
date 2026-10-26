package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Screen navigation animation; omitted means platform. Separate from node visibility. */
@Serializable
enum class PrototypeStackTransition(val value: String) {
  @SerialName("platform") PLATFORM("platform"),
  @SerialName("slide") SLIDE("slide"),
  @SerialName("fade") FADE("fade"),
  @SerialName("none") NONE("none");

  companion object {
    fun fromValue(value: String): PrototypeStackTransition? = entries.firstOrNull {
      it.value == value
    }
  }
}
