package dev.jasonpearson.automobile.protoviewer

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.net.toUri
import java.io.IOException
import java.io.InputStream
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * The subset of the AboutLibraries `aboutlibraries.json` the licenses screen uses. The Gradle
 * plugin generates the file at build time (#14158); the app links no AboutLibraries runtime.
 */
@Serializable
internal data class LicenseDocument(
  val libraries: List<LicensedLibrary> = emptyList(),
  val licenses: Map<String, LicenseText> = emptyMap(),
)

@Serializable
internal data class LicensedLibrary(
  val uniqueId: String,
  val artifactVersion: String? = null,
  val name: String? = null,
  val website: String? = null,
  val organization: LicenseOwner? = null,
  val developers: List<LicenseOwner> = emptyList(),
  val licenses: List<String> = emptyList(),
) {
  /** The copyright holder shown beside the library: its organization, else its developers. */
  val owner: String?
    get() =
      organization?.name?.takeIf { it.isNotBlank() }
        ?: developers
          .mapNotNull { it.name?.takeIf(String::isNotBlank) }
          .takeIf { it.isNotEmpty() }
          ?.joinToString(", ")

  val displayName: String
    get() = name?.takeIf { it.isNotBlank() } ?: uniqueId
}

@Serializable internal data class LicenseOwner(val name: String? = null)

@Serializable
internal data class LicenseText(
  val name: String? = null,
  val url: String? = null,
  val content: String? = null,
)

private val licenseJson = Json { ignoreUnknownKeys = true }

internal fun parseLicenseDocument(text: String): LicenseDocument =
  licenseJson.decodeFromString(text)

/** Unique ids of libraries that list no license, or one whose full text is not in the document. */
internal fun LicenseDocument.librariesMissingLicense(): List<String> =
  libraries
    .filter { library ->
      library.licenses.isEmpty() || library.licenses.any { licenses[it]?.content.isNullOrBlank() }
    }
    .map { it.uniqueId }

/** Reads and parses the generated notices, or returns null (after logging) when unreadable. */
internal fun loadLicenseDocument(open: () -> InputStream): LicenseDocument? =
  try {
    parseLicenseDocument(open().bufferedReader().use { it.readText() })
  } catch (error: IOException) {
    Log.w("ProtoViewerLicenses", "Cannot read the generated licenses", error)
    null
  } catch (error: SerializationException) {
    Log.w("ProtoViewerLicenses", "Cannot parse the generated licenses", error)
    null
  }

internal const val SECURITY_POLICY_URL =
  "https://github.com/kaeawc/auto-mobile/blob/main/SECURITY.md"

/** Opens the published security policy in the user's browser; false when nothing can show it. */
internal fun launchSecurityPolicy(context: Context): Boolean =
  try {
    context.startActivity(Intent(Intent.ACTION_VIEW, SECURITY_POLICY_URL.toUri()))
    true
  } catch (error: ActivityNotFoundException) {
    Log.w("ProtoViewerSecurity", "No app can open the security policy", error)
    false
  }
