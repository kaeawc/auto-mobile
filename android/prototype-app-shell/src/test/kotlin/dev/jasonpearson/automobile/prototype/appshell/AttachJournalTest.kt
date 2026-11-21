package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import java.io.RandomAccessFile
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AttachJournalTest {
  @get:Rule val folder = TemporaryFolder()

  private val logs = mutableListOf<String>()
  private val file
    get() = folder.root.resolve("attach-journal.json")

  private val state =
    AttachJournalState(
      appInstanceId = "test-instance",
      showing = 3,
      lastSequence = 8,
      dropped = 2,
      pending =
        listOf(
          PrototypeEvent(
            1,
            "panel",
            7,
            PrototypeEventKind.EMIT,
            "change",
            buildJsonObject { put("text", "こんにちは") },
            emptyMap(),
          ),
        ),
    )

  @Test
  fun `journal round trips identity counters and wire events`() {
    val journal = FileAttachJournal(file, INSTALL, logs::add)
    assertNull(journal.load())
    journal.save(state)
    assertEquals(state, FileAttachJournal(file, INSTALL, logs::add).load())
    assertTrue(logs.isEmpty())
  }

  @Test
  fun `journal written under an earlier install is discarded without logging its payload`() {
    FileAttachJournal(file, INSTALL, logs::add).save(state)
    // `adb install -r` keeps filesDir, so the file survives; only the install identity changes.
    val reinstalled = FileAttachJournal(file, "lastUpdateTime:2", logs::add)
    assertNull(reinstalled.load())
    assertEquals(1, logs.size)
    assertFalse(logs.single().contains("test-instance"))

    reinstalled.save(state.copy(appInstanceId = "new-instance", pending = emptyList()))
    assertEquals("new-instance", reinstalled.load()?.appInstanceId)
    assertNull(FileAttachJournal(file, INSTALL, logs::add).load())
  }

  @Test
  fun `journal replaces the previous snapshot and ignores interrupted temporary writes`() {
    val journal = FileAttachJournal(file, INSTALL, logs::add)
    journal.save(state)
    val temp = folder.root.resolve("attach-journal.json.tmp")
    temp.writeText("partial write")
    assertEquals(state, journal.load())

    val replacement = state.copy(lastSequence = 9, pending = emptyList())
    // A reader that already opened the original inode can still finish reading it.
    file.inputStream().use { original ->
      val originalText = file.readText()
      journal.save(replacement)
      assertEquals(originalText, original.bufferedReader().readText())
    }
    assertEquals(replacement, journal.load())
    assertFalse(temp.exists())
    assertTrue(logs.isEmpty())
  }

  @Test
  fun `corrupt journal logs no payload and the process starts fresh`() = runTest {
    val corrupt = "private-payload"
    file.writeText(corrupt)
    val journal = FileAttachJournal(file, INSTALL, logs::add)
    assertNull(journal.load())
    assertEquals(1, logs.size)
    assertFalse(logs.single().contains(corrupt))

    val process =
      AppAttachProcess(
        "secret",
        backgroundScope,
        appInstanceId = "fresh-instance",
        log = {},
        journal = journal,
      )
    assertEquals("fresh-instance", process.appInstanceId)
    assertEquals("fresh-instance:1", process.nextShowingId())
    assertEquals(1L, process.nextSequence())
    // Issuing a sequence is not written: the emit that follows saves it before delivery.
    assertEquals(
      AttachJournalState("fresh-instance", 1, 0, 0, emptyList()),
      journal.load(),
    )
  }

  @Test
  fun `journal refuses an oversized file`() {
    RandomAccessFile(file, "rw").use { it.setLength(FileAttachJournal.MAX_BYTES + 1L) }
    assertNull(FileAttachJournal(file, INSTALL, logs::add).load())
    assertEquals(1, logs.size)
  }

  @Test
  fun `save failure is logged and preserves the previous snapshot`() {
    val journal = FileAttachJournal(file, INSTALL, logs::add)
    journal.save(state)
    val temp = folder.newFolder("attach-journal.json.tmp")
    temp.resolve("blocked").createNewFile()

    journal.save(state.copy(showing = 4))

    assertEquals(state, journal.load())
    assertEquals(1, logs.size)
  }

  private companion object {
    const val INSTALL = "lastUpdateTime:1"
  }
}
