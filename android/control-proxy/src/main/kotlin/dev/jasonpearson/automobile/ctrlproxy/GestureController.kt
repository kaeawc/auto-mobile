package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService.GestureResultCallback
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Build
import android.os.Handler
import android.util.Log
import androidx.annotation.RequiresApi
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.perf.MutablePerfEntry
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfRequestContext
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.RequestDrag
import dev.jasonpearson.automobile.protocol.RequestGestureEnd
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.android.asCoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Timing, performance tracking and delivery for gesture result frames. */
internal data class GestureReportingDependencies(
  val perfProvider: PerfProvider,
  val timeProvider: TimeProvider,
  val resultSender: ResultSender,
)

/**
 * Accessibility gesture injection: tap, double tap, long press, swipe, multi-finger swipe, pinch,
 * the chained press/drag/hold drag, and the streamed press/move/lift gestures, together with their
 * result frames. Owns the dedicated gesture thread every dispatch callback runs on.
 *
 * Timing is device-measured behaviour and must not drift in a move: accessibility strokes complete
 * at their last emitted event, and the pointer stays down between continued strokes (drag phases
 * and streamed segments). Everything that needs the live accessibility service or the late-bound
 * WebSocket server comes through [Host] and [ResultSender].
 */
internal class GestureController(
  private val host: Host,
  private val scope: () -> CoroutineScope,
  reporting: GestureReportingDependencies,
  private val gestureThreadFactory: () -> GestureThread,
) {
  private val perfProvider = reporting.perfProvider
  private val timeProvider = reporting.timeProvider
  private val resultSender = reporting.resultSender

  /** Service-side operations the controller cannot perform without the accessibility service. */
  interface Host {
    /** `AccessibilityService.dispatchGesture`; may throw or return false when refused. */
    fun dispatchGesture(
      gesture: GestureDescription,
      callback: GestureResultCallback,
      handler: Handler,
    ): Boolean

    /** The device-owned frame context an input was mapped through. */
    fun currentFrameContext(): String

    fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit)

    /** An injected pointer may move the text caret, so every dispatch drops the remembered one. */
    fun forgetRememberedInsert()

    /** Waits for hierarchy quiescence after a tap and returns the settled hierarchy, if any. */
    suspend fun settledHierarchy(displayId: Int?): ViewHierarchy?

    /** Broadcasts [hierarchy] synchronously, ahead of the tap result that follows it. */
    suspend fun publishHierarchy(hierarchy: ViewHierarchy)
  }

  companion object {
    private const val TAG = "CtrlProxy"
  }

  /** The service scope, resolved per launch so completion work follows the live service scope. */
  private val serviceScope: CoroutineScope
    get() = scope()

  /** Starts the gesture thread; the service calls this from onCreate, before any request. */
  fun startThread() {
    gestureThread
  }

  /** Closes streamed gestures, then runs [quitThread] (see [teardownGestures]). */
  fun closeStreams(quitThread: () -> Unit) = gestureStreamRouter.close(quitThread)

  fun quitThread() = gestureThread.quitSafely()

  /** Fails and cancels the streamed gestures owned by a disconnected client. */
  fun cancelStreamsOwnedBy(client: WebSocketServer.ConnectedClient) {
    gestureStreamRouter.cancelOwnedBy(client)
  }

  fun startStream(request: RequestGestureStart, requester: WebSocketServer.ConnectedClient?) {
    val requestId = request.requestId
    host.forgetRememberedInsert()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      broadcastGestureResult(requestId, false, "Streaming gestures require Android 8.0 (API 26)")
      return
    }
    gestureStreamRouter.start(request, requester)
  }

  fun moveStream(requestId: String?, gestureId: String, x: Double, y: Double) {
    host.forgetRememberedInsert()
    gestureStreamRouter.move(requestId, gestureId, x.toFloat(), y.toFloat())
  }

  fun endStream(request: RequestGestureEnd, requester: WebSocketServer.ConnectedClient?) {
    host.forgetRememberedInsert()
    gestureStreamRouter.end(request, requester)
  }

  /**
   * The DEDICATED thread streamed gestures are driven on — deliberately NOT the main thread.
   * `StrokeDescription.continueStroke` must be issued promptly after the previous stroke completes
   * or the framework cancels the continued gesture; the main thread runs the accessibility-event
   * and hierarchy work (e.g. a ~460ms `hierarchyDebouncer` pass) that would stall a continuation
   * posted there long enough to trip that cancel. A private [HandlerGestureThread] keeps the
   * continuation cadence off that contention. The gesture state machine is single-threaded, so
   * every gesture mutation and pump is funnelled onto this one thread (see [GestureStreamSession]);
   * WebSocket requests arrive on [serviceScope]'s IO threads and hand their work here.
   */
  // Resolved on first use (the service's onCreate) so tests can supply a deterministic queue after
  // constructing the service, without starting a real HandlerThread.
  private val gestureThread by lazy { gestureThreadFactory() }
  private val gestureHandler: Handler
    get() = gestureThread.handler

  // Atomic terminal callbacks remain FIFO even while a tap's quiescence wait yields the handler.
  private val gestureCompletionMutex = Mutex()

  internal var dragDeadline: GestureDeadline = GestureDeadline { delayMs, onTimeout ->
    val task = Runnable { onTimeout() }
    check(gestureHandler.postDelayed(task, delayMs)) { "Gesture thread rejected drag deadline" }
    val cancel: () -> Unit = { gestureHandler.removeCallbacks(task) }
    cancel
  }

  internal var dragResultReporter: (String?, GestureDispatchOutcome) -> Unit =
    { requestId, outcome ->
      if (outcome.completed) {
        Log.d(
          TAG,
          "Drag completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
        )
      } else {
        Log.w(TAG, "Drag failed after ${outcome.totalTimeMs}ms: ${outcome.error}")
      }
      host.launchRequestScope(requestId) {
        broadcastDragResult(
          requestId,
          outcome.completed,
          outcome.error,
          outcome.totalTimeMs,
          outcome.gestureTimeMs,
        )
      }
    }

  private val gestureStreamRouter =
    GestureStreamRouter(
      runOnGestureThread = { gestureThread.post(it) },
      newSession = { onFinished ->
        GestureStreamSession(
          coordinator = GestureStreamCoordinator(),
          // startStream rejects API < 26 before this factory can run on the gesture thread.
          dispatcher =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) AccessibilityStrokeDispatcher()
            else error("Streaming gestures require Android 8.0 (API 26)"),
          runOnGestureThread = { gestureThread.post(it) },
          onFinished = onFinished,
        )
      },
      onResult = ::broadcastGestureResult,
      logWarning = { Log.w(TAG, it) },
    )

  /**
   * The Android half of streaming gesture input: builds real `StrokeDescription`s and dispatches
   * them through the AccessibilityService, one continued stroke per [GestureSegment]. Kept a thin
   * seam so the continuation loop ([GestureStreamSession]) stays framework-free and unit-tested.
   * Requires API 26+ (the `willContinue` constructor and `continueStroke`); the caller guards.
   */
  @RequiresApi(Build.VERSION_CODES.O)
  private inner class AccessibilityStrokeDispatcher :
    StrokeDispatcher<GestureDescription.StrokeDescription> {
    override fun initialStroke(segment: GestureSegment): GestureDescription.StrokeDescription =
      GestureDescription.StrokeDescription(
        segment.toPath(),
        0,
        segment.durationMs.coerceAtLeast(1L),
        segment.willContinue,
      )

    override fun continueStroke(
      previous: GestureDescription.StrokeDescription,
      segment: GestureSegment,
    ): GestureDescription.StrokeDescription =
      previous.continueStroke(
        segment.toPath(),
        0,
        segment.durationMs.coerceAtLeast(1L),
        segment.willContinue,
      )

    override fun dispatch(
      stroke: GestureDescription.StrokeDescription,
      onComplete: () -> Unit,
      onFailed: (error: String) -> Unit,
      displayId: Int?,
    ) = dispatchContinuing(stroke, onComplete, onFailed, onFailed, displayId)

    override fun dispatchContinuing(
      stroke: GestureDescription.StrokeDescription,
      onComplete: () -> Unit,
      onFailed: (error: String) -> Unit,
      onRejected: (error: String) -> Unit,
      displayId: Int?,
    ) {
      val gesture = gestureBuilder(displayId).addStroke(stroke).build()
      val dispatched =
        withGestureFailures(
          onFailure = { e ->
            Log.e(TAG, "Error dispatching streamed gesture stroke", e)
            onRejected(e.message ?: "Failed to dispatch streamed gesture stroke")
            return
          },
        ) {
          host.dispatchGesture(
            gesture,
            object : GestureResultCallback() {
              override fun onCompleted(gestureDescription: GestureDescription?) = onComplete()

              override fun onCancelled(gestureDescription: GestureDescription?) =
                onFailed("Streamed gesture stroke was cancelled")
            },
            gestureHandler,
          )
        }
      if (!dispatched) onRejected("Failed to dispatch streamed gesture stroke")
    }

    private fun GestureSegment.toPath(): Path =
      Path().apply {
        moveTo(from.x, from.y)
        lineTo(to.x, to.y)
      }
  }

  /** Ack one streamed-gesture request, reusing the shared `swipe_result` frame. */
  private fun broadcastGestureResult(requestId: String?, success: Boolean, error: String?) {
    host.launchRequestScope(requestId) { broadcastSwipeResult(requestId, success, error, 0L, null) }
  }

  /**
   * Dispatch a built gesture and centralize the callback/perf lifecycle shared by every gesture
   * action. The caller owns gesture construction and result broadcasting; this helper owns the
   * `dispatchGesture` perf operation, callback result conversion, and guaranteed outer perf close.
   */
  private fun dispatchGestureWithResult(
    request: GestureDispatchRequest,
    beforeCompletedResult: suspend () -> Unit = {},
    onResult: (GestureDispatchOutcome) -> Unit,
  ) {
    val perfLabel = request.perfLabel
    val gesture = request.gesture
    val requestId = request.requestId
    val startTimeMs = request.startTimeMs
    val gestureBuiltTimeMs = request.gestureBuiltTimeMs
    val frameContext = request.frameContext

    host.forgetRememberedInsert()
    val lifecycle =
      GestureDispatchLifecycle(
        startTimeMs = startTimeMs,
        gestureBuiltTimeMs = gestureBuiltTimeMs,
        nowMs = { timeProvider.currentTimeMillis() },
        startOperation = { perfProvider.startOperation(it) },
        endOperation = { perfProvider.endOperation(it) },
        endPerfBlock = { perfProvider.end() },
      )

    lifecycle.startDispatch()
    if (frameContext != null && frameContext != host.currentFrameContext()) {
      lifecycle.failed(
        IllegalStateException("Stale frame context; observe a fresh frame before retrying"),
        onResult,
      )
      return
    }
    val dispatched =
      withGestureFailures(
        onFailure = { e ->
          Log.e(TAG, "Error dispatching $perfLabel gesture (requestId=$requestId)", e)
          lifecycle.failed(e, onResult)
          return
        },
      ) {
        host.dispatchGesture(
          gesture,
          object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
              // Keep extraction, perf closure and result in callback order on the gesture thread;
              // quiescence polling yields that thread instead of blocking its continuation queue.
              serviceScope.launch(
                gestureHandler.asCoroutineDispatcher().immediate +
                  RequestIdContext(requestId) +
                  PerfRequestContext(requestId),
              ) {
                gestureCompletionMutex.withLock {
                  lifecycle.completed(beforeResult = beforeCompletedResult, onResult = onResult)
                }
              }
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
              serviceScope.launch(
                gestureHandler.asCoroutineDispatcher().immediate +
                  RequestIdContext(requestId) +
                  PerfRequestContext(requestId),
              ) {
                gestureCompletionMutex.withLock { lifecycle.cancelled(onResult) }
              }
            }
          },
          gestureHandler,
        )
      }

    if (!dispatched) {
      Log.e(TAG, "Failed to dispatch $perfLabel gesture (requestId=$requestId)")
      lifecycle.notDispatched(onResult)
    }
  }

  /** Preserve legacy routing when absent; explicit displays share the validated API gate. */
  private fun gestureBuilder(displayId: Int?): GestureDescription.Builder =
    GestureDescription.Builder().apply {
      GestureDisplayRouting.apply(displayId, Build.VERSION.SDK_INT) { id ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setDisplayId(id)
      }
    }

  /**
   * Perform a swipe gesture using AccessibilityService's dispatchGesture API. This is significantly
   * faster than ADB's input swipe command.
   */
  fun performSwipe(request: RequestSwipe) {
    val requestId = request.requestId
    val startTime = timeProvider.currentTimeMillis()
    Log.d(
      TAG,
      "performSwipe: (${request.x1}, ${request.y1}) -> (${request.x2}, ${request.y2}) duration=${request.duration}ms",
    )
    perfProvider.serial("performSwipe")

    withGestureFailures(
      onFailure = { e ->
        perfProvider.end() // end performSwipe block
        val errorTime = timeProvider.currentTimeMillis()
        Log.e(TAG, "Error performing swipe", e)
        host.launchRequestScope(requestId) {
          broadcastSwipeResult(requestId, false, e.message, errorTime - startTime, null)
        }
      },
    ) {
      // Create the swipe path
      perfProvider.startOperation("buildPath")
      val path =
        Path().apply {
          moveTo(request.x1.toFloat(), request.y1.toFloat())
          lineTo(request.x2.toFloat(), request.y2.toFloat())
        }

      // Build the gesture description
      val gesture =
        gestureBuilder(request.displayId)
          .addStroke(GestureDescription.StrokeDescription(path, 0, request.duration))
          .build()
      perfProvider.endOperation("buildPath")

      val gestureBuiltTime = timeProvider.currentTimeMillis()
      Log.d(TAG, "Gesture built in ${gestureBuiltTime - startTime}ms")

      dispatchGestureWithResult(
        GestureDispatchRequest(
          perfLabel = "performSwipe",
          gesture = gesture,
          requestId = requestId,
          startTimeMs = startTime,
          gestureBuiltTimeMs = gestureBuiltTime,
          frameContext = request.frameContext,
        ),
      ) { outcome ->
        if (outcome.completed) {
          Log.d(
            TAG,
            "Swipe completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
          )
          host.launchRequestScope(requestId) {
            broadcastSwipeResult(requestId, true, null, outcome.totalTimeMs, outcome.gestureTimeMs)
          }
        } else {
          Log.w(TAG, "Swipe failed after ${outcome.totalTimeMs}ms: ${outcome.error}")
          host.launchRequestScope(requestId) {
            broadcastSwipeResult(requestId, false, outcome.error, outcome.totalTimeMs, null)
          }
        }
      }
    }
  }

  /**
   * Perform a drag gesture using AccessibilityService's dispatchGesture API.
   *
   * @param request Resolved drag endpoints, phase durations, and frame/display context.
   */
  fun performDrag(request: RequestDrag) {
    DragOperation(request).run()
  }

  private inner class DragOperation(private val request: RequestDrag) {
    private val requestId = request.requestId
    private val x1 = request.x1
    private val y1 = request.y1
    private val x2 = request.x2
    private val y2 = request.y2
    private val pressDurationMs = request.resolvedPressDurationMs
    private val dragDurationMs = request.resolvedDragDurationMs
    private val holdDurationMs = request.holdDurationMs
    private val frameContext = request.frameContext
    private val displayId = request.displayId

    private val startTime = timeProvider.currentTimeMillis()

    fun run() {
      Log.d(
        TAG,
        "performDrag: ($x1, $y1) -> ($x2, $y2) press=${pressDurationMs}ms drag=${dragDurationMs}ms hold=${holdDurationMs}ms",
      )
      // Chained callbacks cross threads. Own these entries by request rather than leaving an IO
      // thread's perf stack open and trying to close it from the gesture thread.
      val dragPerf =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          MutablePerfEntry("performDrag", startTime, requestId).apply {
            children.add(MutablePerfEntry("buildPath", timeProvider.currentTimeMillis(), requestId))
          }
        } else null
      if (dragPerf == null) perfProvider.serial("performDrag")

      withGestureFailures(
        onFailure = { e ->
          reportFailure(e, dragPerf)
        },
      ) {
        if (dragPerf == null) perfProvider.startOperation("buildPath")
        val gestureBuilder = gestureBuilder(displayId)
        val startX = x1.toFloat()
        val startY = y1.toFloat()
        val endX = x2.toFloat()
        val endY = y2.toFloat()

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
          addLegacyDragStroke(
            gestureBuilder,
            GesturePoint(startX, startY),
            GesturePoint(endX, endY),
            pressDurationMs + dragDurationMs + holdDurationMs,
          )
        } else {
          val plan =
            dragStrokePlan(
              GesturePoint(startX, startY),
              GesturePoint(endX, endY),
              pressDurationMs,
              dragDurationMs,
              holdDurationMs,
            )
          ContinuedDrag(requestId, startTime, frameContext, displayId, requireNotNull(dragPerf))
            .dispatch(plan)
          return
        }
        dispatchLegacy(gestureBuilder)
      }
    }

    private fun dispatchLegacy(gestureBuilder: GestureDescription.Builder) {
      val gesture = gestureBuilder.build()
      perfProvider.endOperation("buildPath")

      val gestureBuiltTime = timeProvider.currentTimeMillis()
      Log.d(TAG, "Drag gesture built in ${gestureBuiltTime - startTime}ms")

      dispatchGestureWithResult(
        GestureDispatchRequest(
          perfLabel = "performDrag",
          gesture = gesture,
          requestId = requestId,
          startTimeMs = startTime,
          gestureBuiltTimeMs = gestureBuiltTime,
          frameContext = frameContext,
        ),
      ) { outcome ->
        dragResultReporter(requestId, outcome)
      }
    }

    private fun reportFailure(e: Exception, dragPerf: MutablePerfEntry?) {
      val errorTime = timeProvider.currentTimeMillis()
      if (dragPerf == null) perfProvider.end()
      else {
        dragPerf.children.forEach { if (it.endTime == null) it.endTime = errorTime }
        dragPerf.endTime = errorTime
        perfProvider.complete(dragPerf)
      }
      Log.e(TAG, "Error performing drag", e)
      dragResultReporter(
        requestId,
        GestureDispatchOutcome(
          false,
          errorTime - startTime,
          null,
          e.message ?: "Failed to perform drag",
        ),
      )
    }
  }

  private inner class ContinuedDrag(
    private val requestId: String?,
    private val startTime: Long,
    private val frameContext: String?,
    private val displayId: Int?,
    private val ownedPerf: MutablePerfEntry,
  ) {
    fun dispatch(plan: List<GestureSegment>) {
      val gestureBuiltTime = timeProvider.currentTimeMillis()
      ownedPerf.children.single().endTime = gestureBuiltTime
      val dispatchPerf = MutablePerfEntry("dispatchGesture", gestureBuiltTime, requestId)
      val lifecycle =
        GestureDispatchLifecycle(
          startTimeMs = startTime,
          gestureBuiltTimeMs = gestureBuiltTime,
          nowMs = { timeProvider.currentTimeMillis() },
          startOperation = { ownedPerf.children.add(dispatchPerf) },
          endOperation = { dispatchPerf.endTime = timeProvider.currentTimeMillis() },
          endPerfBlock = {
            ownedPerf.endTime = timeProvider.currentTimeMillis()
            perfProvider.complete(ownedPerf)
          },
        )
      host.forgetRememberedInsert()
      lifecycle.startDispatch()
      val onResult: (GestureDispatchOutcome) -> Unit = { dragResultReporter(requestId, it) }
      val posted = gestureThread.post {
        // Check once immediately before DOWN; this gesture's own events may advance the token.
        if (frameContext != null && frameContext != host.currentFrameContext()) {
          lifecycle.failed(
            IllegalStateException("Stale frame context; observe a fresh frame before retrying"),
            onResult,
          )
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          DragStrokeSession(
              plan = plan,
              dispatcher = AccessibilityStrokeDispatcher(),
              timing =
                DragStrokeDependencies(
                  deadline = dragDeadline,
                  nowMs = android.os.SystemClock::elapsedRealtime,
                ),
              displayId = displayId,
              logError = { Log.e(TAG, "Error dispatching drag stroke", it) },
              onFinished = { success, error ->
                if (success) {
                  serviceScope.launch(
                    gestureHandler.asCoroutineDispatcher().immediate +
                      RequestIdContext(requestId) +
                      PerfRequestContext(requestId),
                  ) {
                    gestureCompletionMutex.withLock { lifecycle.completed(onResult = onResult) }
                  }
                } else {
                  lifecycle.failed(IllegalStateException(error ?: "Drag failed"), onResult)
                }
              },
            )
            .start()
        }
      }
      if (!posted) lifecycle.notDispatched(onResult)
    }
  }

  /**
   * Perform a tap at specific coordinates using AccessibilityService's dispatchGesture API. This is
   * significantly faster than ADB input tap and more precise than resource-id lookup.
   *
   * @param request Tap coordinates, duration, frame/display context, and double-tap mode.
   */
  fun performTapCoordinates(request: RequestTapCoordinates) {
    val requestId = request.requestId
    val duration = request.duration
    val displayId = request.displayId

    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "performTapCoordinates: (${request.x}, ${request.y}) duration=${duration}ms")
    perfProvider.serial("performTapCoordinates")

    withGestureFailures(
      onFailure = { e ->
        perfProvider.end() // end performTapCoordinates block
        val errorTime = timeProvider.currentTimeMillis()
        Log.e(TAG, "Error performing tap", e)
        host.launchRequestScope(requestId) {
          broadcastTapCoordinatesResult(requestId, false, e.message, errorTime - startTime)
        }
      },
    ) {
      // Create a tap path (single point, no movement)
      perfProvider.startOperation("buildPath")
      val path = Path().apply { moveTo(request.x.toFloat(), request.y.toFloat()) }

      // Build the gesture description
      val builder = gestureBuilder(displayId)
      builder.addStroke(GestureDescription.StrokeDescription(path, 0, duration))
      if (request.doubleTap) {
        // Fixed 100ms release-to-press gap, independent of host reply latency.
        builder.addStroke(GestureDescription.StrokeDescription(path, duration + 100L, duration))
      }
      val gesture = builder.build()
      perfProvider.endOperation("buildPath")

      val gestureBuiltTime = timeProvider.currentTimeMillis()
      Log.d(TAG, "Tap gesture built in ${gestureBuiltTime - startTime}ms")

      var freshHierarchy: ViewHierarchy? = null
      dispatchGestureWithResult(
        GestureDispatchRequest(
          perfLabel = "performTapCoordinates",
          gesture = gesture,
          requestId = requestId,
          startTimeMs = startTime,
          gestureBuiltTimeMs = gestureBuiltTime,
          frameContext = request.frameContext,
        ),
        beforeCompletedResult = {
          // Wait for UI to settle after tap, then extract fresh hierarchy.
          freshHierarchy = host.settledHierarchy(displayId)
        },
      ) { outcome ->
        if (outcome.completed) {
          Log.d(
            TAG,
            "Tap completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
          )
          host.launchRequestScope(requestId) {
            freshHierarchy?.let { host.publishHierarchy(it) }
            broadcastTapCoordinatesResult(requestId, true, null, outcome.totalTimeMs)
          }
        } else {
          Log.w(TAG, "Tap failed after ${outcome.totalTimeMs}ms: ${outcome.error}")
          host.launchRequestScope(requestId) {
            broadcastTapCoordinatesResult(requestId, false, outcome.error, outcome.totalTimeMs)
          }
        }
      }
    }
  }

  /**
   * Perform a two-finger swipe gesture for TalkBack mode scrolling. This allows scrolling content
   * without moving the TalkBack focus cursor.
   *
   * @param request Parallel finger strokes, duration, spacing, and display context.
   */
  fun performTwoFingerSwipe(request: RequestTwoFingerSwipe) {
    val requestId = request.requestId
    val x1 = request.x1
    val y1 = request.y1
    val x2 = request.x2
    val y2 = request.y2
    val duration = request.duration
    val offset = request.offset
    val displayId = request.displayId
    val fingerCount = request.fingerCount

    val startTime = timeProvider.currentTimeMillis()
    Log.d(
      TAG,
      "performTwoFingerSwipe: ($x1, $y1) -> ($x2, $y2) duration=${duration}ms, offset=${offset}px, fingers=$fingerCount",
    )
    perfProvider.serial("performTwoFingerSwipe")

    withGestureFailures(
      onFailure = { e ->
        perfProvider.end() // end performTwoFingerSwipe block
        val errorTime = timeProvider.currentTimeMillis()
        Log.e(TAG, "Error performing two-finger swipe", e)
        host.launchRequestScope(requestId) {
          broadcastSwipeResult(requestId, false, e.message, errorTime - startTime, null)
        }
      },
    ) {
      // One parallel stroke per finger (geometry shared with iOS via computeMultiFingerStrokes).
      perfProvider.startOperation("buildPaths")
      val gesture = buildMultiFingerGesture(gestureBuilder(displayId), request)
      perfProvider.endOperation("buildPaths")

      val gestureBuiltTime = timeProvider.currentTimeMillis()
      Log.d(TAG, "Two-finger gesture built in ${gestureBuiltTime - startTime}ms")

      dispatchGestureWithResult(
        GestureDispatchRequest(
          perfLabel = "performTwoFingerSwipe",
          gesture = gesture,
          requestId = requestId,
          startTimeMs = startTime,
          gestureBuiltTimeMs = gestureBuiltTime,
        ),
      ) { outcome ->
        GestureReporter(requestId).twoFingerSwipe(outcome)
      }
    }
  }

  /** Perform a pinch gesture using AccessibilityService's dispatchGesture API. */
  fun performPinch(request: RequestPinch) {
    val requestId = request.requestId
    val centerX = request.centerX
    val centerY = request.centerY
    val distanceStart = request.distanceStart
    val distanceEnd = request.distanceEnd
    val rotationDegrees = request.rotationDegrees
    val duration = request.duration
    val displayId = request.displayId

    val startTime = timeProvider.currentTimeMillis()
    Log.d(
      TAG,
      "performPinch: center=($centerX,$centerY) start=$distanceStart end=$distanceEnd rotation=$rotationDegrees duration=${duration}ms",
    )
    perfProvider.serial("performPinch")

    withGestureFailures(
      onFailure = { e ->
        perfProvider.end()
        val errorTime = timeProvider.currentTimeMillis()
        Log.e(TAG, "Error performing pinch", e)
        host.launchRequestScope(requestId) {
          broadcastPinchResult(requestId, false, e.message, errorTime - startTime, null)
        }
      },
    ) {
      perfProvider.startOperation("buildPath")
      val gesture = buildPinchGesture(request) { gestureBuilder(displayId) }
      perfProvider.endOperation("buildPath")

      val gestureBuiltTime = timeProvider.currentTimeMillis()
      Log.d(TAG, "Pinch gesture built in ${gestureBuiltTime - startTime}ms")

      dispatchGestureWithResult(
        GestureDispatchRequest(
          perfLabel = "performPinch",
          gesture = gesture,
          requestId = requestId,
          startTimeMs = startTime,
          gestureBuiltTimeMs = gestureBuiltTime,
        ),
      ) { outcome ->
        GestureReporter(requestId).pinch(outcome)
      }
    }
  }

  private inner class GestureReporter(private val requestId: String?) {
    fun twoFingerSwipe(outcome: GestureDispatchOutcome) {

      if (outcome.completed) {
        Log.d(
          TAG,
          "Two-finger swipe completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
        )
        host.launchRequestScope(requestId) {
          broadcastSwipeResult(
            requestId,
            true,
            null,
            outcome.totalTimeMs,
            outcome.gestureTimeMs,
          )
        }
      } else {
        Log.w(TAG, "Two-finger swipe failed after ${outcome.totalTimeMs}ms: ${outcome.error}")
        host.launchRequestScope(requestId) {
          broadcastSwipeResult(requestId, false, outcome.error, outcome.totalTimeMs, null)
        }
      }
    }

    fun pinch(outcome: GestureDispatchOutcome) {

      if (outcome.completed) {
        Log.d(
          TAG,
          "Pinch completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
        )
        host.launchRequestScope(requestId) {
          broadcastPinchResult(
            requestId,
            true,
            null,
            outcome.totalTimeMs,
            outcome.gestureTimeMs,
          )
        }
      } else {
        Log.w(TAG, "Pinch failed after ${outcome.totalTimeMs}ms: ${outcome.error}")
        host.launchRequestScope(requestId) {
          broadcastPinchResult(requestId, false, outcome.error, outcome.totalTimeMs, null)
        }
      }
    }
  }

  /** Broadcast swipe result to WebSocket clients */
  suspend fun broadcastSwipeResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    gestureTimeMs: Long?,
  ) {
    resultSender.sendFrame(requestId, "swipe_result") { perfTiming ->
      swipeResultFrame(
        GestureFrameResult(
          requestId = requestId,
          success = success,
          error = error,
          totalTimeMs = totalTimeMs,
          gestureTimeMs = gestureTimeMs,
        ),
        perfTiming,
      )
    }
  }

  /** Broadcast drag result to WebSocket clients */
  suspend fun broadcastDragResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    gestureTimeMs: Long?,
  ) {
    resultSender.sendFrame(requestId, "drag_result") { perfTiming ->
      dragResultFrame(
        GestureFrameResult(
          requestId = requestId,
          success = success,
          error = error,
          totalTimeMs = totalTimeMs,
          gestureTimeMs = gestureTimeMs,
        ),
        perfTiming,
      )
    }
  }

  /** Broadcast tap coordinates result to WebSocket clients */
  suspend fun broadcastTapCoordinatesResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    resultSender.sendFrame(requestId, "tap_coordinates_result") { perfTiming ->
      tapCoordinatesResultFrame(requestId, success, error, totalTimeMs, perfTiming)
    }
  }

  /** Broadcast pinch result to WebSocket clients */
  private suspend fun broadcastPinchResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    gestureTimeMs: Long?,
  ) {
    resultSender.sendFrame(requestId, "pinch_result") { perfTiming ->
      pinchResultFrame(
        GestureFrameResult(
          requestId = requestId,
          success = success,
          error = error,
          totalTimeMs = totalTimeMs,
          gestureTimeMs = gestureTimeMs,
        ),
        perfTiming,
      )
    }
  }
}

