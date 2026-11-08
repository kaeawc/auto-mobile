package dev.jasonpearson.automobile.leanbackfixture

import android.os.Bundle
import androidx.fragment.app.FragmentActivity
import dev.jasonpearson.automobile.sdk.AutoMobileSDK

/**
 * Hosts [FixtureBrowseFragment]; a recreated activity keeps the restored fragment. Each resume
 * reports [LeanbackScreen.BROWSE] to the AutoMobile SDK.
 */
class MainActivity : FragmentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    AutoMobileSDK.initialize(applicationContext)
    if (savedInstanceState == null) {
      supportFragmentManager
        .beginTransaction()
        .replace(android.R.id.content, FixtureBrowseFragment())
        .commit()
    }
  }

  override fun onResume() {
    super.onResume()
    SdkScreenTracker.onScreen(LeanbackScreen.Browse)
  }
}
