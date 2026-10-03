package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.SdkEvent

/** Submit persisted batches in FIFO order and remove only fully handed-off batches. */
internal fun replayEventBatches(
  persistence: EventPersistence,
  deliver: (List<SdkEvent>, (Boolean) -> Unit) -> Unit,
) {
  val pending =
    try {
      persistence.loadPending()
    } catch (_: Exception) {
      // Custom persistence may fail to read; leave its files for the next launch.
      return
    }
  for ((batchId, events) in pending) {
    try {
      deliver(events) { delivered ->
        if (delivered) {
          try {
            persistence.removeBatch(batchId)
          } catch (_: Exception) {
            // Removal is best-effort; a retained file can safely be replayed next launch.
          }
        }
        // Partial delivery keeps the whole file. Already-sent chunks may replay next launch.
      }
    } catch (_: Exception) {
      // Submission failed; keep the original file rather than persisting a duplicate.
    }
  }
}
