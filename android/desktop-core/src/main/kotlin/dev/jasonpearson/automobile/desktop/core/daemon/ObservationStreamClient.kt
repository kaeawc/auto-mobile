package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
import dev.jasonpearson.automobile.desktop.domain.KeyValueType
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.serializer

/**
 * A line-oriented bidirectional transport over the observation-stream socket. Abstracted from the
 * concrete [SocketChannel] so [ObservationStreamClient] can be unit-tested for fd release across an
 * EOF -> reconnect / EOF -> dispose cycle without a real daemon socket (issue #5261).
 *
 * [close] must be idempotent: the read loop and [ObservationStreamClient.disconnect] can both reach
 * it for the same transport.
 */
interface ObservationStreamTransport {
  val reader: BufferedReader
  val writer: BufferedWriter

  fun close()
}

/**
 * Opens an [ObservationStreamTransport] for a socket path. Constructor-injected into
 * [ObservationStreamClient]; production uses [SocketChannelTransportFactory] (a real AF_UNIX
 * socket), tests supply a fake that records opens and closes.
 */
fun interface ObservationStreamTransportFactory {
  fun open(socketPath: String): ObservationStreamTransport
}

/** Default factory backed by a real AF_UNIX [SocketChannel]. */
internal object SocketChannelTransportFactory : ObservationStreamTransportFactory {
  override fun open(socketPath: String): ObservationStreamTransport =
    SocketChannelTransport(SocketChannel.open(UnixDomainSocketAddress.of(socketPath)))
}

private class SocketChannelTransport(private val channel: SocketChannel) :
  ObservationStreamTransport {
  override val reader: BufferedReader =
    BufferedReader(InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8))
  override val writer: BufferedWriter =
    BufferedWriter(OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8))

  // Closing the channel tears down the streams built from it; SocketChannel.close() on an
  // already-closed channel is a no-op, so this stays idempotent for the death-point/disconnect
  // race.
  override fun close() {
    channel.close()
  }
}

/**
 * Client for the observation stream Unix socket server. Subscribes to receive real-time hierarchy
 * and screenshot updates from the MCP server.
 *
 * Socket path: ~/.auto-mobile/observation-stream.sock
 */
