package dev.jasonpearson.automobile.buildlogic.baselineprofile

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.Deflater
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ApkBaselineProfileTest {
  @get:Rule val tmp = TemporaryFolder()

  private val types = listOf("La/A;", "Lb/B;", "Lc/C;")

  @Test
  fun readsProfiledClassesThroughDexTypeTable() {
    val profile = profile("classes.dex" to listOf(0, 2), methodCount = 5)
    val classes = ArtProfileClasses.read(profile) { if (it == "classes.dex") dex(types) else null }
    assertEquals(setOf("La/A;", "Lc/C;"), classes)
  }

  @Test
  fun resolvesEachDexAgainstItsOwnTypeTable() {
    val profile = profile("classes.dex" to listOf(1), "classes2.dex" to listOf(0), methodCount = 9)
    val dexes = mapOf("classes.dex" to dex(types), "classes2.dex" to dex(listOf("Ld/D;")))
    assertEquals(setOf("Lb/B;", "Ld/D;"), ArtProfileClasses.read(profile, dexes::get))
  }

  @Test
  fun rejectsUnknownProfiles() {
    val notProfile = runCatching { ArtProfileClasses.read(ByteArray(32)) { null } }
    assertTrue(notProfile.exceptionOrNull() is ArtProfileClasses.UnsupportedProfileException)
    val wrongVersion = profile("classes.dex" to listOf(0)).also { it[4] = '9'.code.toByte() }
    val versionError = runCatching { ArtProfileClasses.read(wrongVersion) { dex(types) } }
    assertTrue(versionError.exceptionOrNull()!!.message!!.contains("version"))
  }

  @Test
  fun acceptsProfileListingRequiredClasses() {
    val entries = ApkProfileEntries(true, true, setOf("La/A;", "Lb/B;"))
    assertTrue(ApkBaselineProfile.violations(entries, listOf("La/A;")).isEmpty())
  }

  @Test
  fun reportsMissingEntriesAndClasses() {
    assertEquals(
      listOf(
        "missing APK entry: assets/dexopt/baseline.prof",
        "missing APK entry: assets/dexopt/baseline.profm",
      ),
      ApkBaselineProfile.violations(ApkProfileEntries(false, false, null), listOf("La/A;")),
    )
    assertEquals(
      listOf("assets/dexopt/baseline.prof does not list Lz/Z;"),
      ApkBaselineProfile.violations(ApkProfileEntries(true, true, setOf("La/A;")), listOf("Lz/Z;")),
    )
  }

  @Test
  fun readsProfileFromApk() {
    val apk = tmp.newFile("app.apk")
    ZipOutputStream(apk.outputStream()).use { zip ->
      zip.entry(ApkBaselineProfile.PROFILE_ENTRY, profile("classes.dex" to listOf(1)))
      zip.entry("classes.dex", dex(types))
    }
    val entries = ApkBaselineProfile.read(apk)
    assertEquals(ApkProfileEntries(true, false, setOf("Lb/B;")), entries)
    assertEquals(
      listOf("missing APK entry: assets/dexopt/baseline.profm"),
      ApkBaselineProfile.violations(entries, listOf("Lb/B;")),
    )
  }

  @Test
  fun reportsUnreadableProfile() {
    val apk = tmp.newFile("broken.apk")
    ZipOutputStream(apk.outputStream()).use { zip ->
      zip.entry(ApkBaselineProfile.PROFILE_ENTRY, ByteArray(4))
      zip.entry(ApkBaselineProfile.METADATA_ENTRY, ByteArray(4))
    }
    val entries = ApkBaselineProfile.read(apk)
    assertNull(entries.profiledClasses)
    assertEquals(
      listOf("assets/dexopt/baseline.prof is unreadable: not an ART binary profile"),
      ApkBaselineProfile.violations(entries, emptyList()),
    )
  }

  private fun ZipOutputStream.entry(name: String, bytes: ByteArray) {
    putNextEntry(ZipEntry(name))
    write(bytes)
    closeEntry()
  }

  /** A P-version (010) profile listing the given type indexes per dex, with no hot methods. */
  private fun profile(vararg dexes: Pair<String, List<Int>>, methodCount: Int = 0): ByteArray {
    val body = ByteArrayOutputStream()
    for ((key, classes) in dexes) {
      val keyBytes = key.toByteArray()
      body.write(
        le(keyBytes.size, 2) + le(classes.size, 2) + le(0, 4) + le(0, 4) + le(methodCount, 4),
      )
      body.write(keyBytes)
    }
    for ((_, classes) in dexes) {
      var previous = 0
      for (index in classes) {
        body.write(le(index - previous, 2))
        previous = index
      }
      body.write(ByteArray((methodCount * 2 + 7) / 8))
    }
    val raw = body.toByteArray()
    val deflater = Deflater()
    deflater.setInput(raw)
    deflater.finish()
    val compressed = ByteArray(raw.size + 64)
    val compressedSize = deflater.deflate(compressed)
    deflater.end()
    return "pro\u0000010\u0000".toByteArray() +
      byteArrayOf(dexes.size.toByte()) +
      le(raw.size, 4) +
      le(compressedSize, 4) +
      compressed.copyOf(compressedSize)
  }

  /** A dex image with just the header fields and tables [ArtProfileClasses] reads. */
  private fun dex(descriptors: List<String>): ByteArray {
    val headerSize = 0x70
    val stringIdsOffset = headerSize
    val typeIdsOffset = stringIdsOffset + descriptors.size * 4
    var dataOffset = typeIdsOffset + descriptors.size * 4
    val data = ByteArrayOutputStream()
    val stringOffsets = descriptors.map { descriptor ->
      val offset = dataOffset + data.size()
      data.write(descriptor.length)
      data.write(descriptor.toByteArray())
      data.write(0)
      offset
    }
    dataOffset += data.size()
    val buffer = ByteBuffer.allocate(dataOffset).order(ByteOrder.LITTLE_ENDIAN)
    buffer.putInt(0x38, descriptors.size)
    buffer.putInt(0x3C, stringIdsOffset)
    buffer.putInt(0x40, descriptors.size)
    buffer.putInt(0x44, typeIdsOffset)
    stringOffsets.forEachIndexed { index, offset ->
      buffer.putInt(stringIdsOffset + index * 4, offset)
      buffer.putInt(typeIdsOffset + index * 4, index)
    }
    val bytes = buffer.array()
    data.toByteArray().copyInto(bytes, typeIdsOffset + descriptors.size * 4)
    return bytes
  }

  private fun le(value: Int, size: Int): ByteArray =
    ByteArray(size) { ((value shr (it * 8)) and 0xFF).toByte() }
}
