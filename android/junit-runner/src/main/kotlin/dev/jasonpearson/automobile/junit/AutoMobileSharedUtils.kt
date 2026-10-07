package dev.jasonpearson.automobile.junit

import java.util.concurrent.TimeUnit

/** Shared utilities for AutoMobile tests. */
object AutoMobileSharedUtils {
  // Phase 5: Lazy device checker initialization
  @JvmStatic internal var testDeviceChecker: DeviceChecker? = null
  private val defaultDeviceChecker: DeviceChecker by lazy { DeviceAvailabilityChecker() }
  val deviceChecker: DeviceChecker
    get() = testDeviceChecker ?: defaultDeviceChecker

  fun executeCommand(
    command: List<String>,
    timeoutMs: Long,
    environmentOverrides: Map<String, String> = emptyMap(),
  ): CommandResult {
    val processBuilder = ProcessBuilder(command)
    if (environmentOverrides.isNotEmpty()) {
      val environment = processBuilder.environment()
      environmentOverrides.forEach { (key, value) ->
        if (value.isNotBlank()) {
          environment[key] = value
        }
      }
    }
    val process = processBuilder.start()

    // CRITICAL FIX: Close stdin immediately to prevent the process from hanging
    // waiting for input. This is essential for non-interactive command execution.
    process.outputStream.close()

    // Read output and error streams concurrently to prevent deadlock
    val outputFuture =
      java.util.concurrent.CompletableFuture.supplyAsync {
        process.inputStream.bufferedReader().use { it.readText() }
      }

    val errorFuture =
      java.util.concurrent.CompletableFuture.supplyAsync {
        process.errorStream.bufferedReader().use { it.readText() }
      }

    val completed = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)

    if (!completed) {
      process.destroyForcibly()
      // Wait a bit to ensure process is destroyed
      process.waitFor(5, TimeUnit.SECONDS)
      throw RuntimeException("Command execution timed out after ${timeoutMs}ms")
    }

    val exitCode = process.exitValue()
    val output = outputFuture.get(5, TimeUnit.SECONDS)
    val errorOutput = errorFuture.get(5, TimeUnit.SECONDS)

    // Write process errors to STDERR so they appear in test logs
    if (errorOutput.isNotEmpty()) {
      System.err.print(errorOutput)
    }

    return CommandResult(exitCode, output, errorOutput)
  }
}

/** Shared command result data class. */
data class CommandResult(val exitCode: Int, val output: String, val errorOutput: String)

/** Interface for checking device availability. */
interface DeviceChecker {
  fun checkDeviceAvailability()

  fun areDevicesAvailable(): Boolean

  fun getDeviceCount(): Int

  /** Get the last error message from device availability check, if any. */
  fun getLastError(): String? = null

  /**
   * True only when adb was located but the device probe did not complete successfully (non-zero
   * exits, timeouts, or an unexecutable binary). False when adb ran and listed no devices, and when
   * no Android SDK is configured: those are deliberate skips, not infrastructure failures.
   */
  fun checkFailed(): Boolean = false
}

/**
 * Shared device availability checker for AutoMobile tests. Handles checking for connected Android
 * devices via adb with retry logic for transient ADB server issues.
 *
 * Uses a JVM-wide lock to prevent parallel test executors from racing on ADB server startup.
 */