/**
 * Handles the platform failure set shared by these operations. Failure handlers run outside the
 * try.
 */
private inline fun <T> withGestureFailures(onFailure: (Exception) -> T, block: () -> T): T =
  try {
    block()
  } catch (e: kotlinx.coroutines.CancellationException) {
    throw e
  } catch (e: IllegalArgumentException) {
    onFailure(e)
  } catch (e: IllegalStateException) {
    onFailure(e)
  } catch (e: SecurityException) {
    onFailure(e)
  }

private fun buildMultiFingerGesture(
  builder: GestureDescription.Builder,
  request: RequestTwoFingerSwipe,
): GestureDescription {

  for (stroke in
    computeMultiFingerStrokes(
      MultiFingerStrokeGeometry(
        x1 = request.x1,
        y1 = request.y1,
        x2 = request.x2,
        y2 = request.y2,
        offset = request.offset,
        fingerCount = request.fingerCount,
      ),
    )) {
    val path =
      Path().apply {
        moveTo(stroke.startX, stroke.startY)
        // A stationary stroke (multi-finger tap / long press) is a bare moveTo, like a tap.
        if (stroke.startX != stroke.endX || stroke.startY != stroke.endY) {
          lineTo(stroke.endX, stroke.endY)
        }
      }
    builder.addStroke(GestureDescription.StrokeDescription(path, 0, request.duration))
  }
  return builder.build()
}

