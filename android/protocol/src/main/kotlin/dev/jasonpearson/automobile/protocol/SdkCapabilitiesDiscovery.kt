package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Carrier for the SDK's versioned capability and capture-policy snapshot (issue #5191).
 *
 * `outcome` is `ok` when the app's SDK bridge answered, otherwise `unavailable` with a `reason`.
 * The snapshot is forwarded verbatim as JSON so the host validates it against its own schema and an
 * SDK that is newer than CtrlProxy never loses fields.
 */
@Serializable
data class SdkCapabilitiesState(
  val schemaVersion: Int = 1,
  val outcome: String,
  val reason: String? = null,
  val snapshot: JsonElement? = null,
)