class DeviceAvailabilityChecker
@JvmOverloads
constructor(
  private val getenv: (String) -> String? = System::getenv,
  private val commandExecutor: (List<String>, Long) -> CommandResult = { command, timeoutMs ->
    AutoMobileSharedUtils.executeCommand(command, timeoutMs)
  },
) : DeviceChecker {
  private var sleeper: (Long) -> Unit = { ms -> Thread.sleep(ms) }

  /**
   * Injects test backoff while preserving binary compatibility with the original two-parameter
   * primary constructor's synthetic default-argument constructor.
   */
  internal constructor(
    getenv: (String) -> String?,
    commandExecutor: (List<String>, Long) -> CommandResult,
    sleeper: (Long) -> Unit,
  ) : this(getenv, commandExecutor) {
    this.sleeper = sleeper
  }

  @Volatile private var deviceCount = 0

  @Volatile private var checkComplete = false

  @Volatile private var lastError: String? = null

  @Volatile private var probeFailed = false

  companion object {
    private const val MAX_RETRIES = 3
    private const val INITIAL_BACKOFF_MS = 500L
    private const val COMMAND_TIMEOUT_MS = 10000L // 10 seconds per attempt
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

    internal fun countAvailableDevices(output: String): Int = countDevicesInState(output, "device")

    private fun countDevicesInState(output: String, state: String): Int =
      output.lineSequence().count { line ->
        val trimmed = line.trim()
        !trimmed.startsWith("*") && trimmed.split(Regex("\\s+")).getOrNull(1) == state
      }

    // JVM-wide lock to prevent parallel test executors from racing on ADB server startup
    private val adbLock = java.util.concurrent.locks.ReentrantLock()
  }

  override fun checkDeviceAvailability() {
    if (checkComplete) {
      return
    }

    // Acquire lock to prevent parallel ADB operations
    adbLock.lock()
    try {
      // Double-check after acquiring lock
      if (checkComplete) {
        return
      }

      checkDeviceAvailabilityLocked()
    } finally {
      adbLock.unlock()
    }
  }

  private fun checkDeviceAvailabilityLocked() {
    println("Checking for available Android devices...")

    val androidHome = getAndroidHome()
    if (androidHome == null) {
      deviceCount = 0
      lastError =
        "ANDROID_HOME / ANDROID_SDK_ROOT is not set; cannot locate adb — treating as no devices available"
      checkComplete = true
      println("No devices found - AutoMobile tests will be skipped")
      return
    }

    val command = listOf("$androidHome/platform-tools/adb", "devices")
    println("Running device check: ${command.joinToString(" ")}")
    checkDevicesWithRetries(command)
  }

  private fun checkDevicesWithRetries(command: List<String>) {
    var lastDiagnostic: String? = null
    for (attempt in 1..MAX_RETRIES) {
      try {
        val result = executeCommand(command, COMMAND_TIMEOUT_MS)
        logDeviceCheckResult(result, attempt)
        if (acceptDeviceCheckResult(result, attempt)) return
        lastDiagnostic = buildAdbErrorMessage(result)
        logRetryableFailure(result, attempt)
      } catch (e: Exception) {
        lastDiagnostic = e.message ?: e.javaClass.name
        println("Error during device availability check (attempt $attempt): ${e.message}")
        if (isMissingBinary(e)) {
          lastDiagnostic = "Cannot execute adb: $lastDiagnostic"
          break
        }
      }

      // An idempotent probe retries unknown failures too, but never sleeps after the last attempt.
      if (attempt < MAX_RETRIES) {
        val backoffMs = INITIAL_BACKOFF_MS * (1 shl (attempt - 1))
        println("Retrying in ${backoffMs}ms...")
        sleeper(backoffMs)
      }
    }

    lastError = lastDiagnostic
    probeFailed = true
    deviceCount = 0
    checkComplete = true
  }

  private fun logDeviceCheckResult(result: CommandResult, attempt: Int) {
    val debugMode = SystemPropertyCache.getBoolean("automobile.debug", false)
    if (debugMode || attempt > 1) {
      println("Device check attempt $attempt output:\n${result.output}")
      if (result.errorOutput.isNotEmpty()) {
        println("Device check attempt $attempt errors:\n${result.errorOutput}")
      }
      println("Device check attempt $attempt exit code: ${result.exitCode}")
    }
  }

  private fun acceptDeviceCheckResult(result: CommandResult, attempt: Int): Boolean {
    if (result.exitCode != 0) return false
    if (attempt < MAX_RETRIES && hasOnlyConnectingDevices(result.output)) return false

    deviceCount = countAvailableDevices(result.output)
    if (deviceCount > 0) {
      println("Found $deviceCount connected device(s)")
      println("Device availability check completed successfully")
    } else {
      println("No devices found - AutoMobile tests will be skipped")
    }
    lastError = null
    probeFailed = false
    checkComplete = true
    return true
  }

  private fun hasOnlyConnectingDevices(output: String): Boolean =
    countAvailableDevices(output) == 0 && countDevicesInState(output, "connecting") > 0

  private fun isTransientFailure(result: CommandResult): Boolean =
    TRANSIENT_ADB_MESSAGES.any { message ->
      result.errorOutput.contains(message, ignoreCase = true) ||
        result.output.contains(message, ignoreCase = true)
    }

  private fun isMissingBinary(exception: Exception): Boolean =
    exception is java.io.IOException &&
      MISSING_BINARY_MESSAGES.any { exception.message?.contains(it, ignoreCase = true) == true }

  private fun logRetryableFailure(result: CommandResult, attempt: Int) {
    if (result.exitCode == 0) {
      println("ADB device still connecting (attempt $attempt/$MAX_RETRIES)")
    } else {
      println("Warning: Device check failed with exit code ${result.exitCode}")
      if (isTransientFailure(result)) {
        println("ADB server issue detected (attempt $attempt/$MAX_RETRIES)")
        if (attempt == MAX_RETRIES) {
          println(
            "ADB server failed to start after $MAX_RETRIES attempts. This may be a CI environment issue."
          )
        }
      }
    }
  }

  private fun buildAdbErrorMessage(result: CommandResult): String {
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

  /** Get the last error message from device availability check, if any. */
  override fun getLastError(): String? = lastError

  override fun checkFailed(): Boolean {
    if (!checkComplete) {
      checkDeviceAvailability()
    }
    return probeFailed
  }

  override fun areDevicesAvailable(): Boolean {
    if (!checkComplete) {
      checkDeviceAvailability()
    }
    return deviceCount > 0
  }

  /**
   * Get the number of connected Android devices. This can be used to limit parallelism to match
   * available devices.
   */
  override fun getDeviceCount(): Int {
    if (!checkComplete) {
      checkDeviceAvailability()
    }
    return deviceCount
  }

  private fun executeCommand(command: List<String>, timeoutMs: Long): CommandResult {
    return commandExecutor(command, timeoutMs)
  }

  private fun getAndroidHome(): String? {
    val androidHome =
      getenv("ANDROID_HOME")
        ?: getenv("ANDROID_SDK_ROOT")
        ?: getenv("ANDROID_SDK_HOME")
        ?: return null

    // Validate the path to prevent command injection
    // Phase 6: Use cached regex to avoid repeated compilation
    if (androidHome.contains(RegexCache.getRegex("[;&|`\$()<>\\s]"))) {
      throw IllegalStateException("ANDROID_HOME contains invalid characters")
    }

    // Ensure the path exists
    if (!java.io.File(androidHome).exists()) {
      throw IllegalStateException("ANDROID_HOME path does not exist: $androidHome")
    }

    return androidHome
  }
}
