package dev.jasonpearson.automobile.desktop.core.settings

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FileSettingsProviderTest {

  private val tempDirs = mutableListOf<File>()

  private fun tempSettingsFile(): File {
    val dir = Files.createTempDirectory("am-settings").toFile()
    tempDirs += dir
    return File(dir, "desktop-settings.properties")
  }

  @After
  fun cleanUpTempDirs() {
    tempDirs.forEach { it.deleteRecursively() }
    tempDirs.clear()
  }

  @Test
  fun `returns defaults when the file is absent`() {
    val settings = FileSettingsProvider(tempSettingsFile())
    assertFalse(settings.hasSeenOnboarding)
    assertEquals("dark", settings.themeMode)
    assertEquals("auto", settings.androidIde)
  }

  @Test
  fun `persists values across instances - the onboarding-once fix`() {
    val file = tempSettingsFile()
    FileSettingsProvider(file).apply {
      hasSeenOnboarding = true
      themeMode = "light"
    }
    // A fresh instance (a new app launch) reads the persisted values back.
    val reloaded = FileSettingsProvider(file)
    assertTrue(reloaded.hasSeenOnboarding)
    assertEquals("light", reloaded.themeMode)
  }

  @Test
  fun `writes the backing file on the first set`() {
    val file = tempSettingsFile()
    assertFalse(file.exists())
    FileSettingsProvider(file).hasSeenOnboarding = true
    assertTrue(file.exists())
  }
}
