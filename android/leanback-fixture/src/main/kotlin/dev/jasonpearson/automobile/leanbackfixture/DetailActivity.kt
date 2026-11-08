package dev.jasonpearson.automobile.leanbackfixture

import android.os.Bundle
import android.widget.TextView
import androidx.fragment.app.FragmentActivity

/** Shows the title and detail text of the card named by [LeanbackFixtureCatalog.EXTRA_CARD_ID]. */
class DetailActivity : FragmentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_detail)
    val (title, text) =
      LeanbackFixtureCatalog.detailLines(
        intent.getStringExtra(LeanbackFixtureCatalog.EXTRA_CARD_ID),
      )
    findViewById<TextView>(R.id.detail_title).text = title
    findViewById<TextView>(R.id.detail_text).text = text
  }
}
