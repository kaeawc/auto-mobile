package dev.jasonpearson.automobile.leanbackfixture

import android.os.Bundle
import android.widget.TextView
import androidx.fragment.app.FragmentActivity
import dev.jasonpearson.automobile.sdk.AutoMobileSDK

/**
 * Shows the title and detail text of the card named by [LeanbackFixtureCatalog.EXTRA_CARD_ID]. Each
 * resume reports [LeanbackScreen.DETAIL] to the AutoMobile SDK.
 */
class DetailActivity : FragmentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // A restored task can start here without MainActivity; initialize is a no-op when already done.
    AutoMobileSDK.initialize(applicationContext)
    setContentView(R.layout.activity_detail)
    val (title, text) =
      LeanbackFixtureCatalog.detailLines(
        intent.getStringExtra(LeanbackFixtureCatalog.EXTRA_CARD_ID),
      )
    findViewById<TextView>(R.id.detail_title).text = title
    findViewById<TextView>(R.id.detail_text).text = text
  }

  override fun onResume() {
    super.onResume()
    SdkScreenTracker.onScreen(
      LeanbackScreen.detail(intent.getStringExtra(LeanbackFixtureCatalog.EXTRA_CARD_ID)),
    )
  }
}
