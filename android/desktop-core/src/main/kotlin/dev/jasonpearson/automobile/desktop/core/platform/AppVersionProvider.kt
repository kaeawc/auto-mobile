package dev.jasonpearson.automobile.desktop.core.platform

/** Supplies the running app's [AppVersion]. Consumers (e.g. the update checker) depend on this. */
fun interface AppVersionProvider {
  fun current(): AppVersion
}

/**
 * The raw version-string lookup seam, kept separate from [AppVersionProvider] so unit tests can
 * feed a fixed string or null without a packaged jar or a classpath resource. The production
 * implementation is [PackagedVersionSource].
 */
fun interface VersionSource {
  /** Returns the packaged version string, or null when running unpackaged (dev/IDE/hot-reload). */
  fun resolve(): String?
}

/**
 * Turns a [VersionSource] into an [AppVersionProvider] by mapping its raw string through
 * [AppVersion.of]. All the interesting behavior (blank/absent → [AppVersion.Dev], raw preserved
 * otherwise) lives in that pure mapping so it is exercised here with a fake source.
 */
class RuntimeAppVersionProvider(private val source: VersionSource) : AppVersionProvider {
  override fun current(): AppVersion = AppVersion.of(source.resolve())
}
