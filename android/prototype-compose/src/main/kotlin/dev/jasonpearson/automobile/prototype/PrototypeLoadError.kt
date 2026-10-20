package dev.jasonpearson.automobile.prototype

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

/**
 * A spec could not be loaded; no prototype nodes are drawn. The Kotlin validator does not report
 * required capabilities separately: unsupported fields/types surface as [Invalid].
 */
sealed interface PrototypeLoadError {
  /**
   * A validator failure.
   *
   * @property path Canonical JSON path rejected by the validator.
   * @property message Canonical explanation from the validator.
   */
  data class Invalid(val path: String, val message: String) : PrototypeLoadError

  /**
   * Persistence could not be opened.
   *
   * @property message Description of the I/O failure.
   */
  data class Storage(val message: String) : PrototypeLoadError
}

/** Visible fallback used when the embedding app does not supply custom error content. */
@Composable
fun DefaultPrototypeError(error: PrototypeLoadError) {
  Text(
    when (error) {
      is PrototypeLoadError.Invalid -> "Cannot load prototype at ${error.path}: ${error.message}"
      is PrototypeLoadError.Storage -> "Cannot load prototype storage: ${error.message}"
    },
  )
}

/** Why an embedded prototype dismissed itself. Disposal alone emits no dismissal. */
enum class PrototypeDismissReason {
  /** A user gesture, back action, or authored dismiss action. */
  USER,
  /** Removed by an agent. */
  AGENT,
  /** Its host disconnected. */
  DISCONNECT,
  /** Its lifetime expired. */
  TTL,
  /** Its host shut down. */
  TEARDOWN,
}
