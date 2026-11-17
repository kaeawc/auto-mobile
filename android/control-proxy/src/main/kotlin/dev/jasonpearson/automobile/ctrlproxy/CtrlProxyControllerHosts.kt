package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityService.GestureResultCallback
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback
import android.accessibilityservice.GestureDescription
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.ime.CtrlProxyIme
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitRequest
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitResult
import dev.jasonpearson.automobile.ctrlproxy.ime.session.KeyboardProfileStore
import dev.jasonpearson.automobile.ctrlproxy.ime.session.SharedPreferencesKeyboardProfileStore
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import java.io.File
import java.io.OutputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

/*
 * The service seams [CtrlProxy] hands its feature controllers (#11876). Each host only forwards to
 * the service; the controllers own the behaviour.
 */

/** Wires [TextInputController] to the active window, display, soft keyboard and IME. */
internal class CtrlProxyTextInputHost(private val service: CtrlProxy) : TextInputController.Host {
  override fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit) {
    service.launchRequestScope(requestId, block)
  }

  override fun activeWindowRoot(): AccessibilityNodeInfo? = service.rootInActiveWindow

  override fun screenDimensions(displayId: Int) =
    service.displayController.getScreenDimensions(displayId)

  override fun hideSoftKeyboard() {
    service.softKeyboardController.setShowMode(AccessibilityService.SHOW_MODE_HIDDEN)
  }

  override suspend fun performImeNavigationAction(actionId: Int) =
    CtrlProxyIme.current()?.performNavigationAction(actionId)

  override fun sendKeycodeEnter() =
    Runtime.getRuntime().exec(arrayOf("input", "keyevent", "66")).waitFor() == 0

  override suspend fun publishSettledHierarchy() {
    service.hierarchyController.publishSettledHierarchy()
  }
}

/** Wires [ImeController] to the running [CtrlProxyIme] and the keyboard profile store. */
internal class CtrlProxyImeHost(private val service: CtrlProxy) : ImeController.Host {
  override fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit) {
    service.launchRequestScope(requestId, block)
  }

  override fun currentIme(): ImeController.ImeTarget? =
    CtrlProxyIme.current()?.let { ime ->
      object : ImeController.ImeTarget {
        override fun commitText(request: ImeCommitRequest, onResult: (ImeCommitResult) -> Unit) =
          ime.commitText(request, onResult)
      }
    }

  override fun setActiveProfile(id: String, onComplete: (Boolean) -> Unit) =
    CtrlProxyIme.setActiveProfile(id, onComplete)

  override fun keyboardProfileStore(): KeyboardProfileStore =
    SharedPreferencesKeyboardProfileStore(service)

  override fun forgetRememberedInsert() = service.textInputController.forgetRememberedInsert()
}

/** Wires [SdkControlController] to the service's broadcasts and the WebSocket reply. */
internal class CtrlProxySdkControlHost(private val service: CtrlProxy) : SdkControlController.Host {
  override fun sendBroadcast(intent: Intent) = service.sendBroadcast(intent)

  override fun sendOrderedBroadcast(intent: Intent, resultReceiver: BroadcastReceiver) =
    service.sendOrderedBroadcast(
      intent,
      null,
      resultReceiver,
      null,
      Activity.RESULT_OK,
      null,
      null,
    )

  override fun replyNetworkMockRules(result: SetNetworkMockRulesResult) {
    val server = service.webSocketServerOrNull
    if (server?.isRunning() == true) {
      service.serviceScope.launch { server.broadcast(result) }
    }
  }
}

/** Wires [GestureController] to the framework's gesture dispatch and the settled hierarchy. */
internal class CtrlProxyGestureHost(private val service: CtrlProxy) : GestureController.Host {
  override fun dispatchGesture(
    gesture: GestureDescription,
    callback: GestureResultCallback,
    handler: Handler,
  ) = service.dispatchGesture(gesture, callback, handler)

  override fun currentFrameContext() = service.currentFrameContext()

  override fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit) {
    service.launchRequestScope(requestId, block)
  }

  override fun forgetRememberedInsert() = service.textInputController.forgetRememberedInsert()

  override suspend fun settledHierarchy(displayId: Int?) =
    service.hierarchyController.settledHierarchy(displayId)

  override suspend fun publishHierarchy(hierarchy: ViewHierarchy) =
    service.hierarchyController.broadcastHierarchyUpdate(hierarchy, sync = true)
}

