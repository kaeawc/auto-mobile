package dev.jasonpearson.automobile.ctrlproxy.ime

internal const val IME_SERVICE_READY_TIMEOUT_MS = 2_000L
internal const val IME_SERVICE_READY_POLL_MS = 50L

/** Same bounded activation poll as requestCommitText, with no Android or wall-clock dependency. */
internal suspend fun <T> awaitImeServiceReady(
  nowMs: () -> Long,
  delayMs: suspend (Long) -> Unit,
  probe: () -> T?,
  isCancelled: () -> Boolean,
): T? {
  val deadlineMs = nowMs() + IME_SERVICE_READY_TIMEOUT_MS
  var instance = probe()
  while (instance == null && !isCancelled() && nowMs() < deadlineMs) {
    delayMs(IME_SERVICE_READY_POLL_MS)
    instance = probe()
  }
  return instance
}
