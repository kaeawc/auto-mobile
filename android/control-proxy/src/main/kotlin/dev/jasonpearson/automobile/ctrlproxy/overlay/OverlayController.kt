package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.util.Log
import android.view.Display
import dev.jasonpearson.automobile.protocol.OverlayScalar
import dev.jasonpearson.automobile.protocol.OverlaySpec
import dev.jasonpearson.automobile.protocol.OverlaySpecValidation
import dev.jasonpearson.automobile.protocol.OverlaySpecValidator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** The CtrlProxy application id, named in errors that tell the host which package to grant. */
const val DEFAULT_CTRL_PROXY_PACKAGE = "dev.jasonpearson.automobile.ctrlproxy"

fun interface OverlayResultSink {
  suspend fun send(requestId: String?, success: Boolean, error: String?)

  /**
   * A successful `show_overlay` or `update_overlay` that references assets the device does not
   * have: a warning carried by the same single `overlay_result`, so the host can re-upload. Sinks
   * that predate it drop the list.
   */
  suspend fun sendWithMissingAssets(
    requestId: String?,
    success: Boolean,
    error: String?,
    missingAssets: List<String>,
  ) = send(requestId, success, error)
}

/**
 * One active ID/spec, serialized with host mutations. Validation/mapping happen before replacement;
 * rejected requests retain the previous spec/window. State patches merge, including new valid keys;
 * the canonical validator supplies key rules and JSON paths. There is no opacity-only wire field.
 */