class ObservationStreamClient(
  private val transportFactory: ObservationStreamTransportFactory = SocketChannelTransportFactory,
  private val socketPathProvider: () -> String = { getSocketPath() },
  // Test seam: invoked when a readMessages() invocation returns (superseded or not), so a test can
  // await a specific read loop's completion deterministically. No-op in production.
  private val onReadLoopExit: () -> Unit = {},
) : ObservationStream {
  companion object {
    internal fun getSocketPath(): String =
      AutoMobileSocketPaths.socketPath("observation-stream.sock")

    fun socketExists(): Boolean = Files.exists(Path.of(getSocketPath()))
  }

  private val log = LoggerFactory.getLogger(ObservationStreamClient::class.java)
  private val json = DaemonJson
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  // Serializes transport ownership: the (transport, connectionGeneration) pair is only ever read or
  // mutated while holding this lock, so a read loop's generation check and connect()/disconnect()'s
  // reassignment can never interleave.
  private val ownershipLock = Any()

  // Single owning reference to the live transport. Closed at its death point in the read loop (EOF
  // or read error) and in disconnect(), so no reconnect abandons a still-open socket (issue #5261).
  private var transport: ObservationStreamTransport? = null

  // Monotonic token identifying the current connection attempt. Advanced whenever the active
  // transport is installed (connect) or released (disconnect/EOF). A read loop captures the
  // generation it was started for and only clears the transport / publishes Disconnected while it
  // still owns that generation, so a stale loop that outlives a reconnect is inert (issue #5261,
  // CodeRabbit).
  private var connectionGeneration: Long = 0L

  // Flow for hierarchy updates
  private val _hierarchyUpdates = MutableSharedFlow<HierarchyStreamUpdate>(replay = 1)
  override val hierarchyUpdates: SharedFlow<HierarchyStreamUpdate> =
    _hierarchyUpdates.asSharedFlow()

  // Flow for screenshot updates
  private val _screenshotUpdates = MutableSharedFlow<ScreenshotStreamUpdate>(replay = 1)
  override val screenshotUpdates: SharedFlow<ScreenshotStreamUpdate> =
    _screenshotUpdates.asSharedFlow()

  // Flow for navigation graph updates
  private val _navigationUpdates = MutableSharedFlow<NavigationGraphStreamUpdate>(replay = 1)
  override val navigationUpdates: SharedFlow<NavigationGraphStreamUpdate> =
    _navigationUpdates.asSharedFlow()

  // Flow for performance metrics updates (use extraBufferCapacity + DROP_OLDEST to avoid blocking)
  private val _performanceUpdates =
    MutableSharedFlow<PerformanceStreamUpdate>(
      replay = 1,
      extraBufferCapacity = 10,
      onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )
  override val performanceUpdates: SharedFlow<PerformanceStreamUpdate> =
    _performanceUpdates.asSharedFlow()

  // Flow for live key/value storage changes. Storage writes can burst (a screen that persists
  // several preferences at once), so this follows the performance flow's non-blocking policy
  // rather than suspending the socket reader.
  private val _storageUpdates =
    MutableSharedFlow<StorageStreamUpdate>(
      replay = 1,
      extraBufferCapacity = 32,
      onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )
  override val storageUpdates: SharedFlow<StorageStreamUpdate> = _storageUpdates.asSharedFlow()

  // Flow for device-level stream events such as control connection loss.
  private val _deviceEvents = MutableSharedFlow<DeviceStreamEvent>(replay = 1)
  override val deviceEvents: SharedFlow<DeviceStreamEvent> = _deviceEvents.asSharedFlow()

  // Flow for connection state
  private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected())
  override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

  // Requested observation cadence, remembered so it is re-applied on every (re)subscribe (so the
  // cadence survives reconnects). Managed via setCadence(); null means "use the daemon's default".
  private var subscribedDeviceId: String? = null
  private var subscribedDeviceSessionUuid: String? = null
  private var subscriptionId: String? = null
  private var pendingCadenceUpdate = false
  private var requestedScreenshotIntervalMs: Long? = null
  private var requestedHierarchyIntervalMs: Long? = null

  // Per-file storage subscriptions requested by consumers (the storage facet subscribes each loaded
  // key/value file so external writes emit storage_update frames). Remembered so they are
  // re-applied
  // automatically on every (re)subscribe -- a reconnect would otherwise leave the device-side
  // content
  // observers unregistered, silently killing live updates (issue #4709). Guarded by
  // [ownershipLock].
  private val storageSubscriptions = LinkedHashSet<StorageSubscriptionKey>()

  /**
   * Connect to the observation stream socket and subscribe to updates. Any cadence configured via
   * [setCadence] is sent on the subscribe request and re-applied automatically on reconnect.
   *
   * @param deviceId Optional device ID to subscribe to. If null, subscribes to all devices.
   */
  override fun connect(deviceId: String?, deviceSessionUuid: String?) {
    if (_connectionState.value.isConnected) {
      log.info("Already connected to observation stream")
      return
    }

    val socketPath = socketPathProvider()
    log.info("Connecting to observation stream at $socketPath")

    _connectionState.update { ConnectionState.Connecting }

    try {
      val path = Path.of(socketPath)
      if (!Files.exists(path)) {
        log.warn("Observation stream socket not found at $socketPath")
        _connectionState.update { ConnectionState.Disconnected("Socket not found") }
        return
      }

      // Open the fresh transport, then install it and advance the generation atomically. Any
      // transport left over from a prior connection is closed rather than abandoned (issue #5261),
      // and the generation bump supersedes any read loop still running from a previous attempt.
      val newTransport = transportFactory.open(socketPath)
      val previousTransport: ObservationStreamTransport?
      val generation: Long
      synchronized(ownershipLock) {
        previousTransport = transport
        transport = newTransport
        generation = ++connectionGeneration
      }
      closeQuietly(previousTransport)

      _connectionState.update { ConnectionState.Connected() }
      log.info("Connected to observation stream")

      // Send subscribe request (carries any cadence configured via setCadence)
      subscribedDeviceId = deviceId
      subscribedDeviceSessionUuid = deviceSessionUuid
      subscriptionId = null
      pendingCadenceUpdate = false
      subscribe(deviceId, deviceSessionUuid)

      // Start reading messages for this generation
      scope.launch {
        readMessages(generation)
      }
    } catch (e: Exception) {
      log.warn("Failed to connect to observation stream: ${e.message}")
      _connectionState.update { ConnectionState.Disconnected(e.message) }
    }
  }

  override fun disconnect() {
    if (!_connectionState.value.isConnected) return

    val previousState = _connectionState.value

    try {
      // Send unsubscribe request
      if (previousState is ConnectionState.Connected && previousState.subscribed) {
        val currentSubscriptionId = subscriptionId
        val request =
          StreamRequest(
            id = UUID.randomUUID().toString(),
            command = "unsubscribe",
            subscriptionId = currentSubscriptionId,
          )
        sendRequest(request)
      }
    } catch (e: Exception) {
      log.warn("Error disconnecting from observation stream: ${e.message}")
    }

    releaseActiveTransport()
    subscriptionId = null
    pendingCadenceUpdate = false
    _connectionState.update { ConnectionState.Disconnected() }
  }

  /**
   * Clear the active transport and advance the generation under [ownershipLock], then close it. The
   * generation bump supersedes any running read loop so it becomes inert on exit, and closing the
   * transport releases its fd (issue #5261). Safe when there is no transport (no-op close).
   */
  private fun releaseActiveTransport() {
    val target =
      synchronized(ownershipLock) {
        val current = transport
        transport = null
        connectionGeneration++
        current
      }
    closeQuietly(target)
  }

  /**
   * Close [target] best-effort. Closing a [SocketChannel]-backed transport is idempotent, so a
   * redundant call (the read loop racing [disconnect]) is safe.
   */
  private fun closeQuietly(target: ObservationStreamTransport?) {
    if (target == null) return
    try {
      target.close()
    } catch (e: Exception) {
      log.warn("Error closing observation stream transport: ${e.message}")
    }
  }

  override fun isConnected(): Boolean = _connectionState.value.isConnected

  /**
   * Disconnect and cancel the internal coroutine scope. After calling dispose(), this client
   * instance should not be reused.
   */
  override fun dispose() {
    disconnect()
    scope.coroutineContext[Job]?.cancel()
  }

  private fun subscribe(deviceId: String?, deviceSessionUuid: String?) {
    val request =
      StreamRequest(
        id = UUID.randomUUID().toString(),
        command = "subscribe",
        deviceId = deviceId,
        deviceSessionUuid = deviceSessionUuid,
        screenshotIntervalMs = requestedScreenshotIntervalMs,
        hierarchyIntervalMs = requestedHierarchyIntervalMs,
      )

    if (sendRequest(request)) {
      _connectionState.update { current ->
        if (current is ConnectionState.Connected) {
          current.copy(subscribed = true)
        } else {
          current
        }
      }
      log.info("Subscribed to observation stream (device: ${deviceId ?: "all"})")
      // Re-register any remembered per-file storage observers so live updates survive a reconnect.
      reapplyStorageSubscriptions()
    }
  }

  /**
   * Update the requested observation cadence. When connected, sends an `update_cadence` command so
   * the daemon reconfigures capture in place (no resubscribe, no backfill); the values are also
   * remembered and re-applied on the next (re)subscribe, so the cadence survives reconnects. Pass
   * null for a field to fall back to the daemon's per-platform default. No-op when the cadence is
   * unchanged, so callers can invoke this on every focus change without spamming the socket.
   */
  override fun setCadence(screenshotIntervalMs: Long?, hierarchyIntervalMs: Long?) {
    if (
      requestedScreenshotIntervalMs == screenshotIntervalMs &&
        requestedHierarchyIntervalMs == hierarchyIntervalMs
    ) {
      return
    }
    requestedScreenshotIntervalMs = screenshotIntervalMs
    requestedHierarchyIntervalMs = hierarchyIntervalMs

    if (!_connectionState.value.isConnected) return
    val currentSubscriptionId = subscriptionId
    if (currentSubscriptionId == null) {
      pendingCadenceUpdate = true
      return
    }

    sendCadenceUpdate(currentSubscriptionId)
  }

  private fun sendCadenceUpdate(currentSubscriptionId: String): Boolean {
    val request =
      StreamRequest(
        id = UUID.randomUUID().toString(),
        command = "update_cadence",
        subscriptionId = currentSubscriptionId,
        deviceId = subscribedDeviceId,
        deviceSessionUuid = subscribedDeviceSessionUuid,
        screenshotIntervalMs = requestedScreenshotIntervalMs,
        hierarchyIntervalMs = requestedHierarchyIntervalMs,
      )
    if (sendRequest(request)) {
      log.info(
        "Requested observation cadence update (screenshot=$requestedScreenshotIntervalMs, hierarchy=$requestedHierarchyIntervalMs)"
      )
      return true
    }
    return false
  }

  private fun sendRequest(request: StreamRequest): Boolean {
    val currentWriter = transport?.writer ?: return false

    return try {
      val message = json.encodeToString(serializer<StreamRequest>(), request)
      currentWriter.write(message)
      currentWriter.newLine()
      currentWriter.flush()
      true
    } catch (e: Exception) {
      log.warn("Failed to send request: ${e.message}")
      false
    }
  }

  private suspend fun readMessages(generation: Long) {
    // Bind to the transport for this generation. If a disconnect()/reconnect already superseded us
    // before we started reading, there is nothing to own -- exit without touching state.
    val activeTransport =
      synchronized(ownershipLock) { if (connectionGeneration == generation) transport else null }
    if (activeTransport == null) {
      onReadLoopExit()
      return
    }
    val currentReader = activeTransport.reader

    try {
      log.info("Starting message read loop")

      // Stop as soon as a later connect()/disconnect() supersedes this generation, so a stale loop
      // never emits frames onto the shared flows after ownership has moved on.
      while (ownsGeneration(generation) && _connectionState.value.isConnected) {
        val line = currentReader.readLine() ?: break
        if (line.isBlank()) continue

        log.info("Received message (${line.length} chars): ${line.take(200)}...")

        try {
          handleMessage(line)
        } catch (e: Exception) {
          log.warn("Failed to parse observation stream message: ${e.message}", e)
        }
      }
      log.info("Read loop ended - connected=${_connectionState.value.isConnected}")
    } catch (e: Exception) {
      log.warn("Error reading from observation stream: ${e.message}", e)
    }

    // Death point (EOF or read error). Clear the transport and publish Disconnected ONLY while we
    // still own the active generation: a loop superseded by disconnect()/reconnect must do nothing,
    // or it would both close the NEW transport's slot and stomp the live Connected state -- after
    // which disconnect()/dispose() would early-return and leak the new socket (issue #5261,
    // CodeRabbit). disconnect() early-returns once not Connected, so for the still-owning EOF case
    // this is the only place that releases the dead socket's fd.
    val stillOwner =
      synchronized(ownershipLock) {
        if (connectionGeneration == generation) {
          transport = null
          connectionGeneration++
          true
        } else {
          false
        }
      }
    if (stillOwner) {
      closeQuietly(activeTransport)
      _connectionState.update { ConnectionState.Disconnected("Stream ended") }
      log.info("Observation stream disconnected")
    }
    onReadLoopExit()
  }

  private fun ownsGeneration(generation: Long): Boolean =
    synchronized(ownershipLock) { connectionGeneration == generation }

  internal suspend fun handleMessage(message: String) {
    val response = json.decodeFromString(serializer<StreamResponse>(), message)
    log.info("Handling message type: ${response.type}")

    when (response.type) {
      "subscription_response" -> {
        log.info("Subscription response: success=${response.success}")
        if (response.success != true) {
          log.warn("Subscription failed: ${response.error}")
        } else if (response.subscriptionId != null) {
          subscriptionId = response.subscriptionId
          if (pendingCadenceUpdate) {
            pendingCadenceUpdate = !sendCadenceUpdate(response.subscriptionId)
          }
        }
      }
      "hierarchy_update" -> {
        // Extract packageName from the data if present
        val packageName = extractPackageName(response.data)
        log.info(
          "Hierarchy update received - deviceId=${response.deviceId}, timestamp=${response.timestamp}, packageName=$packageName, dataPresent=${response.data != null}"
        )
        val update =
          HierarchyStreamUpdate(
            deviceId = response.deviceId,
            timestamp = response.timestamp ?: System.currentTimeMillis(),
            data = response.data,
            packageName = packageName,
            diff = response.hierarchyDiff,
            captureSequence = response.captureSequence,
            frameContext = response.frameContext,
            coordinateSpace = CoordinateSpace.fromWire(response.coordinateSpace),
            nativeScale = response.nativeScale,
            rotation = response.rotation,
          )
        _hierarchyUpdates.emit(update)
        log.info("Emitted hierarchy update to flow")
      }
      "screenshot_update" -> {
        log.info(
          "Screenshot update received - deviceId=${response.deviceId}, hasScreenshot=${response.screenshotBase64 != null}"
        )
        val update =
          ScreenshotStreamUpdate(
            deviceId = response.deviceId,
            timestamp = response.timestamp ?: System.currentTimeMillis(),
            screenshotBase64 = response.screenshotBase64,
            screenWidth = response.screenWidth ?: 1080,
            screenHeight = response.screenHeight ?: 2340,
            screenshotMimeType = response.screenshotMimeType,
            screenshotFormat = response.screenshotFormat,
            screenshotCaptureSource = response.screenshotCaptureSource,
            screenshotFallback = response.screenshotFallback,
            screenshotFallbackReason = response.screenshotFallbackReason,
            screenshotCaptureDurationMs = response.screenshotCaptureDurationMs,
            screenshotEncodeDurationMs = response.screenshotEncodeDurationMs,
            screenshotByteLength = response.screenshotByteLength,
            screenshotBase64Length = response.screenshotBase64Length,
            captureSequence = response.captureSequence,
            frameContext = response.frameContext,
            coordinateSpace = CoordinateSpace.fromWire(response.coordinateSpace),
            nativeScale = response.nativeScale,
            rotation = response.rotation,
          )
        _screenshotUpdates.emit(update)
        log.info("Emitted screenshot update to flow")
      }
      "navigation_update" -> {
        val navGraph = response.navigationGraph
        log.info(
          "Navigation update received - appId=${navGraph?.appId}, nodes=${navGraph?.nodes?.size}, edges=${navGraph?.edges?.size}"
        )
        if (navGraph != null) {
          val update =
            NavigationGraphStreamUpdate(
              timestamp = response.timestamp ?: System.currentTimeMillis(),
              appId = navGraph.appId,
              nodes = navGraph.nodes,
              edges = navGraph.edges,
              currentScreen = navGraph.currentScreen,
            )
          _navigationUpdates.emit(update)
          log.info("Emitted navigation update to flow")
        }
      }
      "performance_update" -> {
        val perfData = response.performanceData
        log.info(
          "Performance update received - deviceId=${response.deviceId}, fps=${perfData?.fps}, jankFrames=${perfData?.jankFrames}, touchLatencyMs=${perfData?.touchLatencyMs}, ttiMs=${perfData?.timeToInteractiveMs}"
        )
        if (perfData != null) {
          // When jank is 0 and FPS is below 60, the device is idle (no frames
          // being rendered). The reported FPS gets stuck at a stale value.
          // Assume 60 FPS / 16.67ms frame time since nothing is janking.
          val isIdle = perfData.jankFrames == 0 && perfData.fps < 60f
          val fps = if (isIdle) 60f else perfData.fps
          val frameTimeMs = if (isIdle) 16.67f else perfData.frameTimeMs
          val update =
            PerformanceStreamUpdate(
              deviceId = response.deviceId,
              timestamp = response.timestamp ?: System.currentTimeMillis(),
              fps = fps,
              frameTimeMs = frameTimeMs,
              jankFrames = perfData.jankFrames,
              droppedFrames = perfData.droppedFrames,
              memoryUsageMb = perfData.memoryUsageMb,
              cpuUsagePercent = perfData.cpuUsagePercent,
              touchLatencyMs = perfData.touchLatencyMs,
              timeToInteractiveMs = perfData.timeToInteractiveMs,
              screenName = perfData.screenName,
              isResponsive = perfData.isResponsive,
              recompositionCount = perfData.recompositionCount,
              recompositionRate = perfData.recompositionRate,
            )
          _performanceUpdates.tryEmit(update)
          log.info("Emitted performance update to flow")
        }
      }
      "storage_update" -> {
        val storageEvent = response.storageEvent
        if (storageEvent == null) {
          log.warn("storage_update without a storageEvent payload, ignoring")
        } else {
          _storageUpdates.tryEmit(
            StorageStreamUpdate(
              deviceId = response.deviceId,
              // The frame's own timestamp is the daemon's receive clock; the event carries the
              // device-side time the change actually happened, which is what ordering wants.
              timestamp = storageEvent.timestamp,
              packageName = storageEvent.packageName,
              fileName = storageEvent.fileName,
              key = storageEvent.key,
              value = storageEvent.value,
              valueType = KeyValueType.fromProtocolName(storageEvent.valueType),
              sequenceNumber = storageEvent.sequenceNumber,
            )
          )
        }
      }
      "ping" -> {
        log.info("Received ping, sending pong")
        sendPong()
      }
      "error" -> {
        log.warn("Observation stream error: ${response.error}")
        emitDeviceEvent(response)
      }
      else -> {
        log.warn("Unknown message type: ${response.type}")
      }
    }
  }

  @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
  private suspend fun emitDeviceEvent(response: StreamResponse) {
    val deviceId = response.deviceId ?: return
    val error = response.error ?: return
    if (error != DEVICE_CONNECTION_LOST_ERROR) return

    _hierarchyUpdates.resetReplayCache()
    _screenshotUpdates.resetReplayCache()
    _performanceUpdates.resetReplayCache()
    _deviceEvents.emit(
      DeviceStreamEvent.DeviceConnectionLost(
        deviceId = deviceId,
        timestamp = response.timestamp ?: System.currentTimeMillis(),
        error = error,
      )
    )
    log.info("Emitted device connection lost event for $deviceId")
  }

  /**
   * Drop the buffered replay of the layout streams (screenshot + hierarchy) so a subscriber that
   * (re)subscribes afterward does not immediately receive the last pre-existing frame
   * (issue #3347).
   *
   * `screenshotUpdates`/`hierarchyUpdates` are `replay = 1` SharedFlows, so on Live Layout reopen
   * the restarted collectors would otherwise replay the stale pre-close frame and re-arm client
   * device control from it. Clearing the replay right before resubscribing means only genuinely
   * post-open frames arm control. Active collectors are unaffected — this only clears what a new
   * subscriber would replay — so it is safe to call at every (re)subscribe. Mirrors the reset
   * already done on a device-connection-lost event.
   */
  @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
  override fun resetLayoutReplayCache() {
    _screenshotUpdates.resetReplayCache()
    _hierarchyUpdates.resetReplayCache()
  }

  /**
   * Request the current navigation graph from the server. The response arrives through the existing
   * navigation_update flow.
   *
   * @param appId Optional app ID to request the graph for a specific app. If null, the server
   *   returns the graph for the current foreground app.
   */
  override fun requestNavigationGraph(appId: String?) {
    if (!_connectionState.value.isConnected) return

    val request =
      StreamRequest(
        id = UUID.randomUUID().toString(),
        command = "request_navigation_graph",
        appId = appId,
      )
    sendRequest(request)
  }

  /**
   * Ask the daemon for a single fresh observation now, without changing the subscription cadence.
   *
   * The captured hierarchy arrives out-of-band on [hierarchyUpdates] like any other frame; the
   * daemon's direct reply is only an ack (or an `error` frame, which surfaces on [deviceEvents]).
   *
   * @param deviceId Capture just this device; null captures every subscribed device.
   */
  override fun requestObservation(deviceId: String?) {
    if (!_connectionState.value.isConnected) return

    val request =
      StreamRequest(
        id = UUID.randomUUID().toString(),
        command = "request_observation",
        deviceId = deviceId,
        deviceSessionUuid = subscribedDeviceSessionUuid,
      )
    sendRequest(request)
  }

  private fun sendPong() {
    val request =
      StreamRequest(
        id = UUID.randomUUID().toString(),
        command = "pong",
      )
    sendRequest(request)
  }

  override fun subscribeStorage(packageName: String, fileName: String) {
    val key = StorageSubscriptionKey(packageName, fileName)
    synchronized(ownershipLock) {
      // Deduplicate: the facet may re-request the same file across recompositions, and the device
      // registers one observer per (package, file) regardless.
      if (!storageSubscriptions.add(key)) return
    }
    // Only meaningful once subscribed to a device stream; otherwise it is remembered above and
    // re-applied by [reapplyStorageSubscriptions] on the next (re)subscribe.
    if (_connectionState.value.isConnected) {
      sendStorageSubscription("subscribe_storage", key)
    }
  }

  override fun unsubscribeStorage(packageName: String, fileName: String) {
    val key = StorageSubscriptionKey(packageName, fileName)
    synchronized(ownershipLock) {
      if (!storageSubscriptions.remove(key)) return
    }
    if (_connectionState.value.isConnected) {
      sendStorageSubscription("unsubscribe_storage", key)
    }
  }

  private fun sendStorageSubscription(command: String, key: StorageSubscriptionKey) {
    sendRequest(
      StreamRequest(
        id = UUID.randomUUID().toString(),
        command = command,
        deviceId = subscribedDeviceId,
        deviceSessionUuid = subscribedDeviceSessionUuid,
        packageName = key.packageName,
        fileName = key.fileName,
      )
    )
  }

  /**
   * Re-send every remembered storage subscription so a reconnect re-registers the device-side
   * content observers. Mirrors how the cadence is re-applied on (re)subscribe. Called after the
   * subscribe command lands, when [subscribedDeviceId] is already set.
   */
  private fun reapplyStorageSubscriptions() {
    val keys = synchronized(ownershipLock) { storageSubscriptions.toList() }
    for (key in keys) {
      sendStorageSubscription("subscribe_storage", key)
    }
  }

  /**
   * Extract packageName from the hierarchy data. The data structure is: { "hierarchy": {...},
   * "packageName": "com.example.app", ... }
   */
  private fun extractPackageName(data: JsonElement?): String? {
    if (data == null) return null
    return try {
      val obj = data as? JsonObject ?: return null
      val packageNameElement = obj["packageName"] as? JsonPrimitive
      packageNameElement?.contentOrNull?.takeIf { it.isNotEmpty() }
    } catch (e: Exception) {
      log.warn("Failed to extract packageName: ${e.message}")
      null
    }
  }
}

