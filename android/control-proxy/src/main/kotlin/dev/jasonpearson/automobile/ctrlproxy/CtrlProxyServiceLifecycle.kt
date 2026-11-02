package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeController
import dev.jasonpearson.automobile.ctrlproxy.storage.StorageSubscriptionManager
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

// The service's log tag, so the moved startup steps keep logging under it.
private const val TAG = "CtrlProxy"

/** Starts SharedPreferences change tracking and forwards each change to connected clients. */
internal fun CtrlProxy.startStorageSubscription() {
  // Initialize storage subscription manager for SharedPreferences inspection
  storageSubscriptionManager = StorageSubscriptionManager(this, scope = serviceScope)
  Log.d(TAG, "Storage subscription manager initialized")

  // Subscribe to storage change events and broadcast them
  storageChangeJob =
    storageSubscriptionManager.changeEvents
      .onEach { event ->
        Log.d(
          TAG,
          "Storage change: ${event.packageName}:${event.fileName} key=${event.key}",
        )
        storageController.broadcastStorageChange(event)
      }
      .launchIn(serviceScope)
}

/** Stops forwarding storage changes and releases the subscription manager, if it was created. */
internal fun CtrlProxy.stopStorageSubscription() {
  storageChangeJob?.cancel()
  storageSubscriptionManagerOrNull?.let {
    it.destroy()
    Log.d(TAG, "Storage subscription manager destroyed")
  }
}

/** Creates and starts the WebSocket server; a failure to start disables the service. */
@Suppress("TooGenericExceptionCaught") // Any construction failure leaves the service unusable.
internal fun CtrlProxy.startWebSocketServer() {
  // Keep inbound blocking work off Ktor's read loops, preserving each connection's wire order.
  try {
    val queuedHandler = queuedMessageHandler()
    val sessions = clientSessionRouter(queuedHandler, prototypeController)
    webSocketServer =
      WebSocketServer(
        port = 8765,
        platform = prototypePlatform,
        scope = serviceScope,
        options =
          WebSocketServerOptions(
            messageHandler = queuedHandler,
            onClientDisconnected = sessions::onClientDisconnected,
            onClientCountChanged = sessions::onClientCountChanged,
            onPrototypeResponse = hostPrototypeHttp::onResponse,
            onClientConnected = sessions::onClientConnected,
            onPermanentStartFailure = { disableSelf() },
          ),
      )
    webSocketLifecycle.replace(webSocketServer)
    webSocketServer.start()
  } catch (e: Exception) {
    Log.e(TAG, "Error initializing WebSocket server during service connection", e)
    disableSelf()
  }
}

/** Stops the WebSocket server, if it was created. */
internal fun CtrlProxy.stopWebSocketServer() {
  if (webSocketServerOrNull != null) {
    webSocketLifecycle.stop()
    Log.d(TAG, "WebSocket server stopped")
  }
}

/** Starts navigation and SDK event ingestion once the WebSocket server can deliver events. */
internal fun CtrlProxy.startEventIngestion() {
  // Receivers may enqueue into the processor's bounded channel during bind retries. Do not
  // drain it, or publish accumulator events, until the listener can deliver them.
  serviceScope.launch {
    startEventIngestionWhenReady(
      isRunning = { webSocketServer.isRunning() },
      pause = { kotlinx.coroutines.delay(50L) },
    ) {
      navigationEventAccumulator.initialize()
      Log.d(TAG, "Navigation event accumulator initialized")
      navigationEventJob =
        navigationEventAccumulator.latestEvent
          .onEach { event ->
            if (event != null) {
              Log.d(TAG, "Navigation event: ${event.destination} at ${event.timestamp}")
              deviceEvents.navigationEvent(event)
            }
          }
          .launchIn(serviceScope)
      sdkEventBatchProcessor.start()
      Log.d(TAG, "SDK event batch processor started")
    }
  }
}

/** Stops publishing navigation events; the SDK batch processor ends with the service scope. */
internal fun CtrlProxy.stopEventIngestion() {
  navigationEventJob?.cancel()
}

/** Starts the logcat reader and forwards its bounded buffer to connected clients. */
internal fun CtrlProxy.startLogcatForwarding() {
  // Start logcat reader for automatic log capture. Gate parsing on a connected client so a
  // chatty device is not regex-parsed while nobody is consuming logs.
  val logBuffer = BoundedLogBuffer(capacity = 128, stats = workStats)
  logEventBuffer = logBuffer
  serviceScope.launch {
    logBuffer.drainTo(
      isRunning = { webSocketServerOrNull?.isRunning() == true },
      broadcast = { webSocketServer.broadcast(it) },
      onFailure = { Log.w(TAG, "Error broadcasting log event", it) },
    )
  }
  logcatReader =
    LogcatReader(
      onLogEvent = {},
      tryDeliver = logBuffer::offer,
      hasConsumer = { (webSocketServerOrNull?.getConnectionCount() ?: 0) > 0 },
      stats = workStats,
    )
  logcatReader?.start()
  Log.d(TAG, "Logcat reader started")
}

/** Stops the logcat reader and closes its buffer, ending the forwarding loop. */
internal fun CtrlProxy.stopLogcatForwarding() {
  logcatReader?.stop()
  logcatReader = null
  logEventBuffer?.channel?.close()
  logEventBuffer = null
}

private fun CtrlProxy.clientSessionRouter(
  queuedHandler: QueuedWebSocketMessageHandler,
  prototypes: PrototypeController,
) =
  ClientSessionRouter(
    object : ClientSessionRouter.Host<WebSocketServer.ConnectedClient> {
      override fun dropQueuedCommands(client: WebSocketServer.ConnectedClient) =
        queuedHandler.disconnect(client)

      override fun cancelGestureStreams(client: WebSocketServer.ConnectedClient) =
        gestureController.cancelStreamsOwnedBy(client)

      override fun failHostRequests(client: WebSocketServer.ConnectedClient?) =
        hostPrototypeHttp.onHostLost(client)

      override fun launch(block: suspend () -> Unit) {
        serviceScope.launch { block() }
      }

      override suspend fun prototypeClientCountChanged(count: Int, observerSession: Int) {
        prototypes.onClientCountChanged(count, observerSession)
      }

      override suspend fun prototypeClientConnected() {
        prototypes.onClientConnected()
      }
    },
  )
