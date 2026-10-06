package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.util.Log
import dev.jasonpearson.automobile.protocol.OverlayScalar
import dev.jasonpearson.automobile.protocol.OverlaySpec
import dev.jasonpearson.automobile.protocol.OverlaySpecValidation
import dev.jasonpearson.automobile.protocol.OverlaySpecValidator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

fun interface OverlayResultSink {
  suspend fun send(requestId: String?, success: Boolean, error: String?)
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

  suspend fun show(requestId: String?, spec: OverlaySpec) =
    execute(requestId) {
      display(spec, replace = activeRuntime != null)
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
      if (spec != null) display(spec, replace = true, preservePages = true)
      else {
        val patched =
          validate(checkNotNull(current).copy(state = current.state.orEmpty() + state.orEmpty()))
        render(patched) // Validate Compose sizes too, before mutating the live runtime.
        activeRuntime?.replace(patched)
        activeRuntime?.let { armIdle(it) }
      }
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
      }
    }

  private fun validate(spec: OverlaySpec): OverlaySpec {
    guardOverlayTree(spec.root)
    return when (val validation = OverlaySpecValidator.validate(json.encodeToString(spec))) {
      is OverlaySpecValidation.Failure ->
        error("${validation.error.path}: ${validation.error.message}")
      is OverlaySpecValidation.Success -> validation.spec
    }
  }

  private suspend fun display(spec: OverlaySpec, replace: Boolean, preservePages: Boolean = false) {
    val validated = validate(spec)
    val request = render(validated)
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
        onHostDismiss = { interact(runtime, OverlayInteraction.HostDismiss) },
        content = {
          OverlayRuntimeContent(runtime) { interaction -> interact(runtime, interaction) }
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
    if (lifecycle.clientCount() == 0) dismissForDisconnect(runtime)
  }

  /** Shared by dismiss_overlay and the dismiss action, under the controller mutex. */
  private suspend fun removeActive(): Boolean {
    if (!host.dismiss()) return false
    activeRuntime = null
    activeRequest = null
    lifecycle.cancel()
    notifyDetached()
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
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w("OverlayController", "Overlay interaction failed", error)
      }
    }

  private suspend fun execute(requestId: String?, action: suspend () -> Unit) = mutex.withLock {
    val error =
      try {
        check(!destroyed) { "Overlay host destroyed" }
        action()
        null
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w("OverlayController", "Overlay request failed", error)
        error.message ?: "Overlay request failed (${error.javaClass.simpleName})"
      }
    sink.send(requestId, error == null, error)
  }

  private fun armIdle(
    runtime: OverlayRuntime,
    delayMillis: Long = lifecycle.ttlMillis,
    retriesLeft: Int = OVERLAY_DISMISS_MAX_RETRIES,
  ) {
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
      // A delayed disconnect from a previous observer session cannot dismiss a newly shown overlay.
      if (count == 0 && (observerSession == null || observerSession == activeObserverSession))
        activeRuntime?.let { dismissForDisconnect(it) }
    }

  /**
   * Rotation/density changes keep the same runtime and Compose tree; hiding retains authored state.
   */
  suspend fun onConfigurationChanged(displayAvailable: Boolean = true) = signal {
    val runtime = activeRuntime ?: return@signal
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
    if (host.show(request)) return
    if (lifecycle.isBlocked()) notifyDetached() // Locked meanwhile: hidden, restored on unlock.
    else abandon(runtime)
  }

  /** Terminal teardown for a window that cannot be shown again: exactly one `dismissed` event. */
  private suspend fun abandon(runtime: OverlayRuntime) {
    activeRuntime = null
    activeRequest = null
    lifecycle.cancel()
    notifyDetached()
    runtime.finishDismissal(OverlayDismissReason.TEARDOWN)
  }

  /**
   * Service unbind: ends the active overlay as teardown but keeps the controller reusable, because
   * Android can rebind the same service instance before onDestroy. Failed removal stays retryable.
   */
  suspend fun dismissForUnbind() = signal {
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
