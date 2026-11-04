package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.ObservationReconnectPolicy
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.keepObservationConnected
import kotlinx.coroutines.CoroutineScope

internal suspend fun CoroutineScope.reconnectObservationStream(
  s: ObservationStream,
  options: ReconnectingObservationOptions,
  onConnected: () -> Unit,
) {
  keepObservationConnected(
    s,
    ObservationReconnectPolicy(options.backoffDelay, options.socketAvailable),
  ) {
    s.connect(deviceId = options.deviceId, deviceSessionUuid = options.deviceSessionUuid)
    onConnected()
  }
}
