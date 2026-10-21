package dev.jasonpearson.automobile.ctrlproxy

import android.content.Context
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.DisplayCutoutInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfRequestContext
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import java.io.OutputStream
import java.util.Collections
import java.util.IdentityHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/** Performance and work accounting shared by hierarchy extraction and its debouncer. */
internal data class HierarchyDiagnosticsDependencies(
  val perfProvider: PerfProvider,
  val timeProvider: TimeProvider,
  val workStats: CtrlProxyWorkStats,
)

/**
 * Hierarchy extraction orchestration: owns the [HierarchyDebouncer] and its result collector, the
 * `request_hierarchy` / stale / interval request handling, the direct and ADB-broadcast extractor
 * invocations, the latest-hierarchy file and the `hierarchy_update` broadcast. Everything that
 * needs the live accessibility service or the late-bound WebSocket server comes through [Host];
 * clock reads go through the injected [TimeProvider].
 */
internal class HierarchyController(
  private val host: Host,
  private val serviceScope: CoroutineScope,
  private val viewHierarchyExtractor: ViewHierarchyExtractor,
  private val displayController: DisplayController,
  diagnostics: HierarchyDiagnosticsDependencies,
  private val jsonCompact: Json,
) : HierarchyRequestController(host, serviceScope, diagnostics) {
  private val perfProvider = diagnostics.perfProvider

  /** Service-side operations the controller cannot perform without the accessibility service. */
  interface Host : HierarchyDeliveryHost {
    fun currentFrameContext(): String

    fun selectDisplayWindows(displayId: Int?): ViewHierarchyExtractor.DisplayWindows

    fun activeWindowRoot(): AccessibilityNodeInfo?

    fun lastWindowClassName(): String?

    fun rotationProvenance(): RotationProvenanceTracker

    fun occlusionEnabled(): Boolean

    fun wakefulness(): String

    fun foregroundActivity(rootPackage: String?, windowClass: String?): String?

    fun isEmulator(): Boolean

    fun accessibilityTool(): Boolean?
  }

  companion object {
    private const val TAG = "CtrlProxy"
    private const val HIERARCHY_FILE_NAME = "latest_hierarchy.json"
    private const val DUMP_MARKER_FILE_NAME = "dump_hierarchy"
    const val DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS = 250L
  }

  // A hierarchy has object identity for its short trip from extraction to broadcast. Retaining the
  // extraction-time token lets broadcast fail closed if an accessibility event intervenes.
  internal override val extractedHierarchyFrameContexts: MutableMap<ViewHierarchy, String> =
    Collections.synchronizedMap(IdentityHashMap<ViewHierarchy, String>())

  override val captureDirect: (Boolean, HierarchySnapshotOptions) -> ViewHierarchy? =
    ::extractHierarchyDirect
  override val deliverCollectedResult: suspend (HierarchyResult) -> Unit = ::deliverResult
  override val extractRequestedHierarchy:
    suspend (Boolean, HierarchySnapshotOptions, String?) -> Unit =
    ::extractHierarchyNow

  internal suspend fun deliverResult(result: HierarchyResult) {
    // Guard the whole body: serialization was hoisted here (issue #5469) out of
    // writeHierarchyToFile/broadcastHierarchyUpdate's own try/catch, so an encode failure
    // on
    // one frame (e.g. a NaN/Infinity textSizeInPx) would otherwise complete this collector
    // —
    // and it is never relaunched, silently losing all later unsolicited updates. Swallow so
    // one bad frame is dropped, not the whole flow.
    try {
      when (result) {
        is HierarchyResult.Changed -> {
          Log.d(
            TAG,
            "Hierarchy changed (hash=${result.hash}, extraction=${result.extractionTimeMs}ms)",
          )
          // Serialize once for the debug file and wire; release frame context on failure.
          deliverHierarchyFrame(
            serialize = {
              perfProvider.track("serializeHierarchy") {
                jsonCompact.encodeToString(result.hierarchy)
              }
            },
            write = { serialized ->
              if (hierarchyDumpEnabled()) {
                writeHierarchyToFile(result.hierarchy, serialized = serialized)
              }
            },
            broadcast = { serialized ->
              broadcastHierarchyUpdate(result.hierarchy, serialized = serialized)
            },
            releaseFrameContext = { extractedHierarchyFrameContexts.remove(result.hierarchy) },
          )
        }
        is HierarchyResult.Unchanged -> {
          Log.d(TAG, "Hierarchy unchanged (animation mode, skipped=${result.skippedEventCount})")
          broadcastHierarchyUpdate(result.hierarchy)
        }
        is HierarchyResult.Error -> {
          Log.w(TAG, "Hierarchy extraction error: ${result.message}")
        }
      }
    } catch (e: CancellationException) {
      // Let cooperative cancellation unwind the collector normally.
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error handling hierarchy result — dropping this frame", e)
    }
  }

  /**
   * Direct hierarchy extraction without debouncing. Used by the HierarchyDebouncer. Extracts from
   * all visible windows to capture popups, toolbars, etc.
   */
  private fun extractHierarchyDirect(
    disableAllFiltering: Boolean = false,
    snapshotOptions: HierarchySnapshotOptions = HierarchySnapshotOptions(),
  ): ViewHierarchy? {
    return HierarchyCapture(snapshotOptions.displayId)
      .extractDirect(disableAllFiltering, snapshotOptions)
  }

  private inner class HierarchyCapture(displayId: Int?) {
    private val contextAtExtractionStart = host.currentFrameContext()
    // Bracket every input acquisition and the extraction itself. If rotation changes anywhere in
    // that interval, hierarchy geometry cannot be proven to match a single display orientation.
    private val selected = host.selectDisplayWindows(displayId)
    private val targetDisplayId = selected.displayId
    private val rotationProvenance = host.rotationProvenance()
    private val rotationCapture = rotationProvenance.beginCapture(targetDisplayId)
    private val rotationAtCaptureStart = displayController.getRotationOrNull(targetDisplayId)
    private val allWindows = selected.windows
    private val rootNode =
      viewHierarchyExtractor.rootForDisplay(host.activeWindowRoot(), allWindows, targetDisplayId)
    // Capture foreground info atomically with rootNode to avoid race conditions
    // where the app state changes between hierarchy extraction and getForegroundActivity()
    private val capturedRootPackage = rootNode?.packageName?.toString()
    private val capturedWindowClass = host.lastWindowClassName()
    private val screenDimensions = displayController.getScreenDimensions(targetDisplayId)
    private val insets = displayController.getObservationInsets(screenDimensions, targetDisplayId)

    fun walkDirect(
      disableAllFiltering: Boolean,
      snapshotOptions: HierarchySnapshotOptions,
    ): ViewHierarchy? {
      return if (!allWindows.isNullOrEmpty()) {
        Log.d(
          TAG,
          "Extracting from ${allWindows.size} windows " +
            "(disableAllFiltering: $disableAllFiltering, occlusionEnabled: ${host.occlusionEnabled()})",
        )
        viewHierarchyExtractor.extractFromAllWindows(
          allWindows,
          rootNode,
          options =
            HierarchyExtractionOptions(
              textFilter = null,
              screenDimensions = screenDimensions,
              dedupeTextContentDesc = true,
              disableAllFiltering = disableAllFiltering,
              occlusionEnabled = host.occlusionEnabled(),
              snapshotOptions = snapshotOptions,
              displayId = targetDisplayId,
              panelUniqueId = displayController.panelUniqueId(targetDisplayId),
            ),
        )
      } else {
        viewHierarchyExtractor.extractFromActiveWindow(
          rootNode,
          options =
            HierarchyExtractionOptions(
              textFilter = null,
              screenDimensions = screenDimensions,
              dedupeTextContentDesc = true,
              disableAllFiltering = disableAllFiltering,
              snapshotOptions = snapshotOptions,
              displayId = targetDisplayId,
              panelUniqueId = displayController.panelUniqueId(targetDisplayId),
            ),
        )
      }
    }

    private fun enrichDirect(hierarchy: ViewHierarchy?): ViewHierarchy? {
      val rotation =
        rotationProvenance.rotationIfUnchanged(
          rotationCapture,
          rotationAtCaptureStart,
          displayController.getRotationOrNull(targetDisplayId),
          targetDisplayId,
        )
      // Bounding rectangles are only meaningful relative to the same orientation
      // as screenDimensions. Keep the established edge insets, but avoid emitting
      // stale geometry when the capture's orientation could not be proven.
      val captureInsets =
        if (rotation == null) {
          insets.copy(displayCutoutInfo = DisplayCutoutInfo.unknown())
        } else {
          insets
        }

      // Add device metadata to the hierarchy (eliminates need for dumpsys calls on client)
      val wakefulness = host.wakefulness()
      val foreground = host.foregroundActivity(capturedRootPackage, capturedWindowClass)
      val density = displayController.getDensity()
      val enriched =
        HierarchyMetadataBuilder.enrich(
          hierarchy,
          HierarchyMetadata(
            displayId = targetDisplayId,
            panelUniqueId = displayController.panelUniqueId(targetDisplayId),
            panelFingerprint = displayController.panelFingerprint(targetDisplayId),
            screenWidth = screenDimensions?.width,
            screenHeight = screenDimensions?.height,
            rotation = rotation,
            systemInsets = CtrlProxy.legacySystemInsets(captureInsets),
            insets = captureInsets,
            wakefulness = wakefulness,
            foregroundActivity = foreground,
            density = density,
            sdkInt = Build.VERSION.SDK_INT,
            deviceModel = Build.MODEL,
            isEmulator = host.isEmulator(),
            accessibilityTool = host.accessibilityTool(),
          ),
        )

      return enriched
    }

    fun extractDirect(
      disableAllFiltering: Boolean,
      snapshotOptions: HierarchySnapshotOptions,
    ): ViewHierarchy? {

      if (allWindows.isNullOrEmpty() && rootNode == null) {
        Log.w(TAG, "No windows or root node available for extraction")
        return null
      }

      // Use multi-window extraction if windows are available, otherwise fall back to single window
      val hierarchy = walkDirect(disableAllFiltering, snapshotOptions)

      if (snapshotOptions.isCancelled()) {
        // A cancelled snapshot will not be delivered; do not retain its frame-context entry.
        Log.d(TAG, "Discarding cancelled direct hierarchy extraction")
        return null
      }

      val enriched = enrichDirect(hierarchy)
      val hierarchyWithScaleMetadata = withScaleMetadata(enriched, screenDimensions)
      if (
        hierarchyWithScaleMetadata != null && contextAtExtractionStart == host.currentFrameContext()
      ) {
        extractedHierarchyFrameContexts[hierarchyWithScaleMetadata] = contextAtExtractionStart
      }
      return hierarchyWithScaleMetadata
    }

    fun walkFallback(textFilter: String?, disableAllFiltering: Boolean): ViewHierarchy? {
      return if (!allWindows.isNullOrEmpty()) {
        Log.d(
          TAG,
          "extractHierarchy from ${allWindows.size} windows " +
            "(disableAllFiltering: $disableAllFiltering, occlusionEnabled: ${host.occlusionEnabled()})",
        )
        viewHierarchyExtractor.extractFromAllWindows(
          allWindows,
          rootNode,
          options =
            HierarchyExtractionOptions(
              textFilter = textFilter,
              screenDimensions = screenDimensions,
              dedupeTextContentDesc = true,
              disableAllFiltering = disableAllFiltering,
              occlusionEnabled = host.occlusionEnabled(),
              displayId = targetDisplayId,
              panelUniqueId = displayController.panelUniqueId(targetDisplayId),
            ),
        )
      } else {
        viewHierarchyExtractor.extractFromActiveWindow(
          rootNode,
          options =
            HierarchyExtractionOptions(
              textFilter = textFilter,
              screenDimensions = screenDimensions,
              dedupeTextContentDesc = true,
              disableAllFiltering = disableAllFiltering,
              displayId = targetDisplayId,
              panelUniqueId = displayController.panelUniqueId(targetDisplayId),
            ),
        )
      }
    }

    private fun enrichFallback(hierarchy: ViewHierarchy?): ViewHierarchy? {
      val rotation =
        rotationProvenance.rotationIfUnchanged(
          rotationCapture,
          rotationAtCaptureStart,
          displayController.getRotationOrNull(targetDisplayId),
          targetDisplayId,
        )
      val captureInsets =
        if (rotation == null) insets.copy(displayCutoutInfo = DisplayCutoutInfo.unknown())
        else insets
      val enriched =
        HierarchyMetadataBuilder.enrich(
          hierarchy,
          HierarchyMetadata(
            displayId = targetDisplayId,
            panelUniqueId = displayController.panelUniqueId(targetDisplayId),
            panelFingerprint = displayController.panelFingerprint(targetDisplayId),
            screenWidth = screenDimensions?.width,
            screenHeight = screenDimensions?.height,
            rotation = rotation,
            systemInsets = CtrlProxy.legacySystemInsets(captureInsets),
            insets = captureInsets,
            wakefulness = host.wakefulness(),
            foregroundActivity = host.foregroundActivity(capturedRootPackage, capturedWindowClass),
            density = displayController.getDensity(),
            sdkInt = Build.VERSION.SDK_INT,
            deviceModel = Build.MODEL,
            isEmulator = host.isEmulator(),
            accessibilityTool = host.accessibilityTool(),
          ),
        )

      return enriched
    }

    fun extractFallback(textFilter: String?, disableAllFiltering: Boolean): ViewHierarchy? {

      if (allWindows.isNullOrEmpty() && rootNode == null) {
        return null
      }

      val hierarchy = walkFallback(textFilter, disableAllFiltering)
      val enriched = enrichFallback(hierarchy)
      val hierarchyWithScaleMetadata = withScaleMetadata(enriched, screenDimensions)
      if (
        hierarchyWithScaleMetadata != null && contextAtExtractionStart == host.currentFrameContext()
      ) {
        extractedHierarchyFrameContexts[hierarchyWithScaleMetadata] = contextAtExtractionStart
      }
      return hierarchyWithScaleMetadata
    }
  }

  /**
   * Apply the additive #4548 scale metadata to a hierarchy response. Android accessibility bounds
   * and screenshots are both physical pixels, so the bounds->pixel ratio is exactly 1 and the pixel
   * dimensions equal the reported screen dimensions; the fields are omitted (null) when screen
   * dimensions are unavailable. EVERY route that produces a hierarchy response — the debounced
   * direct extraction ([extractHierarchyDirect]) AND the ADB EXTRACT_HIERARCHY broadcast
   * ([extractHierarchy]) — passes through here, so the daemon can retain the metadata regardless of
   * which route delivered the hierarchy (#4548).
   */
  private fun withScaleMetadata(
    hierarchy: ViewHierarchy?,
    screenDimensions: ScreenDimensions?,
  ): ViewHierarchy? =
    hierarchy?.copy(
      nativeScale = if (screenDimensions != null) 1f else null,
      pixelWidth = screenDimensions?.width,
      pixelHeight = screenDimensions?.height,
    )

  /**
   * Extract hierarchy immediately and broadcast synchronously, bypassing the debouncer and the
   * SharedFlow async path. Used for explicit WebSocket requests where the daemon is waiting for
   * fresh data. Matches the sync=true pattern used by tap/setText/imeAction handlers.
   */
  internal suspend fun extractHierarchyNow(
    disableAllFiltering: Boolean = false,
    snapshotOptions: HierarchySnapshotOptions = HierarchySnapshotOptions(),
    requestId: String? = null,
  ) {
    Log.d(TAG, "extractHierarchyNow (disableAllFiltering: $disableAllFiltering)")
    val commandJob = currentCoroutineContext()[Job]
    val cancellableOptions =
      snapshotOptions.copy(
        isCancelled = {
          snapshotOptions.isCancelled() ||
            commandJob?.isActive == false ||
            serviceScope.coroutineContext[Job]?.isActive == false
        },
      )
    try {
      val hierarchy = hierarchyExtractionResult {
        debouncer.extractImmediately(
          skipFlowEmit = true,
          disableAllFiltering = disableAllFiltering,
          snapshotOptions = cancellableOptions,
        )
      }
        .getOrElse { e ->
          Log.e(TAG, "Error extracting WebSocket hierarchy for requestId=$requestId", e)
          if (requestId == null) throw e
          commandJob?.let { it.ensureActive() }
          serviceScope.coroutineContext[Job]?.ensureActive()
          host.broadcastHierarchyExtractFrame(
            HierarchyExtractErrorFrames.thrownFrame(requestId, e),
            externallyCorrelated = false,
          )
          host.releaseRequestOwner(requestId)
          // The extraction failure is settled here, so neither the queue nor scope guard replies.
          return
        }

      if (hierarchy != null) {
        ImmediateHierarchyDelivery(requestId, commandJob).deliver(hierarchy)
      } else {
        commandJob?.ensureActive()
        serviceScope.coroutineContext[Job]?.ensureActive()
        host.broadcastHierarchyExtractFrame(
          HierarchyExtractErrorFrames.nullResultFrame(requestId),
          externallyCorrelated = false,
        )
      }
      host.releaseRequestOwner(requestId)
    } catch (e: CancellationException) {
      host.releaseRequestOwner(requestId)
      throw e
    }
  }

  private inner class ImmediateHierarchyDelivery(
    private val requestId: String?,
    private val commandJob: Job?,
  ) {
    suspend fun deliver(hierarchy: ViewHierarchy) {
      // Explicit request: broadcast and optionally dump, serializing the tree once (#5469).
      // Routed through deliverHierarchyFrame so the frame-context entry is released even if the
      // encode throws (leak fix).
      deliverHierarchyFrame(
        serialize = {
          commandJob?.ensureActive()
          perfProvider.track("serializeHierarchy") { jsonCompact.encodeToString(hierarchy) }
        },
        write = { serialized ->
          if (hierarchyDumpEnabled()) {
            writeHierarchyToFile(hierarchy, serialized = serialized)
          }
        },
        broadcast = { serialized ->
          broadcastHierarchyUpdate(
            hierarchy,
            sync = true,
            serialized = serialized,
            requestId = requestId,
            routeByRequestId = false,
          )
        },
        releaseFrameContext = { extractedHierarchyFrameContexts.remove(hierarchy) },
      )
    }
  }

  private fun hierarchyDumpEnabled(): Boolean =
    host.filesDir().resolve(DUMP_MARKER_FILE_NAME).exists()

  private inline fun <T> hierarchyExtractionResult(block: () -> T): Result<T> =
    try {
      Result.success(block())
    } catch (e: CancellationException) {
      throw e
    } catch (e: IllegalArgumentException) {
      Result.failure(e)
    } catch (e: IllegalStateException) {
      Result.failure(e)
    } catch (e: SecurityException) {
      Result.failure(e)
    }

  /**
   * Writes the hierarchy to a file for synchronous access. Callers that already serialized the tree
   * for the wire frame pass that exact compact string via [serialized] so a single change is never
   * serialized twice (issue #5469); the file therefore holds the same canonical form as the wire.
   */
  internal fun writeHierarchyToFile(
    hierarchy: ViewHierarchy,
    filename: String = HIERARCHY_FILE_NAME,
    serialized: String? = null,
  ) {
    try {
      val jsonString = serialized ?: jsonCompact.encodeToString(hierarchy)
      val jsonBytes = jsonString.toByteArray()
      host.openFileOutput(filename, Context.MODE_PRIVATE).use { output ->
        Log.d(TAG, "Writing ${jsonBytes.size} bytes to $filename")
        output.write(jsonBytes)
        output.flush()
      }
    } catch (e: java.io.IOException) {
      Log.e(TAG, "Error writing hierarchy to file: $filename", e)
    } catch (e: SecurityException) {
      Log.e(TAG, "Error writing hierarchy to file: $filename", e)
    } catch (e: IllegalArgumentException) {
      Log.e(TAG, "Error writing hierarchy to file: $filename", e)
    }
  }

  internal fun extractHierarchy(
    textFilter: String? = null,
    disableAllFiltering: Boolean = false,
  ): ViewHierarchy? {
    return HierarchyCapture(null).extractFallback(textFilter, disableAllFiltering)
  }

  /**
   * Broadcast hierarchy update to WebSocket clients (suspend function for proper ordering).
   *
   * @param sync If true, enqueues for each client in call order; each client's sender drains its
   *   queue FIFO. Returns before socket delivery.
   */
  internal suspend fun broadcastHierarchyUpdate(
    hierarchy: ViewHierarchy,
    sync: Boolean = false,
    serialized: String? = null,
    requestId: String? = null,
    routeByRequestId: Boolean = false,
  ) {
    val contextAtExtraction = extractedHierarchyFrameContexts.remove(hierarchy)
    if (!host.isServerRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping broadcast")
      return
    }

    try {
      // Reuse the string the caller already serialized for the disk file when present, so a single
      // change is serialized at most once (issue #5469); otherwise serialize the wire form here.
      val jsonString =
        serialized
          ?: perfProvider.track("serializeHierarchy") { jsonCompact.encodeToString(hierarchy) }

      val messageBuilder: (kotlinx.serialization.json.JsonElement?) -> String = { perfTiming ->
        hierarchyUpdateFrame(
          timestamp = System.currentTimeMillis(),
          hierarchyJson = jsonString,
          requestId = requestId,
          frameContext = contextAtExtraction?.takeIf { it == host.currentFrameContext() },
          perfTiming = perfTiming,
        )
      }

      withContext(PerfRequestContext(null)) {
        if (sync) {
          // Enqueue in call order; each client's sender preserves FIFO without waiting for
          // delivery.
          host.broadcastHierarchyWithPerfSync(
            routeByRequestId = routeByRequestId,
            messageBuilder = messageBuilder,
          )
        } else {
          // Async broadcast - for normal event-driven updates
          host.broadcastHierarchyWithPerf(
            routeByRequestId = routeByRequestId,
            messageBuilder = messageBuilder,
          )
        }
      }
      Log.d(
        TAG,
        "Broadcasted hierarchy update to ${host.connectionCount()} clients (sync=$sync)",
      )
    } catch (e: CancellationException) {
      // Let cooperative cancellation unwind cleanly rather than logging it as an error (#3191).
      throw e
    } catch (e: java.io.IOException) {
      Log.e(TAG, "Error broadcasting hierarchy update", e)
    } catch (e: IllegalArgumentException) {
      Log.e(TAG, "Error broadcasting hierarchy update", e)
    } catch (e: IllegalStateException) {
      Log.e(TAG, "Error broadcasting hierarchy update", e)
    } catch (e: SecurityException) {
      Log.e(TAG, "Error broadcasting hierarchy update", e)
    }
  }

  /** Clean up any existing UUID-based hierarchy files */
  internal fun cleanupUuidHierarchyFiles() {
    try {
      val filesDir = host.filesDir()
      val files = filesDir.listFiles() ?: return

      var deletedCount = 0
      files.forEach { file ->
        if (
          file.name.startsWith("hierarchy_") &&
            file.name.endsWith(".json") &&
            file.name != HIERARCHY_FILE_NAME
        ) {
          if (file.delete()) {
            deletedCount++
            Log.d(TAG, "Deleted old hierarchy file: ${file.name}")
          } else {
            Log.w(TAG, "Failed to delete hierarchy file: ${file.name}")
          }
        }
      }

      if (deletedCount > 0) {
        Log.i(TAG, "Cleaned up $deletedCount old UUID hierarchy files")
      }
    } catch (e: SecurityException) {
      Log.e(TAG, "Error cleaning up UUID hierarchy files", e)
      // Don't let cleanup errors prevent the main operation

    }
  }
}

