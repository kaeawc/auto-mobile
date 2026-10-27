package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter

internal fun McpStdioClient.discardProcess(currentProcess: Process) {
  synchronized(ioLock) { retireProcess(currentProcess, unexpected = false) }
  terminateProcessTree(currentProcess)
}

internal fun McpStdioClient.retireProcess(current: Process, unexpected: Boolean) {
  if (process !== current) {
    return
  }
  if (unexpected) {
    restartGuard.recordExit(processStartedAtNanos)
  }
  process = null
  writer = null
  pump = null
  initialized = false
}

internal fun McpStdioClient.reapIfExited(): Boolean {
  val current = process ?: return false
  if (current.isAlive) {
    return false
  }
  retireProcess(current, unexpected = true)
  return true
}

internal fun McpStdioClient.assertRestartAllowed() {
  val waitMs = restartGuard.remainingCoolDownMs()
  if (waitMs > 0) {
    throw McpConnectionException(
      "MCP stdio server '$command' exited ${restartGuard.consecutiveQuickExits} times in a row " +
        "right after starting, so it is not being restarted for another " +
        "${(waitMs + 999) / 1000}s. Run the command in a terminal to see why it fails.",
    )
  }
}

internal fun McpStdioClient.serverNotRunning(method: String) =
  McpConnectionException(
    "MCP stdio server '$command' is not running, so '$method' was not sent; " +
      "the next request starts a new server",
  )

internal fun McpStdioClient.serverExited(method: String, cause: Throwable) =
  McpConnectionException(
    "MCP stdio server '$command' exited while '$method' was pending. The request was not " +
      "retried because its outcome is unknown; the next request starts a new server",
    cause,
  )

internal fun McpStdioClient.terminateProcessTree(currentProcess: Process) {
  try {
    currentProcess.toHandle().descendants().use { descendants ->
      descendants.forEach { descendant -> descendant.destroyForcibly() }
    }
  } catch (_: UnsupportedOperationException) {
    // Test doubles and constrained runtimes may not expose process handles.
  }
  currentProcess.destroyForcibly()
}

internal fun McpStdioClient.startProcess() {
  if (process != null) {
    return
  }

  val commandParts = parseStdioCommand(command)
  if (commandParts.isEmpty()) {
    throw McpConnectionException("MCP stdio command is empty")
  }

  val newProcess =
    try {
      processStarter(commandParts)
    } catch (e: IOException) {
      restartGuard.recordExit(startedAtNanos = null)
      throw McpConnectionException(
        "MCP stdio command '$command' could not be started: ${e.message}",
        e,
      )
    }
  process = newProcess
  processStartedAtNanos = nowNanos()
  val newReader = BufferedReader(InputStreamReader(newProcess.inputStream))
  writer = BufferedWriter(OutputStreamWriter(newProcess.outputStream))
  pump = StdioResponsePump(newReader, protocolJson).also { it.start() }
}
