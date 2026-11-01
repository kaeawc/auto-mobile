package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPrototypeDeviceAppearance
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPrototypeDeviceLocale
import dev.jasonpearson.automobile.ctrlproxy.prototype.CoroutinePrototypeScheduler
import dev.jasonpearson.automobile.ctrlproxy.prototype.DefaultPrototypeHost
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeBackdropSupport
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeBackdrops
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeController
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeEventSink
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpClients
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImeInset
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeLifecycle
import dev.jasonpearson.automobile.ctrlproxy.prototype.RetrofitPrototypeHttpClient
import dev.jasonpearson.automobile.ctrlproxy.prototype.hasPrototypeTitle
import dev.jasonpearson.automobile.ctrlproxy.prototype.validatePrototypeShaderUniforms
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

// The service's log tag, so the moved setup keeps logging under it.
private const val TAG = "CtrlProxy"

/**
 * Builds the prototype controller and the window host factory it uses, from the service's
 * collaborators. Called once from [CtrlProxy.onServiceConnected]; a same-process rebind reuses it.
 */
internal fun CtrlProxy.createPrototypeController(): PrototypeController {
  // Locks are shared safety facts; foreground suspension is request-local per surface.
  val windowBlocked = { this@createPrototypeController.prototypeWindowBlocked() }
  val createPrototypeHost = {
    DefaultPrototypeHost(
      context = this,
      displayWindows = prototypeDisplays,
      onWindowAttached = {
        ownWindowTypeMemo.clear()
        overlayManager.setPrototypeAttached(true)
      },
      onWindowLost = ::refreshPrototypeWindow,
      isBlocked = windowBlocked,
      imeInset = PrototypeImeInset { displayId -> prototypeImeLiftPx(displayId) },
      backScope = serviceScope,
    )
  }
  return PrototypeController(
    createPrototypeHost(),
    prototypeResultSink,
    onDismissed = {
      ownWindowTypeMemo.clear()
      withContext(Dispatchers.Main.immediate) {
        overlayManager.setPrototypeAttached(false)
      }
    },
    lifecycle = prototypeLifecycle(windowBlocked),
    eventSink = prototypeEventSink(),
    storage = prototypeStorage,
    backdropSupport =
      PrototypeBackdropSupport {
        // Cross-window blur can be switched off at runtime (battery saver, developer
        // option).
        Build.VERSION.SDK_INT >= PrototypeBackdrops.MIN_BLUR_SDK &&
          getSystemService(WindowManager::class.java)?.isCrossWindowBlurEnabled == true
      },
    windowOnScreen = prototypeWindowProbe(),
    displays = prototypeDisplays,
    clearAssets = { prototypeAssets.clear() },
    hasAsset = { prototypeAssets.lookup(it) != null },
    validateShaders = { validatePrototypeShaderUniforms(it, prototypeAssets::lookup) },
    images = prototypeImages,
    // The host grants this appop before showing a window.layer "app" prototype.
    appLayerPermitted = {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Settings.canDrawOverlays(this)
    },
    packageName = packageName,
    fonts = prototypeFonts,
    foreground = prototypeForeground,
    deviceAppearance = AndroidPrototypeDeviceAppearance(this),
    deviceLocale = AndroidPrototypeDeviceLocale(this),
    hostFactory = createPrototypeHost,
    httpClients =
      PrototypeHttpClients(
        host = hostPrototypeHttp,
        device = RetrofitPrototypeHttpClient(OkHttpClient()),
      ),
    requestScope = serviceScope,
    platform = prototypePlatform,
  )
}

/**
 * The prototype lifecycle, fed the lock gate, observer session and client count from the service.
 */
private fun CtrlProxy.prototypeLifecycle(windowBlocked: () -> Boolean) =
  PrototypeLifecycle(
    CoroutinePrototypeScheduler(serviceScope),
    isBlocked = windowBlocked,
    observerSession = {
      webSocketServerOrNull?.observerSessionGeneration() ?: 0
    },
    clientCount = {
      // Unknown (server not up yet) counts as connected: never drop a prototype on a
      // guess.
      webSocketServerOrNull?.getConnectionCount() ?: 1
    },
  )

/** Whether the prototype window is on a display, from this service's accessibility windows. */
private fun CtrlProxy.prototypeWindowProbe() =
  PrototypeWindowProbe(
    sdkInt = Build.VERSION.SDK_INT,
    source =
      object : PrototypeWindowProbe.Source<AccessibilityWindowInfo> {
        override fun legacyWindows(): List<AccessibilityWindowInfo>? = windows

        override fun displayWindows(displayId: Int) =
          viewHierarchyExtractor.selectDisplayWindows(this@prototypeWindowProbe, displayId).windows

        override fun hasTitle(window: AccessibilityWindowInfo) =
          hasPrototypeTitle(window.type, window.title)

        override fun rootPackage(window: AccessibilityWindowInfo): String? {
          val root = window.root
          return try {
            root?.packageName?.toString()
          } finally {
            root?.recycle()
          }
        }
      },
    ownPackage = packageName,
    onFailure = { Log.d(TAG, "Could not determine prototype window visibility", it) },
  )

/** Prototype events go to connected clients as frames, guarded so a failed send is contained. */
private fun CtrlProxy.prototypeEventSink() = PrototypeEventSink { event ->
  if (webSocketServerOrNull?.isRunning() == true) {
    resultBroadcaster.guard(null, "prototype_event") {
      webSocketServer.broadcastWithPerf { _ -> prototypeEventFrame(event) }
    }
  }
}