@Serializable
data class StreamRequest(
  val id: String,
  val command: String,
  val subscriptionId: String? = null,
  val deviceId: String? = null,
  val deviceSessionUuid: String? = null,
  val appId: String? = null,
  val screenshotIntervalMs: Long? = null,
  val hierarchyIntervalMs: Long? = null,
  val packageName: String? = null,
  val fileName: String? = null,
)

/**
 * Identity of a per-file storage subscription: one device-side content observer per (package,
 * file).
 */
data class StorageSubscriptionKey(val packageName: String, val fileName: String)

@Serializable
data class StreamResponse(
  val id: String? = null,
  val type: String,
  val success: Boolean? = null,
  val error: String? = null,
  val subscriptionId: String? = null,
  val deviceId: String? = null,
  val timestamp: Long? = null,
  val data: JsonElement? = null,
  val screenshotBase64: String? = null,
  val screenWidth: Int? = null,
  val screenHeight: Int? = null,
  val screenshotMimeType: String? = null,
  val screenshotFormat: String? = null,
  val screenshotCaptureSource: String? = null,
  val screenshotFallback: Boolean? = null,
  val screenshotFallbackReason: String? = null,
  val screenshotCaptureDurationMs: Long? = null,
  val screenshotEncodeDurationMs: Long? = null,
  val screenshotByteLength: Int? = null,
  val screenshotBase64Length: Int? = null,
  val navigationGraph: NavigationGraphStreamData? = null,
  val performanceData: PerformanceStreamData? = null,
  val hierarchyDiff: HierarchyDiffSummary? = null,
  val storageEvent: StorageEventData? = null,
  /**
   * Shared capture identity for the device geometry this message describes (issue #3348). Monotonic
   * per device, assigned on each `hierarchy_update` and echoed on each `screenshot_update` that
   * reports geometry derived from that hierarchy. Null on daemons that predate it.
   */
  val captureSequence: Long? = null,
  /** Opaque device-authored identity for the UI state this message describes. */
  val frameContext: String? = null,
  /**
   * Declared coordinate space of this message's geometry — `"px"` for canonical physical pixels
   * (issue #4549). Absent on a legacy frame. Kept as the raw wire [String] here so an unknown
   * future value round-trips through deserialization instead of failing the whole message; it is
   * narrowed to the typed [CoordinateSpace] (unknown -> null -> legacy) at the emit boundary.
   */
  val coordinateSpace: String? = null,
  /** Point-to-physical-pixel ratio for a canonical-pixel frame. */
  val nativeScale: Double? = null,
  /** Device display rotation for this captured frame. */
  val rotation: Int? = null,
)

