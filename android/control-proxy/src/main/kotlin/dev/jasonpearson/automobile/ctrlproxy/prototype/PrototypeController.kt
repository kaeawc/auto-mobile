package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import android.view.Display
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStatusEntry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** The CtrlProxy application id, named in errors that tell the host which package to grant. */
const val DEFAULT_CTRL_PROXY_PACKAGE = "dev.jasonpearson.automobile.ctrlproxy"

fun interface PrototypeResultSink {
  suspend fun send(requestId: String?, success: Boolean, error: String?)

  /**
   * A successful `show_prototype` that references assets the device does not have: a warning
   * carried by the same single `prototype_result`, so the host can re-upload. Sinks that predate it
   * drop the list.
   */
  suspend fun sendWithMissingAssets(
    requestId: String?,
    success: Boolean,
    error: String?,
    missingAssets: List<String>,
  ) = send(requestId, success, error)

  /** The reply to `inspect_prototypes`. Sinks that predate it answer a bare success. */
  suspend fun sendPrototypeStatus(
    requestId: String?,
    prototypes: List<PrototypeStatusEntry>,
    droppedEvents: Long,
  ) = send(requestId, true, null)
}

/**
 * One active ID/spec, serialized with host mutations. Validation/mapping happen before replacement;
 * rejected requests retain the previous spec/window. Every show carries a full spec whose state is
 * authoritative; the canonical validator supplies key rules and JSON paths. There is no
 * opacity-only wire field.
 */
