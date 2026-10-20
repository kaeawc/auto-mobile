package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
import kotlinx.coroutines.flow.update

internal fun ObservationStreamClient.releaseActiveTransport() {
  val target =
    synchronized(ownershipLock) {
      val current = transport
      transport = null
      connectionGeneration++
      current
    }
  closeQuietly(target)
}

internal fun ObservationStreamClient.closeQuietly(target: ObservationStreamTransport?) {
  if (target == null) return
  try {
    target.close()
  } catch (e: java.io.IOException) {
    log.warn("Error closing observation stream transport: ${e.message}")
  }
}

internal suspend fun ObservationStreamClient.readMessages(generation: Long) {
  // Bind to the transport for this generation. If a disconnect()/reconnect already superseded us
  // before we started reading, there is nothing to own -- exit without touching state.
  val activeTransport =
    synchronized(ownershipLock) { if (connectionGeneration == generation) transport else null }
  if (activeTransport == null) {
    onReadLoopExit()
    return
  }
  val currentReader = activeTransport.reader

  try {
    log.info("Starting message read loop")

    // Stop as soon as a later connect()/disconnect() supersedes this generation, so a stale loop
    // never emits frames onto the shared flows after ownership has moved on.
    while (ownsGeneration(generation) && _connectionState.value.isConnected) {
      val line = currentReader.readLine() ?: break
      if (line.isBlank()) continue

      log.info("Received message (${line.length} chars): ${line.take(200)}...")

      try {
        handleMessage(line)
      } catch (e: kotlinx.serialization.SerializationException) {
        log.warn("Failed to parse observation stream message: ${e.message}", e)
      }
    }
    log.info("Read loop ended - connected=${_connectionState.value.isConnected}")
  } catch (e: java.io.IOException) {
    logObservationReadError(e)
  } finally {
    finishObservationRead(generation, activeTransport)
    onReadLoopExit()
  }
}

internal fun ObservationStreamClient.ownsGeneration(generation: Long): Boolean =
  synchronized(ownershipLock) { connectionGeneration == generation }

private fun ObservationStreamClient.logObservationReadError(e: java.io.IOException) {
  val nowMs = System.nanoTime() / 1_000_000L
  val shouldLog =
    synchronized(ownershipLock) {
      val last = lastReadErrorLogAtMs
      if (last == null || nowMs - last >= ObservationStreamClient.READ_ERROR_LOG_INTERVAL_MS) {
        lastReadErrorLogAtMs = nowMs
        true
      } else false
    }
  if (shouldLog) log.warn(ObservationStreamClient.readErrorLogMessage(e), e)
}

private fun ObservationStreamClient.finishObservationRead(
  generation: Long,
  activeTransport: ObservationStreamTransport,
) {
  // Death point (EOF or read error). Clear the transport and publish Disconnected ONLY while we
  // still own the active generation: a loop superseded by disconnect()/reconnect must do nothing,
  // or it would both close the NEW transport's slot and stomp the live Connected state -- after
  // which disconnect()/dispose() would early-return and leak the new socket (issue #5261,
  // CodeRabbit). disconnect() early-returns once not Connected, so for the still-owning EOF case
  // this is the only place that releases the dead socket's fd.
  val stillOwner =
    synchronized(ownershipLock) {
      if (connectionGeneration == generation) {
        transport = null
        connectionGeneration++
        true
      } else {
        false
      }
    }
  if (stillOwner) {
    closeQuietly(activeTransport)
    synchronized(ownershipLock) {
      confirmedStorageSubscriptions.clear()
      pendingStorageSubscriptions.clear()
    }
    _connectionState.update { ConnectionState.Disconnected("Stream ended") }
    log.info("Observation stream disconnected")
  }
}