/** Delivery and request ownership supplied by the live service. */
internal interface HierarchyDeliveryHost : HierarchyFileHost {
  /** True once the WebSocket server exists and is running. */
  fun isServerRunning(): Boolean

  fun connectionCount(): Int

  fun releaseRequestOwner(requestId: String?)

  suspend fun broadcastHierarchyWithPerf(
    routeByRequestId: Boolean,
    messageBuilder: (perfTiming: JsonElement?) -> String,
  )

  suspend fun broadcastHierarchyWithPerfSync(
    routeByRequestId: Boolean,
    messageBuilder: (perfTiming: JsonElement?) -> String,
  )

  suspend fun broadcastHierarchyExtractFrame(frame: ErrorResponse?, externallyCorrelated: Boolean)

  fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit): Job
}

/** File operations used by hierarchy delivery and cleanup. */
internal interface HierarchyFileHost {
  fun openFileOutput(filename: String, mode: Int): OutputStream

  fun filesDir(): java.io.File
}

/** Owns request admission and debouncer lifecycle while extraction stays in the controller. */
internal abstract class HierarchyRequestController(
  private val host: HierarchyController.Host,
  private val serviceScope: CoroutineScope,
  private val diagnostics: HierarchyDiagnosticsDependencies,
) {
  internal abstract val extractedHierarchyFrameContexts: MutableMap<ViewHierarchy, String>
  protected abstract val captureDirect: (Boolean, HierarchySnapshotOptions) -> ViewHierarchy?
  protected abstract val deliverCollectedResult: suspend (HierarchyResult) -> Unit
  protected abstract val extractRequestedHierarchy:
    suspend (Boolean, HierarchySnapshotOptions, String?) -> Unit

  private companion object {
    const val TAG = "CtrlProxy"
    const val DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS =
      HierarchyController.DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS
  }

  // Job for collecting hierarchy flow results
  private var hierarchyFlowJob: Job? = null

  /** The debouncer; only valid after [start] (tests may assign a fake one). */
  internal lateinit var debouncer: HierarchyDebouncer

  /** Creates the debouncer and starts collecting its results. */
  fun start() {
    // Initialize the smart hierarchy debouncer with structural hash comparison
    debouncer =
      HierarchyDebouncer(
        scope = serviceScope,
        timeProvider = diagnostics.timeProvider,
        perfProvider = diagnostics.perfProvider,
        config =
          HierarchyDebouncerConfig(
            quickDebounceMs = 5L,
            animationSkipWindowMs = 100L,
            unsolicitedIntervalMs = DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS,
          ),
        stats = diagnostics.workStats,
        dependencies =
          HierarchyDebouncerDependencies(
            onDiscardedHierarchy = { extractedHierarchyFrameContexts.remove(it) },
            extractHierarchy = { disableAllFiltering, snapshotOptions ->
              captureDirect(disableAllFiltering, snapshotOptions)
            },
          ),
      )

    // Event-driven extraction is admitted before this collector at the configured interval.
    // Deliver every admitted result so extraction time cannot cause a final refresh to be lost.
    val deliverResult = deliverCollectedResult
    hierarchyFlowJob =
      debouncer.hierarchyFlow.onEach { result -> deliverResult(result) }.launchIn(serviceScope)
  }

  /** Cancels the result collector and resets the debouncer. */
  fun stop() {
    // Cancel hierarchy flow subscription
    hierarchyFlowJob?.cancel()
  }

  fun resetDebouncer() {
    if (::debouncer.isInitialized) {
      debouncer.reset()
    }
  }

  /** Feeds an accessibility event to the debouncer when it exists. */
  fun onAccessibilityEvent() {
    if (::debouncer.isInitialized) {
      debouncer.onAccessibilityEvent()
    }
  }

  /** Requests an immediate debounced extraction when the debouncer exists. */
  fun extractNow() {
    if (::debouncer.isInitialized) {
      debouncer.extractNow()
    }
  }

  suspend fun requestHierarchy(request: RequestHierarchy) {
    val disableAllFiltering = request.disableAllFiltering
    val maxDepth = request.maxDepth
    val maxNodes = request.maxNodes
    val displayId = request.displayId
    val requestId = request.requestId

    extractRequestedHierarchy(
      disableAllFiltering,
      HierarchySnapshotOptions(
        maxDepth = maxDepth ?: 100,
        maxNodes = maxNodes ?: 10_000,
        displayId = displayId,
      ),
      requestId,
    )
  }

  suspend fun requestHierarchyIfStale(sinceTimestamp: Long, requestId: String?) {
    var extractionRequested = false
    debouncer.extractIfStale(sinceTimestamp) {
      extractionRequested = true
      host
        .launchRequestScope(requestId) {
          extractRequestedHierarchy(false, HierarchySnapshotOptions(), requestId)
        }
        .invokeOnCompletion { cause ->
          // Also release when the service scope cancels the launch before extraction starts.
          if (cause is CancellationException) {
            host.releaseRequestOwner(requestId)
          }
        }
    }
    if (!extractionRequested) {
      host.releaseRequestOwner(requestId)
    }
  }

  fun setHierarchyInterval(intervalMs: Long?) {
    val resolvedIntervalMs = intervalMs ?: DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS
    if (::debouncer.isInitialized) {
      debouncer.setUnsolicitedIntervalMs(resolvedIntervalMs)
    }
    Log.d(TAG, "Hierarchy broadcast interval set to ${resolvedIntervalMs}ms")
  }
}
