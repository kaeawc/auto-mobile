package dev.jasonpearson.automobile.junit

internal object DeviceProbeDiagnostics {
  const val MAX_RETRIES = 3

  fun countDevicesInState(output: String, state: String): Int =
    output.lineSequence().count { line ->
      val trimmed = line.trim()
      !trimmed.startsWith("*") && trimmed.split(Regex("\\s+")).getOrNull(1) == state
    }

  private val TRANSIENT_ADB_MESSAGES =
    listOf(
      "adb server didn't ack",
      "address already in use",
      "failed to start daemon",
      "cannot connect to daemon",
      "protocol fault",
      "daemon not running",
      "failed to check server version",
      "connection reset",
      "broken pipe",
      "device still connecting",
      "device offline",
    )
  private val MISSING_BINARY_MESSAGES =
    listOf(
      "error=2",
      "error=13",
      "No such file or directory",
      "Permission denied",
      "Cannot run program",
    )

  fun logDeviceCheckResult(result: CommandResult, attempt: Int) {
    val debugMode = SystemPropertyCache.getBoolean("automobile.debug", false)
    if (debugMode || attempt > 1) {
      println("Device check attempt $attempt output:\n${result.output}")
      if (result.errorOutput.isNotEmpty()) {
        println("Device check attempt $attempt errors:\n${result.errorOutput}")
      }
      println("Device check attempt $attempt exit code: ${result.exitCode}")
    }
  }

  fun hasOnlyConnectingDevices(output: String): Boolean =
    DeviceAvailabilityChecker.countAvailableDevices(output) == 0 &&
      countDevicesInState(output, "connecting") > 0

  fun isTransientFailure(result: CommandResult): Boolean = TRANSIENT_ADB_MESSAGES.any { message ->
    result.errorOutput.contains(message, ignoreCase = true) ||
      result.output.contains(message, ignoreCase = true)
  }

  fun isMissingBinary(exception: Exception): Boolean =
    exception is java.io.IOException &&
      MISSING_BINARY_MESSAGES.any { exception.message?.contains(it, ignoreCase = true) == true }

  fun logRetryableFailure(result: CommandResult, attempt: Int) {
    if (result.exitCode == 0) {
      println(
        "ADB device still connecting (attempt $attempt/${MAX_RETRIES})",
      )
    } else {
      println("Warning: Device check failed with exit code ${result.exitCode}")
      if (isTransientFailure(result)) {
        println(
          "ADB server issue detected (attempt $attempt/${MAX_RETRIES})",
        )
        if (attempt == MAX_RETRIES) {
          println(
            "ADB server failed to start after ${MAX_RETRIES} attempts. This may be a CI environment issue.",
          )
        }
      }
    }
  }

  fun buildAdbErrorMessage(result: CommandResult): String {
    val diagnostic = result.errorOutput.ifEmpty { result.output }
    val errorDetails = StringBuilder()
    errorDetails.append("ADB device check failed (exit code ${result.exitCode})")

    if (diagnostic.contains("Address already in use", ignoreCase = true)) {
      errorDetails.append(": ADB server port conflict - another process may be using port 5037")
    } else if (diagnostic.contains("failed to start daemon", ignoreCase = true)) {
      errorDetails.append(": ADB daemon failed to start")
    } else if (diagnostic.contains("cannot connect to daemon", ignoreCase = true)) {
      errorDetails.append(": Cannot connect to ADB daemon")
    } else if (diagnostic.isNotEmpty()) {
      errorDetails.append(": ${diagnostic.take(200)}")
    }

    return errorDetails.toString()
  }
}
