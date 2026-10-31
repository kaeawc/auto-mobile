package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CancellationException

/** The socket device events leave through; the service resolves its lateinit server. */
internal interface DeviceEventTransport {
  fun isRunning(): Boolean

  fun connectionCount(): Int

  suspend fun broadcast(message: String)

  suspend fun broadcast(
    response: WebSocketResponse,
    mode: WebSocketServer.BroadcastMode,
    waitForClient: Boolean,
  )
}

/**
 * Forwards package, navigation, SDK and failure events to connected clients. Each event is skipped
 * while the socket is down. A send failure is logged and dropped so one bad event cannot stop the
 * stream; cancellation is rethrown so the caller unwinds cleanly (#3191).
 */
internal class DeviceEventBroadcaster(
  private val transport: DeviceEventTransport,
  private val timeProvider: TimeProvider,
) {
  suspend fun packageEvent(event: PackageBroadcastEvent) {
    if (skipped("package event broadcast")) return
    guarded("package event") {
      val message =
        packageEventFrame(
          PackageEventResult(
            timestamp = timeProvider.currentTimeMillis(),
            action = event.action,
            packageName = event.packageName,
            userId = event.userId,
            uid = event.uid,
            isSystem = event.isSystem,
            removedForAllUsers = event.removedForAllUsers,
          ),
        )
      transport.broadcast(message)
      Log.d(TAG, "Broadcasted package event to ${transport.connectionCount()} clients")
    }
  }

  suspend fun navigationEvent(
    event: TimestampedNavigationEvent,
    mode: WebSocketServer.BroadcastMode = WebSocketServer.BroadcastMode.Async,
    waitForClient: Boolean = false,
  ) {
    if (skipped("navigation event broadcast")) return
    guarded("navigation event") {
      transport.broadcast(navigationEventResponse(event), mode, waitForClient)
      Log.d(
        TAG,
        "Broadcasted navigation event to ${transport.connectionCount()} clients: ${event.destination}",
      )
    }
  }

  suspend fun handledException(report: HandledExceptionReport) {
    if (skipped("handled exception broadcast")) return
    guarded("handled exception event") {
      transport.broadcast(
        handledExceptionEventResponse(report, nowMs = timeProvider.currentTimeMillis()),
        WebSocketServer.BroadcastMode.Async,
        waitForClient = false,
      )
      Log.d(
        TAG,
        "Broadcasted handled exception to ${transport.connectionCount()} clients: ${report.exceptionClass}",
      )
    }
  }

  suspend fun crash(report: CrashReport) {
    if (skipped("crash broadcast")) return
    guarded("crash event") {
      transport.broadcast(
        crashEventResponse(report, nowMs = timeProvider.currentTimeMillis()),
        WebSocketServer.BroadcastMode.Async,
        waitForClient = false,
      )
      Log.i(
        TAG,
        "Broadcasted crash to ${transport.connectionCount()} clients: ${report.exceptionClass} on thread ${report.threadName}",
      )
    }
  }

  /** An individual SDK event from a batch; events with no client response are not sent. */
  suspend fun sdkEvent(
    event: SdkEvent,
    mode: WebSocketServer.BroadcastMode = WebSocketServer.BroadcastMode.Async,
    waitForClient: Boolean = false,
  ) {
    if (!transport.isRunning()) return
    guarded("SDK event") {
      sdkEventResponse(event)?.let { transport.broadcast(it, mode, waitForClient) }
    }
  }

  private fun skipped(what: String): Boolean {
    if (transport.isRunning()) return false
    Log.d(TAG, "WebSocket server not running, skipping $what")
    return true
  }

  // A device event is best effort: any send failure is logged and dropped, never rethrown.
  @Suppress("TooGenericExceptionCaught")
  private suspend fun guarded(what: String, send: suspend () -> Unit) {
    try {
      send()
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error broadcasting $what", e)
    }
  }

  private companion object {
    const val TAG = "CtrlProxy"
  }
}
