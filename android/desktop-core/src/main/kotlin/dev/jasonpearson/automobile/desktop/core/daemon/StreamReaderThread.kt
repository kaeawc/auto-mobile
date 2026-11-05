package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher

/**
 * Creates the dispatcher a JSON stream client parks its blocking `readLine()` on, one per
 * connection: the read loop closes it when that connection ends, so a read still unwinding from an
 * interrupt never delays the next connection's reader. Injected so a test can count or substitute
 * reader threads without opening sockets.
 */
fun interface StreamReaderDispatcherFactory {
  fun create(name: String): ExecutorCoroutineDispatcher
}

/**
 * Production factory: one dedicated daemon thread per stream, the pattern [VideoStreamClient]
 * already uses. A blocked reader then never occupies a shared `Dispatchers.IO` slot, so a farm of
 * dozens of streams cannot exhaust that pool and starve unrelated `withContext(Dispatchers.IO)`
 * work.
 */
object DedicatedStreamReaderThreads : StreamReaderDispatcherFactory {
  override fun create(name: String): ExecutorCoroutineDispatcher =
    Executors.newSingleThreadExecutor(daemonThreadFactory(name)).asCoroutineDispatcher()

  private fun daemonThreadFactory(name: String) = ThreadFactory { runnable ->
    Thread(runnable, name).apply { isDaemon = true }
  }
}
