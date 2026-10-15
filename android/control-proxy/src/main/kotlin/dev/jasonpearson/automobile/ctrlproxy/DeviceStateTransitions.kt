package dev.jasonpearson.automobile.ctrlproxy

import android.content.Context
import android.os.Build
import android.util.Log
import android.view.WindowManager
import androidx.core.content.ContextCompat
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Best-effort fold-posture notifications through Jetpack WindowManager; no hidden API is used.
 * The emitted integer is an opaque change key, not a platform device-state identifier.
 */
internal object DeviceStateTransitions {
  internal enum class Kind {
    FLAT,
    HALF_OPENED,
  }

  internal data class FoldPosture(
    val state: Kind,
    val isVertical: Boolean,
    val isSeparating: Boolean,
  )

  /**
   * Zero means no folding feature. Codes 1..8 encode state, orientation, and separation. For
   * multiple features, select the smallest code, independent of feature ordering or duplicates.
   */
  internal fun postureCode(features: List<FoldPosture>): Int =
    features.minOfOrNull {
      1 +
        (if (it.state == Kind.HALF_OPENED) 4 else 0) +
        (if (it.isVertical) 2 else 0) +
        (if (it.isSeparating) 1 else 0)
    } ?: 0

  internal class StateObserver(private val onChange: (Int) -> Unit) {
    private var lastState: Int? = null

    fun accept(state: Int) {
      val previous = lastState
      lastState = state
      if (previous != null && previous != state) onChange(state)
    }
  }

  /** Sources deliver serially on the main thread in production and release observation on close. */
  internal fun interface PostureSource {
    fun observe(onPostures: (List<FoldPosture>) -> Unit): AutoCloseable
  }

  /** Owns collection independently of the service's IO scope. The provider may fail synchronously. */
  internal class PostureFlowSource(
    private val postures: () -> Flow<List<FoldPosture>>,
    private val dispatcher: CoroutineDispatcher,
    private val warn: (String, Throwable?) -> Unit = ::logWarning,
  ) : PostureSource {
    override fun observe(onPostures: (List<FoldPosture>) -> Unit): AutoCloseable {
      val flow = postures()
      val scope = CoroutineScope(dispatcher)
      scope.launch {
        try {
          flow.collect { onPostures(it) }
        } catch (e: CancellationException) {
          throw e
        } catch (e: Exception) {
          warn("WindowManager collection failed; fold-posture events are lost", e)
        } catch (e: LinkageError) {
          warn("WindowManager collection linkage failed; fold-posture events are lost", e)
        } finally {
          scope.cancel()
        }
      }
      return AutoCloseable { scope.cancel() }
    }
  }

  private fun logWarning(message: String, cause: Throwable?) {
    Log.w("CtrlProxyDeviceState", message, cause)
  }

  private fun windowPostures(context: Context): Flow<List<FoldPosture>> {
    if (Build.VERSION.SDK_INT < 30) {
      throw IllegalArgumentException("WindowManager requires a UI context on API 30+")
    }
    // AccessibilityService is not an Activity. WindowManager requires a UI context (API 30+).
    val uiContext =
      context.createWindowContext(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, null)
    return WindowInfoTracker.getOrCreate(uiContext).windowLayoutInfo(uiContext).map { layout ->
      layout.displayFeatures.filterIsInstance<FoldingFeature>().map { feature ->
        FoldPosture(
          state = if (feature.state == FoldingFeature.State.FLAT) Kind.FLAT else Kind.HALF_OPENED,
          isVertical = feature.orientation == FoldingFeature.Orientation.VERTICAL,
          isSeparating = feature.isSeparating,
        )
      }
    }
  }

  fun register(
    context: Context,
    sdkInt: Int = Build.VERSION.SDK_INT,
    source: PostureSource = PostureSource { onPostures ->
      PostureFlowSource(
          { windowPostures(context) },
          ContextCompat.getMainExecutor(context).asCoroutineDispatcher(),
        )
        .observe(onPostures)
    },
    onState: (Int) -> Unit,
  ): AutoCloseable? = register(source, sdkInt, ::logWarning, onState)

  /** Android-free registration seam; warnings use Log.w in the Context overload. */
  internal fun register(
    source: PostureSource,
    sdkInt: Int,
    warn: (String, Throwable?) -> Unit,
    onState: (Int) -> Unit,
  ): AutoCloseable? {
    if (sdkInt < 30) {
      warn("WindowManager requires a UI context on API 30+; fold-posture events are lost", null)
      return null
    }
    val observer = StateObserver(onState)
    val closed = AtomicBoolean(false)
    return try {
      val registration = source.observe { if (!closed.get()) observer.accept(postureCode(it)) }
      AutoCloseable { if (closed.compareAndSet(false, true)) registration.close() }
    } catch (e: CancellationException) {
      closed.set(true)
      throw e
    } catch (e: Exception) {
      closed.set(true)
      warn("WindowManager observation unavailable; fold-posture events are lost", e)
      null
    } catch (e: LinkageError) {
      closed.set(true)
      warn("WindowManager observation linkage failed; fold-posture events are lost", e)
      null
    }
  }
}
