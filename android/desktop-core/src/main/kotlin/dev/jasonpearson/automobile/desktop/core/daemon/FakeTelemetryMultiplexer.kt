package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Fake [TelemetryMultiplexer] for hub tests: records every subscription, lets a test push events to
 * one device's live subscription and drive that subscription's state.
 */
class FakeTelemetryMultiplexer : TelemetryMultiplexer {
  /** One recorded subscription. A new subscription starts subscribed. */
  inner class Subscription(
    val key: DeviceStreamKey,
    private val sink: (TelemetryDisplayEvent) -> Unit,
  ) : TelemetrySubscription {
    private val mutableState =
      MutableStateFlow<ConnectionState>(ConnectionState.Connected(subscribed = true))
    override val state: StateFlow<ConnectionState> = mutableState.asStateFlow()

    @Volatile
    var retryCount = 0
      private set

    @Volatile
    var closed = false
      private set

    /** True when its owner closed it before the multiplexer itself was closed. */
    @Volatile
    var released = false
      private set

    /** Deliver [event] as the daemon would on this subscription; dropped once it is closed. */
    fun emit(event: TelemetryDisplayEvent) {
      if (!closed) sink(event)
    }

    fun setState(state: ConnectionState) {
      mutableState.value = state
    }

    /** A no-op once closed, as the real subscription ignores a retry after its release. */
    override fun retry() {
      if (closed) return
      retryCount++
      mutableState.value = ConnectionState.Connected(subscribed = true)
    }

    override fun close() {
      if (closed) return
      released = !this@FakeTelemetryMultiplexer.closed
      closed = true
      mutableState.value = ConnectionState.Disconnected(null)
    }
  }

  private val recorded = mutableListOf<Subscription>()

  /** Every subscription ever made, oldest first. */
  val subscriptions: List<Subscription>
    get() = synchronized(recorded) { recorded.toList() }

  @Volatile
  var closed = false
    private set

  /** [key]'s single live subscription. */
  fun subscriptionFor(key: DeviceStreamKey): Subscription = subscriptions.single {
    it.key == key && !it.closed
  }

  override fun subscribe(
    key: DeviceStreamKey,
    sink: (TelemetryDisplayEvent) -> Unit,
  ): TelemetrySubscription =
    Subscription(key, sink).also { synchronized(recorded) { recorded += it } }

  /** Closes the multiplexer and, as the real one does, every subscription still open. */
  override fun close() {
    closed = true
    subscriptions.forEach { it.close() }
  }
}
