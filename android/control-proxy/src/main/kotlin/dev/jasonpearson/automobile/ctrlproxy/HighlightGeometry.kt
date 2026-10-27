package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightBounds
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import kotlin.math.abs
import kotlin.math.sin
import kotlin.random.Random

/** Builds hand-drawn ellipse geometry using the caller-supplied random source. */
internal class HighlightGeometry(
  private val random: Random,
  private val resolveTargetDimensions: () -> ScreenDimensions?,
) {
  private companion object {
    const val TAG = "OverlayDrawer"
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

  fun buildRenderState(shape: HighlightShape): HighlightRenderResult {
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
        ),
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
    val hasInvalidRadii =
      !radiusX.isFinite() || !radiusY.isFinite() || radiusX <= 0f || radiusY <= 0f
    if (hasInvalidRadii) {
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
        ),
      )
    }

    return segments
  }

  private fun resolveEllipseWidthFactor(angleRad: Double): Float {
    val variation = abs(sin(angleRad)).toFloat()
    return ELLIPSE_MIN_WIDTH_FACTOR +
      (ELLIPSE_MAX_WIDTH_FACTOR - ELLIPSE_MIN_WIDTH_FACTOR) * variation
  }

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
}

internal data class HighlightRenderState(
  val shape: HighlightShape,
  val rect: RectF?,
  val ellipseSegments: List<EllipseSegment>?,
  val strokePaint: Paint?,
  val baseAlpha: Int,
  var alpha: Float,
  var drawProgress: Float = 0f,
)

internal data class EllipseSegment(
  val oval: RectF,
  val startAngle: Float,
  val sweepAngle: Float,
  val strokeWidth: Float,
)

private data class HighlightRectResult(val rect: RectF? = null, val error: String? = null)

private data class HighlightScaleResult(
  val scaleX: Float? = null,
  val scaleY: Float? = null,
  val error: String? = null,
)

internal data class HighlightRenderResult(
  val state: HighlightRenderState? = null,
  val error: String? = null,
)
