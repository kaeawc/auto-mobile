package dev.jasonpearson.automobile.junit

import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

internal object DaemonRuntimePaths {
  internal fun resolveRuntimePath(): String {
    // Gradle test workers often have a stripped PATH, so resolve full paths.
    // Prefer bun since the project runs on bun.
    val home = System.getProperty("user.home") ?: System.getenv("HOME") ?: ""
    val candidates =
      listOfNotNull(
        if (home.isNotEmpty()) "$home/.bun/bin/bun" else null,
        "/usr/local/bin/bun",
        "/opt/homebrew/bin/bun",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        if (home.isNotEmpty()) "$home/.nvm/current/bin/node" else null,
      )

    for (path in candidates) {
      if (File(path).exists()) return path
    }

    return resolveCommandPath("bun") ?: resolveCommandPath("node") ?: "node"
  }

  internal fun resolvePackageRunner(): String? {
    for (cmd in listOf("bunx", "npx")) {
      val resolved = resolveCommandPath(cmd)
      if (resolved != null) return resolved
    }
    return null
  }

  private fun resolveCommandPath(cmd: String): String? {
    try {
      val process = ProcessBuilder("which", cmd).redirectErrorStream(true).start()
      val exited = process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)
      if (exited && process.exitValue() == 0) {
        val path = process.inputStream.bufferedReader().readText().trim()
        if (path.isNotEmpty()) return path
      }
    } catch (e: IOException) {
      println("Command path lookup failed: $e")
    } catch (e: SecurityException) {
      println("Command path lookup inaccessible: $e")
    } catch (e: InterruptedException) {
      println("Command path lookup interrupted: $e")
    }
    return null
  }
}
