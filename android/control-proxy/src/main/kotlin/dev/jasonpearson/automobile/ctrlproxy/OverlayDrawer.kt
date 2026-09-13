package dev.jasonpearson.automobile.ctrlproxy

import android.animation.ValueAnimator
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.Log
import androidx.annotation.VisibleForTesting
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightBounds
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random

data class HighlightOperationResult(
  val success: Boolean,
  val error: String? = null,
)

class OverlayDrawer(
  private var overlayManager: OverlayManager? = null,
  private val screenDimensionsProvider: (() -> ScreenDimensions?)? = null,
  private val random: Random = Random.Default,
) {

  companion object {
    private const val TAG = "OverlayDrawer"
    private const val DEFAULT_STROKE_WIDTH = 8f
    private const val ELLIPSE_SEGMENT_COUNT = 64
    private const val ELLIPSE_JITTER_RATIO = 0.035f
    private const val ELLIPSE_JITTER_FREQ_X = 2.3f
    private const val ELLIPSE_JITTER_FREQ_Y = 3.7f
    private const val ELLIPSE_START_ANGLE = -90f
    private const val ELLIPSE_START_ANGLE_JITTER = 8f
    private const val ELLIPSE_MIN_WIDTH_FACTOR = 0.75f
    private const val ELLIPSE_MAX_WIDTH_FACTOR = 2.0f
  }

  private val lock = Any()
  private val highlights = LinkedHashMap<String, HighlightRenderState>()

  // Reusable render snapshot rebuilt only when the highlight set changes, so the
  // hot onDraw path does not allocate a fresh list every frame (issue #5465).
  private var renderSnapshot: List<HighlightRenderState> = emptyList()
  private var snapshotRebuildCount = 0

  // Coalesces the per-frame invalidations: the animator updates alpha and draw
  // progress separately each frame, but we only need to schedule one redraw. The
  // flag is cleared in draw() once the frame is consumed (issue #5465).
  private var invalidatePending = false

  private var overlayView: HighlightOverlayView? = null
  private val animator =
    HighlightAnimator(
      onAlphaUpdate = { id, alpha -> updateHighlightAlpha(id, alpha) },
      onDrawProgressUpdate = { id, progress -> updateHighlightDrawProgress(id, progress) },
      onAnimationComplete = { id -> removeHighlightInternal(id, cancelAnimation = false) },
      onAnimationActiveChanged = { active -> overlayView?.setAnimationActive(active) },
    )

  fun attachOverlayManager(manager: OverlayManager) {
    overlayManager = manager
  }

  internal fun attachView(view: HighlightOverlayView) {
    overlayView = view
    view.setAnimationActive(animator.isAnimating())
  }

  @VisibleForTesting
  internal fun getAnimatorForTest(id: String): ValueAnimator? = animator.getAnimatorForTest(id)

  @VisibleForTesting
  internal fun snapshotRebuildCountForTest(): Int = synchronized(lock) { snapshotRebuildCount }

  fun addHighlight(id: String?, shape: HighlightShape?): HighlightOperationResult {
    if (id.isNullOrBlank()) {
      return HighlightOperationResult(false, "Missing highlight id")
    }
    if (shape == null) {
      return HighlightOperationResult(false, "Missing highlight shape")
    }

    val renderResult = buildRenderState(shape)
    val renderState = renderResult.state
    if (renderState == null) {
      return HighlightOperationResult(
        false,
        renderResult.error ?: "Invalid highlight shape",
      )
    }

    val overlayError = ensureOverlayVisible()
    if (overlayError != null) {
      return HighlightOperationResult(false, overlayError)
    }

    animator.cancel(id)
    synchronized(lock) {
      highlights[id] = renderState
      rebuildSnapshotLocked()
    }
    animator.startFadeOut(id)
    scheduleInvalidate()
    return HighlightOperationResult(true, null)
  }

  fun destroy() {
    animator.cancelAll()
    synchronized(lock) {
      highlights.clear()
      rebuildSnapshotLocked()
      overlayManager?.hide()
    }
    overlayView = null
    overlayManager = null
  }

  private fun removeHighlightInternal(id: String, cancelAnimation: Boolean) {
    if (cancelAnimation) {
      animator.cancel(id)
    }

    synchronized(lock) {
      highlights.remove(id)
      rebuildSnapshotLocked()
      if (highlights.isEmpty()) {
        overlayManager?.hide()
      }
    }

    scheduleInvalidate()
  }

  private fun rebuildSnapshotLocked() {
    renderSnapshot = ArrayList(highlights.values)
    snapshotRebuildCount++
  }

  private fun scheduleInvalidate() {
    val view = overlayView ?: return
    val shouldInvalidate =
      synchronized(lock) {
        if (invalidatePending) {
          false
        } else {
          invalidatePending = true
          true
        }
      }
    if (shouldInvalidate) {
      view.invalidate()
    }
  }

  internal fun draw(canvas: Canvas) {
    val snapshot =
      synchronized(lock) {
        // Frame consumed: allow the next animation update to schedule a redraw.
        invalidatePending = false
        renderSnapshot
      }
    snapshot.forEach { renderState -> drawEllipse(canvas, renderState) }
  }

  private fun drawEllipse(canvas: Canvas, renderState: HighlightRenderState) {
    val rect = renderState.rect ?: return
    val paint = renderState.strokePaint ?: return

    val segments = renderState.ellipseSegments
    if (segments.isNullOrEmpty()) {
      applyStrokeAlpha(renderState, paint)
      canvas.drawOval(rect, paint)
      return
    }

    val progress = renderState.drawProgress.coerceIn(0f, 1f)
    val totalSegments = segments.size
    val exactCount = progress * totalSegments
    val fullSegments = exactCount.toInt().coerceIn(0, totalSegments)
    val partialProgress = exactCount - fullSegments.toFloat()

    val originalWidth = paint.strokeWidth
    val originalAlpha = paint.alpha

    for (index in 0 until fullSegments) {
      val segment = segments[index]
      paint.strokeWidth = segment.strokeWidth
      applyStaggeredFadeAlpha(renderState, paint, index, totalSegments)
      canvas.drawArc(segment.oval, segment.startAngle, segment.sweepAngle, false, paint)
    }
    if (partialProgress > 0f && fullSegments < totalSegments) {
      val segment = segments[fullSegments]
      paint.strokeWidth = segment.strokeWidth
      applyStaggeredFadeAlpha(renderState, paint, fullSegments, totalSegments)
      canvas.drawArc(
        segment.oval,
        segment.startAngle,
        segment.sweepAngle * partialProgress,
        false,
        paint,
      )
    }

    paint.strokeWidth = originalWidth
    paint.alpha = originalAlpha
  }

  private fun applyStrokeAlpha(renderState: HighlightRenderState, paint: Paint) {
    val targetAlpha = (renderState.baseAlpha * renderState.alpha).roundToInt().coerceIn(0, 255)
    if (paint.alpha != targetAlpha) {
      paint.alpha = targetAlpha
    }
  }

  private fun applyStaggeredFadeAlpha(
    renderState: HighlightRenderState,
    paint: Paint,
    segmentIndex: Int,
    totalSegments: Int,
  ) {
    val globalAlpha = renderState.alpha

    // If fully visible (alpha = 1.0) or drawing phase, use full alpha
    if (globalAlpha >= 1f || renderState.drawProgress < 1f) {
      val targetAlpha = (renderState.baseAlpha * globalAlpha).roundToInt().coerceIn(0, 255)
      paint.alpha = targetAlpha
      return
    }

    // During fade-out, stagger the fade for each segment
    // Earlier segments (lower index) start fading first
    val segmentFraction =
      if (totalSegments > 1) {
        segmentIndex.toFloat() / (totalSegments - 1).toFloat()
      } else {
        0f
      }

    // Stagger the fade: segment 0 starts immediately, last segment starts after delay
    // With 200ms total and 95% stagger, last segment has 10ms to fade
    val staggerAmount = 0.95f // 95% of fade time is staggered
    val fadeProgress = 1f - globalAlpha // 0.0 at start, 1.0 at end
    val segmentFadeStart = segmentFraction * staggerAmount
    val segmentFadeProgress =
      ((fadeProgress - segmentFadeStart) / (1f - staggerAmount)).coerceIn(0f, 1f)
    val segmentAlpha = 1f - segmentFadeProgress

    val targetAlpha = (renderState.baseAlpha * segmentAlpha).roundToInt().coerceIn(0, 255)
    paint.alpha = targetAlpha
  }

  private fun updateHighlightAlpha(id: String, alpha: Float) {
    val clamped = alpha.coerceIn(0f, 1f)
    synchronized(lock) { highlights[id]?.alpha = clamped }
    scheduleInvalidate()
  }

  private fun updateHighlightDrawProgress(id: String, progress: Float) {
    val clamped = progress.coerceIn(0f, 1f)
    synchronized(lock) { highlights[id]?.drawProgress = clamped }
    scheduleInvalidate()
  }

  private fun ensureOverlayVisible(): String? {
    val manager = overlayManager ?: return "Overlay not initialized"
    if (!manager.show()) {
      return "Overlay not available"
    }
    if (overlayView == null) {
      Log.w(TAG, "Overlay view missing after show()")
      return "Overlay view unavailable"
    }
    return null
  }

  private fun buildRenderState(shape: HighlightShape): HighlightRenderResult {
    if (shape.type != "circle")
      return HighlightRenderResult(error = "Only hand-drawn circle highlights are supported")
    val paint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.RED
        style = Paint.Style.STROKE
        strokeWidth = DEFAULT_STROKE_WIDTH
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
      }
    val bounds = shape.bounds ?: return HighlightRenderResult(error = "Missing highlight bounds")
    if (!bounds.hasValidSize()) {
      return HighlightRenderResult(error = "Highlight bounds must have positive width and height")
    }

    val rectResult = resolveRect(bounds)
    val rect = rectResult.rect
    if (rect == null) {
      return HighlightRenderResult(error = rectResult.error ?: "Invalid highlight bounds")
    }

    val baseStrokeWidth = DEFAULT_STROKE_WIDTH
    val ellipseSegments = buildEllipseSegments(rect, baseStrokeWidth)
    val baseAlpha = 255
    return HighlightRenderResult(
      state =
        HighlightRenderState(
          shape = shape,
          rect = rect,
          ellipseSegments = ellipseSegments,
          strokePaint = paint,
          baseAlpha = baseAlpha,
          alpha = 1f,
          drawProgress = 0f,
        )
    )
  }

  private fun buildEllipseSegments(rect: RectF, baseStrokeWidth: Float): List<EllipseSegment> {
    val segmentCount = ELLIPSE_SEGMENT_COUNT
    if (segmentCount <= 0) {
      return emptyList()
    }

    val centerX = rect.centerX()
    val centerY = rect.centerY()
    val radiusX = rect.width() / 2f
    val radiusY = rect.height() / 2f
    if (!radiusX.isFinite() || !radiusY.isFinite() || radiusX <= 0f || radiusY <= 0f) {
      return emptyList()
    }

    val sweep = 360f / segmentCount.toFloat()
    val phaseX = random.nextDouble() * Math.PI * 2.0
    val phaseY = random.nextDouble() * Math.PI * 2.0
    val startOffset =
      ELLIPSE_START_ANGLE + ((random.nextFloat() - 0.5f) * ELLIPSE_START_ANGLE_JITTER)

    val segments = ArrayList<EllipseSegment>(segmentCount)
    for (index in 0 until segmentCount) {
      val startAngle = startOffset + (index * sweep)
      val midAngle = startAngle + (sweep / 2f)
      val angleRad = Math.toRadians(midAngle.toDouble())
      val jitterX =
        1f + (ELLIPSE_JITTER_RATIO * sin(angleRad * ELLIPSE_JITTER_FREQ_X + phaseX).toFloat())
      val jitterY =
        1f + (ELLIPSE_JITTER_RATIO * sin(angleRad * ELLIPSE_JITTER_FREQ_Y + phaseY).toFloat())
      val oval =
        RectF(
          centerX - (radiusX * jitterX),
          centerY - (radiusY * jitterY),
          centerX + (radiusX * jitterX),
          centerY + (radiusY * jitterY),
        )
      val widthFactor = resolveEllipseWidthFactor(angleRad)
      segments.add(
        EllipseSegment(
          oval = oval,
          startAngle = startAngle,
          sweepAngle = sweep,
          strokeWidth = baseStrokeWidth * widthFactor,
        )
      )
    }

    return segments
  }

  private fun resolveEllipseWidthFactor(angleRad: Double): Float {
    val variation = abs(sin(angleRad)).toFloat()
    return ELLIPSE_MIN_WIDTH_FACTOR +
      (ELLIPSE_MAX_WIDTH_FACTOR - ELLIPSE_MIN_WIDTH_FACTOR) * variation
  }

  private data class HighlightRenderState(
    val shape: HighlightShape,
    val rect: RectF?,
    val ellipseSegments: List<EllipseSegment>?,
    val strokePaint: Paint?,
    val baseAlpha: Int,
    var alpha: Float,
    var drawProgress: Float = 0f,
  )

  private data class EllipseSegment(
    val oval: RectF,
    val startAngle: Float,
    val sweepAngle: Float,
    val strokeWidth: Float,
  )

  private fun resolveRect(bounds: HighlightBounds): HighlightRectResult {
    val scale = resolveScale(bounds)
    if (scale.error != null) {
      return HighlightRectResult(error = scale.error)
    }
    val scaleX = scale.scaleX ?: 1f
    val scaleY = scale.scaleY ?: 1f
    return HighlightRectResult(rect = bounds.toRectF(scaleX, scaleY))
  }

  private fun resolveScale(bounds: HighlightBounds): HighlightScaleResult {
    val sourceWidth = bounds.sourceWidth
    val sourceHeight = bounds.sourceHeight

    if (sourceWidth == null && sourceHeight == null) {
      return HighlightScaleResult()
    }

    if (sourceWidth == null || sourceHeight == null) {
      Log.w(TAG, "Highlight bounds missing sourceWidth/sourceHeight; ignoring scaling.")
      return HighlightScaleResult()
    }

    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return HighlightScaleResult(error = "sourceWidth and sourceHeight must be greater than 0")
    }

    val targetDimensions = resolveTargetDimensions()
    if (targetDimensions == null || !targetDimensions.isValid()) {
      Log.w(TAG, "Unable to resolve target dimensions; ignoring scaling.")
      return HighlightScaleResult()
    }

    return HighlightScaleResult(
      scaleX = targetDimensions.width.toFloat() / sourceWidth.toFloat(),
      scaleY = targetDimensions.height.toFloat() / sourceHeight.toFloat(),
    )
  }

  private fun resolveTargetDimensions(): ScreenDimensions? {
    val view = overlayView
    if (view != null && view.width > 0 && view.height > 0) {
      return ScreenDimensions(view.width, view.height)
    }
    return screenDimensionsProvider?.invoke()
  }

  private data class HighlightRectResult(val rect: RectF? = null, val error: String? = null)

  private data class HighlightScaleResult(
    val scaleX: Float? = null,
    val scaleY: Float? = null,
    val error: String? = null,
  )

  private data class HighlightRenderResult(
    val state: HighlightRenderState? = null,
    val error: String? = null,
  )
}
