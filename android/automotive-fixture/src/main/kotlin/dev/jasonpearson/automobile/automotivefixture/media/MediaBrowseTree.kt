package dev.jasonpearson.automobile.automotivefixture.media

/** A node in the fixed browse tree: browsable when it has children, playable when it has none. */
data class MediaNode(
  val mediaId: String,
  val title: String,
  val subtitle: String,
  val children: List<MediaNode> = emptyList(),
) {
  val isBrowsable: Boolean
    get() = children.isNotEmpty()
}

/** Lookup over a fixed tree. Media ids are unique across the whole tree. */
class MediaBrowseTree(val root: MediaNode) {
  private val byId: Map<String, MediaNode> = buildMap { index(root) }

  init {
    require(byId.size == countNodes(root)) { "Media ids must be unique in the browse tree" }
  }

  fun find(mediaId: String): MediaNode? = byId[mediaId]

  /** Children of a browsable node, or null when the id is unknown or names a playable item. */
  fun childrenOf(parentId: String): List<MediaNode>? =
    byId[parentId]?.takeIf { it.isBrowsable }?.children

  /** The playable item for an id, or null when the id is unknown or names a browsable node. */
  fun playable(mediaId: String): MediaNode? = byId[mediaId]?.takeUnless { it.isBrowsable }

  private fun MutableMap<String, MediaNode>.index(node: MediaNode) {
    put(node.mediaId, node)
    node.children.forEach { index(it) }
  }

  private fun countNodes(node: MediaNode): Int = 1 + node.children.sumOf { countNodes(it) }

  companion object {
    const val ROOT_ID = "fixture_root"

    private fun track(album: String, number: Int, artist: String) =
      MediaNode("${album}_track_$number", "Track $number", artist)

    /** The fixture's browse tree: two albums and a playlist, three tracks each. */
    fun fixture(): MediaBrowseTree =
      MediaBrowseTree(
        MediaNode(
          ROOT_ID,
          "AutoMobile Fixture",
          "Media root",
          listOf(
            MediaNode(
              "albums",
              "Albums",
              "Two albums",
              listOf(
                MediaNode(
                  "album_morning",
                  "Morning Drive",
                  "Fixture Band",
                  (1..3).map { track("album_morning", it, "Fixture Band") },
                ),
                MediaNode(
                  "album_evening",
                  "Evening Drive",
                  "Fixture Trio",
                  (1..3).map { track("album_evening", it, "Fixture Trio") },
                ),
              ),
            ),
            MediaNode(
              "playlists",
              "Playlists",
              "One playlist",
              listOf(
                MediaNode(
                  "playlist_commute",
                  "Commute Mix",
                  "Fixture Mix",
                  (1..3).map { track("playlist_commute", it, "Fixture Mix") },
                ),
              ),
            ),
          ),
        ),
      )
  }
}
