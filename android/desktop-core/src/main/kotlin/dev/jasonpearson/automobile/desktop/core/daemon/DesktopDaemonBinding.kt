package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal data class DesktopBindingContext(
  val options: DesktopDaemonSessionOptions,
  val state: DesktopDaemonCompositionState,
  val session: DesktopDaemonSession,
  val target: DesktopDaemonSessionBinding?,
  val bindingMutex: Mutex,
  val bindingGeneration: AtomicLong,
  val generation: Long,
)

/**
 * Per-effect bind retries and heartbeat recovery; discarded whenever its target/session changes.
 */
internal class DesktopDaemonBinding(private val context: DesktopBindingContext) {
  private val options = context.options
  private val state = context.state
  private val session = context.session
  private val target = context.target
  private val carried = state.carriedBindError?.takeIf { it.first == target?.deviceId }
  private var refreshAfterRecovery = state.pendingRecoveryRefresh.getAndSet(false)
  private var failureLogged = false
  private var bindingAcknowledged = false
  private var failedBinds = if (carried != null) MAX_BIND_ATTEMPTS else 0
  private var ticksWithBindError = 0
  private var bindErrorRetries = 0
  private var bindErrorWaitTicks = -1
  private var rotateSession = false
  private var lastHeartbeatOkAtMs = options.monotonicClockMs()

  suspend fun run() {
    state.carriedBindError = null
    if (carried != null) {
      state.bindErrorMessage = carried.second
      state.bindErrorDeviceId = carried.first
    }
    while (
      currentCoroutineContext().isActive && context.bindingGeneration.get() == context.generation
    ) {
      val registered = register()
      if (context.bindingGeneration.get() != context.generation) return
      if (rotateSession) {
        state.sessionEpoch++
        return
      }
      if (!registered) {
        delay(HEARTBEAT_INTERVAL_MS)
        continue
      }
      failureLogged = false
      state.boundDeviceId = target?.deviceId?.takeIf { bindingAcknowledged }
      refreshAfterRegistration()
      val (alive, lapse) = heartbeat()
      scheduleBindRetry(alive)
      if (afterHeartbeat(alive, lapse)) return
    }
  }

  private suspend fun register(): Boolean {
    return runCatching {
      context.bindingMutex.withLock {
        if (context.bindingGeneration.get() != context.generation) return false
        withContext(options.ioDispatcher) { bind() }
      }
    }
      .onFailure { error ->
        if (error is CancellationException) throw error
        if (!bindingAcknowledged) target?.let { state.gates.complete(it.deviceId, allowed = false) }
        if (!failureLogged) {
          DESKTOP_DAEMON_COMPOSITION_LOG.warn(
            "Failed to register desktop session: ${error.message}",
          )
          failureLogged = true
        }
      }
      .isSuccess
  }

  private fun bind() {
    when {
      target == null -> session.ensureRegistered()
      state.heldElsewhereDeviceId == target.deviceId || failedBinds >= MAX_BIND_ATTEMPTS -> {
        session.ensureRegistered()
        state.gates.complete(target.deviceId, allowed = false)
      }
      bindingAcknowledged -> state.gates.complete(target.deviceId, allowed = true)
      else ->
        handleBindResult(session.client.setActiveDevice(target.deviceId, target.platform), target)
    }
  }

  private fun handleBindResult(result: SetActiveDeviceResult, target: DesktopDaemonSessionBinding) {
    when {
      result.success -> {
        bindingAcknowledged = true
        // Start the lapse window when the daemon actually acknowledges the allocation.
        lastHeartbeatOkAtMs = options.monotonicClockMs()
        failedBinds = 0
        bindErrorRetries = 0
        state.bindErrorMessage = null
        state.bindErrorDeviceId = null
        session.deviceBound(held = true)
        state.heldDevice.set(target.deviceId)
        state.gates.complete(target.deviceId, allowed = true)
      }
      result.refusal == SetActiveDeviceRefusal.SESSION_RELEASED -> {
        DESKTOP_DAEMON_COMPOSITION_LOG.info(
          "Desktop session ${session.sessionUuid} was released by the daemon; " +
            "allocating ${target.deviceId} under a fresh session: ${result.message}",
        )
        rotateSession = true
      }
      result.refusal == SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION -> {
        state.heldElsewhereDeviceId = target.deviceId
        state.gates.complete(target.deviceId, allowed = false)
        DESKTOP_DAEMON_COMPOSITION_LOG.info(
          "Device ${target.deviceId} is held by another session; watching only: ${result.message}",
        )
        if (session.holdsDevice) rotateSession = true else session.ensureRegistered()
      }
      else -> handleBindFailure(target, result.message ?: "Failed to set active device")
    }
  }