/**
 * Payload of a `storage_update` frame — one key/value change observed on the device.
 *
 * [key] and [value] are nullable by protocol: a null [key] means the whole file was cleared, and a
 * null [value] means the key was deleted (or the file cleared).
 */
@Serializable
data class StorageEventData(
  val packageName: String,
  val fileName: String,
  val key: String? = null,
  val value: String? = null,
  val valueType: String = KeyValueType.Unknown.protocolName,
  val timestamp: Long = 0L,
  val sequenceNumber: Long = 0L,
)

/** A live key/value change, surfaced to the storage inspector. */
data class StorageStreamUpdate(
  val deviceId: String?,
  val timestamp: Long,
  val packageName: String,
  val fileName: String,
  val key: String?,
  val value: String?,
  val valueType: KeyValueType,
  val sequenceNumber: Long,
) {
  /** True when the whole file was cleared rather than a single key changing. */
  val isFileCleared: Boolean
    get() = key == null
}

/**
 * Per-frame hierarchy diff summary emitted by the daemon on `hierarchy_update` (issue #3758).
 * Counts how the current frame differs from the previous one for a device; [hasBaseline] is false
 * for the first frame (or first after a reconnect), where nothing is diffed and no node is
 * annotated. Absent for daemons that do not emit diff metadata, in which case the layout inspector
 * renders unchanged.
 */
