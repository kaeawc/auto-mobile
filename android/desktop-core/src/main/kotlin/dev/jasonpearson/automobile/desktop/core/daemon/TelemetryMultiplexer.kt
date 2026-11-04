package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/** One device's held subscription on a [TelemetryMultiplexer]. */
interface TelemetrySubscription : AutoCloseable {
  /** This subscription's own health: one device's rejection never changes another's. */
  val state: Flow<ConnectionState>

  /** Subscribe again now if this subscription failed or stopped; a no-op while it is live. */
  fun retry()

  /** Release the subscription; closing twice is a no-op. */
  override fun close()
}

/**
 * Carries device-scoped telemetry subscriptions for the [SharedDaemonStreamHub]. Each subscription
 * names one device, so the daemon backfills that device's own history, and delivers only its events
 * to its sink. The sink must not block.
 */
interface TelemetryMultiplexer {
  fun subscribe(key: DeviceStreamKey, sink: (TelemetryDisplayEvent) -> Unit): TelemetrySubscription

  /** Release every subscription and connection. */
  fun close()
}

/**
 * A [TelemetryMultiplexer] that gives each subscription its own [TelemetryPushClient] from
 * [clientFactory]. The desktop uses [MultiplexedTelemetrySocketClient] instead; this keeps hosts
 * and tests built on the per-connection client contract working.
 */
class PerConnectionTelemetryMultiplexer(
  private val clientFactory: () -> TelemetryPushClient,
  private val scope: CoroutineScope,
) : TelemetryMultiplexer {
  private class Subscription(
    val client: TelemetryPushClient,
    val forwarding: Job,
  ) : TelemetrySubscription {
    override val state: Flow<ConnectionState> = client.connectionState

    override fun retry() {
      if (!client.isConnected()) client.reconnect()
    }

    override fun close() {
      forwarding.cancel()
      client.dispose()
    }
  }

  override fun subscribe(
    key: DeviceStreamKey,
    sink: (TelemetryDisplayEvent) -> Unit,
  ): TelemetrySubscription {
    val client = clientFactory()
    val forwarding = scope.launch { client.telemetryEvents.collect(sink) }
    client.connect(deviceId = key.deviceId, deviceSessionUuid = key.deviceSessionUuid)
    return Subscription(client, forwarding)
  }

  override fun close() = Unit
}
