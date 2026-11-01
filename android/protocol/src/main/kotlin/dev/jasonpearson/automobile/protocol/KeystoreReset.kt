package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.Serializable

/** Identifiers and deletion outcomes only; never carries key material. */
@Serializable
data class KeystoreResetState(
  val schemaVersion: Int = 1,
  val capability: String = "storage.keystore",
  val outcome: String,
  val reason: String? = null,
  val bridgeAvailable: Boolean,
  val requestedScope: String? = null,
  val requestedAlias: String? = null,
  val status: String? = null,
  val deletedCount: Int = 0,
  val aliases: List<KeystoreAliasReset>? = null,
)

@Serializable data class KeystoreAliasReset(val alias: String, val outcome: String)
