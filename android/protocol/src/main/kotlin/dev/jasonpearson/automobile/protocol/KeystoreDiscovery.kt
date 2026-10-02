package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.Serializable

/** Metadata capability only. Never carries keys, certificates, or alias values. */
@Serializable
data class KeystoreDiscoveryState(
  val schemaVersion: Int = 1,
  val capability: String = "storage.keystore",
  val outcome: String,
  val reason: String? = null,
  val bridgeAvailable: Boolean,
  val metadata: String = "supported",
  val mutation: String = "declared_unsupported",
  val deviceLocked: String = "unknown",
  val scopes: List<String> = emptyList(),
)
