package dev.jasonpearson.automobile.desktop.core.diagnostics

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.File

internal fun runSystemChecks(): List<DiagnosticCheck> {
  val checks = mutableListOf<DiagnosticCheck>()

  // Check ADB
  val adbCheck = checkAdb()
  checks.add(adbCheck)

  // Check Node.js
  val nodeCheck = checkNode()
  checks.add(nodeCheck)

  // Check Bun (optional)
  val bunCheck = checkBun()
  checks.add(bunCheck)

  // Check ANDROID_HOME
  val androidHomeCheck =
    System.getenv("ANDROID_HOME")?.let { path ->
      if (File(path).exists()) {
        DiagnosticCheck("ANDROID_HOME", DiagnosticStatus.Success, path)
      } else {
        DiagnosticCheck(
          "ANDROID_HOME",
          DiagnosticStatus.Warning,
          "Set but path doesn't exist: $path",
        )
      }
    } ?: DiagnosticCheck("ANDROID_HOME", DiagnosticStatus.Warning, "Not set")
  checks.add(androidHomeCheck)

  // Check Java
  val javaCheck = checkJava()
  checks.add(javaCheck)

  return checks
}

internal fun checkAdb(): DiagnosticCheck =
  try {
    val process = ProcessBuilder("which", "adb").start()
    val exitCode = process.waitFor()
    if (exitCode == 0) {
      val path = process.inputStream.bufferedReader().readText().trim()
      DiagnosticCheck("ADB", DiagnosticStatus.Success, path)
    } else {
      DiagnosticCheck("ADB", DiagnosticStatus.Error, "Not found in PATH")
    }
  } catch (e: java.io.IOException) {
    DiagnosticCheck("ADB", DiagnosticStatus.Error, e.message)
  }

internal fun checkNode(): DiagnosticCheck =
  try {
    val process = ProcessBuilder("node", "--version").start()
    val exitCode = process.waitFor()
    if (exitCode == 0) {
      val version = process.inputStream.bufferedReader().readText().trim()
      DiagnosticCheck("Node.js", DiagnosticStatus.Success, version)
    } else {
      DiagnosticCheck("Node.js", DiagnosticStatus.Error, "Not found")
    }
  } catch (e: java.io.IOException) {
    DiagnosticCheck("Node.js", DiagnosticStatus.Error, e.message)
  }

internal fun checkBun(): DiagnosticCheck =
  try {
    val process = ProcessBuilder("bun", "--version").start()
    val exitCode = process.waitFor()
    if (exitCode == 0) {
      val version = process.inputStream.bufferedReader().readText().trim()
      DiagnosticCheck("Bun", DiagnosticStatus.Success, version)
    } else {
      DiagnosticCheck("Bun", DiagnosticStatus.Info, "Not installed (optional)")
    }
  } catch (e: java.io.IOException) {
    DIAGNOSTICS_LOG.debug("Bun check unavailable: ${e.message}")
    DiagnosticCheck("Bun", DiagnosticStatus.Info, "Not installed (optional)")
  }

internal fun checkJava(): DiagnosticCheck =
  try {
    val process = ProcessBuilder("java", "-version").redirectErrorStream(true).start()
    val exitCode = process.waitFor()
    if (exitCode == 0) {
      val output = process.inputStream.bufferedReader().readText()
      val versionLine = output.lines().firstOrNull() ?: "Unknown"
      DiagnosticCheck("Java", DiagnosticStatus.Success, versionLine)
    } else {
      DiagnosticCheck("Java", DiagnosticStatus.Error, "Not found")
    }
  } catch (e: java.io.IOException) {
    DiagnosticCheck("Java", DiagnosticStatus.Error, e.message)
  }

internal enum class DiagnosticStatus {
  Success,
  Warning,
  Error,
  Info,
}

internal data class DiagnosticCheck(
  val name: String,
  val status: DiagnosticStatus,
  val details: String? = null,
)

private val DIAGNOSTICS_LOG = LoggerFactory.getLogger("DiagnosticsDashboard")
