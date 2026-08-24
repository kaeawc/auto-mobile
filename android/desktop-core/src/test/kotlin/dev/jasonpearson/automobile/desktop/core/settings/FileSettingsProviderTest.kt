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
  fun `defaults the live-mirror quality settings`() {
    val settings = FileSettingsProvider(tempSettingsFile())
    assertEquals("medium", settings.streamQualityPreset)
    assertTrue(settings.streamQualityAutoAdjust)
  }

  @Test
  fun `persists the live-mirror quality settings across instances`() {
    val file = tempSettingsFile()
    FileSettingsProvider(file).apply {
      streamQualityPreset = "high"
      streamQualityAutoAdjust = false
    }
    val reloaded = FileSettingsProvider(file)
    assertEquals("high", reloaded.streamQualityPreset)
    assertFalse(reloaded.streamQualityAutoAdjust)
  }

  @Test
  fun `writes the backing file on the first set`() {
    val file = tempSettingsFile()
    assertFalse(file.exists())
    FileSettingsProvider(file).hasSeenOnboarding = true
    assertTrue(file.exists())
  }

  @Test
  fun `a malformed settings file falls back to clean defaults, not a partial mix`() {
    val file = tempSettingsFile()
    // A valid onboarding line followed by a malformed \u escape: Properties.load reads the first
    // entry and then throws, so a naive load would retain hasSeenOnboarding=true. The atomic load
    // must discard the whole parse and leave defaults.
    file.writeText("hasSeenOnboarding=true\nthemeMode=\\uZZZZ\n")
    val settings = FileSettingsProvider(file)
    assertFalse(settings.hasSeenOnboarding)
    assertEquals("dark", settings.themeMode)
  }

  @Test
  fun `saving replaces atomically and leaves no stray temp files`() {
    val file = tempSettingsFile()
    val settings = FileSettingsProvider(file)
    settings.hasSeenOnboarding = true
    settings.themeMode = "light"
    // The atomic temp-then-move write cleans up its temp — only the settings file remains.
    val dir = requireNotNull(file.parentFile)
    assertEquals(listOf(file.name), dir.list().orEmpty().sorted())
    // And the fully-written file reads back intact.
    val reloaded = FileSettingsProvider(file)
    assertTrue(reloaded.hasSeenOnboarding)
    assertEquals("light", reloaded.themeMode)
  }
}
