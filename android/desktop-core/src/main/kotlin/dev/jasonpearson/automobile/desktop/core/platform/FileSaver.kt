package dev.jasonpearson.automobile.desktop.core.platform

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory

private val LOG = LoggerFactory.getLogger("FileSaver")

/**
 * Platform-agnostic file save operation. The IDE plugin provides an IntelliJ implementation; the
 * desktop app can use a Swing/AWT file dialog.
 */
fun interface FileSaver {
  /**
   * Present a save dialog for the given file name and content. Calls [onSuccess] with the saved
   * file path on success, or [onError] with the failure so a caller can surface it instead of the
   * save silently doing nothing (#3609).
   */
  fun save(
    fileName: String,
    content: String,
    onSuccess: (String) -> Unit,
    onError: (Throwable) -> Unit,
  )
}

/** Default no-op file saver for environments without a file dialog. */
object NoOpFileSaver : FileSaver {
  override fun save(
    fileName: String,
    content: String,
    onSuccess: (String) -> Unit,
    onError: (Throwable) -> Unit,
  ) {}
}

/**
 * Desktop file saver that uses Swing's JFileChooser. Suitable for standalone desktop applications.
 */
object SwingFileSaver : FileSaver {
  override fun save(
    fileName: String,
    content: String,
    onSuccess: (String) -> Unit,
    onError: (Throwable) -> Unit,
  ) {
    val result =
      try {
        val chooser = javax.swing.JFileChooser()
        chooser.selectedFile = java.io.File(fileName)
        chooser.showSaveDialog(null) to chooser.selectedFile
      } catch (e: Exception) {
        LOG.warn("Failed to present save dialog for '$fileName': ${e.message}")
        onError(e)
        return
      }
    val (approval, selectedFile) = result
    if (approval != javax.swing.JFileChooser.APPROVE_OPTION) return
    writeFile(selectedFile, content).onSuccess(onSuccess).onFailure { e ->
      LOG.warn("Failed to save file '$fileName' to '${selectedFile.absolutePath}': ${e.message}")
      onError(e)
    }
  }
}

/**
 * Writes [content] to [file] as UTF-8, returning the absolute path on success or the failure
 * (permissions, disk full, invalid path) as a [Result]. Extracted from the Swing dialog flow so the
 * write path — the part that used to swallow errors silently (#3609) — is unit-testable without a
 * display.
 */
internal fun writeFile(file: java.io.File, content: String): Result<String> = runCatching {
  file.writeText(content, Charsets.UTF_8)
  file.absolutePath
}