class OverlayController(
  private val host: InteractiveOverlayHost,
  private val sink: OverlayResultSink,
  private val onDismissed: suspend () -> Unit = {},
  private val eventSink: OverlayEventSink = OverlayEventSink {},
  private val clock: () -> Long = System::currentTimeMillis,
  private val lifecycle: OverlayLifecycle = OverlayLifecycle(CoroutineOverlayScheduler()),
  private val render: (OverlaySpec) -> InteractiveOverlayRequest = { mapOverlaySpec(it).request() },
  /** Decides whether a non-default display can host the overlay; the default always can. */
  private val displays: OverlayDisplayProvider = OverlayDisplayProvider { true },
  /**
   * Drops every uploaded asset when the overlay session ends: any dismissal or abandonment, unbind,
   * destroy, a dismiss-all with nothing showing, and the last client disconnecting (even with
   * nothing showing, since assets are uploaded before the overlay that uses them). Not called for a
   * show replacement or a temporary lock-screen hide.
   */
  private val clearAssets: () -> Unit = {},
  /** Whether the asset store holds [id]; `show` and `update` report referenced ids that fail. */
  private val hasAsset: (String) -> Boolean = { true },
  /** Decoded-image cache the rendered overlay draws `image` nodes from. */
  private val images: OverlayImageCache? = null,
  /**
   * Whether this package may add `window.layer: "app"` windows (SYSTEM_ALERT_WINDOW); a request for
   * that layer without it fails before anything is replaced, naming the appop to grant.
   */
  private val appLayerPermitted: () -> Boolean = { true },
  private val packageName: String = DEFAULT_CTRL_PROXY_PACKAGE,
) {
  val isShowing: Boolean
    get() = host.isShowing

  private val mutex = Mutex()
  internal var activeRuntime: OverlayRuntime? = null
    private set

  // Controller lifetime ledger: same-id show/dismiss/re-show and reconnect never rewind sequences.
  private val sequences = mutableMapOf<String, Long>()
  private var destroyed = false
  private var activeObserverSession = 0
  // A disconnect dismissal whose window removal failed; retried on the next lifecycle signal.
  private var disconnectPending = false
  private var activeRequest: InteractiveOverlayRequest? = null
  // Match WebSocketServer.protocolJson; default-valued optional fields are omitted, not null.
  private val json = Json {
    prettyPrint = false
    ignoreUnknownKeys = true
    classDiscriminator = "type"
  }

  /** [displayId] null means the default display, exactly as before display targeting. */
  suspend fun show(requestId: String?, spec: OverlaySpec, displayId: Int? = null) =
    execute(requestId) {
      display(
        spec,
        replace = activeRuntime != null,
        displayId = displayId ?: Display.DEFAULT_DISPLAY,
      )
      missingAssets()
    }

  suspend fun update(
    requestId: String?,
    id: String,
    spec: OverlaySpec?,
    state: Map<String, OverlayScalar>?,
  ) =
    execute(requestId) {
      val current = activeRuntime?.current?.spec
      require(current?.id == id) { "Unknown overlay id: $id" }
      require((spec == null) != (state == null)) { "Exactly one of spec or state is required" }
      require(spec == null || spec.id == id) { "spec.id: Must match overlay id $id" }
      // A replacement spec stays on the display the overlay was shown on.
      if (spec != null)
        display(spec, replace = true, preservePages = true, displayId = shownDisplayId())
      else {
        val patched =
          validate(checkNotNull(current).copy(state = current.state.orEmpty() + state.orEmpty()))
        render(patched) // Validate Compose sizes too, before mutating the live runtime.
        val runtime = checkNotNull(activeRuntime)
        runtime.replace(patched)
        armIdle(runtime)
        ensureShowing(runtime)
        syncTextFieldFocus(runtime)
      }
      missingAssets()
    }

  suspend fun dismiss(requestId: String?, id: String?, all: Boolean?) =
    execute(requestId) {
      require(all == true || (id != null && activeRuntime?.current?.spec?.id == id)) {
        "Unknown overlay id: $id"
      }
      val runtime = activeRuntime
      if (runtime != null) runtime.dismiss(OverlayDismissReason.AGENT)
      else {
        check(host.dismiss()) { "Overlay host failed to dismiss window" }
        notifyDetached()
        releaseAssets()
      }
      emptyList()
    }

  /** Referenced assets the store lacks, for the active spec. Never fails the request. */
  private fun missingAssets(): List<String> {
    val spec = activeRuntime?.current?.spec ?: return emptyList()
    return overlayAssetReferences(spec.root).filterNot(hasAsset)
  }

  private fun validate(spec: OverlaySpec): OverlaySpec {
    guardOverlayTree(spec.root)
    return when (val validation = OverlaySpecValidator.validate(json.encodeToString(spec))) {
      is OverlaySpecValidation.Failure ->
        error("${validation.error.path}: ${validation.error.message}")
      is OverlaySpecValidation.Success -> validation.spec
    }
  }

  private fun shownDisplayId(): Int = activeRequest?.displayId ?: Display.DEFAULT_DISPLAY

  /** The default display is always present; any other must be connected, or nothing is replaced. */
  private fun requireDisplayAvailable(displayId: Int) =
    require(displayId == Display.DEFAULT_DISPLAY || displays.isAvailable(displayId)) {
      "Unknown or disconnected display: $displayId"
    }

  private suspend fun display(
    spec: OverlaySpec,
    replace: Boolean,
    preservePages: Boolean = false,
    displayId: Int = Display.DEFAULT_DISPLAY,
  ) {
    val validated = validate(spec)
    val request = render(validated).copy(displayId = displayId)
    requireDisplayAvailable(displayId)
    requireLayerPermitted(request.layer)
    val previous = activeRuntime
    val observerSession = lifecycle.observerSession()
    val runtime =
      OverlayRuntime(
        validated,
        eventSink,
        clock,
        nextSequence = {
          val next = (sequences[validated.id] ?: 0L) + 1
          sequences[validated.id] = next
          next
        },
        requestDismiss = { removeActive() },
        previousPages = if (preservePages) previous?.current?.pages.orEmpty() else emptyMap(),
      )
    val interactive =
      request.copy(
        hasTextField = mapOverlaySpec(validated, runtime.current.pages).hasTextField,
        onHostDismiss = { interact(runtime, OverlayInteraction.HostDismiss) },
        content = {
          OverlayRuntimeContent(runtime, images) { interaction -> interact(runtime, interaction) }
        },
      )
    val blocked = lifecycle.isBlocked()
    check(
      if (blocked) host.dismiss()
      else if (replace) host.replace(interactive) else host.show(interactive)
    ) {
      "Overlay host failed to render window"
    }
    if (blocked) notifyDetached()
    previous?.close()
    activeRuntime = runtime
    activeRequest = interactive
    activeObserverSession = observerSession
    disconnectPending = false
    armIdle(runtime)
    // The session's last client can leave before this queued show runs; nothing would remove it.
    // A device-persistent overlay is meant to outlive its clients, so it stays.
    if (lifecycle.clientCount() == 0 && !runtime.persistent) dismissForDisconnect(runtime)
  }

  private val OverlayRuntime.persistent: Boolean
    get() = isDevicePersistent(current.spec)

  private fun requireLayerPermitted(layer: OverlayWindowLayer) =
    require(layer != OverlayWindowLayer.APP || appLayerPermitted()) {
      "window.layer: app needs Android 8.0+ and SYSTEM_ALERT_WINDOW for $packageName, which is " +
        "not granted. Grant it with `adb shell appops set $packageName SYSTEM_ALERT_WINDOW " +
        "allow`, or omit window.layer to use the system layer."
    }

  /** Shared by dismiss_overlay and the dismiss action, under the controller mutex. */
  private suspend fun removeActive(): Boolean {
    if (!host.dismiss()) return false
    activeRuntime = null
    activeRequest = null
    lifecycle.cancel()
    notifyDetached()
    releaseAssets()
    return true
  }

  private suspend fun notifyDetached() {
    try {
      onDismissed()
    } catch (error: Exception) {
      // Removal succeeded; ancillary highlight cleanup must not suppress a terminal overlay event.
      Log.w("OverlayController", "Overlay highlight cleanup failed", error)
    }
  }

  /** Asset cleanup is ancillary: it must never suppress a dismissal, event or lifecycle step. */
  private fun releaseAssets() {
    try {
      clearAssets()
    } catch (error: Exception) {
      Log.w("OverlayController", "Overlay asset cleanup failed", error)
    }
  }

  internal suspend fun interact(runtime: OverlayRuntime, interaction: OverlayInteraction) =
    mutex.withLock {
      if (destroyed || runtime !== activeRuntime) return@withLock
      try {
        // Compose reports its initial/restored settled page; that is rendering, not idle activity.
        if (
          interaction !is OverlayInteraction.PagerMotion ||
            interaction.scrolling ||
            runtime.current.pages[interaction.pager] != interaction.page
        )
          armIdle(runtime)
        runtime.handle(interaction)
        if (runtime === activeRuntime && runtime.current.active) syncTextFieldFocus(runtime)
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w("OverlayController", "Overlay interaction failed", error)
      }
    }

  /** [action] returns the referenced asset ids the device lacks, reported as a warning. */
  private suspend fun execute(requestId: String?, action: suspend () -> List<String>) =
    mutex.withLock {
      var missing = emptyList<String>()
      val error =
        try {
          check(!destroyed) { "Overlay host destroyed" }
          missing = action()
          null
        } catch (error: CancellationException) {
          throw error
        } catch (error: Exception) {
          Log.w("OverlayController", "Overlay request failed", error)
          error.message ?: "Overlay request failed (${error.javaClass.simpleName})"
        }
      if (missing.isEmpty()) sink.send(requestId, error == null, error)
      else sink.sendWithMissingAssets(requestId, error == null, error, missing)
    }

  private fun armIdle(
    runtime: OverlayRuntime,
    delayMillis: Long = lifecycle.ttlMillis,
    retriesLeft: Int = OVERLAY_DISMISS_MAX_RETRIES,
  ) {
    // A device-persistent overlay is a standalone mock with nobody to re-show it: never idle out.
    if (runtime.persistent) {
      lifecycle.cancel()
      return
    }
    lifecycle.arm(delayMillis) { token ->
      signal {
        if (runtime === activeRuntime && lifecycle.isCurrent(token)) {
          try {
            runtime.dismiss(OverlayDismissReason.TTL)
          } catch (error: CancellationException) {
            throw error
          } catch (error: Exception) {
            // The one-shot expiry is spent; re-arm (bounded) so a failed removal is not final.
            if (retriesLeft > 0 && runtime === activeRuntime)
              armIdle(runtime, OVERLAY_DISMISS_RETRY_MILLIS, retriesLeft - 1)
            throw error
          }
        }
      }
    }
  }

  /** Ends [runtime] for a gone session; a failed removal is logged and retried by [signal]. */
  private suspend fun dismissForDisconnect(runtime: OverlayRuntime) {
    try {
      runtime.dismiss(OverlayDismissReason.DISCONNECT)
      disconnectPending = false
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      disconnectPending = runtime === activeRuntime
      Log.w("OverlayController", "Overlay disconnect dismissal failed", error)
    }
  }

  /** Local override until a daemon/tool TTL field exists; no new protocol field is invented. */
  suspend fun setIdleTtlMillis(millis: Long) = mutex.withLock {
    lifecycle.ttlMillis = millis
    activeRuntime?.let { armIdle(it) }
  }

  suspend fun onClientCountChanged(count: Int, observerSession: Int? = null) =
    signal(retryDisconnect = false) {
      require(count >= 0) { "Client count must be nonnegative" }
      // A device-persistent overlay keeps running offline, and keeps the assets it draws.
      if (activeRuntime?.persistent == true) return@signal
      // A delayed disconnect from a previous observer session cannot dismiss a newly shown overlay.
      if (count == 0 && (observerSession == null || observerSession == activeObserverSession))
        activeRuntime?.let { dismissForDisconnect(it) }
      // Assets outlive no client, shown or not; a stale disconnect must not drop a new session's.
      if (count == 0 && (observerSession == null || observerSession == lifecycle.observerSession()))
        releaseAssets()
    }

  /**
   * Rotation/density changes keep the same runtime and Compose tree; hiding retains authored state.
   * The overlay's own display going away dismisses it even when the caller does not know that.
   */
  suspend fun onConfigurationChanged(displayAvailable: Boolean = true) = signal {
    val runtime = activeRuntime ?: return@signal
    applyWindowDecision(runtime, displayAvailable && ownDisplayAvailable())
  }

  /**
   * A display callback. Only the overlay's own display matters: its removal dismisses with
   * `teardown` rather than moving the content to another display, and a change relayouts. Other
   * displays' transitions are not this overlay's business.
   */
  suspend fun onDisplayTransition(displayId: Int, removed: Boolean) = signal {
    val runtime = activeRuntime ?: return@signal
    if (displayId == shownDisplayId())
      applyWindowDecision(runtime, !removed && ownDisplayAvailable())
  }

  private fun ownDisplayAvailable(): Boolean =
    shownDisplayId() == Display.DEFAULT_DISPLAY || displays.isAvailable(shownDisplayId())

  private suspend fun applyWindowDecision(runtime: OverlayRuntime, displayAvailable: Boolean) {
    when (overlayWindowDecision(displayAvailable, lifecycle.isBlocked())) {
      OverlayWindowDecision.DISMISS -> runtime.dismiss(OverlayDismissReason.TEARDOWN)
      OverlayWindowDecision.HIDE -> {
        check(host.dismiss()) { "Overlay host failed to hide window" }
        notifyDetached()
      }
      OverlayWindowDecision.RELAYOUT -> relayoutOrRestore(runtime)
    }
  }

  /**
   * A window the platform reports detached is cleared by the host, so a failed relayout with
   * nothing showing means the overlay vanished underneath us: re-show the authored request. If the
   * window cannot come back the runtime ends once, as teardown, instead of lingering windowless.
   */
  private suspend fun relayoutOrRestore(runtime: OverlayRuntime) {
    val request = checkNotNull(activeRequest)
    if (host.isShowing) {
      if (host.relayout()) {
        if (!host.isShowing) notifyDetached() // The host hid it: a lock arrived mid-signal.
        return
      }
      // Still attached: a retryable platform failure, so keep the window and runtime as they are.
      check(!host.isShowing) { "Overlay host failed to re-layout window" }
    }
    if (restoreWindow(request)) return
    if (lifecycle.isBlocked()) notifyDetached() // Locked meanwhile: hidden, restored on unlock.
    else abandon(runtime)
  }

  /**
   * A display can still be listed yet unable to take a window (its window context fails), which
   * makes the host throw instead of returning false. That is the same "cannot come back" outcome:
   * report it as false so the caller abandons rather than leaving the runtime windowless.
   */
  private suspend fun restoreWindow(request: InteractiveOverlayRequest): Boolean =
    try {
      host.show(request)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("OverlayController", "Overlay window could not be restored", error)
      false
    }

  /**
   * A state-only update never touches the host, so a window the host cleared as detached would
   * leave the runtime windowless while the request reports success. A lock-hidden window is
   * legitimate (restored on unlock) and keeps the patched state; otherwise restore it now, and fail
   * the request when the overlay could not come back (the runtime then ended once, as teardown).
   */
  private suspend fun ensureShowing(runtime: OverlayRuntime) {
    if (host.isShowing || lifecycle.isBlocked()) return
    relayoutOrRestore(runtime)
    check(runtime === activeRuntime && (host.isShowing || lifecycle.isBlocked())) {
      "Overlay window was lost and could not be restored"
    }
  }

  /**
   * The window may hold input focus only while a text field is visible in the CURRENT tree, so a
   * page swipe, tab change or sheet open/close can flip it; otherwise Back and key input to the app
   * behind would be swallowed. A failed flip keeps the old request and is retried on the next
   * change.
   */
  private suspend fun syncTextFieldFocus(runtime: OverlayRuntime) {
    val request = activeRequest ?: return
    val visible = mapOverlaySpec(runtime.current.spec, runtime.current.pages).hasTextField
    if (visible == request.hasTextField) return
    // A window cleared as detached is restored from activeRequest, so record the change for it.
    if (host.setTextFieldVisible(visible) || !host.isShowing)
      activeRequest = request.copy(hasTextField = visible)
    else Log.w("OverlayController", "Overlay host failed to update window focusability")
  }

  /** Terminal teardown for a window that cannot be shown again: exactly one `dismissed` event. */
  private suspend fun abandon(runtime: OverlayRuntime) {
    activeRuntime = null
    activeRequest = null
    lifecycle.cancel()
    notifyDetached()
    releaseAssets()
    runtime.finishDismissal(OverlayDismissReason.TEARDOWN)
  }

  /**
   * Service unbind: ends the active overlay as teardown but keeps the controller reusable, because
   * Android can rebind the same service instance before onDestroy. Failed removal stays retryable.
   */
  suspend fun dismissForUnbind() = signal {
    releaseAssets()
    val runtime = activeRuntime
    if (runtime != null) runtime.dismiss(OverlayDismissReason.TEARDOWN)
    else if (host.isShowing) {
      check(host.dismiss()) { "Overlay host failed to dismiss window" }
      notifyDetached()
    }
  }

  private suspend fun signal(retryDisconnect: Boolean = true, action: suspend () -> Unit) =
    mutex.withLock {
      if (destroyed) return@withLock
      try {
        if (retryDisconnect && disconnectPending) activeRuntime?.let { dismissForDisconnect(it) }
        action()
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w("OverlayController", "Overlay lifecycle signal failed", error)
      }
    }

  /** Run from a teardown scope independent of the cancelled service scope; no blocking join. */
  suspend fun destroy() = mutex.withLock {
    destroyed = true
    lifecycle.cancel()
    try {
      if (host.destroy()) notifyDetached()
      else Log.w("OverlayController", "Overlay host failed to destroy window")
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("OverlayController", "Overlay teardown failed", error)
    } finally {
      val runtime = activeRuntime
      activeRuntime = null
      activeRequest = null
      releaseAssets()
      // Allocate the terminal sequence even when the last socket or service sink is gone.
      try {
        runtime?.finishDismissal(OverlayDismissReason.TEARDOWN)
      } catch (error: Exception) {
        // Teardown is best effort once the sink has shut down; the runtime is already terminal.
        Log.w("OverlayController", "Overlay teardown event delivery failed", error)
      }
    }
  }
}