private fun buildPinchGesture(
  request: RequestPinch,
  builder: () -> GestureDescription.Builder,
): GestureDescription {
  // Geometry is extracted into computePinchPoints so it stays unit testable (see
  // PinchGeometryTest) and stays in sync with the iOS runner. rotationDegrees rotates the
  // finger axis *during* the pinch (start horizontal, end rotated); see issue #2911.
  val points =
    computePinchPoints(
      request.centerX,
      request.centerY,
      request.distanceStart,
      request.distanceEnd,
      request.rotationDegrees,
    )

  // A rotating pinch follows an arc (angle and radius interpolated) instead of the straight
  // chord, which would shrink the radius mid-gesture and zoom a pure rotation (issue #12996).
  val interior =
    computePinchPathInterior(
      request.centerX,
      request.centerY,
      request.distanceStart,
      request.distanceEnd,
      request.rotationDegrees,
    )
  val path1 =
    Path().apply {
      moveTo(points.startX1, points.startY1)
      interior.forEach { lineTo(it.x1, it.y1) }
      lineTo(points.endX1, points.endY1)
    }
  val path2 =
    Path().apply {
      moveTo(points.startX2, points.startY2)
      interior.forEach { lineTo(it.x2, it.y2) }
      lineTo(points.endX2, points.endY2)
    }

  return builder()
    .addStroke(GestureDescription.StrokeDescription(path1, 0, request.duration))
    .addStroke(GestureDescription.StrokeDescription(path2, 0, request.duration))
    .build()
}

private fun addLegacyDragStroke(
  gestureBuilder: GestureDescription.Builder,
  start: GesturePoint,
  end: GesturePoint,
  durationMs: Long,
) {
  // Pre-API-26 GestureDescription has no stroke continuation (the willContinue
  // StrokeDescription constructor is API 26+), so press/drag/hold cannot be
  // chained as one continuous touch. Approximate with a single stroke covering
  // the combined duration. Previously this path threw NoSuchMethodError.
  val totalDurationMs = maxOf(1L, durationMs)
  val dragPath =
    Path().apply {
      moveTo(start.x, start.y)
      lineTo(end.x, end.y)
    }
  gestureBuilder.addStroke(GestureDescription.StrokeDescription(dragPath, 0, totalDurationMs))
  Log.d(
    "CtrlProxy",
    "Legacy (<API 26) single-stroke drag: (${start.x}, ${start.y}) -> (${end.x}, ${end.y}), duration=${totalDurationMs}ms",
  )
}
