package dev.jasonpearson.automobile.ctrlproxy

/** Close gestures before quitting their thread, then cancel the service scope even on failure. */
internal fun teardownGestures(
  close: (() -> Unit) -> Unit,
  quitThread: () -> Unit,
  cancelScope: () -> Unit,
  onCloseFailure: (Throwable) -> Unit,
) {
  try {
    runCatching { close(quitThread) }
      .onFailure {
        onCloseFailure(it)
        quitThread()
      }
  } finally {
    cancelScope()
  }
}
