package dev.jasonpearson.automobile.junit

import java.io.File

internal object DiagnosticTools {
  private const val DEFAULT_TOOL_TIMEOUT_MS = 20_000L

  fun findTool(toolName: String): String? {
    val javaHome = File(System.getProperty("java.home", ""))
    val directCandidate = File(javaHome, "bin/$toolName")
    val parentCandidate = javaHome.parentFile?.let { File(it, "bin/$toolName") }
    val windowsCandidate = File(javaHome, "bin/$toolName.exe")
    val parentWindowsCandidate = javaHome.parentFile?.let { File(it, "bin/$toolName.exe") }

    listOf(directCandidate, parentCandidate, windowsCandidate, parentWindowsCandidate)
      .firstOrNull { it != null && it.exists() && it.canExecute() }
      ?.let {
        return it.absolutePath
      }

    val path = System.getenv("PATH") ?: return null
    val segments = path.split(File.pathSeparator)
    val candidates =
      segments
        .map { segment ->
          listOf(
            File(segment, toolName),
            File(segment, "$toolName.exe"),
          )
        }
        .flatten()
    return candidates.firstOrNull { it.exists() && it.canExecute() }?.absolutePath
  }

  fun runAndWriteTool(
    diagnosticsDir: File,
    filePrefix: String,
    tool: String?,
    args: List<String>,
    errors: MutableList<String>,
  ) {
    if (tool == null) {
      errors.add("$filePrefix: tool not found")
      return
    }

    val command = listOf(tool) + args
    val output = runTool(command, DEFAULT_TOOL_TIMEOUT_MS)
    val outputFile = File(diagnosticsDir, "$filePrefix.txt")
    writeCommandOutput(outputFile, command, output, null)

    if (output.exitCode != 0) {
      errors.add("$filePrefix: exitCode=${output.exitCode}")
    }
  }

  fun runTool(command: List<String>, timeoutMs: Long): ToolOutput {
    return try {
      val result = AutoMobileSharedUtils.executeCommand(command, timeoutMs)
      ToolOutput(result.exitCode, result.output, result.errorOutput)
    } catch (e: java.io.IOException) {
      ToolOutput(-1, "", e.message ?: "Unknown error")
    } catch (e: IllegalStateException) {
      ToolOutput(-1, "", e.message ?: "Unknown error")
    } catch (e: SecurityException) {
      ToolOutput(-1, "", e.message ?: "Unknown error")
    } catch (e: InterruptedException) {
      ToolOutput(-1, "", e.message ?: "Unknown error")
    } catch (e: java.util.concurrent.ExecutionException) {
      ToolOutput(-1, "", e.message ?: "Unknown error")
    } catch (e: java.util.concurrent.TimeoutException) {
      ToolOutput(-1, "", e.message ?: "Unknown error")
    }
  }

  fun writeCommandOutput(
    file: File,
    command: List<String>,
    output: ToolOutput,
    reason: String?,
  ) {
    val content = buildString {
      appendLine("Command: ${command.joinToString(" ")}")
      if (!reason.isNullOrBlank()) {
        appendLine("Reason: $reason")
      }
      appendLine("Exit Code: ${output.exitCode}")
      if (output.stdout.isNotBlank()) {
        appendLine()
        appendLine("STDOUT:")
        appendLine(output.stdout)
      }
      if (output.stderr.isNotBlank()) {
        appendLine()
        appendLine("STDERR:")
        appendLine(output.stderr)
      }
    }
    file.writeText(content)
  }

  data class ToolOutput(val exitCode: Int, val stdout: String, val stderr: String)
}
