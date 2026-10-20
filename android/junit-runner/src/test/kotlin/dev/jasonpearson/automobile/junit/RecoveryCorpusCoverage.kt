package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertTrue

internal class RecoveryCorpusCoverage {
  private var hinted = false
  private var unbounded = false
  private var permanent = false

  fun recordWait(hint: Long?) {
    if (hint == null) unbounded = true else hinted = true
  }

  fun recordPermanent(recovering: Boolean) {
    if (!recovering) permanent = true
  }

  fun assertCovered() {
    assertTrue(hinted && unbounded && permanent)
  }
}

internal data class RecoveryFixtureEvidence(
  val code: String,
  val recovering: Boolean,
  val waits: Boolean,
  val hint: Long?,
)

/** Independent expected wait rule for the shared wire corpus, rather than the production parser. */
internal fun recoveryFixtureEvidence(wire: JsonObject): RecoveryFixtureEvidence? {
  val envelope = wire["error"] as? JsonObject
  val code = (envelope?.get("code") ?: wire["code"])?.jsonPrimitive?.content
  if (code !in setOf("device_unhealthy", "session_held_by_recovery")) return null
  val recovering = (envelope?.get("recovering") ?: wire["recovering"]) == JsonPrimitive(true)
  val retryable = (envelope?.get("retryable") ?: wire["retryable"]) == JsonPrimitive(true)
  val waits = retryable && (code == "session_held_by_recovery" || recovering)
  val hint = (envelope?.get("retryAfterMs") ?: wire["retryAfterMs"])?.jsonPrimitive?.long
  return RecoveryFixtureEvidence(checkNotNull(code), recovering, waits, hint)
}
