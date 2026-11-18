package dev.jasonpearson.automobile.prototype.appshell

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Collections
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Android-only abstract-namespace listener; all protocol policy lives in [AppAttachAgent]. */
internal class AppAttachServer
private constructor(
  private val listener: LocalServerSocket,
  private val agent: AppAttachAgent,
  private val scope: CoroutineScope,
  private val io: CoroutineDispatcher,
) {
  private val connections = Collections.synchronizedSet(mutableSetOf<SocketConnection>())
  private var acceptJob: Job? = null
  @Volatile private var closed = false

  private fun start() {
    acceptJob =
      scope.launch(io) {
        try {
          while (!closed) {
            val connection = SocketConnection(listener.accept(), io)
            synchronized(connections) {
              if (closed) connection.close()
              else {
                connections.add(connection)
                scope.launch {
                  try {
                    agent.serve(connection)
                  } finally {
                    connections.remove(connection)
                  }
                }
              }
            }
          }
        } catch (error: CancellationException) {
          throw error
        } catch (_: IOException) {
          // A close while accept is blocked is the normal destroy path.
          Log.d(TAG, "Attach listener stopped")
        }
      }
  }

  fun close() {
    closed = true
    synchronized(connections) {
      connections.forEach { it.close() }
      connections.clear()
    }
    try {
      listener.close()
    } catch (_: IOException) {
      Log.d(TAG, "Attach listener already closed")
    }
    acceptJob?.cancel()
  }

  companion object {
    private const val TAG = "PrototypeAppAttach"

    fun start(
      packageName: String,
      agent: AppAttachAgent,
      scope: CoroutineScope,
      io: CoroutineDispatcher = Dispatchers.IO,
    ): AppAttachServer? {
      if (!agent.enabled) return null
      return try {
        AppAttachServer(LocalServerSocket("automobile-app-$packageName"), agent, scope, io).also {
          it.start()
        }
      } catch (_: IOException) {
        Log.w(TAG, "Cannot open attach listener")
        null
      }
    }
  }
}

private class SocketConnection(
  private val socket: LocalSocket,
  private val io: CoroutineDispatcher,
) : AttachConnection {
  private val input = socket.inputStream.buffered()
  private val output = socket.outputStream.buffered()

  override suspend fun readLine(maxBytes: Int): String? =
    withContext(io) {
      val bytes = ByteArrayOutputStream()
      var value = input.read()
      while (value != '\n'.code) {
        if (value == -1) return@withContext null
        if (bytes.size() == maxBytes) throw IOException("Attach frame exceeds limit")
        bytes.write(value)
        value = input.read()
      }
      bytes.toString(Charsets.UTF_8.name()).removeSuffix("\r")
    }

  override suspend fun write(line: String) =
    withContext(io) {
      output.write(line.toByteArray(Charsets.UTF_8))
      output.write('\n'.code)
      output.flush()
    }

  override fun close() {
    try {
      socket.close()
    } catch (_: IOException) {
      Log.d("PrototypeAppAttach", "Attach peer already closed")
    }
  }
}
