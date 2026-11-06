package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import kotlinx.coroutines.flow.Flow

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