@Serializable
data class HierarchyDiffSummary(
  val hasBaseline: Boolean = false,
  val added: Int = 0,
  val changed: Int = 0,
  val removed: Int = 0,
)

@Serializable
data class NavigationGraphStreamData(
  val appId: String?,
  val nodes: List<NavigationNodeData>,
  val edges: List<NavigationEdgeData>,
  val currentScreen: String?,
)

@Serializable
data class NavigationNodeData(
  val id: Int,
  val screenName: String,
  val visitCount: Int,
  val screenshotPath: String? = null,
)

@Serializable
data class NavigationEdgeData(
  val id: Int,
  val from: String,
  val to: String,
  val toolName: String? = null,
  val traversalCount: Int = 1,
)

data class HierarchyStreamUpdate(
  val deviceId: String?,
  val timestamp: Long,
  val data: JsonElement?,
  val packageName: String? = null,
  val diff: HierarchyDiffSummary? = null,
  /** Shared capture identity; see [StreamResponse.captureSequence]. */
  val captureSequence: Long? = null,
  /** Opaque device-authored identity; see [StreamResponse.frameContext]. */
  val frameContext: String? = null,
  /**
   * Declared coordinate space of this update's element `bounds`; see
   * [StreamResponse.coordinateSpace]. Null means the daemon declared none (legacy point-space).
   */
  val coordinateSpace: CoordinateSpace? = null,
  /** Point-to-physical-pixel ratio for a canonical-pixel frame. */
  val nativeScale: Double? = null,
  /** Device display rotation for this captured hierarchy. */
  val rotation: Int? = null,
)

