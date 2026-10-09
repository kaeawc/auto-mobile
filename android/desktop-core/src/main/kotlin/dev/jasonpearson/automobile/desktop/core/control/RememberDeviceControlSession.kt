package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopInputAllocation
import dev.jasonpearson.automobile.desktop.core.daemon.inputAllocatingClient
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers

/**
 * The host's ONE [DeviceControlSession] and the wiring that makes its input active tool use
 * (#10730): every client it mints per input is the current [clientProvider]'s client wrapped by
 * [inputAllocatingClient], so a tap, swipe, key or text first allocates its device to the desktop
 * session. Kept as its own composable so a composition test can pin that wiring (#10975): a call
 * site that handed the raw provider to the session would compile and pass every unit test of
 * [inputAllocatingClient].
 *
 * The provider swaps behind the session (a daemon reconnect) and [LaunchedEffect] resets the
 * session on each swap, dropping everything captured against the previous provider.
 */
@Composable
internal fun rememberDeviceControlSession(
  scope: CoroutineScope,
  clientProvider: (() -> AutoMobileClient)?,
  inputAllocation: () -> DesktopInputAllocation,
  platform: () -> String,
  nowMs: () -> Long,
  publishError: (String?) -> Unit,
  streamingEnabled: Boolean,
  uiContext: CoroutineContext = Dispatchers.Main,
  ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
): DeviceControlSession {
  val currentProvider by rememberUpdatedState(clientProvider)
  val currentAllocation by rememberUpdatedState(inputAllocation)
  val session =
    remember(scope) {
      DeviceControlSession(
        scope = scope,
        clientProvider = { inputAllocatingClient(currentProvider) { currentAllocation() } },
        platform = platform,
        nowMs = nowMs,
        publishError = publishError,
        uiContext = uiContext,
        ioDispatcher = ioDispatcher,
        streamingEnabled = streamingEnabled,
      )
    }
  LaunchedEffect(clientProvider) { session.reset() }
  return session
}
