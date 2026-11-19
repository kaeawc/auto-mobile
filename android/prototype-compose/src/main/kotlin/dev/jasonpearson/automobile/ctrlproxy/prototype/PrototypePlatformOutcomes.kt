package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformError
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One FIFO per contract call, owned by the runtime's dispatcher and guarded by its lock. */
internal class PrototypePlatformOutcomes {
  private val queues = mutableMapOf<String, ArrayDeque<PlatformCallResult>>()

  fun enqueue(call: String, outcome: JsonObject) {
    require(
      outcome.toString().toByteArray(Charsets.UTF_8).size <=
        PrototypeSpecValidator.MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES,
    ) {
      "simulate outcome exceeds the 4096-byte emit budget"
    }
    val result = decode(outcome)
    val queue = queues[call]
    require((queue?.size ?: 0) < MAX_QUEUED_PER_CALL) {
      "At most $MAX_QUEUED_PER_CALL outcomes can be queued for $call"
    }
    (queue ?: ArrayDeque<PlatformCallResult>().also { queues[call] = it }).addLast(result)
  }

  fun consume(call: String): PlatformCallResult? {
    val queue = queues[call] ?: return null
    val result = queue.removeFirst()
    if (queue.isEmpty()) queues.remove(call)
    return result
  }

  fun clear() = queues.clear()

  private fun decode(outcome: JsonObject): PlatformCallResult {
    require(outcome.size == 1) { "Provide exactly one result or error" }
    outcome["result"]?.let {
      return PlatformCallResult.Success(it)
    }
    val error =
      requireNotNull(outcome["error"] as? JsonObject) {
        "Provide exactly one result or error"
      }
    require(error.keys.all { it == "code" || it == "message" }) { "Unexpected outcome error field" }
    val code = (error["code"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val knownCode =
      requireNotNull(PlatformErrorCode.entries.firstOrNull { it.wireValue == code }) {
        "Unknown platform error code: $code"
      }
    val message =
      error["message"]
        ?.let {
          val text = (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content
          require(text != null && text.length <= 200) {
            "Outcome error message must be at most 200 characters"
          }
          text
        }
        .orEmpty()
    return PlatformCallResult.Failure(PlatformError(knownCode, message))
  }

  private companion object {
    const val MAX_QUEUED_PER_CALL = 16
  }
}