data class ScreenshotStreamUpdate(
  val deviceId: String?,
  val timestamp: Long,
  val screenshotBase64: String?,
  val screenWidth: Int,
  val screenHeight: Int,
  val screenshotMimeType: String? = null,
  val screenshotFormat: String? = null,
  val screenshotCaptureSource: String? = null,
  val screenshotFallback: Boolean? = null,
  val screenshotFallbackReason: String? = null,
  val screenshotCaptureDurationMs: Long? = null,
  val screenshotEncodeDurationMs: Long? = null,
  val screenshotByteLength: Int? = null,
  val screenshotBase64Length: Int? = null,
  /** Shared capture identity; see [StreamResponse.captureSequence]. */
  val captureSequence: Long? = null,
  /** Opaque device-authored identity; see [StreamResponse.frameContext]. */
  val frameContext: String? = null,
  /**
   * Declared coordinate space of this frame's [screenWidth]/[screenHeight]; see
   * [StreamResponse.coordinateSpace]. Null means the daemon declared none (legacy point-space).
   */
  val coordinateSpace: CoordinateSpace? = null,
  /** Point-to-physical-pixel ratio for a canonical-pixel frame. */
  val nativeScale: Double? = null,
  /** Device display rotation for this captured screenshot. */
  val rotation: Int? = null,
)

