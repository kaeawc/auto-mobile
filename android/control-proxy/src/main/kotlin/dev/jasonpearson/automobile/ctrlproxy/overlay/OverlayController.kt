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
      }
    }

  suspend fun dismiss(requestId: String?, id: String?, all: Boolean?) =
    execute(requestId) {
      require(all == true || (id != null && activeRuntime?.current?.spec?.id == id)) {
        "Unknown overlay id: $id"
      }
      val runtime = activeRuntime
      if (runtime != null) runtime.dismiss()
      else {
        check(host.dismiss()) { "Overlay host failed to dismiss window" }
        onDismissed()
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
        content = {
          OverlayRuntimeContent(runtime) { interaction -> interact(runtime, interaction) }
        }
      )
    check(if (replace) host.replace(interactive) else host.show(interactive)) {
      "Overlay host failed to render window"
    }
    previous?.close()
    activeRuntime = runtime
  }

  /** Shared by dismiss_overlay and the dismiss action, under the controller mutex. */
  private suspend fun removeActive(): Boolean {
    if (!host.dismiss()) return false
    activeRuntime = null
    onDismissed()
    return true
  }

  internal suspend fun interact(runtime: OverlayRuntime, interaction: OverlayInteraction) =
    mutex.withLock {
      if (destroyed || runtime !== activeRuntime) return@withLock
      try {
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

  /** Run from a teardown scope independent of the cancelled service scope; no blocking join. */
  suspend fun destroy() = mutex.withLock {
    destroyed = true
    activeRuntime?.close()
    try {
      if (host.destroy()) {
        activeRuntime = null
        onDismissed()
      } else Log.w("OverlayController", "Overlay host failed to destroy window")
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("OverlayController", "Overlay teardown failed", error)
    }
  }
}
