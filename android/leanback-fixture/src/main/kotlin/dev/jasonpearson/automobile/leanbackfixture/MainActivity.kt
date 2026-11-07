package dev.jasonpearson.automobile.leanbackfixture

import android.os.Bundle
import androidx.fragment.app.FragmentActivity

/** Hosts [FixtureBrowseFragment]; a recreated activity keeps the restored fragment. */
class MainActivity : FragmentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (savedInstanceState == null) {
      supportFragmentManager
        .beginTransaction()
        .replace(android.R.id.content, FixtureBrowseFragment())
        .commit()
    }
  }
}
