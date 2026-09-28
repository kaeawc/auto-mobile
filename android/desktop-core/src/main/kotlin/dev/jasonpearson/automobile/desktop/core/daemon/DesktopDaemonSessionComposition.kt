package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("DesktopDaemonSessionComposition")
private const val HEARTBEAT_INTERVAL_MS = 2_000L

data class DesktopDaemonSessionBinding(val deviceId: String, val platform: String)

data class DesktopDaemonSessionState(
  val session: DesktopDaemonSession?,
  val boundDeviceId: String?,
) {
  val sessionUuidProvider: () -> String?
    get() = session?.sessionUuidProvider ?: { null }
}

/** Owns the Compose-lifetime daemon session, binding, heartbeat recovery, and release. */
@Composable
fun rememberDesktopDaemonSession(
  socketPath: String?,
  binding: MutableState<DesktopDaemonSessionBinding?>,
  onDaemonRecovered: suspend () -> Boolean = { true },
): DesktopDaemonSessionState {
  val session =
    remember(socketPath) {
      socketPath?.let {
        runCatching { DesktopDaemonSession.create(it) }
          .onFailure { error ->
            LOG.warn("Could not create desktop daemon session: ${error.message}")
          }
          .getOrNull()
      }
    }
  var boundDeviceId by remember(session) { mutableStateOf<String?>(null) }
  val bindingMutex = remember(session) { Mutex() }
  val bindingGeneration = remember(session) { AtomicLong(0L) }

  DisposableEffect(session) {
    val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    onDispose {
      if (session != null) {
        cleanupScope.launch {
          runCatching { session.release() }
            .onFailure { error ->
              LOG.warn("Failed to release desktop daemon session: ${error.message}")
            }
          cleanupScope.cancel()
        }
      } else {
        cleanupScope.cancel()
      }
    }
  }

  LaunchedEffect(session, binding.value) {
    val generation = bindingGeneration.incrementAndGet()
    val target = binding.value
    boundDeviceId = null
    if (target == null) return@LaunchedEffect
    if (session == null) {
      boundDeviceId = target.deviceId
      return@LaunchedEffect
    }

    var refreshAfterRecovery = false
    while (isActive && bindingGeneration.get() == generation) {
      val registered = runCatching {
        bindingMutex.withLock {
          if (bindingGeneration.get() != generation) return@LaunchedEffect
          withContext(Dispatchers.IO) {
            session.client.setActiveDevice(target.deviceId, target.platform)
          }
        }
      }
        .onFailure { error ->
          LOG.warn("Failed to bind desktop session to ${target.deviceId}: ${error.message}")
        }
        .isSuccess
      if (bindingGeneration.get() != generation) return@LaunchedEffect
      if (!registered) {
        delay(HEARTBEAT_INTERVAL_MS)
        continue
      }

      boundDeviceId = target.deviceId
      if (refreshAfterRecovery) {
        refreshAfterRecovery =
          !runCatching { onDaemonRecovered() }
            .onFailure { error ->
              LOG.warn("Failed to refresh state after daemon recovery: ${error.message}")
            }
            .getOrDefault(false)
      }
      val alive = runCatching {
        delay(HEARTBEAT_INTERVAL_MS)
        withContext(Dispatchers.IO) { session.heartbeat() }
      }
        .onFailure { error ->
          LOG.warn("Desktop daemon session lapsed, re-registering: ${error.message}")
        }
        .isSuccess
      if (!alive) {
        refreshAfterRecovery = true
        boundDeviceId = null
      }
    }
  }

  return DesktopDaemonSessionState(session = session, boundDeviceId = boundDeviceId)
}
