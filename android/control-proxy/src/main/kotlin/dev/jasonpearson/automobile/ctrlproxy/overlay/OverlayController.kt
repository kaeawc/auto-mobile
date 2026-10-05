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
  private val render: (OverlaySpec) -> InteractiveOverlayRequest = { mapOverlaySpec(it).request() },
) {
  val isShowing: Boolean
    get() = host.isShowing

  private val mutex = Mutex()
  private var active: OverlaySpec? = null
  private var destroyed = false
  // Match WebSocketServer.protocolJson; default-valued optional fields are omitted, not null.
  private val json = Json {
    prettyPrint = false
    ignoreUnknownKeys = true
    classDiscriminator = "type"
  }

  suspend fun show(requestId: String?, spec: OverlaySpec) =
    execute(requestId) {
      display(spec, replace = active != null)
    }

  suspend fun update(
    requestId: String?,
    id: String,
    spec: OverlaySpec?,
    state: Map<String, OverlayScalar>?,
  ) =
    execute(requestId) {
      val current = active
      require(current?.id == id) { "Unknown overlay id: $id" }
      require((spec == null) != (state == null)) { "Exactly one of spec or state is required" }
      require(spec == null || spec.id == id) { "spec.id: Must match overlay id $id" }
      display(
        spec ?: checkNotNull(current).copy(state = current.state.orEmpty() + state.orEmpty()),
        replace = true,
      )
    }

  suspend fun dismiss(requestId: String?, id: String?, all: Boolean?) =
    execute(requestId) {
      require(all == true || (id != null && active?.id == id)) { "Unknown overlay id: $id" }
      check(host.dismiss()) { "Overlay host failed to dismiss window" }
      active = null
      onDismissed()
    }

  private suspend fun display(spec: OverlaySpec, replace: Boolean) {
    // Guard before serialization too: programmatically constructed trees cannot overflow the
    // encoder.
    guardOverlayTree(spec.root)
    when (val validation = OverlaySpecValidator.validate(json.encodeToString(spec))) {
      is OverlaySpecValidation.Failure ->
        error("${validation.error.path}: ${validation.error.message}")
      is OverlaySpecValidation.Success -> {
        val request = render(validation.spec)
        check(if (replace) host.replace(request) else host.show(request)) {
          "Overlay host failed to render window"
        }
        active = validation.spec
      }
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
    try {
      if (host.destroy()) {
        active = null
        onDismissed()
      } else Log.w("OverlayController", "Overlay host failed to destroy window")
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("OverlayController", "Overlay teardown failed", error)
    }
  }
}
