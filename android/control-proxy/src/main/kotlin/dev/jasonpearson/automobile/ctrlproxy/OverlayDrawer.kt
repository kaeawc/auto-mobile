package dev.jasonpearson.automobile.ctrlproxy

import android.animation.ValueAnimator
import android.graphics.Canvas
import android.util.Log
import androidx.annotation.VisibleForTesting
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
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
  }

  private val geometry =
    HighlightGeometry(random) {
      val view = overlayView
      if (view != null && view.width > 0 && view.height > 0) {
        ScreenDimensions(view.width, view.height)
      } else {
        screenDimensionsProvider?.invoke()
      }
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
      dependencies =
        HighlightAnimatorDependencies(
          onAlphaUpdate = { id, alpha ->
            val clamped = alpha.coerceIn(0f, 1f)
            synchronized(lock) { highlights[id]?.alpha = clamped }
            scheduleInvalidate()
          },
          onDrawProgressUpdate = { id, progress ->
            val clamped = progress.coerceIn(0f, 1f)
            synchronized(lock) { highlights[id]?.drawProgress = clamped }
            scheduleInvalidate()
          },
          onAnimationComplete = { id -> removeHighlightInternal(id, cancelAnimation = false) },
          onAnimationActiveChanged = { active -> overlayView?.setAnimationActive(active) },
        ),
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

    val renderResult = geometry.buildRenderState(shape)
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
}
