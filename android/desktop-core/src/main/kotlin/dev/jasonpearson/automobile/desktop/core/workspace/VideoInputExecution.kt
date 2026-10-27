package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher

private val LOG = LoggerFactory.getLogger("VideoInputDispatcher")

internal fun VideoInputDispatcher.dispatchDispatcher(): CoroutineDispatcher {
  injectedDispatcher?.let {
    return it
  }
  ownedDispatcher?.let {
    return it
  }
  val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "video-input-dispatch-$deviceId").apply { isDaemon = true }
  }
  val dispatcher = executor.asCoroutineDispatcher()
  ownedExecutor = executor
  ownedDispatcher = dispatcher
  return dispatcher
}

internal fun VideoInputDispatcher.retireExecutor() {
  // shutdown() (not shutdownNow) lets any queued coroutine drain — generation-stale ones drop.
  ownedExecutor?.shutdown()
  ownedExecutor = null
  ownedDispatcher = null
}
