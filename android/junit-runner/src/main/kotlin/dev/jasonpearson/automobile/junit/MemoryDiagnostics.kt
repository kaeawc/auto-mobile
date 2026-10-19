package dev.jasonpearson.automobile.junit

import java.io.File
import java.lang.management.ManagementFactory
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal data class MemorySnapshot(
  val timestampMs: Long,
  val heapUsedBytes: Long,
  val heapCommittedBytes: Long,
  val heapMaxBytes: Long,
  val nonHeapUsedBytes: Long,
  val nonHeapCommittedBytes: Long,
  val nonHeapMaxBytes: Long,
)

internal object MemoryDiagnostics {
  private const val DEFAULT_HEAP_DUMP_DIR = "heap-dump"
  private const val DEFAULT_TOOL_TIMEOUT_MS = 20_000L
  private val labelSanitizer = RegexCache.getRegex("[^a-zA-Z0-9_-]")
  private val timestampFormatter =
    DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS").withZone(ZoneId.systemDefault())

  fun captureSnapshot(): MemorySnapshot {
    val bean = ManagementFactory.getMemoryMXBean()
    val heap = bean.heapMemoryUsage
    val nonHeap = bean.nonHeapMemoryUsage
    return MemorySnapshot(
      timestampMs = System.currentTimeMillis(),
      heapUsedBytes = heap.used,
      heapCommittedBytes = heap.committed,
      heapMaxBytes = heap.max,
      nonHeapUsedBytes = nonHeap.used,
      nonHeapCommittedBytes = nonHeap.committed,
      nonHeapMaxBytes = nonHeap.max,
    )
  }

  fun forceGc() {
    // MemoryMXBean.gc has the same collection-request semantics as System.gc.
    ManagementFactory.getMemoryMXBean().gc()
  }

  fun dumpHeap(label: String, reason: String? = null): File? {
    val baseDir = resolveHeapDumpDir()
    if (!baseDir.exists() && !baseDir.mkdirs()) {
      System.err.println(
        "MemoryDiagnostics: Failed to create heap dump directory: ${baseDir.absolutePath}",
      )
      return null
    }

    val sanitizedLabel = sanitizeLabel(label)
    val timestamp = timestampFormatter.format(Instant.now())
    val heapDumpFile = File(baseDir, "${timestamp}_${sanitizedLabel}.hprof")

    val pid = currentPid()
    val jcmd = DiagnosticTools.findTool("jcmd")
    val jmap = DiagnosticTools.findTool("jmap")

    val command =
      when {
        jcmd != null -> listOf(jcmd, pid.toString(), "GC.heap_dump", heapDumpFile.absolutePath)
        jmap != null ->
          listOf(jmap, "-dump:format=b,file=${heapDumpFile.absolutePath}", pid.toString())
        else -> null
      }

    if (command == null) {
      System.err.println("MemoryDiagnostics: jcmd/jmap not found; cannot create heap dump.")
      return null
    }

    val output = DiagnosticTools.runTool(command, DEFAULT_TOOL_TIMEOUT_MS)
    DiagnosticTools.writeCommandOutput(
      File(baseDir, "${timestamp}_${sanitizedLabel}_heap_dump.log"),
      command,
      output,
      reason,
    )

    return if (heapDumpFile.exists()) heapDumpFile else null
  }

  fun captureDiagnostics(label: String, reason: String? = null): File? {
    val baseDir = resolveHeapDumpDir()
    if (!baseDir.exists() && !baseDir.mkdirs()) {
      System.err.println(
        "MemoryDiagnostics: Failed to create heap dump directory: ${baseDir.absolutePath}",
      )
      return null
    }

    val sanitizedLabel = sanitizeLabel(label)
    val timestamp = timestampFormatter.format(Instant.now())
    val diagnosticsDir = File(baseDir, "diagnostics/${timestamp}_${sanitizedLabel}")
    if (!diagnosticsDir.exists() && !diagnosticsDir.mkdirs()) {
      System.err.println(
        "MemoryDiagnostics: Failed to create diagnostics directory: ${diagnosticsDir.absolutePath}",
      )
      return null
    }

    val pid = currentPid()
    writeSummary(diagnosticsDir, timestamp, pid, reason)

    val errors = mutableListOf<String>()

    val commands =
      listOf(
        Triple("jstat-gc", "jstat", listOf("-gc", pid.toString(), "1", "1")),
        Triple("jstat-gccapacity", "jstat", listOf("-gccapacity", pid.toString(), "1", "1")),
      ) +
        listOf(
            "heap-info" to "GC.heap_info",
            "class-histogram" to "GC.class_histogram",
            "vm-flags" to "VM.flags",
            "vm-system-properties" to "VM.system_properties",
            "gc-finalizer-info" to "GC.finalizer_info",
            "thread-print" to "Thread.print",
          )
          .map { (name, command) -> Triple("jcmd-$name", "jcmd", listOf(pid.toString(), command)) }
    for ((prefix, tool, args) in commands) {
      DiagnosticTools.runAndWriteTool(
        diagnosticsDir,
        prefix,
        DiagnosticTools.findTool(tool),
        args,
        errors,
      )
    }

    if (errors.isNotEmpty()) {
      File(diagnosticsDir, "errors.txt").writeText(errors.joinToString("\n"))
    }

    return diagnosticsDir
  }

  private fun resolveHeapDumpDir(): File {
    val configured =
      System.getProperty("automobile.junit.memory.heapdump.dir", DEFAULT_HEAP_DUMP_DIR)
    val trimmed = configured.trim()
    return File(if (trimmed.isEmpty()) DEFAULT_HEAP_DUMP_DIR else trimmed)
  }

  private fun sanitizeLabel(label: String): String {
    return label.replace(labelSanitizer, "_")
  }

  private fun currentPid(): Long {
    return ProcessHandle.current().pid()
  }

  private fun formatBytes(bytes: Long): String = formatMebibytes(bytes)

  private fun writeSummary(diagnosticsDir: File, timestamp: String, pid: Long, reason: String?) {
    val snapshot = captureSnapshot()
    val summary = buildString {
      appendLine("Timestamp: $timestamp")
      appendLine("PID: $pid")
      if (!reason.isNullOrBlank()) {
        appendLine("Reason: $reason")
      }
      appendLine("Heap Used: ${formatBytes(snapshot.heapUsedBytes)}")
      appendLine("Heap Committed: ${formatBytes(snapshot.heapCommittedBytes)}")
      appendLine("Heap Max: ${formatBytes(snapshot.heapMaxBytes)}")
      appendLine("Non-Heap Used: ${formatBytes(snapshot.nonHeapUsedBytes)}")
      appendLine("Non-Heap Committed: ${formatBytes(snapshot.nonHeapCommittedBytes)}")
      appendLine("Non-Heap Max: ${formatBytes(snapshot.nonHeapMaxBytes)}")
    }
    File(diagnosticsDir, "summary.txt").writeText(summary)
  }
}
