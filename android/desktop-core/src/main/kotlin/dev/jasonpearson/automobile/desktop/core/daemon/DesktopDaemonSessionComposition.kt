package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
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
  val isRegistered: Boolean = false,
) {
  val sessionUuidProvider: () -> String?
    get() = session?.sessionUuidProvider ?: { null }
}

/** Owns the Compose-lifetime daemon session, binding, heartbeat recovery, and release. */
@Composable
fun rememberDesktopDaemonSession(
  socketPath: String?,
  binding: MutableState<DesktopDaemonSessionBinding?>,
  sessionFactory: (String) -> DesktopDaemonSession = { DesktopDaemonSession.create(it) },
  ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  onDaemonRecovered: suspend () -> Boolean = { true },
): DesktopDaemonSessionState {
  val session =
    remember(socketPath) {
      socketPath?.let {
        runCatching { sessionFactory(it) }
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
    if (session == null) {
      boundDeviceId = target?.deviceId
      return@LaunchedEffect
    }

    var refreshAfterRecovery = false
    var failureLogged = false
    // The daemon acknowledged this effect's binding (#10237). A healthy heartbeat cycle sends only
    // `daemon/heartbeat`; the binding is re-sent when a send failed or the heartbeat lapsed (a
    // daemon restart loses it). A changed binding restarts this effect, so it starts unbound.
    var bindingAcknowledged = false
    while (isActive && bindingGeneration.get() == generation) {
      val registered = runCatching {
        bindingMutex.withLock {
          if (bindingGeneration.get() != generation) return@LaunchedEffect
          withContext(ioDispatcher) {
            if (target == null) {
              session.ensureRegistered()
            } else if (!bindingAcknowledged) {
              bindingAcknowledged =
                session.client.setActiveDevice(target.deviceId, target.platform).success
              session.deviceBound()
            }
          }
        }
      }
        .onFailure { error ->
          if (error is CancellationException) throw error
          if (!failureLogged) {
            LOG.warn("Failed to register desktop session: ${error.message}")
            failureLogged = true
          }
        }
        .isSuccess
      if (bindingGeneration.get() != generation) return@LaunchedEffect
      if (!registered) {
        delay(HEARTBEAT_INTERVAL_MS)
        continue
      }

      failureLogged = false
      boundDeviceId = target?.deviceId
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
        withContext(ioDispatcher) { session.heartbeat() }
      }
        .onFailure { error ->
          if (error is CancellationException) throw error
          LOG.warn("Desktop daemon session lapsed, re-registering: ${error.message}")
        }
        .isSuccess
      if (!alive) {
        refreshAfterRecovery = true
        bindingAcknowledged = false
        boundDeviceId = null
      }
    }
  }

  val registered = session?.isRegistered?.collectAsState()?.value ?: false
  return DesktopDaemonSessionState(
    session = session,
    boundDeviceId = boundDeviceId,
    isRegistered = registered,
  )
}
