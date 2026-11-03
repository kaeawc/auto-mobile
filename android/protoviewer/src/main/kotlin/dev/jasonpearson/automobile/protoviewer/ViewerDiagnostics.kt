package dev.jasonpearson.automobile.protoviewer

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.widget.Toast
import dev.jasonpearson.automobile.prototype.PrototypeLoadError

/**
 * Why the viewer last failed, as a fixed code. Only the category is kept: validator paths and
 * messages, storage messages and exception text can echo spec content, so none of them are stored.
 */
enum class ViewerFailure(val code: String) {
  /** The spec failed validation in the renderer. */
  Validation("validation"),
  /** The renderer could not open the prototype's storage. */
  StorageLoad("storage-load"),
  /** Composition threw, or the renderer reported a failure. */
  Render("render"),
  /** The render watchdog expired before the first successful composition. */
  Watchdog("watchdog"),
  NotFound("library-not-found"),
  Corrupt("library-corrupt"),
  UnsupportedFormat("library-unsupported-format"),
  Storage("library-storage"),
  Limit("library-limit"),
  Invalid("library-invalid");

  companion object {
    fun of(error: PrototypeLoadError): ViewerFailure =
      when (error) {
        is PrototypeLoadError.Storage -> StorageLoad
        else -> Validation
      }

    fun of(error: LibraryError): ViewerFailure =
      when (error) {
        LibraryError.NotFound -> NotFound
        LibraryError.Corrupt -> Corrupt
        LibraryError.UnsupportedFormat -> UnsupportedFormat
        LibraryError.Storage -> Storage
        LibraryError.Limit -> Limit
        LibraryError.Invalid -> Invalid
      }
  }
}

/**
 * The "Copy diagnostics" payload. It holds only app-owned facts: the app version, the renderer's
 * capability set, the last failure code and whether the render watchdog tripped. There is no field
 * for spec contents, prototype storage, network requests, labels or library ids, so none can leak.
 */
data class ViewerDiagnostics(
  val appVersion: String,
  val androidSdk: Int,
  val capabilities: Set<String>,
  val lastFailure: ViewerFailure?,
  val watchdogTripped: Boolean,
) {
  /** Plain text for pasting into a GitHub issue. Keys are fixed and unlocalized. */
  fun format(): String =
    listOf(
        "ProtoViewer diagnostics",
        "platform: android",
        "app-version: $appVersion",
        "android-sdk: $androidSdk",
        "capabilities: ${capabilities.sorted().joinToString(",").ifEmpty { "none" }}",
        "last-error: ${lastFailure?.code ?: "none"}",
        "watchdog-tripped: $watchdogTripped",
      )
      .joinToString("\n")
}

internal fun Context.appVersionName(): String =
  try {
    packageManager.getPackageInfo(packageName, 0).versionName ?: "unknown"
  } catch (error: PackageManager.NameNotFoundException) {
    // Our own package always resolves; keep the action usable if it somehow does not.
    Log.w("ProtoViewer", "Cannot read the app version", error)
    "unknown"
  }

/** Puts [diagnostics] on the clipboard; Android 13+ confirms clipboard writes itself. */
internal fun Context.copyDiagnostics(diagnostics: ViewerDiagnostics) {
  val clipboard = getSystemService(ClipboardManager::class.java) ?: return
  clipboard.setPrimaryClip(
    ClipData.newPlainText(getString(R.string.diagnostics_label), diagnostics.format()),
  )
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
    Toast.makeText(this, R.string.diagnostics_copied, Toast.LENGTH_SHORT).show()
  }
}
