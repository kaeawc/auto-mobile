package dev.jasonpearson.automobile.junit

/**
 * A failed result always carries the error text in [AutoMobilePlanExecutionResult.output] (the
 * usual `assertTrue(result.success, result.output)` message), with the daemon socket and device
 * selector this runner used, so a test report alone shows why and where a plan failed (#17953). A
 * failure whose output the daemon filled in keeps it and gains the error and context lines.
 */
internal class PlanFailureDiagnostics(private val collaborators: PlanExecutorCollaborators) {

  fun annotate(
    result: AutoMobilePlanExecutionResult,
    options: AutoMobilePlanExecutionOptions,
  ): AutoMobilePlanExecutionResult {
    if (result.success) return result
    val context =
      "AutoMobile daemon socket: ${collaborators.daemonEndpoint()}\n" +
        "Device: ${describeDeviceSelector(options)}"
    val error = result.errorMessage.ifBlank { "AutoMobile plan failed without an error message" }
    val output =
      when {
        result.output.isBlank() -> "$error\n$context"
        error in result.output -> "${result.output}\n$context"
        else -> "${result.output}\n$error\n$context"
      }
    return result.copy(output = output)
  }

  private fun describeDeviceSelector(options: AutoMobilePlanExecutionOptions): String {
    val configured = options.device.trim()
    val serial = PlanDeviceSelection.androidSerial(collaborators.environment)
    val serialEnv = PlanDeviceSelection.ANDROID_SERIAL_ENV
    return when {
      configured.isNotEmpty() && configured != "auto" -> "$configured (options.device)"
      serial != null -> "$serial ($serialEnv; ignored by multi-device plans)"
      else -> "auto (daemon chooses; set $serialEnv or options.device to pin one)"
    }
  }
}
