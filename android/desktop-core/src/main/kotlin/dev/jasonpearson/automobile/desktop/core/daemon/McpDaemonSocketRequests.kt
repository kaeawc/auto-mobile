package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.UUID
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Open one Unix-socket channel and leave it connected. Reuses [sendRequest]'s connect discipline —
 * open unconnected, arm a deadline watchdog before the blocking connect — so a wedged daemon that
 * never accepts cannot hang the caller forever.
 */
internal fun McpDaemonClient.connectPersistentChannel(): McpPersistentChannel {
  ensureVersionMatchedDaemon()
  ensureSocketExists()
  val address = UnixDomainSocketAddress.of(socketPathValue)
  val channel = SocketChannel.open(java.net.StandardProtocolFamily.UNIX)
  val expired = java.util.concurrent.atomic.AtomicBoolean(false)
  val watchdog =
    McpDaemonClient.requestWatchdog.schedule(
      {
        expired.set(true)
        try {
          channel.close()
        } catch (error: java.io.IOException) {
          DAEMON_PATHS_LOG.debug("Daemon connectPersistentChannel failed: ${error.message}")

          // Best-effort; the caller owns the definitive close.
        }
      },
      inputRequestTimeoutMs,
      java.util.concurrent.TimeUnit.MILLISECONDS,
    )
  try {
    channel.connect(address)
    val reader =
      BufferedReader(InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8))
    val writer =
      BufferedWriter(
        OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8),
      )
    return McpPersistentChannel(channel, reader, writer)
  } catch (e: java.io.IOException) {
    try {
      channel.close()
    } catch (error: java.io.IOException) {
      DAEMON_PATHS_LOG.debug("Daemon connectPersistentChannel failed: ${error.message}")

      // Best-effort cleanup after a failed connect.
    }
    if (expired.get()) {
      throw DaemonUnavailableException(
        "Gesture stream connect timed out after ${inputRequestTimeoutMs}ms",
      )
    }
    throw e
  } finally {
    watchdog.cancel(false)
  }
}

/**
 * Send one request. [timeoutMs] is a HANG ceiling, not a latency budget, and is OPT-IN: null
 * (ordinary tool calls) leaves the request unbounded, because the daemon deliberately grants
 * long-running tools multi-minute floors (executePlan 600s, startDevice/launchApp/observe 90s; see
 * src/daemon/mcpRequestTimeout.ts) and a blanket client ceiling would disconnect a valid slow call
 * while it is still running. Only the input helpers pass a value, where a hang freezes the video
 * pane's single dispatch thread.
 *
 * When set, the same deadline is sent as `DaemonRequest.timeoutMs` (#6385) so the daemon abandons
 * the request when this client gives up, instead of running on to its 30s default. When null the
 * field is omitted and the daemon applies its default plus per-tool floors.
 */
internal fun McpDaemonClient.sendRequest(
  method: String,
  params: JsonObject = JsonObject(emptyMap()),
  timeoutMs: Long? = null,
  skipLifecyclePreflight: Boolean = false,
): DaemonResponse {
  requestTransport?.let { transport ->
    return transport.send(
      DaemonRequest(
        id = UUID.randomUUID().toString(),
        type = "mcp_request",
        method = method,
        params = params,
        clientVersion = clientVersion,
        timeoutMs = timeoutMs,
      ),
    )
  }
  // Status and the session keep-alives are passive. Status reports a wedged daemon, so running
  // the lifecycle preflight first can itself hang before the request watchdog is armed; a
  // keep-alive must never start or restart the shared daemon (#11072).
  if (!skipLifecyclePreflight) {
    ensureVersionMatchedDaemon()
  }
  ensureSocketExists()

  val address = UnixDomainSocketAddress.of(socketPathValue)
  // Open the channel UNCONNECTED so the deadline can be armed BEFORE the blocking connect(): a
  // wedged daemon whose accept backlog is full would otherwise hang in connect() before any
  // watchdog exists.
  SocketChannel.open(java.net.StandardProtocolFamily.UNIX).use { channel ->
    // Deadline watchdog. A blocking SocketChannel has no connect/read timeout, so a daemon that
    // never accepts or never replies would hang the calling thread forever (for video-pane
    // input that meant ALL input died). The watchdog closes the channel, which makes the blocked
    // connect/read throw; `expired` is set BEFORE the close so the request thread
    // deterministically
    // reports the deadline rather than the incidental ClosedChannelException the close raced in.
    val expired = java.util.concurrent.atomic.AtomicBoolean(false)
    val watchdog = timeoutMs?.let { deadline ->
      McpDaemonClient.requestWatchdog.schedule(
        {
          expired.set(true)
          try {
            channel.close()
          } catch (error: java.io.IOException) {
            DAEMON_PATHS_LOG.debug("Daemon sendRequest failed: ${error.message}")

            // Best-effort close; the request thread owns the definitive close via use{}.
          }
        },
        deadline,
        java.util.concurrent.TimeUnit.MILLISECONDS,
      )
    }
    try {
      channel.connect(address)
      return exchangeDaemonRequest(channel, method, params, timeoutMs)
    } catch (e: java.io.IOException) {
      if (expired.get()) {
        throw DaemonUnavailableException(
          "Daemon request '$method' timed out after ${timeoutMs}ms",
        )
      }
      throw e
    } finally {
      watchdog?.cancel(false)
    }
  }
}

internal fun McpDaemonClient.exchangeDaemonRequest(
  channel: SocketChannel,
  method: String,
  params: JsonObject,
  timeoutMs: Long?,
): DaemonResponse {
  val reader =
    BufferedReader(
      InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8),
    )
  val writer =
    BufferedWriter(
      OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8),
    )

  val request =
    DaemonRequest(
      id = UUID.randomUUID().toString(),
      type = "mcp_request",
      method = method,
      params = params,
      clientVersion = clientVersion,
      timeoutMs = timeoutMs,
    )

  writer.write(json.encodeToString(request))
  writer.newLine()
  writer.flush()

  val line = reader.readLine() ?: throw DaemonUnavailableException("Daemon closed the socket")
  return json.decodeFromString(line)
}

internal fun McpDaemonClient.ensureSocketExists() {
  val path = File(socketPathValue).toPath()
  if (!Files.exists(path)) {
    throw DaemonUnavailableException("Daemon socket not found at $socketPathValue")
  }
}

internal fun McpDaemonClient.ensureVersionMatchedDaemon() {
  when (val result = daemonLifecycle?.ensureVersionMatchedDaemon()) {
    is DaemonLifecycleResult.Failure -> throw DaemonUnavailableException(result.message)
    is DaemonLifecycleResult.Ready,
    null -> Unit
  }
}

internal fun McpDaemonClient.ensureSuccess(
  response: DaemonResponse,
  method: String = "daemon request",
): JsonElement {
  if (!response.success) {
    throw DaemonUnavailableException(response.error ?: "Daemon request failed")
  }
  return response.result
    ?: throw DaemonUnavailableException(
      "JSON-RPC $method response contained no result; check the daemon response.",
    )
}
