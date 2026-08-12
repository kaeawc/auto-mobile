package dev.jasonpearson.automobile.desktop.core.platform

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.util.Properties
import java.util.jar.Attributes
import java.util.jar.Manifest

private val LOG = LoggerFactory.getLogger("PackagedVersionSource")

/** Property key written into the generated version resource by the desktop-app build. */
private const val VERSION_PROPERTY = "version"

/** Manifest attribute the desktop-app build stamps onto its jar, used to disambiguate the scan. */
private const val MANIFEST_TITLE = "AutoMobile"

/**
 * Resolves the packaged version string, preferring the build-generated [resourceName] classpath
 * resource (deterministic across jpackage's runtime image) and falling back to scanning classpath
 * jar manifests for the one stamped `Implementation-Title: AutoMobile`.
 *
 * Both lookups are classpath-global, so this works no matter which module's jar carries the value —
 * the reader does not couple to a specific main-class package. Returns null when neither yields a
 * value (unpackaged runs), which [AppVersion.of] maps to [AppVersion.Dev].
 *
 * The [classLoader] is injectable so tests can point the manifest scan at a controlled classpath;
 * production uses this class's own loader.
 */
class PackagedVersionSource(
  private val resourceName: String = "automobile-version.properties",
  private val classLoader: ClassLoader = PackagedVersionSource::class.java.classLoader,
) : VersionSource {

  override fun resolve(): String? = fromResource() ?: fromManifests()

  private fun fromResource(): String? {
    val stream = classLoader.getResourceAsStream(resourceName) ?: return null
    return try {
      stream.use { versionFromProperties(it.readBytes().decodeToString()) }
    } catch (error: Exception) {
      // Best-effort: a malformed resource must not crash startup — fall through to the manifest.
      LOG.warn("Failed to read version resource '$resourceName': ${error.message}", error)
      null
    }
  }

  private fun fromManifests(): String? =
    try {
      classLoader
        .getResources("META-INF/MANIFEST.MF")
        .asSequence()
        .firstNotNullOfOrNull(::readManifestVersion)
    } catch (error: Exception) {
      // Best-effort: manifest enumeration failures leave us at the Dev sentinel, never a crash.
      LOG.warn("Failed to scan classpath manifests for app version: ${error.message}", error)
      null
    }

  /**
   * Reads one manifest's AutoMobile version. A single malformed manifest anywhere on the classpath
   * must not abort the scan (a later jar may be ours), so its failure is swallowed here rather than
   * by the enumeration's catch.
   */
  private fun readManifestVersion(url: java.net.URL): String? =
    try {
      url.openStream().use { versionFromManifest(Manifest(it)) }
    } catch (error: Exception) {
      // A broken third-party manifest is expected noise; keep scanning.
      LOG.debug("Skipping unreadable manifest at $url: ${error.message}")
      null
    }
}

/** Parses the generated `version=...` properties text. Non-blank [VERSION_PROPERTY] wins. */
internal fun versionFromProperties(text: String): String? {
  val parsed = Properties().apply { load(text.reader()) }
  return parsed.getProperty(VERSION_PROPERTY)?.takeIf { it.isNotBlank() }
}

/** Reads `Implementation-Version` from a manifest, but only if it is the AutoMobile app jar. */
internal fun versionFromManifest(manifest: Manifest): String? {
  val attrs = manifest.mainAttributes
  val title = attrs.getValue(Attributes.Name.IMPLEMENTATION_TITLE)
  if (title != MANIFEST_TITLE) return null
  return attrs.getValue(Attributes.Name.IMPLEMENTATION_VERSION)?.takeIf { it.isNotBlank() }
}
