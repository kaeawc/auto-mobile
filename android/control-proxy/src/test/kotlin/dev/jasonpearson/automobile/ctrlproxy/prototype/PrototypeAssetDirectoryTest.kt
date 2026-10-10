package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.File
import java.io.IOException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The production file seam, over a real temporary directory. No Android APIs involved. */
class PrototypeAssetDirectoryTest {
  @get:Rule val temp = TemporaryFolder()

  private fun directory(): Pair<File, PrototypeAssetDirectory> {
    val dir = File(temp.root, "prototype-assets") // not created yet: the first write makes it
    return dir to PrototypeAssetDirectory(dir)
  }

  @Test
  fun `write creates the directory and read returns the bytes`() {
    val (dir, assets) = directory()
    val bytes = byteArrayOf(1, 2, 3)
    assets.write("asset-0", bytes)
    assertTrue(dir.isDirectory)
    assertArrayEquals(bytes, assets.read("asset-0"))
    assertEquals(listOf("asset-0"), dir.list()!!.toList())
  }

  @Test
  fun `read of a missing name is null and delete of a missing name is harmless`() {
    val (_, assets) = directory()
    assertNull(assets.read("asset-9"))
    assets.delete("asset-9")
  }

  @Test
  fun `delete removes only the named file`() {
    val (dir, assets) = directory()
    assets.write("asset-0", byteArrayOf(1))
    assets.write("asset-1", byteArrayOf(2))
    assets.delete("asset-0")
    assertEquals(listOf("asset-1"), dir.list()!!.toList())
  }

  @Test
  fun `deleteAll removes assets and leftover partial files`() {
    val (dir, assets) = directory()
    assets.write("asset-0", byteArrayOf(1))
    File(dir, "asset-7.partial").writeBytes(byteArrayOf(9))
    File(dir, "stray").writeBytes(byteArrayOf(9))
    assets.deleteAll()
    assertEquals(0, dir.list()!!.size)
    assets.write("asset-1", byteArrayOf(2)) // still usable afterwards
    assertArrayEquals(byteArrayOf(2), assets.read("asset-1"))
  }

  @Test
  fun `deleteAll before the directory exists is a no-op`() {
    val (dir, assets) = directory()
    assets.deleteAll()
    assertFalse(dir.exists())
  }

  @Test
  fun `names that are not store tokens never touch the file system`() {
    val (_, assets) = directory()
    for (name in listOf("../escape", "a/b", "asset-1.partial", "hero", "", "asset-")) {
      assertThrows(IllegalArgumentException::class.java) { assets.write(name, byteArrayOf(1)) }
      assertThrows(IllegalArgumentException::class.java) { assets.read(name) }
      assertThrows(IllegalArgumentException::class.java) { assets.delete(name) }
    }
    assertFalse(File(temp.root, "escape").exists())
  }

  @Test
  fun `a write that cannot create the directory fails with IOException`() {
    val blocker = temp.newFile("prototype-assets") // a file where the directory should be
    val assets = PrototypeAssetDirectory(blocker)
    assertThrows(IOException::class.java) { assets.write("asset-0", byteArrayOf(1)) }
    assertTrue(blocker.isFile)
  }
}
