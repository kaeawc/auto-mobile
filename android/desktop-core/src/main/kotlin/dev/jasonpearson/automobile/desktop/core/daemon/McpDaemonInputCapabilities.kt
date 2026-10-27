package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.BasicFileAttributes
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.serializer

/**
 * Whether the connected daemon advertises `input/gestureStream`. Mirrors the append-mode probe: an
 * older daemon answers the capability query with its unsupported-method envelope (→ false), and a
 * successful probe is cached only while the socket's file identity is unchanged.
 */
internal fun McpDaemonClient.daemonSupportsGestureStream(): Boolean {
  val identity = socketIdentity()
  val capabilities =
    if (identity == null) {
      when (val probe = queryDaemonCapabilities(null)) {
        is DaemonCapabilitiesProbe.Available -> probe.capabilities
        DaemonCapabilitiesProbe.Legacy -> return false
        is DaemonCapabilitiesProbe.Failure -> return false
      }
    } else {
      daemonCapabilities?.takeIf { it.identity == identity }?.capabilities
        ?: sharedDaemonCapabilities[identity]
        ?: when (val probe = queryDaemonCapabilities(identity)) {
          is DaemonCapabilitiesProbe.Available -> probe.capabilities
          DaemonCapabilitiesProbe.Legacy -> return false
          is DaemonCapabilitiesProbe.Failure -> return false
        }
    }
  return INPUT_GESTURE_STREAM_CAPABILITY in capabilities
}

/**
 * Reads the daemon's additive capability list before the desktop sends `mode: "append"`.
 *
 * An older daemon answers this query with its normal unsupported-method envelope. That leaves
 * append support unknown, so the client attempts the non-destructive append request and translates
 * only its exact unsupported-parameter response. Other probe failures, including version
 * mismatches, are preserved. Successful responses are shared only while the Unix socket's file
 * identity is unchanged, so the per-action facade clients in the control queue reuse one probe
 * without trusting a daemon restarted at the same pathname. An unsupported older daemon is
 * deliberately not cached so restarting it lets the next keystroke discover the upgraded
 * capability.
 */
internal fun McpDaemonClient.inputTypeTextAppendSupportError(): String? {
  val identity = socketIdentity()
  val capabilities =
    if (identity == null) {
      when (val probe = queryDaemonCapabilities(null)) {
        is DaemonCapabilitiesProbe.Available -> probe.capabilities
        DaemonCapabilitiesProbe.Legacy -> return null
        is DaemonCapabilitiesProbe.Failure -> return probe.error
      }
    } else {
      daemonCapabilities?.takeIf { it.identity == identity }?.capabilities
        ?: sharedDaemonCapabilities[identity]
        ?: when (val probe = queryDaemonCapabilities(identity)) {
          is DaemonCapabilitiesProbe.Available -> probe.capabilities
          DaemonCapabilitiesProbe.Legacy -> return null
          is DaemonCapabilitiesProbe.Failure -> return probe.error
        }
    }
  return if (INPUT_TYPE_TEXT_APPEND_CAPABILITY in capabilities) null
  else UNSUPPORTED_APPEND_MODE_ERROR
}

internal fun McpDaemonClient.queryDaemonCapabilities(
  identity: SocketIdentity?,
): DaemonCapabilitiesProbe {
  // This probe runs on the keyboard input path (inputTypeText append=true), which shares the
  // video pane's single FIFO dispatch thread. Bound it with the same input hang ceiling so a
  // never-replying daemon can't freeze keystrokes forever — the taps/keys deadline is useless if
  // its prerequisite blocks unbounded.
  val response = sendRequest(DAEMON_CAPABILITIES_METHOD, timeoutMs = inputRequestTimeoutMs)
  if (!response.success) {
    if (response.error == OLD_DAEMON_CAPABILITIES_ERROR) return DaemonCapabilitiesProbe.Legacy
    return DaemonCapabilitiesProbe.Failure(response.error ?: "Daemon capability probe failed.")
  }
  if (response.result == null) {
    return DaemonCapabilitiesProbe.Failure("Daemon capability probe returned no result.")
  }
  val capabilities =
    try {
      json
        .decodeFromJsonElement(serializer<DaemonCapabilitiesResult>(), response.result)
        .capabilities
    } catch (error: IllegalArgumentException) {
      DAEMON_PATHS_LOG.debug("Daemon queryDaemonCapabilities failed: ${error.message}")

      return DaemonCapabilitiesProbe.Failure(
        "Daemon capability probe returned an invalid result.",
      )
    }
  val resolved = capabilities.toSet()
  // A daemon restart can replace a socket at the same pathname between the probe and this
  // point. Only publish the result if the response came from the same socket identity.
  if (identity != null && socketIdentity() == identity) {
    daemonCapabilities = CachedDaemonCapabilities(identity, resolved)
    sharedDaemonCapabilities[identity] = resolved
  }
  return DaemonCapabilitiesProbe.Available(resolved)
}

internal fun McpDaemonClient.evictDaemonCapabilities() {
  daemonCapabilities?.identity?.let(sharedDaemonCapabilities::remove)
  daemonCapabilities = null
}

/** A socket pathname is not daemon identity: a restart can replace its inode. */
internal fun McpDaemonClient.socketIdentity(): SocketIdentity? {
  val path = File(socketPathValue).toPath()
  return try {
    Files.readAttributes(path, BasicFileAttributes::class.java).fileKey()?.toString()?.let {
      SocketIdentity(socketPathValue, it)
    }
  } catch (error: java.io.IOException) {
    DAEMON_PATHS_LOG.debug("Daemon socketIdentity failed: ${error.message}")

    null
  } catch (error: SecurityException) {
    DAEMON_PATHS_LOG.debug("Daemon socketIdentity failed: ${error.message}")

    null
  }
}
