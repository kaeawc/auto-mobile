package dev.jasonpearson.automobile.sdk.capabilities

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull

/** A decoded snapshot, or an unavailable snapshot with a diagnostic reason. */
sealed interface SdkCapabilitySnapshotResult {
  data class Success(val document: SdkCapabilityDocument) : SdkCapabilitySnapshotResult

  data class Failure(val reason: String) : SdkCapabilitySnapshotResult
}

private val snapshotJson = Json {
  encodeDefaults = true
  ignoreUnknownKeys = true
}

/** Encodes the complete snapshot, including default policy flags, without accessing SDK state. */
fun SdkCapabilityDocument.toSnapshotJson(): String =
  snapshotJson.encodeToString<SdkCapabilityDocument>(this)

/**
 * Decodes versions 1 and higher using the version 1 structure, preserving the supplied version.
 * Version 0 and negative versions have no supported schema. Unknown keys are ignored and unknown
 * state strings become UNKNOWN; missing required fields and invalid field types remain failures.
 * Omitted policy flags retain the safe false defaults of [SdkCapturePolicy].
 */
fun decodeSdkCapabilitySnapshot(json: String): SdkCapabilitySnapshotResult {
  return try {
    val document =
      snapshotJson.parseToJsonElement(json) as? JsonObject
        ?: return SdkCapabilitySnapshotResult.Failure("Snapshot must be a JSON object")
    val version =
      document["schemaVersion"] as? JsonPrimitive
        ?: return SdkCapabilitySnapshotResult.Failure("Missing or invalid schemaVersion")
    val versionNumber = version.intOrNull
    if (version.isString || versionNumber == null || versionNumber < 1) {
      return SdkCapabilitySnapshotResult.Failure("schemaVersion must be a positive integer")
    }
    val policy =
      document["policy"] as? JsonObject
        ?: return SdkCapabilitySnapshotResult.Failure("Missing or invalid policy")
    // kotlinx serialization accepts quoted booleans, so validate authorization flags explicitly.
    for (flag in listOf("captureHeaders", "captureBodies", "allowMutations")) {
      val value = policy[flag] ?: continue
      if (value !is JsonPrimitive || value.isString || value.booleanOrNull == null) {
        return SdkCapabilitySnapshotResult.Failure("policy.$flag must be a JSON boolean")
      }
    }
    SdkCapabilitySnapshotResult.Success(
      snapshotJson.decodeFromJsonElement<SdkCapabilityDocument>(normalizeUnknownStates(document)),
    )
  } catch (error: SerializationException) {
    SdkCapabilitySnapshotResult.Failure(error.message ?: "Malformed capability snapshot")
  }
}

private fun normalizeUnknownStates(document: JsonObject): JsonObject {
  val capabilities = document["capabilities"] as? JsonArray ?: return document
  return JsonObject(
    document + ("capabilities" to JsonArray(capabilities.map(::normalizeUnknownState))),
  )
}

private fun normalizeUnknownState(element: JsonElement): JsonElement {
  val descriptor = element as? JsonObject ?: return element
  val state = descriptor["state"] as? JsonPrimitive ?: return descriptor
  return if (state.isString && SdkCapabilityState.entries.none { it.name == state.content }) {
    JsonObject(descriptor + ("state" to JsonPrimitive(SdkCapabilityState.UNKNOWN.name)))
  } else descriptor
}
