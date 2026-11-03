package dev.jasonpearson.automobile.protoviewer

import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * Local report/block state (#16437). Hide keys on the spec SHA-256 recorded at import, so only this
 * content is hidden; Block keys on the link-origin host, which is the only sender identity a
 * received bundle has. Neither reads anything from bundle bytes.
 */
interface ContentBlocklist {
  fun hiddenSpecHashes(): Set<String>

  fun blockedHosts(): Set<String>

  fun hide(specSha256: String)

  fun block(host: String)
}

class SharedPreferencesContentBlocklist(private val preferences: SharedPreferences) :
  ContentBlocklist {
  override fun hiddenSpecHashes(): Set<String> = read(HIDDEN)

  override fun blockedHosts(): Set<String> = read(BLOCKED)

  @Synchronized
  override fun hide(specSha256: String) {
    require(SPEC_HASH.matches(specSha256)) { "Not a spec SHA-256" }
    add(HIDDEN, specSha256)
  }

  @Synchronized
  override fun block(host: String) {
    require(validSourceHost(host)) { "Not a link-origin host" }
    add(BLOCKED, host)
  }

  // getStringSet returns a live set that must not be mutated; always copy.
  private fun read(key: String): Set<String> =
    preferences.getStringSet(key, emptySet()).orEmpty().toSet()

  private fun add(key: String, value: String) {
    preferences.edit { putStringSet(key, read(key) + value) }
  }

  private companion object {
    const val HIDDEN = "hidden_spec_sha256"
    const val BLOCKED = "blocked_source_hosts"
    val SPEC_HASH = Regex("[a-f0-9]{64}")
  }
}

/** Report, Hide and Block apply to content another person sent, not the user's own prototypes. */
internal val LibrarySource.isReceived: Boolean
  get() = this == LibrarySource.file || this == LibrarySource.share

internal val LibraryEntry.isReceived: Boolean
  get() = source.isReceived

internal fun LibraryEntry.isBlockedBy(hidden: Set<String>, hosts: Set<String>): Boolean =
  isBlocked(source, specSha256, sourceHost, hidden, hosts)

private fun isBlocked(
  source: LibrarySource,
  specSha256: String,
  sourceHost: String?,
  hidden: Set<String>,
  hosts: Set<String>,
): Boolean =
  source.isReceived && (specSha256 in hidden || (sourceHost != null && sourceHost in hosts))

/** Lowercase DNS host name, as the link importer records it; no port, user info or IP literal. */
internal fun validSourceHost(host: String): Boolean =
  host.length <= MAX_HOST_LENGTH && SOURCE_HOST.matches(host)

private const val MAX_HOST_LENGTH = 253
private val SOURCE_HOST =
  Regex("(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?")

/** Whether received content with this hash or link host is hidden or blocked on this device. */
internal fun ContentBlocklist.rejects(
  source: LibrarySource,
  specSha256: String,
  sourceHost: String? = null,
): Boolean = isBlocked(source, specSha256, sourceHost, hiddenSpecHashes(), blockedHosts())

/**
 * Hides received content from a hidden spec or blocked host everywhere the library is read: the
 * list, MCP `open` and the viewer all see a blocked entry as not found.
 */
class BlocklistLibraryRepository(
  private val delegate: LibraryRepository,
  private val blocklist: ContentBlocklist,
) : LibraryRepository by delegate {
  override fun list(): LibraryResult<List<LibraryEntry>> =
    when (val listed = delegate.list()) {
      is LibraryResult.Failure -> listed
      is LibraryResult.Success -> {
        val hidden = blocklist.hiddenSpecHashes()
        val hosts = blocklist.blockedHosts()
        LibraryResult.Success(listed.value.filterNot { it.isBlockedBy(hidden, hosts) })
      }
    }

  override fun get(libraryId: String): LibraryResult<LibraryPrototype> =
    when (val loaded = delegate.get(libraryId)) {
      is LibraryResult.Failure -> loaded
      is LibraryResult.Success ->
        if (loaded.value.entry.isBlockedBy(blocklist.hiddenSpecHashes(), blocklist.blockedHosts()))
          LibraryResult.Failure(LibraryError.NotFound)
        else loaded
    }

  /**
   * Deletes every stored entry the blocklist hides, so hidden content never holds library quota
   * (#16631). Only the hash or host stays, in the blocklist. Returns the deleted entries; an entry
   * whose delete fails stays hidden and is retried on the next purge.
   */
  fun purgeBlocked(): LibraryResult<List<LibraryEntry>> =
    when (val listed = delegate.list()) {
      is LibraryResult.Failure -> listed
      is LibraryResult.Success -> {
        val hidden = blocklist.hiddenSpecHashes()
        val hosts = blocklist.blockedHosts()
        LibraryResult.Success(
          listed.value
            .filter { it.isBlockedBy(hidden, hosts) }
            .filter { delegate.delete(it.libraryId) is LibraryResult.Success },
        )
      }
    }
}
