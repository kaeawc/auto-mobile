package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse

/** Sends hierarchy-extract error frames over the WebSocket server. */
internal fun CtrlProxy.hierarchyExtractTransport(): HierarchyExtractFrameSender.Transport =
  object : HierarchyExtractFrameSender.Transport {
    override fun isRunning() = isWebSocketRunning()

    override suspend fun broadcastExternallyCorrelated(frame: ErrorResponse) =
      webSocketServer.broadcastExternallyCorrelatedResponse(frame)

    override suspend fun broadcast(frame: ErrorResponse) = webSocketServer.broadcast(frame)
  }

/** Sends request results over the WebSocket server, flushing perf timing first. */
internal fun CtrlProxy.guardedResultTransport(): GuardedResultSender.Transport =
  object : GuardedResultSender.Transport {
    override fun isRunning() = isWebSocketRunning()

    override fun flushPerfTiming() = perfProvider.flush()

    override suspend fun sendFrame(frame: String) = webSocketServer.broadcast(frame)

    override suspend fun send(response: WebSocketResponse) = webSocketServer.broadcast(response)

    override fun connectionCount() = webSocketServer.getConnectionCount()
  }

/** Broadcasts device events over the WebSocket server. */
internal fun CtrlProxy.deviceEventTransport(): DeviceEventTransport =
  object : DeviceEventTransport {
    override fun isRunning() = isWebSocketRunning()

    override fun connectionCount() = webSocketServer.getConnectionCount()

    override suspend fun broadcast(message: String) = webSocketServer.broadcast(message)

    override suspend fun broadcast(
      response: WebSocketResponse,
      mode: WebSocketServer.BroadcastMode,
      waitForClient: Boolean,
    ) = webSocketServer.broadcast(response, mode, waitForClient)
  }

/** Broadcasts prototype results over the WebSocket server. */
internal fun CtrlProxy.prototypeResultTransport(): PrototypeResultTransport =
  object : PrototypeResultTransport {
    override fun isRunning() = isWebSocketRunning()

    override suspend fun broadcastFrame(buildFrame: () -> String) =
      webSocketServer.broadcastWithPerf { _ ->
        buildFrame()
      }
  }
