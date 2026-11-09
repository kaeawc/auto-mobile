package dev.jasonpearson.automobile.leanbackfixture

import android.content.Intent
import android.os.Bundle
import androidx.leanback.app.BrowseSupportFragment
import androidx.leanback.widget.ArrayObjectAdapter
import androidx.leanback.widget.HeaderItem
import androidx.leanback.widget.ListRow
import androidx.leanback.widget.ListRowPresenter
import androidx.leanback.widget.OnItemViewClickedListener

/**
 * The Leanback browse screen: a headers column with one header per row, and rows of cards. With no
 * search listener set, Leanback shows no search orb, so nothing on screen asks for audio.
 */
class FixtureBrowseFragment : BrowseSupportFragment() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    title = LeanbackFixtureCatalog.BROWSE_TITLE
    headersState = HEADERS_ENABLED
    isHeadersTransitionOnBackEnabled = true
    adapter =
      ArrayObjectAdapter(ListRowPresenter()).apply {
        LeanbackFixtureCatalog.rows.forEach { row ->
          val cards = ArrayObjectAdapter(CardPresenter()).apply { addAll(0, row.cards) }
          add(ListRow(HeaderItem(row.headerId, row.title), cards))
        }
      }
    onItemViewClickedListener = OnItemViewClickedListener { _, item, _, _ ->
      val card = item as? FixtureCard ?: return@OnItemViewClickedListener
      startActivity(
        Intent(requireContext(), DetailActivity::class.java)
          .putExtra(LeanbackFixtureCatalog.EXTRA_CARD_ID, card.id),
      )
    }
  }
}
