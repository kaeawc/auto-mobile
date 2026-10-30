package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformCalls
import dev.jasonpearson.automobile.prototype.PlatformAvailability
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformError
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PlatformEvent
import dev.jasonpearson.automobile.prototype.PrototypePlatformModule
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Transports of the default network, named as the contract names them. */
enum class ConnectivityTransport(val wireValue: String) {
  VPN("vpn"),
  WIFI("wifi"),
  CELLULAR("cellular"),
  ETHERNET("ethernet"),
}

/** One reading of the default network's capabilities. */
data class ConnectivityNetwork(
  val validated: Boolean,
  val notMetered: Boolean,
  val transports: Set<ConnectivityTransport>,
)

/** Maps a default-network reading to `/platform/connectivity` (#14273). */
object PrototypeConnectivityState {
  /**
   * No default network is offline on `none`. A VPN is reported over the transport it rides on,
   * since the VPN is the default network an app's traffic uses. `constrained` is Data Saver, which
   * only restricts metered networks.
   */
  fun of(network: ConnectivityNetwork?, dataSaver: Boolean): JsonObject = buildJsonObject {
    put("online", network?.validated == true)
    put("transport", transport(network))
    val metered = network != null && !network.notMetered
    put("metered", metered)
    put("constrained", metered && dataSaver)
  }

  private fun transport(network: ConnectivityNetwork?): String =
    when {
      network == null -> "none"
      else ->
        ConnectivityTransport.entries.firstOrNull { it in network.transports }?.wireValue ?: "other"
    }
}

/** Live connectivity state; the Android source feeds it from ConnectivityManager callbacks. */
interface PrototypeConnectivitySource {
  val state: StateFlow<JsonObject>

  fun close()
}

/** Keeps the latest network and Data Saver readings; callbacks may arrive on any thread. */
class ConnectivityTracker(network: ConnectivityNetwork? = null, dataSaver: Boolean = false) {
  private var network = network
  private var dataSaver = dataSaver
  private val mutableState = MutableStateFlow(PrototypeConnectivityState.of(network, dataSaver))
  val state: StateFlow<JsonObject> = mutableState.asStateFlow()

  fun onNetwork(next: ConnectivityNetwork?) =
    synchronized(this) {
      network = next
      publish()
    }

  fun onDataSaver(enabled: Boolean) =
    synchronized(this) {
      dataSaver = enabled
      publish()
    }

  private fun publish() {
    mutableState.value = PrototypeConnectivityState.of(network, dataSaver)
  }
}

/**
 * The `connectivity` module: state only, plus a trailing `connectivity.changed` event once the
 * state has been quiet for the contract's debounce. A flap that settles back on the last delivered
 * state is not an event.
 */
class PrototypeConnectivityModule(
  private val source: PrototypeConnectivitySource,
  private val debounceMs: Long = checkNotNull(PrototypePlatformCalls.eventDebounceMs(CHANGED)),
) : PrototypePlatformModule {
  override val name = "connectivity"
  override val capability = "prototype_platform_connectivity_v1"
  // Read through, so a source that starts on first read is not started by registration alone.
  override val state: StateFlow<JsonObject>
    get() = source.state

  @OptIn(FlowPreview::class)
  override val events: Flow<PlatformEvent> = flow {
    var delivered = source.state.value
    source.state.debounce(debounceMs).collect { value ->
      if (value != delivered) {
        delivered = value
        emit(PlatformEvent(CHANGED, value))
      }
    }
  }

  override fun availability() = PlatformAvailability.Ready

  override suspend fun call(call: PlatformCall): PlatformCallResult =
    PlatformCallResult.Failure(
      PlatformError(PlatformErrorCode.UNSUPPORTED, "The connectivity module has no calls"),
    )

  override fun close() = source.close()

  companion object {
    const val CHANGED = "connectivity.changed"
  }
}
