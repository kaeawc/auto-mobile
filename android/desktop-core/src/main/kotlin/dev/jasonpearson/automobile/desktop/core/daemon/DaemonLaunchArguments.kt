package dev.jasonpearson.automobile.desktop.core.daemon

internal fun DesktopDaemonLifecycle.packageDaemonCommand(
  runner: String,
  version: String,
  action: String,
  existingOptions: List<String>,
  osName: String,
): List<String> {
  // `bunx` auto-installs the pinned package without prompting, and is a self-contained native
  // binary, so it needs no `-y` flag and no PATH manipulation.
  val runnerArguments =
    listOf(
      runner,
      "@kaeawc/auto-mobile@${DaemonSocketPaths.releaseVersion(version)}",
      "--daemon",
      action,
    ) + existingOptions
  return commandForPlatform(runnerArguments, osName)
}

internal fun versionsMatch(
  actualVersion: String?,
  expectedVersion: String,
): Boolean {
  val actual = actualVersion?.trim().orEmpty()
  val expected = expectedVersion.trim()
  if (declaresFullVersion(expected)) {
    return actual.isNotEmpty() && actual == expected
  }
  val actualRelease = DaemonSocketPaths.releaseVersion(actual)
  val expectedRelease = DaemonSocketPaths.releaseVersion(expected)
  return actualRelease.isNotEmpty() && actualRelease == expectedRelease
}

internal fun declaresFullVersion(version: String): Boolean =
  DaemonSocketPaths.releaseVersion(version) != version

internal fun DesktopDaemonLifecycle.commandForPlatform(
  command: List<String>,
  osName: String,
): List<String> {
  if (!osName.lowercase().contains("win")) return command
  val quotedCommand = command.joinToString(" ") { quoteForWindowsCmd(it) }
  return listOf("cmd.exe", "/d", "/v:off", "/s", "/c", "\"$quotedCommand\"")
}

private fun quoteForWindowsCmd(value: String): String {
  require(!value.contains('"') && !value.contains('\n') && !value.contains('\r')) {
    "AutoMobile daemon arguments cannot contain Windows command-line quotes or newlines"
  }
  return "\"${value.replace("%", "%%")}\""
}
