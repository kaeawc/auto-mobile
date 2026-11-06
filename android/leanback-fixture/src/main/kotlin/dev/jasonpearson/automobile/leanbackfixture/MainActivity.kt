package dev.jasonpearson.automobile.leanbackfixture

import android.os.Bundle
import androidx.fragment.app.FragmentActivity

/** Hosts [FixtureBrowseFragment]; a recreated activity keeps the restored fragment. */
class MainActivity : FragmentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_main)
    if (savedInstanceState == null) {
      supportFragmentManager
        .beginTransaction()
        .replace(R.id.browse_container, FixtureBrowseFragment())
        .commit()
    }
  }
}
