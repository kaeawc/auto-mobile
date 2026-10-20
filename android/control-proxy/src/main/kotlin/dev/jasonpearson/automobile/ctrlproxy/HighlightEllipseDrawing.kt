package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Canvas
import android.graphics.Paint
import kotlin.math.roundToInt

internal fun drawEllipse(canvas: Canvas, renderState: HighlightRenderState) {
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