data class NavigationGraphStreamUpdate(
  val timestamp: Long,
  val appId: String?,
  val nodes: List<NavigationNodeData>,
  val edges: List<NavigationEdgeData>,
  val currentScreen: String?,
)

@Serializable
data class PerformanceStreamData(
  val fps: Float,
  val frameTimeMs: Float,
  val jankFrames: Int,
  val droppedFrames: Int,
  val memoryUsageMb: Float,
  val cpuUsagePercent: Float,
  val touchLatencyMs: Float? = null,
  val timeToInteractiveMs: Float? = null,
  val screenName: String? = null,
  val isResponsive: Boolean = true,
  val recompositionCount: Int? = null,
  val recompositionRate: Float? = null,
)

data class PerformanceStreamUpdate(
  val deviceId: String?,
  val timestamp: Long,
  val fps: Float,
  val frameTimeMs: Float,
  val jankFrames: Int,
  val droppedFrames: Int,
  val memoryUsageMb: Float,
  val cpuUsagePercent: Float,
  val touchLatencyMs: Float?,
  val timeToInteractiveMs: Float?,
  val screenName: String?,
  val isResponsive: Boolean,
  val recompositionCount: Int?,
  val recompositionRate: Float?,
)

sealed class DeviceStreamEvent {
  data class DeviceConnectionLost(
    val deviceId: String,
    val timestamp: Long,
    val error: String,
  ) : DeviceStreamEvent()
}

private const val DEVICE_CONNECTION_LOST_ERROR = "device connection lost"
