package dev.jasonpearson.automobile.buildlogic.protoviewer

import java.io.File
import java.security.cert.X509Certificate
import java.util.jar.JarFile

/** Facts read from a built AAB, separated from the file so the rules are unit-testable. */
data class AabContents(
  val entryNames: Set<String>,
  /** Subject DNs of the certificates that signed every verified entry. */
  val signerSubjects: List<String>,
  /** Payload entries (outside `META-INF/`) that carry no verified signature. */
  val unsignedEntries: List<String> = emptyList(),
)

/** Checks a ProtoViewer app bundle is what Play will accept (#14146). */
object ProtoViewerAabInspector {
  const val MAPPING_ENTRY = "BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map"
  private const val DEBUG_SUBJECT_MARKER = "CN=Android Debug"

  /** Returns violations; empty means the bundle passes. */
  fun violations(
    contents: AabContents,
    requireReleaseSignature: Boolean,
    requireMapping: Boolean,
  ): List<String> {
    val violations = mutableListOf<String>()
    for (required in listOf("BundleConfig.pb", "base/manifest/AndroidManifest.xml")) {
      if (required !in contents.entryNames) violations.add("missing bundle entry: $required")
    }
    if (contents.entryNames.none { it.startsWith("base/dex/") && it.endsWith(".dex") }) {
      violations.add("missing bundle entry: base/dex/*.dex")
    }
    if (requireMapping && MAPPING_ENTRY !in contents.entryNames) {
      violations.add("missing R8 mapping: $MAPPING_ENTRY (minification is expected to be on)")
    }
    if (requireReleaseSignature) {
      if (contents.signerSubjects.isEmpty()) {
        violations.add("bundle is not signed")
      } else {
        if (contents.signerSubjects.any { it.contains(DEBUG_SUBJECT_MARKER) }) {
          violations.add("bundle is signed with the Android debug certificate")
        }
        if (contents.unsignedEntries.isNotEmpty()) {
          violations.add("bundle has unsigned entries: ${contents.unsignedEntries.sorted()}")
        }
      }
    }
    return violations
  }

  /**
   * Reads entry names and verified signer subjects; every entry is read so signatures are checked.
   */
  fun read(bundle: File): AabContents =
    JarFile(bundle, true).use { jar ->
      val names = mutableSetOf<String>()
      val subjects = sortedSetOf<String>()
      val unsigned = sortedSetOf<String>()
      for (entry in jar.entries().asSequence().filterNot { it.isDirectory }) {
        names.add(entry.name)
        jar.getInputStream(entry).use { it.copyTo(java.io.OutputStream.nullOutputStream()) }
        if (!entry.name.startsWith("META-INF/")) {
          val signers = entry.codeSigners
          if (signers == null) {
            unsigned.add(entry.name)
          } else {
            signers
              .flatMap { it.signerCertPath.certificates }
              .filterIsInstance<X509Certificate>()
              .forEach { subjects.add(it.subjectX500Principal.name) }
          }
        }
      }
      AabContents(names, subjects.toList(), unsigned.toList())
    }
}
