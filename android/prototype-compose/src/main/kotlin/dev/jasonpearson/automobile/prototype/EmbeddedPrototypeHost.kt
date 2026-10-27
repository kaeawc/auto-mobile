package dev.jasonpearson.automobile.prototype

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeEventSink
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeInteraction
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeStorageSessionRegistry
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * AutoMobile host wiring, configured before composition. The host owns stop, replacement and
 * destroy: it serializes flushing/replacement under [interactions] and closes the runtime handed to
 * [onRuntime] on destroy. This keeps its outliving flush scope and replacement ordering outside the
 * stable embedding API.
 */
@InternalAutoMobilePrototypeApi
class EmbeddedPrototypeHost(
  val scope: CoroutineScope,
  val interactions: Mutex,
  val io: CoroutineDispatcher = Dispatchers.IO,
) {
  var clock: () -> Long = System::currentTimeMillis
  var nextSequence: ((String) -> Long)? = null
  var storageRegistry: PrototypeStorageSessionRegistry? = null
  var flushScope: CoroutineScope = scope
  /**
   * Optional awaited delivery for hosts with a suspending sink; [AutoMobilePrototype]'s callback
   * remains a synchronous observer.
   */
  var eventSink: PrototypeEventSink? = null
  var requestDismiss: suspend () -> Boolean = { true }
  /**
   * Checked under the interaction lock before opening, including a queued, obsolete composition.
   */
  var isCurrent: () -> Boolean = { true }
  var onRuntime: (PrototypeRuntime) -> Unit = {}
  /** Called only after runtime content successfully composes, never while storage/fonts load. */
  var onReady: () -> Unit = {}
  var onInteraction: suspend (PrototypeInteraction, PrototypeRuntime) -> Unit =
    { interaction, runtime ->
      interactions.withLock { runtime.handle(interaction) }
    }
}

/** Provides AutoMobile-owned lifecycle and ordering seams without adding stable parameters. */
@InternalAutoMobilePrototypeApi
@Composable
fun ProvideEmbeddedPrototypeHost(host: EmbeddedPrototypeHost, content: @Composable () -> Unit) {
  val environment =
    remember(host) {
      EmbeddedPrototypeEnvironment(
        io = host.io,
        clock = host.clock,
        scope = host.scope,
        host = host,
      )
    }
  CompositionLocalProvider(
    LocalEmbeddedPrototypeEnvironment provides environment,
    content = content,
  )
}
