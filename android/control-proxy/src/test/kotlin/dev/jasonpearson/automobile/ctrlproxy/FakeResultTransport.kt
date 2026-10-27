package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.serialization.json.JsonElement

/**
 * Records what a [GuardedResultSender] puts on the wire, so controller tests keep the real running
 * check and broadcast guard. Perf timing is always absent; override a member to inspect or fail it.
 */
internal open class FakeResultTransport : GuardedResultSender.Transport {
  var running = true
  val sentFrames = mutableListOf<String>()
  val sentResponses = mutableListOf<WebSocketResponse>()

  override fun isRunning() = running

  override fun flushPerfTiming(): JsonElement? = null

  override suspend fun sendFrame(frame: String) {
    sentFrames += frame
  }

  override suspend fun send(response: WebSocketResponse) {
    sentResponses += response
  }

  override fun connectionCount() = 1
}

/** A [GuardedResultSender] over [transport] with debug logging turned off. */
internal fun guardedResultSender(
  transport: GuardedResultSender.Transport,
  resultBroadcaster: ResultBroadcaster,
): ResultSender = GuardedResultSender(transport, resultBroadcaster, logDebug = {})