/** Wires [DisplayController] to the display and window managers, resources and insets. */
internal class CtrlProxyDisplayHost(private val service: CtrlProxy) : DisplayController.Host {
  override fun displayManager() =
    service.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager

  override fun windowManager() = service.getSystemService(Context.WINDOW_SERVICE) as? WindowManager

  private val insetsProvider by lazy { createDisplayInsetsProvider(service) }

  override fun displayInsetsProvider() = insetsProvider

  override fun frameworkDimenPx(name: String) = service.frameworkDimenPx(name)

  override fun isXrSpatialDevice() =
    service.packageManager.hasSystemFeature(CtrlProxy.XR_SPATIAL_FEATURE)

  override fun densityDpi() = service.resources.displayMetrics.densityDpi
}

/** Wires [HierarchyController] to window selection, device facts, the WebSocket and app files. */
// One forwarder per HierarchyController.Host method, so the count is the interface's.
@Suppress("TooManyFunctions")
internal class CtrlProxyHierarchyHost(private val service: CtrlProxy) : HierarchyController.Host {
  override fun currentFrameContext() = service.currentFrameContext()

  override fun selectDisplayWindows(displayId: Int?) =
    service.viewHierarchyExtractor.selectDisplayWindows(service, displayId)

  override fun activeWindowRoot(): AccessibilityNodeInfo? = service.rootInActiveWindow

  override fun lastWindowState() = service.lastWindowState

  override fun rotationProvenance() = service.rotationProvenance

  override fun occlusionEnabled() = service.accessibilityFlags.occlusionEnabled

  override fun wakefulness() = service.deviceInfoController.getWakefulness()

  override fun foregroundActivity(
    rootPackage: String?,
    windowClass: String?,
    windowPackage: String?,
  ) = service.deviceInfoController.getForegroundActivity(rootPackage, windowClass, windowPackage)

  override fun isEmulator() = service.deviceInfoController.getIsEmulator()

  override fun accessibilityTool() = service.deviceInfoController.getAccessibilityTool()

  override fun isServerRunning() = service.isWebSocketRunning()

  override fun connectionCount() = service.webSocketServer.getConnectionCount()

  override fun releaseRequestOwner(requestId: String?) {
    service.webSocketServerOrNull?.releaseRequestOwner(requestId)
  }

  override suspend fun broadcastHierarchyWithPerf(
    routeByRequestId: Boolean,
    messageBuilder: (perfTiming: JsonElement?) -> String,
  ) = service.webSocketServer.broadcastWithPerf(routeByRequestId, messageBuilder)

  override suspend fun broadcastHierarchyWithPerfSync(
    routeByRequestId: Boolean,
    messageBuilder: (perfTiming: JsonElement?) -> String,
  ) = service.webSocketServer.broadcastWithPerfSync(routeByRequestId, messageBuilder)

  override suspend fun broadcastHierarchyExtractFrame(
    frame: ErrorResponse?,
    externallyCorrelated: Boolean,
  ) = service.hierarchyExtractFrames.send(frame, externallyCorrelated)

  override fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit) =
    service.launchRequestScope(requestId, block)

  override fun openFileOutput(filename: String, mode: Int): OutputStream =
    service.openFileOutput(filename, mode)

  override fun filesDir(): File = service.filesDir
}

/** Wires [ScreenshotController] to the framework screenshot API (API 30+). */
internal class CtrlProxyScreenshotHost(private val service: CtrlProxy) : ScreenshotController.Host {
  override fun takeScreenshot(displayId: Int, callback: TakeScreenshotCallback) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      service.takeScreenshot(displayId, service.mainExecutor, callback)
    }
  }

  override fun rotationProvenance() = service.rotationProvenance
}

/** Wires [InteractionEventController] to the WebSocket and the last window class. */
internal class CtrlProxyInteractionEventHost(private val service: CtrlProxy) :
  InteractionEventController.Host {
  override fun connectionCount() = service.webSocketConnectionCount()

  override fun observerSessionGeneration() = service.webSocketObserverGeneration()

  override fun isServerRunning() = service.isWebSocketRunning()

  override suspend fun broadcast(message: String) {
    service.webSocketServer.broadcast(message)
  }

  override fun lastWindowClassName() = service.lastWindowClassName

  override fun launchInServiceScope(block: suspend CoroutineScope.() -> Unit) {
    service.serviceScope.launch(block = block)
  }
}