class PrototypeController(
  private val host: PrototypeHost,
  private val sink: PrototypeResultSink,
  private val onDismissed: suspend () -> Unit = {},
  private val eventSink: PrototypeEventSink = PrototypeEventSink {},
  private val clock: () -> Long = System::currentTimeMillis,
  private val lifecycle: PrototypeLifecycle = PrototypeLifecycle(CoroutinePrototypeScheduler()),
  private val render: (PrototypeSpec) -> PrototypeRequest = { mapPrototypeSpec(it).request() },
  /** Decides whether a non-default display can host the prototype; the default always can. */
  private val displays: PrototypeDisplayProvider = PrototypeDisplayProvider { true },
  /**
   * Drops every uploaded asset when the prototype session ends: any dismissal or abandonment,
   * unbind, destroy, a dismiss-all with nothing showing, and the last client disconnecting (even
   * with nothing showing, since assets are uploaded before the prototype that uses them). Not
   * called for a show replacement or a temporary lock-screen hide.
   */
  private val clearAssets: () -> Unit = {},
  /** Whether the asset store holds [id]; `show` reports referenced ids that fail. */
  private val hasAsset: (String) -> Boolean = { true },
  /** Decoded-image cache the rendered prototype draws `image` nodes from. */
  private val images: PrototypeImageCache? = null,
  /**
   * Whether this package may add `window.layer: "app"` windows (SYSTEM_ALERT_WINDOW); a request for
   * that layer without it fails before anything is replaced, naming the appop to grant.
   */
  private val appLayerPermitted: () -> Boolean = { true },
  private val packageName: String = DEFAULT_CTRL_PROXY_PACKAGE,
  /** Events a device-persistent prototype produced while no host was connected. */
  private val offlineEvents: PrototypeOfflineEventBuffer = PrototypeOfflineEventBuffer(),
  /** Loaded custom fonts the rendered prototype draws `fontFamily: {asset}` text with. */
  private val fonts: PrototypeFontCache? = null,
  /**
   * Ties a session prototype to the app it was shown over: while another app is in front the window
   * is hidden (state kept, no `dismissed` event) and returns with the app (#10261). Separate from
   * the lock-screen block and from any capture-time hide.
   */
  private val foreground: PrototypeForegroundScope = NoPrototypeForegroundScope,
) {
  val isShowing: Boolean
    get() = host.isShowing

  /**
   * Whether the prototype on screen is in the application-overlay layer, whose windows the system
   * reports to accessibility as `TYPE_SYSTEM` rather than as an accessibility overlay.
   */
  val isAppLayerShowing: Boolean
    get() = host.isShowing && activeRequest?.layer == PrototypeWindowLayer.APP

  /**
   * Placement and opacity of the prototype currently drawn, for the hierarchy capture
   * (`prototype_window_metadata_v1`). Null when nothing is showing or the render model cannot be
   * derived, so the host falls back to bounds. A snapshot read off the controller mutex.
   */
  fun windowMetadata(): PrototypeWindowMetadata? {
    val runtime = activeRuntime ?: return null
    if (!host.isShowing) return null
    return try {
      val current = runtime.current
      prototypeWindowMetadata(mapPrototypeSpec(current.spec, current.pages))
    } catch (error: Exception) {
      Log.w("PrototypeController", "Prototype window metadata unavailable", error)
      null
    }
  }

  /** True while a prototype exists but is hidden because its app left the foreground. */
  val isSuspendedByForeground: Boolean
    get() = activeRuntime != null && foreground.suspended

  /**
   * Captures with the prototype hidden (#9305). Deliberately outside the controller mutex: a
   * capture must not wait behind a show, and the host serializes captures and restores on its own.
   * A suspended prototype (its app is not in front, #10261) has no window: the capture treats it as
   * not showing and never touches the host, so it cannot re-show it. The host's restore also goes
   * through isBlocked, covering a suspension or lock that lands mid-capture.
   */
  suspend fun <T> withHiddenForCapture(block: suspend () -> T): PrototypeHiddenCapture<T> =
    if (isSuspendedByForeground) PrototypeHiddenCapture(block(), prototypeExcluded = true)
    else host.withHiddenForCapture(block = block)

  private val mutex = Mutex()
  @Volatile
  internal var activeRuntime: PrototypeRuntime? = null
    private set

  // Controller lifetime ledger: same-id show/dismiss/re-show and reconnect never rewind sequences.
  private val sequences = mutableMapOf<String, Long>()
  private var destroyed = false
  private var activeObserverSession = 0
  // A disconnect dismissal whose window removal failed; retried on the next lifecycle signal.
  private var disconnectPending = false
  @Volatile private var activeRequest: PrototypeRequest? = null
  // Match WebSocketServer.protocolJson; default-valued optional fields are omitted, not null.
  private val json = Json {
    prettyPrint = false
    ignoreUnknownKeys = true
    classDiscriminator = "type"
  }

  /**
   * Always renders the full [spec]. When [spec]'s id is the prototype on screen and [reset] is
   * false, it replaces that prototype in place: it stays on the display it was shown on
   * ([displayId] is ignored) and each pager keeps its page, matched by pager id and clamped to the
   * new page count. The new spec's state is authoritative; values the user changed are not carried
   * over. Otherwise (another id, nothing shown, or [reset]) it is a fresh show on [displayId],
   * where null means the default display, exactly as before display targeting.
   */
  suspend fun show(
    requestId: String?,
    spec: PrototypeSpec,
    displayId: Int? = null,
    reset: Boolean = false,
  ) =
    execute(requestId) {
      val inPlace = !reset && activeRuntime?.current?.spec?.id == spec.id
      display(
        spec,
        replace = activeRuntime != null,
        preservePages = inPlace,
        displayId = if (inPlace) shownDisplayId() else displayId ?: Display.DEFAULT_DISPLAY,
      )
      missingAssets()
    }

  suspend fun dismiss(requestId: String?, id: String?, all: Boolean?) =
    execute(requestId) {
      require(all == true || (id != null && activeRuntime?.current?.spec?.id == id)) {
        "Unknown prototype id: $id"
      }
      val runtime = activeRuntime
      if (runtime != null) runtime.dismiss(PrototypeDismissReason.AGENT)
      else {
        check(host.dismiss()) { "Prototype host failed to dismiss window" }
        notifyDetached()
        releaseAssets()
      }
      emptyList()
    }

  /** Referenced assets the store lacks, for the active spec. Never fails the request. */
  private fun missingAssets(): List<String> {
    val spec = activeRuntime?.current?.spec ?: return emptyList()
    return prototypeAssetReferences(spec.root).filterNot(hasAsset)
  }

  private fun validate(spec: PrototypeSpec): PrototypeSpec {
    guardPrototypeTree(spec.root)
    requireResolvedPrototypeAnchors(spec.root)
    return when (val validation = PrototypeSpecValidator.validate(json.encodeToString(spec))) {
      is PrototypeSpecValidation.Failure ->
        error("${validation.error.path}: ${validation.error.message}")
      is PrototypeSpecValidation.Success -> validation.spec
    }
  }

  private fun shownDisplayId(): Int = activeRequest?.displayId ?: Display.DEFAULT_DISPLAY

  /** The default display is always present; any other must be connected, or nothing is replaced. */
  private fun requireDisplayAvailable(displayId: Int) =
    require(displayId == Display.DEFAULT_DISPLAY || displays.isAvailable(displayId)) {
      "Unknown or disconnected display: $displayId"
    }

  private suspend fun display(
    spec: PrototypeSpec,
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
      PrototypeRuntime(
        validated,
        if (isDevicePersistent(validated)) offlineAwareSink else eventSink,
        clock,
        nextSequence = {
          val next = (sequences[validated.id] ?: 0L) + 1
          sequences[validated.id] = next
          next
        },
        requestDismiss = { removeActive() },
        previousPages = if (preservePages) previous?.current?.pages.orEmpty() else emptyMap(),
      )
    val mappedSpec = mapPrototypeSpec(validated, runtime.current.pages)
    val interactive =
      request.copy(
        hasTextField = mappedSpec.hasTextField,
        darkTheme = prototypeHostDark(mappedSpec),
        themeRoot = mappedSpec.root,
        specTheme = validated.theme,
        onHostDismiss = { interact(runtime, PrototypeInteraction.HostDismiss) },
        content = {
          PrototypeRuntimeContent(runtime, images, fonts) { interaction ->
            interact(runtime, interaction)
          }
        },
      )
    // A device-persistent prototype is a standalone mock with no app to follow.
    val scopeBefore = foreground.capture()
    if (isDevicePersistent(validated)) foreground.release() else foreground.anchor()
    val blocked = lifecycle.isBlocked()
    // A rejected or throwing host leaves the previous window up, so it keeps its own scoping.
    try {
      check(
        if (blocked) host.dismiss()
        else if (replace) host.replace(interactive) else host.show(interactive),
      ) {
        "Prototype host failed to render window"
      }
    } catch (error: Throwable) {
      foreground.restore(scopeBefore)
      throw error
    }
    if (blocked) notifyDetached()
    previous?.close()
    activeRuntime = runtime
    activeRequest = interactive
    activeObserverSession = observerSession
    disconnectPending = false
    armIdle(runtime)
    // The session's last client can leave before this queued show runs; nothing would remove it.
    // A device-persistent prototype is meant to outlive its clients, so it stays.
    if (lifecycle.clientCount() == 0 && !runtime.persistent) dismissForDisconnect(runtime)
  }

  private val PrototypeRuntime.persistent: Boolean
    get() = isDevicePersistent(current.spec)

  /**
   * A device-persistent prototype keeps emitting with no host attached. Those events wait in
   * [offlineEvents] and go out, oldest first, ahead of the next live event. Runs under [mutex].
   */
  private val offlineAwareSink = PrototypeEventSink { event ->
    // A live event never overtakes an older held one: the host ignores lower sequences.
    if (lifecycle.clientCount() == 0 || !replayOfflineEvents()) offlineEvents.add(event)
    else eventSink.send(event)
  }

  /**
   * Delivers what was buffered while no host was connected. An event leaves the buffer only once it
   * is handed to the sink: when delivery fails, or the host goes away mid-replay, that event and
   * the rest are put back for the next connect or inspect. Returns whether everything went out.
   */
  private suspend fun replayOfflineEvents(): Boolean {
    val pending = offlineEvents.drain()
    for ((index, event) in pending.withIndex()) {
      if (lifecycle.clientCount() == 0) {
        offlineEvents.restore(pending.subList(index, pending.size))
        return false
      }
      try {
        eventSink.send(event)
      } catch (error: CancellationException) {
        offlineEvents.restore(pending.subList(index, pending.size))
        throw error
      } catch (error: Exception) {
        Log.w("PrototypeController", "Buffered prototype event delivery failed", error)
        offlineEvents.restore(pending.subList(index, pending.size))
        return false
      }
    }
    return true
  }

  private fun requireLayerPermitted(layer: PrototypeWindowLayer) =
    require(layer != PrototypeWindowLayer.APP || appLayerPermitted()) {
      "window.layer: app needs Android 8.0+ and SYSTEM_ALERT_WINDOW for $packageName, which is " +
        "not granted. Grant it with `adb shell appops set $packageName SYSTEM_ALERT_WINDOW " +
        "allow`, or omit window.layer to use the system layer."
    }

  /** Shared by dismiss_prototype and the dismiss action, under the controller mutex. */
  private suspend fun removeActive(): Boolean {
    if (!host.dismiss()) return false
    activeRuntime = null
    activeRequest = null
    foreground.release()
    lifecycle.cancel()
    notifyDetached()
    releaseAssets()
    return true
  }

  private suspend fun notifyDetached() {
    try {
      onDismissed()
    } catch (error: Exception) {
      // Removal succeeded; ancillary highlight cleanup must not suppress a terminal prototype
      // event.
      Log.w("PrototypeController", "Prototype highlight cleanup failed", error)
    }
  }

  /** Asset cleanup is ancillary: it must never suppress a dismissal, event or lifecycle step. */
  private fun releaseAssets() {
    try {
      clearAssets()
    } catch (error: Exception) {
      Log.w("PrototypeController", "Prototype asset cleanup failed", error)
    }
  }

  internal suspend fun interact(runtime: PrototypeRuntime, interaction: PrototypeInteraction) =
    mutex.withLock {
      if (destroyed || runtime !== activeRuntime) return@withLock
      try {
        // Compose reports its initial/restored settled page; that is rendering, not idle activity.
        if (
          interaction !is PrototypeInteraction.PagerMotion ||
            interaction.scrolling ||
            runtime.current.pages[interaction.pager] != interaction.page
        )
          armIdle(runtime)
        runtime.handle(interaction)
        if (runtime === activeRuntime && runtime.current.active) syncTextFieldFocus(runtime)
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w("PrototypeController", "Prototype interaction failed", error)
      }
    }

  /** [action] returns the referenced asset ids the device lacks, reported as a warning. */
  private suspend fun execute(requestId: String?, action: suspend () -> List<String>) =
    mutex.withLock {
      var missing = emptyList<String>()
      val error =
        try {
          check(!destroyed) { "Prototype host destroyed" }
          missing = action()
          null
        } catch (error: CancellationException) {
          throw error
        } catch (error: Exception) {
          Log.w("PrototypeController", "Prototype request failed", error)
          error.message ?: "Prototype request failed (${error.javaClass.simpleName})"
        }
      if (missing.isEmpty()) sink.send(requestId, error == null, error)
      else sink.sendWithMissingAssets(requestId, error == null, error, missing)
    }

  private fun armIdle(
    runtime: PrototypeRuntime,
    delayMillis: Long = lifecycle.ttlMillis,
    retriesLeft: Int = PROTOTYPE_DISMISS_MAX_RETRIES,
  ) {
    // A device-persistent prototype is a standalone mock with nobody to re-show it: never idle out.
    if (runtime.persistent) {
      lifecycle.cancel()
      return
    }
    lifecycle.arm(delayMillis) { token ->
      signal {
        if (runtime === activeRuntime && lifecycle.isCurrent(token)) {
          try {
            runtime.dismiss(PrototypeDismissReason.TTL)
          } catch (error: CancellationException) {
            throw error
          } catch (error: Exception) {
            // The one-shot expiry is spent; re-arm (bounded) so a failed removal is not final.
            if (retriesLeft > 0 && runtime === activeRuntime)
              armIdle(runtime, PROTOTYPE_DISMISS_RETRY_MILLIS, retriesLeft - 1)
            throw error
          }
        }
      }
    }
  }

  /** Ends [runtime] for a gone session; a failed removal is logged and retried by [signal]. */
  private suspend fun dismissForDisconnect(runtime: PrototypeRuntime) {
    try {
      runtime.dismiss(PrototypeDismissReason.DISCONNECT)
      disconnectPending = false
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      disconnectPending = runtime === activeRuntime
      Log.w("PrototypeController", "Prototype disconnect dismissal failed", error)
    }
  }

  /**
   * Answers `inspect_prototypes`: delivers any buffered events first, then reports the prototype
   * the device is showing, so a host that lost its status (a released session, a new daemon) can
   * adopt it again. The wire order is the events, then the single `prototype_result`.
   */
  suspend fun inspect(requestId: String?) = mutex.withLock {
    try {
      check(!destroyed) { "Prototype host destroyed" }
      // Reporting lastSequence while events are still held would make the host skip them as
      // duplicates on the next inspect, so an incomplete replay fails this inspect instead.
      check(replayOfflineEvents()) {
        "Buffered prototype events could not be delivered; the device kept them, retry inspect"
      }
      val prototypes = listOfNotNull(activeRuntime?.takeIf { it.current.active }?.let(::statusOf))
      sink.sendPrototypeStatus(requestId, prototypes, offlineEvents.dropped)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("PrototypeController", "Prototype inspect failed", error)
      sink.send(requestId, false, error.message ?: "Prototype inspect failed")
    }
  }

  private fun statusOf(runtime: PrototypeRuntime): PrototypeStatusEntry {
    val id = runtime.current.spec.id
    return PrototypeStatusEntry(
      id = id,
      persistent = runtime.persistent,
      state = runtime.current.state.toMap(),
      pages = runtime.current.pages.toMap(),
      lastSequence = sequences[id] ?: 0L,
      suspended = foreground.suspended,
    )
  }

  /**
   * A host connected: hand it the events a device-persistent prototype buffered while it was away.
   */
  suspend fun onClientConnected() =
    signal(retryDisconnect = false) {
      replayOfflineEvents()
    }

  /** Local override until a daemon/tool TTL field exists; no new protocol field is invented. */
  suspend fun setIdleTtlMillis(millis: Long) = mutex.withLock {
    lifecycle.ttlMillis = millis
    activeRuntime?.let { armIdle(it) }
  }

  suspend fun onClientCountChanged(count: Int, observerSession: Int? = null) =
    signal(retryDisconnect = false) {
      require(count >= 0) { "Client count must be nonnegative" }
      // A device-persistent prototype keeps running offline, and keeps the assets it draws.
      if (activeRuntime?.persistent == true) return@signal
      // A delayed disconnect from a previous observer session cannot dismiss a newly shown
      // prototype.
      if (count == 0 && (observerSession == null || observerSession == activeObserverSession))
        activeRuntime?.let { dismissForDisconnect(it) }
      // Assets outlive no client, shown or not; a stale disconnect must not drop a new session's.
      if (count == 0 && (observerSession == null || observerSession == lifecycle.observerSession()))
        releaseAssets()
    }

  /**
   * Rotation/density changes keep the same runtime and Compose tree; hiding retains authored state.
   * The prototype's own display going away dismisses it even when the caller does not know that.
   */
  suspend fun onConfigurationChanged(displayAvailable: Boolean = true) = signal {
    val runtime = activeRuntime ?: return@signal
    applyWindowDecision(runtime, displayAvailable && ownDisplayAvailable())
  }

  /**
   * A display callback. Only the prototype's own display matters: its removal dismisses with
   * `teardown` rather than moving the content to another display, and a change relayouts. Other
   * displays' transitions are not this prototype's business.
   */
  suspend fun onDisplayTransition(displayId: Int, removed: Boolean) = signal {
    val runtime = activeRuntime ?: return@signal
    if (displayId == shownDisplayId())
      applyWindowDecision(runtime, !removed && ownDisplayAvailable())
  }

  private fun ownDisplayAvailable(): Boolean =
    shownDisplayId() == Display.DEFAULT_DISPLAY || displays.isAvailable(shownDisplayId())

  private suspend fun applyWindowDecision(runtime: PrototypeRuntime, displayAvailable: Boolean) {
    when (prototypeWindowDecision(displayAvailable, lifecycle.isBlocked())) {
      PrototypeWindowDecision.DISMISS -> runtime.dismiss(PrototypeDismissReason.TEARDOWN)
      PrototypeWindowDecision.HIDE -> {
        check(host.dismiss()) { "Prototype host failed to hide window" }
        notifyDetached()
      }
      PrototypeWindowDecision.RELAYOUT -> relayoutOrRestore(runtime)
    }
  }

  /**
   * A window the platform reports detached is cleared by the host, so a failed relayout with
   * nothing showing means the prototype vanished underneath us: re-show the authored request. If
   * the window cannot come back the runtime ends once, as teardown, instead of lingering
   * windowless.
   */
  private suspend fun relayoutOrRestore(runtime: PrototypeRuntime) {
    val request = checkNotNull(activeRequest)
    if (host.isShowing) {
      if (host.relayout()) {
        if (!host.isShowing) notifyDetached() // The host hid it: a lock arrived mid-signal.
        return
      }
      // Still attached: a retryable platform failure, so keep the window and runtime as they are.
      check(!host.isShowing) { "Prototype host failed to re-layout window" }
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
  private suspend fun restoreWindow(request: PrototypeRequest): Boolean =
    try {
      host.show(request)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("PrototypeController", "Prototype window could not be restored", error)
      false
    }

  /**
   * The window may hold input focus only while a text field is visible in the CURRENT tree, so a
   * page swipe, tab change or sheet open/close can flip it; otherwise Back and key input to the app
   * behind would be swallowed. A failed flip keeps the old request and is retried on the next
   * change.
   */
  private suspend fun syncTextFieldFocus(runtime: PrototypeRuntime) {
    val request = activeRequest ?: return
    val visible = mapPrototypeSpec(runtime.current.spec, runtime.current.pages).hasTextField
    if (visible == request.hasTextField) return
    // A window cleared as detached is restored from activeRequest, so record the change for it.
    if (host.setTextFieldVisible(visible) || !host.isShowing)
      activeRequest = request.copy(hasTextField = visible)
    else Log.w("PrototypeController", "Prototype host failed to update window focusability")
  }

  /** Terminal teardown for a window that cannot be shown again: exactly one `dismissed` event. */
  private suspend fun abandon(runtime: PrototypeRuntime) {
    activeRuntime = null
    activeRequest = null
    foreground.release()
    lifecycle.cancel()
    notifyDetached()
    releaseAssets()
    runtime.finishDismissal(PrototypeDismissReason.TEARDOWN)
  }

  /**
   * Service unbind: ends the active prototype as teardown but keeps the controller reusable,
   * because Android can rebind the same service instance before onDestroy. Failed removal stays
   * retryable.
   */
  suspend fun dismissForUnbind() = signal {
    releaseAssets()
    val runtime = activeRuntime
    if (runtime != null) runtime.dismiss(PrototypeDismissReason.TEARDOWN)
    else if (host.isShowing) {
      check(host.dismiss()) { "Prototype host failed to dismiss window" }
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
        Log.w("PrototypeController", "Prototype lifecycle signal failed", error)
      }
    }

  /** Run from a teardown scope independent of the cancelled service scope; no blocking join. */
  suspend fun destroy() = mutex.withLock {
    destroyed = true
    lifecycle.cancel()
    try {
      if (host.destroy()) notifyDetached()
      else Log.w("PrototypeController", "Prototype host failed to destroy window")
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("PrototypeController", "Prototype teardown failed", error)
    } finally {
      val runtime = activeRuntime
      activeRuntime = null
      activeRequest = null
      foreground.release()
      releaseAssets()
      // Allocate the terminal sequence even when the last socket or service sink is gone.
      try {
        runtime?.finishDismissal(PrototypeDismissReason.TEARDOWN)
      } catch (error: Exception) {
        // Teardown is best effort once the sink has shut down; the runtime is already terminal.
        Log.w("PrototypeController", "Prototype teardown event delivery failed", error)
      }
    }
  }
}
