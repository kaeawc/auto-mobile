package dev.jasonpearson.automobile.buildlogic.baselineprofile

import java.io.File
import java.util.zip.ZipFile

/** What an APK's packaged ART profile contains, separated from the file for unit tests. */
data class ApkProfileEntries(
  val hasProfile: Boolean,
  val hasMetadata: Boolean,
  /** Class descriptors the profile lists, or null when it is missing or unreadable. */
  val profiledClasses: Set<String>?,
  /** Why [profiledClasses] could not be read, when the profile exists but is unreadable. */
  val readError: String? = null,
)

/** Checks that an APK ships a baseline profile covering the app's own classes (#17417). */
object ApkBaselineProfile {
  const val PROFILE_ENTRY = "assets/dexopt/baseline.prof"
  const val METADATA_ENTRY = "assets/dexopt/baseline.profm"

  /**
   * Returns violations; empty means the APK ships a profile listing every [requiredClasses]
   * descriptor (for example `Lcom/example/MainActivity;`).
   */
  fun violations(entries: ApkProfileEntries, requiredClasses: List<String>): List<String> =
    buildList {
      if (!entries.hasProfile) add("missing APK entry: $PROFILE_ENTRY")
      if (!entries.hasMetadata) add("missing APK entry: $METADATA_ENTRY")
      entries.readError?.let { add("$PROFILE_ENTRY is unreadable: $it") }
      val classes = entries.profiledClasses ?: return@buildList
      requiredClasses
        .filterNot { it in classes }
        .forEach { add("$PROFILE_ENTRY does not list $it") }
    }

  fun read(apk: File): ApkProfileEntries =
    ZipFile(apk).use { zip ->
      fun bytes(name: String): ByteArray? =
        zip.getEntry(name)?.let { entry -> zip.getInputStream(entry).use { it.readBytes() } }
      val profile = bytes(PROFILE_ENTRY)
      val hasMetadata = zip.getEntry(METADATA_ENTRY) != null
      if (profile == null) return@use ApkProfileEntries(false, hasMetadata, null)
      try {
        ApkProfileEntries(true, hasMetadata, ArtProfileClasses.read(profile, ::bytes))
      } catch (error: ArtProfileClasses.UnsupportedProfileException) {
        ApkProfileEntries(true, hasMetadata, null, error.message)
      }
    }
}
