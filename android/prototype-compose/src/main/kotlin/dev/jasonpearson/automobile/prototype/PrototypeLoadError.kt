package dev.jasonpearson.automobile.prototype

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

/**
 * A spec could not be loaded; no prototype nodes are drawn. The Kotlin validator does not report
 * required capabilities separately: unsupported fields/types surface as [Invalid]. This interface
 * is sealed but may grow; consumers should include an `else` branch in `when`.
 */
sealed interface PrototypeLoadError {
  /**
   * A validator failure.
   *
   * @property path Canonical JSON path rejected by the validator.
   * @property message Canonical explanation from the validator.
   */
  data class Invalid internal constructor(val path: String, val message: String) :
    PrototypeLoadError

  /**
   * Persistence could not be opened.
   *
   * @property message Description of the persistence or serialization failure.
   */
  data class Storage internal constructor(val message: String) : PrototypeLoadError
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

/**
 * Why an embedded prototype dismissed itself. Disposal alone emits no dismissal. Reasons may grow;
 * consumers should include an `else` branch in `when`.
 */
enum class PrototypeDismissReason {
  /** A user gesture, back action, or authored dismiss action. */
  USER,
}
