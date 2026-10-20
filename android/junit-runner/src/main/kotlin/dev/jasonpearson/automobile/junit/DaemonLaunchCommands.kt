package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.DaemonLocalBuild.resolveLocalDaemonProjectRoot
import dev.jasonpearson.automobile.junit.DaemonLocalBuild.resolveLocalPackageVersion
import dev.jasonpearson.automobile.junit.DaemonRuntimePaths.resolvePackageRunner
import dev.jasonpearson.automobile.junit.DaemonRuntimePaths.resolveRuntimePath
import java.io.File

internal object DaemonLaunchCommands {
  internal const val DAEMON_PACKAGE_NAME = "@kaeawc/auto-mobile"

  internal const val DAEMON_PACKAGE_VERSION_PROPERTY = "automobile.daemon.package.version"

  internal val ignoredPackageVersions = setOf("latest", "unknown")

  fun buildDaemonStartCommand(
    flagEnvironment: DaemonFlagEnvironment = SystemDaemonFlagEnvironment,
  ): List<String> {
    return buildDaemonCommand("start", flagEnvironment)
  }

  fun buildDaemonRestartCommand(
    flagEnvironment: DaemonFlagEnvironment = SystemDaemonFlagEnvironment,
  ): List<String> {
    return buildDaemonCommand("restart", flagEnvironment)
  }

  internal fun buildDaemonCommand(
    subCommand: String,
    flagEnvironment: DaemonFlagEnvironment = SystemDaemonFlagEnvironment,
  ): List<String> {
    val command =
      resolveLocalCommand(subCommand)
        ?: resolvePackageCommand(subCommand)
        ?: listOf("auto-mobile", "--daemon", subCommand)

    return command + forwardedDaemonFlags(flagEnvironment)
  }

  internal fun resolveLocalCommand(subCommand: String): List<String>? {
    val projectRoot = resolveLocalDaemonProjectRoot() ?: return null
    val runtime = resolveRuntimePath()
    return listOf(
      runtime,
      File(projectRoot, "dist/src/index.js").absolutePath,
      "--daemon",
      subCommand,
    )
  }

  internal fun resolvePackageCommand(subCommand: String): List<String>? {
    val runner = resolvePackageRunner() ?: return null
    return buildPackageDaemonCommand(runner, subCommand)
  }

  internal fun buildPackageDaemonCommand(
    runner: String,
    subCommand: String,
    packageVersion: String? = resolveDaemonPackageVersion(),
  ): List<String>? {
    val packageSpecifier = resolveDaemonPackageSpecifier(packageVersion) ?: return null
    return if (File(runner).nameWithoutExtension == "npx") {
      listOf(runner, "-y", packageSpecifier, "--daemon", subCommand)
    } else {
      listOf(runner, packageSpecifier, "--daemon", subCommand)
    }
  }

  internal fun resolveDaemonPackageSpecifier(packageVersion: String?): String? {
    val trimmedVersion = packageVersion?.trim().orEmpty()
    if (trimmedVersion.isEmpty() || ignoredPackageVersions.contains(trimmedVersion.lowercase())) {
      return null
    }
    return "$DAEMON_PACKAGE_NAME@$trimmedVersion"
  }

  internal fun resolveDaemonPackageVersion(): String? {
    val sysProp = SystemPropertyCache.get(DAEMON_PACKAGE_VERSION_PROPERTY, "").trim()
    if (sysProp.isNotEmpty()) return sysProp

    val daemonPackageEnv = System.getenv("AUTOMOBILE_DAEMON_PACKAGE_VERSION")?.trim().orEmpty()
    if (daemonPackageEnv.isNotEmpty()) return daemonPackageEnv

    val automobileVersionEnv = System.getenv("AUTOMOBILE_VERSION")?.trim().orEmpty()
    if (automobileVersionEnv.isNotEmpty()) return automobileVersionEnv

    return DaemonSocketPaths::class.java.`package`?.implementationVersion?.trim()
  }

  /**
   * Version this runner declares to the daemon for the server-side handshake gate (#2744).
   *
   * Must describe the daemon this runner will actually *start*, else the daemon rejects every
   * request. When a local project override is active, [buildDaemonCommand] starts
   * `<local>/dist/src/index.js` — whose version is the local checkout's, not this runner jar's — so
   * declare the local `package.json` version (falling back to omitting, i.e. a legacy ungated
   * client, when it can't be read) rather than the jar `Implementation-Version` the published
   * package path would use. This was the #2749 review's local-override rejection.
   */
  internal fun resolveClientVersion(): String? {
    val localProjectRoot = resolveLocalDaemonProjectRoot()
    val resolved =
      if (localProjectRoot != null) {
        resolveLocalPackageVersion(localProjectRoot)
      } else {
        resolveDaemonPackageVersion()
      }
    val trimmed = resolved?.trim().orEmpty()
    // Aliases like `latest`/`unknown` are not real versions — resolveDaemonPackageSpecifier()
    // already treats them as unpinnable and starts bare `auto-mobile`. Declaring one as
    // clientVersion would make the gate (and the post-start skew check) compare e.g. `latest`
    // against `0.0.40` and reject, so behave as an unversioned (legacy, ungated) client instead.
    if (trimmed.isEmpty() || ignoredPackageVersions.contains(trimmed.lowercase())) {
      return null
    }
    return trimmed
  }
}