  private fun handleBindFailure(target: DesktopDaemonSessionBinding, message: String) {
    failedBinds++
    state.gates.complete(target.deviceId, allowed = false)
    when {
      failedBinds < MAX_BIND_ATTEMPTS -> {
        DESKTOP_DAEMON_COMPOSITION_LOG.info(
          "Binding ${target.deviceId} failed (attempt $failedBinds of $MAX_BIND_ATTEMPTS), retrying: $message",
        )
        session.ensureRegistered()
      }
      session.holdsDevice -> {
        DESKTOP_DAEMON_COMPOSITION_LOG.warn(
          "Could not bind ${target.deviceId}: $message; releasing the previously bound device",
        )
        state.carriedBindError = target.deviceId to message
        rotateSession = true
      }
      else -> {
        DESKTOP_DAEMON_COMPOSITION_LOG.warn("Could not bind ${target.deviceId}: $message")
        state.bindErrorMessage = message
        state.bindErrorDeviceId = target.deviceId
        session.ensureRegistered()
      }
    }
  }

  private suspend fun refreshAfterRegistration() {
    if (refreshAfterRecovery) {
      refreshAfterRecovery =
        !runCatching { options.onDaemonRecovered() }
          .onFailure { error ->
            DESKTOP_DAEMON_COMPOSITION_LOG.warn(
              "Failed to refresh state after daemon recovery: ${error.message}",
            )
          }
          .getOrDefault(false)
    }
  }

  private suspend fun heartbeat(): Pair<Boolean, Throwable?> {
    var lapse: Throwable? = null
    val alive = runCatching {
      delay(HEARTBEAT_INTERVAL_MS)
      withContext(options.ioDispatcher) { session.heartbeat() }
    }
      .onFailure { error ->
        if (error is CancellationException) throw error
        lapse = error
        DESKTOP_DAEMON_COMPOSITION_LOG.warn(
          "Desktop daemon session heartbeat failed: ${error.message}",
        )
      }
      .isSuccess
    if (alive) lastHeartbeatOkAtMs = options.monotonicClockMs()
    return alive to lapse
  }

  private fun scheduleBindRetry(alive: Boolean) {
    if (alive && failedBinds >= MAX_BIND_ATTEMPTS && state.bindErrorMessage != null) {
      if (bindErrorWaitTicks < 0) {
        val delayMs = options.bindRetryBackoff.delayMs(bindErrorRetries)
        bindErrorWaitTicks = ((delayMs + HEARTBEAT_INTERVAL_MS - 1) / HEARTBEAT_INTERVAL_MS).toInt()
      }
      ticksWithBindError++
      if (ticksWithBindError >= bindErrorWaitTicks) {
        ticksWithBindError = 0
        bindErrorWaitTicks = -1
        bindErrorRetries++
        failedBinds = MAX_BIND_ATTEMPTS - 1
      }
    } else {
      ticksWithBindError = 0
      bindErrorWaitTicks = -1
    }
  }

  private fun afterHeartbeat(alive: Boolean, lapse: Throwable?): Boolean {
    val heldTarget = bindingAcknowledged && target != null
    val sessionGone = lapse is DaemonSessionNotFoundException
    val lapsedPastLease =
      !alive && options.monotonicClockMs() - lastHeartbeatOkAtMs > HEARTBEAT_LAPSE_MS
    val transientMiss = !sessionGone && !lapsedPastLease
    if (!alive && heldTarget && transientMiss) return false
    if (!alive && bindingAcknowledged && target != null) {
      releaseAfterLapse(target, lapse)
      return true
    }
    if (!alive) {
      refreshAfterRecovery = true
      state.boundDeviceId = null
      if (failedBinds >= MAX_BIND_ATTEMPTS) failedBinds = 0
      bindErrorRetries = 0
    }
    return false
  }

  private fun releaseAfterLapse(target: DesktopDaemonSessionBinding, lapse: Throwable?) {
    DESKTOP_DAEMON_COMPOSITION_LOG.info(
      "Desktop session ${session.sessionUuid} lost ${target.deviceId}; watching it under a " +
        "fresh session until it is used again",
    )
    state.heldDevice.set(null)
    state.idleReleasedDeviceId = target.deviceId
    state.releaseReason =
      if (lapse is DaemonSessionNotFoundException) {
        SessionReleaseReason.fromDaemon(lapse.releaseReason)
      } else SessionReleaseReason.HEARTBEAT_LAPSED
    state.inputDeviceId = null
    state.pendingRecoveryRefresh.set(true)
    state.sessionEpoch++
  }
}
