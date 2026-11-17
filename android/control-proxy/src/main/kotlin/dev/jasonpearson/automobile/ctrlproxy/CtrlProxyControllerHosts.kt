package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityService.GestureResultCallback
import android.accessibilityservice.GestureDescription
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Intent
import android.os.Handler
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.ime.CtrlProxyIme
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitRequest
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitResult
import dev.jasonpearson.automobile.ctrlproxy.ime.session.KeyboardProfileStore
import dev.jasonpearson.automobile.ctrlproxy.ime.session.SharedPreferencesKeyboardProfileStore
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

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
