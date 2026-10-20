package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.logging.Logger
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.serializer

internal class FailuresSocketWriter(private val log: Logger) {
  private val json = DaemonJson
  private val writeLock = ReentrantLock()

  fun subscribe(request: FailuresPushRequest, currentSocket: FailuresSocket) {

    if (!sendRequest(request, currentSocket)) {
      throw IllegalStateException("Failed to send failures subscription")
    }
  }

  fun sendRequest(
    request: FailuresPushRequest,
    currentSocket: FailuresSocket?,
  ): Boolean {
    currentSocket ?: return false
    return writeLock.withLock { writeRequest(request, currentSocket) }
  }

  fun sendRequestIfIdle(
    request: FailuresPushRequest,
    currentSocket: FailuresSocket?,
  ): Boolean {
    currentSocket ?: return false
    if (!writeLock.tryLock()) return false
    return try {
      // Even a tiny unsubscribe can block if the OS send buffer is full with no active writer.
      writeRequest(request, currentSocket)
    } finally {
      writeLock.unlock()
    }
  }

  fun writeRequest(
    request: FailuresPushRequest,
    currentSocket: FailuresSocket,
  ): Boolean {
    return try {
      currentSocket.writeLine(json.encodeToString(serializer<FailuresPushRequest>(), request))
      true
    } catch (e: CancellationException) {
      throw e
    } catch (e: java.io.IOException) {
      log.warn("Failed to send request: ${e.message}", e)
      false
    } catch (e: kotlinx.serialization.SerializationException) {
      log.warn("Failed to send request: ${e.message}", e)
      false
    }
  }

  fun sendPong(currentSocket: FailuresSocket) {
    val request =
      FailuresPushRequest(
        id = UUID.randomUUID().toString(),
        command = "pong",
      )
    sendRequest(request, currentSocket)
  }
}
