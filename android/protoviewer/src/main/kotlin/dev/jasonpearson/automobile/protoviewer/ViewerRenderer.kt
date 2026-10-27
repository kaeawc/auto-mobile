package dev.jasonpearson.automobile.protoviewer

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.util.Log
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.FrameLayout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.CancellationException

/** An app-owned composition boundary; fakes can withhold readiness without blocking main. */
interface ViewerRenderer {
  @Composable fun Render(content: @Composable () -> Unit, onFailure: () -> Unit)
}

/**
 * A failed spec composition must not take down the app composition containing Back and provenance.
 * Its own recomposer catches composition failures once, and [GuardedFrame] catches the measure,
 * layout and draw failures that composition cannot see; then the activity removes this surface.
 *
 * Validation (`PrototypeSpecValidator.MAX_PROTOTYPE_DEPTH` and `MAX_PROTOTYPE_NODES`, re-applied on
 * every library load) bounds spec depth and size, so a validated spec cannot reach the
 * stack-overflow path on a device. The StackOverflowError, layout and draw catches are defense in
 * depth for any spec that bypasses validation. ViewerWatchdogTest exercises recovery with its fake
 * renderer's layoutError, drawError and compositionError cases.
 */
object GuardedViewerRenderer : ViewerRenderer {
  @Composable
  @Suppress(
    "TooGenericExceptionCaught",
  ) // Arbitrary spec composition failures share this recovery boundary.
  override fun Render(content: @Composable () -> Unit, onFailure: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val render by rememberUpdatedState(content)
    val failed by rememberUpdatedState(onFailure)
    val recomposer = remember { Recomposer(scope.coroutineContext) }
    val composeView = remember {
      ComposeView(context).apply { setParentCompositionContext(recomposer) }
    }
    val view = remember { GuardedFrame(context, composeView) { failed() } }
    AndroidView(factory = { view }, modifier = Modifier.fillMaxSize())
    DisposableEffect(view) {
      onDispose {
        composeView.disposeComposition()
        recomposer.cancel()
      }
    }
    LaunchedEffect(view) {
      try {
        composeView.setContent { ProtoViewerTheme { render() } }
        recomposer.runRecomposeAndApplyChanges()
      } catch (error: CancellationException) {
        throw error
      } catch (error: RuntimeException) {
        Log.w("ProtoViewer", "Prototype composition failed", error)
        failed()
      } catch (error: StackOverflowError) {
        // A deeply nested spec overflows the stack; the stack has unwound, so recovery is safe.
        Log.w("ProtoViewer", "Prototype composition overflowed the stack", error)
        failed()
      }
    }
  }
}

/**
 * Hosts the spec's [ComposeView] and stops a measure, layout or draw failure from reaching the view
 * traversal (which would crash the process). The first failure detaches the spec from the traversal
 * and reports once; the activity then replaces this surface with the error screen.
 *
 * These layout and draw catches share [GuardedViewerRenderer]'s defense in depth for specs that
 * bypass validation; ViewerWatchdogTest's fake-renderer layoutError and drawError cases exercise
 * recovery without exceeding the validated spec limits on a device.
 */
// Only constructed in code, never inflated from a layout, so the XML constructors are unneeded.
@SuppressLint("ViewConstructor")
private class GuardedFrame(
  context: Context,
  child: ComposeView,
  private val onFailure: () -> Unit,
) : FrameLayout(context) {
  private var failed = false

  init {
    addView(child, LayoutParams(MATCH_PARENT, MATCH_PARENT))
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    if (failed || !guard { super.onMeasure(widthMeasureSpec, heightMeasureSpec) }) {
      setMeasuredDimension(
        resolveSize(0, widthMeasureSpec),
        resolveSize(0, heightMeasureSpec),
      )
    }
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    if (!failed) guard { super.onLayout(changed, left, top, right, bottom) }
  }

  override fun dispatchDraw(canvas: Canvas) {
    if (failed) return
    val saved = canvas.save()
    if (!guard { super.dispatchDraw(canvas) }) canvas.restoreToCount(saved)
  }

  @Suppress("TooGenericExceptionCaught") // Arbitrary spec failures share this recovery boundary.
  private inline fun guard(block: () -> Unit): Boolean =
    try {
      block()
      true
    } catch (error: RuntimeException) {
      fail(error)
    } catch (error: StackOverflowError) {
      // Only spec failures are recoverable; other Errors (out of memory) must still surface.
      fail(error)
    }

  private fun fail(error: Throwable): Boolean {
    Log.w("ProtoViewer", "Prototype layout or draw failed", error)
    failed = true
    onFailure()
    return false
  }
}
