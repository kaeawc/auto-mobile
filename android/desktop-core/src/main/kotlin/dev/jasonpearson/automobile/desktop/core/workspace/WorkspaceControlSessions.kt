package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.MONOTONIC_NOW_MS
import dev.jasonpearson.automobile.desktop.core.control.DeviceControlSession
import dev.jasonpearson.automobile.desktop.core.control.DeviceControlSessionOptions
import dev.jasonpearson.automobile.desktop.core.control.GestureStreamingConfig

@Composable
internal fun rememberWorkspaceInput(
  options: WorkspaceDeviceControlOptions,
  scope: kotlinx.coroutines.CoroutineScope,
  tracer: InteractionLatencyTracer,
): VideoInputDispatcher {
  return with(options) {
    val provider by rememberUpdatedState(clientProvider)
    val heldElsewhereSink by rememberUpdatedState(onDeviceHeldElsewhere)
    val dispatcher =
      remember(scope, column.deviceId) {
        VideoInputDispatcher(
          scope = scope,
          clientProvider = { provider.invoke() },
          platform = { column.platform.wireName() },
          deviceId = column.deviceId,
          tracer = tracer,
          options =
            VideoInputOptions(
              streamingEnabled = GestureStreamingConfig.enabled,
              onDeviceHeldElsewhere = { heldElsewhereSink(column.deviceId) },
            ),
        )
      }

    dispatcher
  }
}

@Composable
internal fun rememberWorkspaceGeometrySession(
  options: WorkspaceDeviceControlOptions,
  scope: kotlinx.coroutines.CoroutineScope,
  publishError: (String?) -> Unit,
): DeviceControlSession {
  return with(options) {
    val controlClientProvider by rememberUpdatedState(clientProvider)
    val session =
      remember(scope, column.deviceId) {
        DeviceControlSession(
          DeviceControlSessionOptions(
            scope = scope,
            clientProvider = { controlClientProvider.invoke() },
            platform = { column.platform.wireName() },
            nowMs = MONOTONIC_NOW_MS,
            publishError = publishError,
          ),
        )
      }

    session
  }
}
