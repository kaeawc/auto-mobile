package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.hardware.display.DisplayManager
import android.hardware.input.InputManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Display
import android.view.InputDevice
import android.view.WindowManager
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart
import kotlinx.serialization.json.JsonObject

/** Framework posture acquisition stays outside the pure device projection. */
internal fun interface PrototypeFoldSource {
  fun folds(): Flow<PrototypeFold>
}

internal fun PrototypeFoldSource.deviceSnapshots(
  inputs: Flow<PrototypeDeviceInput>,
): Flow<JsonObject> =
  combine(inputs, folds().onStart { emit(PrototypeFold.NONE) }) { input, fold ->
      PrototypeDeviceState.snapshot(input.copy(fold = fold))
    }
    .distinctUntilChanged()

internal class AndroidPrototypeFoldSource(private val context: Context) : PrototypeFoldSource {
  override fun folds(): Flow<PrototypeFold> = flow {
    val activity =
      generateSequence(context) { (it as? ContextWrapper)?.baseContext }
        .filterIsInstance<Activity>()
        .firstOrNull()
    val layouts =
      when {
        activity != null -> WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity)
        Build.VERSION.SDK_INT >= 30 -> {
          val display =
            (context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).getDisplay(
              Display.DEFAULT_DISPLAY,
            )
          val ui =
            context
              .createDisplayContext(display)
              .createWindowContext(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, null)
          WindowInfoTracker.getOrCreate(ui).windowLayoutInfo(ui)
        }
        else -> {
          emit(PrototypeFold.NONE)
          return@flow
        }
      }
    emitAll(
      layouts.map { info ->
        val fold = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
        when {
          fold == null -> PrototypeFold.NONE
          fold.state == FoldingFeature.State.FLAT -> PrototypeFold.FLAT
          fold.orientation == FoldingFeature.Orientation.HORIZONTAL ->
            PrototypeFold.HALF_OPENED_HORIZONTAL
          else -> PrototypeFold.HALF_OPENED_VERTICAL
        }
      },
    )
  }
    .catch { failure ->
      Log.w("PrototypeDevice", "Window posture observation unavailable", failure)
      emit(PrototypeFold.NONE)
    }
}

private fun pointerChanges(context: Context): Flow<Boolean> = callbackFlow {
  val manager = context.getSystemService(Context.INPUT_SERVICE) as InputManager
  fun refresh() {
    trySend(hasPointer(context))
  }
  val listener =
    object : InputManager.InputDeviceListener {
      override fun onInputDeviceAdded(deviceId: Int) = refresh()

      override fun onInputDeviceRemoved(deviceId: Int) = refresh()

      override fun onInputDeviceChanged(deviceId: Int) = refresh()
    }
  manager.registerInputDeviceListener(listener, Handler(Looper.getMainLooper()))
  refresh()
  awaitClose { manager.unregisterInputDeviceListener(listener) }
}

private fun hasPointer(context: Context): Boolean {
  val manager = context.getSystemService(Context.INPUT_SERVICE) as InputManager
  return manager.inputDeviceIds.any { id ->
    val device = manager.getInputDevice(id)
    device?.supportsSource(InputDevice.SOURCE_MOUSE) == true ||
      device?.supportsSource(InputDevice.SOURCE_TOUCHPAD) == true
  }
}

/** `FEATURE_PC` is API 27; the feature name is a stable string, so read it on every API level. */
private fun isDesktopDevice(context: Context): Boolean =
  context.packageManager.hasSystemFeature("android.hardware.type.pc")

/** Synchronous baseline before a host has laid out its prototype window. */
@InternalAutoMobilePrototypeApi
fun prototypeInitialDeviceState(context: Context): JsonObject {
  val configuration = context.resources.configuration
  val density = context.resources.displayMetrics.density
  val bounds =
    if (Build.VERSION.SDK_INT >= 30)
      (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager)
        .currentWindowMetrics
        .bounds
    else null
  return PrototypeDeviceState.snapshot(
    PrototypeDeviceInput(
      bounds?.width()?.div(density) ?: configuration.screenWidthDp.toFloat(),
      bounds?.height()?.div(density) ?: configuration.screenHeightDp.toFloat(),
      configuration.smallestScreenWidthDp,
      PrototypeFold.NONE,
      hasPointer(context),
      Build.VERSION.RELEASE,
      isDesktopDevice(context),
    ),
  )
}

@Composable
internal fun ObservePrototypeDevice(send: (PrototypeInteraction) -> Unit) {
  val context = LocalContext.current
  val density = LocalDensity.current.density
  val configuration = LocalConfiguration.current
  // The Compose window is independent of the authored root's wrap-content measurement.
  val size = LocalWindowInfo.current.containerSize
  val folds = remember(context) { AndroidPrototypeFoldSource(context) }
  val pointer by
    remember(context) { pointerChanges(context) }
      .collectAsState(initial = remember(context) { hasPointer(context) })
  val input =
    PrototypeDeviceInput(
      size.width / density,
      size.height / density,
      configuration.smallestScreenWidthDp,
      PrototypeFold.NONE,
      pointer,
      Build.VERSION.RELEASE,
      isDesktopDevice(context),
    )
  val latestInput by rememberUpdatedState(input)
  val latestSend by rememberUpdatedState(send)
  LaunchedEffect(folds) {
    folds
      .deviceSnapshots(snapshotFlow { latestInput }.filter { it.widthDp > 0 && it.heightDp > 0 })
      .collect {
        latestSend(PrototypeInteraction.DeviceState(it))
      }
  }
}
