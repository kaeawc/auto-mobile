package dev.jasonpearson.automobile.ctrlproxy

/**
 * Releases every named registration even when some fail: an already-unregistered receiver throws,
 * and that must not leave the receivers after it registered on a destroyed service. Each failure
 * goes to [onFailure] with its name.
 */
// A failed release must not stop the rest; the caller logs each one.
@Suppress("TooGenericExceptionCaught")
internal fun <T> releaseEach(
  registrations: List<Pair<String, T>>,
  release: (T) -> Unit,
  onFailure: (name: String, error: Exception) -> Unit,
) {
  for ((name, registration) in registrations) {
    try {
      release(registration)
    } catch (e: Exception) {
      onFailure(name, e)
    }
  }
}
