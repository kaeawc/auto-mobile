package dev.jasonpearson.automobile.automotivefixture.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class MediaBrowseTreeTest {
  private val tree = MediaBrowseTree.fixture()

  @Test
  fun `root lists albums and playlists`() {
    assertEquals(
      listOf("albums", "playlists"),
      tree.childrenOf(MediaBrowseTree.ROOT_ID)?.map { it.mediaId },
    )
  }

  @Test
  fun `album children are three playable tracks`() {
    val tracks = tree.childrenOf("album_morning").orEmpty()
    assertEquals(listOf("Track 1", "Track 2", "Track 3"), tracks.map { it.title })
    assertEquals(listOf(false, false, false), tracks.map { it.isBrowsable })
  }

  @Test
  fun `unknown ids and playable items have no children`() {
    assertNull(tree.childrenOf("missing"))
    assertNull(tree.childrenOf("album_morning_track_1"))
  }

  @Test
  fun `playable resolves only leaf items`() {
    assertEquals("Track 2", tree.playable("playlist_commute_track_2")?.title)
    assertNull(tree.playable("playlists"))
    assertNull(tree.playable("missing"))
  }

  @Test
  fun `search matches a playable title ignoring case`() {
    val match = tree.search("TRACK 3")
    assertEquals("Track 3", match?.title)
    assertEquals(false, match?.isBrowsable)
  }

  @Test
  fun `blank search plays the first playable item`() {
    val first = tree.childrenOf("album_morning")?.first()
    assertEquals(first?.mediaId, tree.search(null)?.mediaId)
    assertEquals(first?.mediaId, tree.search(" ")?.mediaId)
  }

  @Test
  fun `search with no match returns null`() {
    assertNull(tree.search("no such song"))
  }

  @Test
  fun `duplicate media ids are rejected`() {
    val duplicate = MediaNode("dup", "Dup", "Dup")
    assertThrows(IllegalArgumentException::class.java) {
      MediaBrowseTree(MediaNode("root", "Root", "Root", listOf(duplicate, duplicate)))
    }
  }
}
