package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * Identity of one observed device on the [DaemonStreamHub]. [deviceSessionUuid] is the routing key
 * when known: a rebooted device that reuses its serial is a new epoch and a new key. [deviceId] is
 * the display label and the fallback for events the daemon could not stamp with an epoch.
 */
data class DeviceStreamKey(val deviceId: String, val deviceSessionUuid: String? = null) {
  /** Whether an event attributed to [eventDeviceId]/[eventDeviceSessionUuid] belongs here. */
  fun matches(eventDeviceId: String?, eventDeviceSessionUuid: String?): Boolean =
    if (deviceSessionUuid != null && eventDeviceSessionUuid != null) {
      deviceSessionUuid == eventDeviceSessionUuid
    } else {
      eventDeviceId != null && eventDeviceId == deviceId
    }
}

/** Whether this event was produced by [key]'s device epoch. */
internal fun TelemetryDisplayEvent.belongsTo(key: DeviceStreamKey): Boolean =
  key.matches(deviceId, deviceSessionUuid)

/** A held hub subscription. Closing it releases the reference; closing twice is a no-op. */
fun interface StreamLease : AutoCloseable {
  override fun close()
}

/**
 * The desktop's shared, per-process owner of daemon streams (#5262). Facets ask the hub for a
 * device's stream instead of opening their own socket: the hub keeps one long-lived connection per
 * stream kind, ref-counts subscriptions per [DeviceStreamKey] as facets mount and unmount, and
 * demultiplexes events to each device. The connection opens on the first subscription and closes
 * when the last one is released.
 */
interface DaemonStreamHub {
  /**
   * Subscribe [sink] to [key]'s telemetry. Events already buffered on the shared connection for
   * that device are delivered first. [sink] runs under the hub's routing lock and must not block.
   */
  fun subscribeTelemetry(key: DeviceStreamKey, sink: (TelemetryDisplayEvent) -> Unit): StreamLease

  /** [key]'s telemetry as a cold flow; collecting holds a subscription until cancelled. */
  fun telemetry(key: DeviceStreamKey): Flow<TelemetryDisplayEvent>

  /**
   * A per-device [TelemetryPushClient] view for consumers built on that contract (the Logs panel):
   * `connect` takes a subscription, `disconnect`/`dispose` release it, and its `telemetryEvents`
   * carry only [key]'s events.
   */
  fun telemetryClient(key: DeviceStreamKey): TelemetryPushClient

  /** State of the shared telemetry connection. */
  val telemetryConnectionState: StateFlow<ConnectionState>

  /** Live subscription count per device; a key leaves the map when its last lease is released. */
  val subscriptions: StateFlow<Map<DeviceStreamKey, Int>>

  /** Ask a failed or stopped shared connection to reconnect; no-op without subscribers. */
  fun retry()

  /** Release every connection. The hub must not be used afterwards. */
  fun close()
}
