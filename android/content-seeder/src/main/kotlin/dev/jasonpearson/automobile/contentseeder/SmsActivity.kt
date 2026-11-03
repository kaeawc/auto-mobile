package dev.jasonpearson.automobile.contentseeder

import android.app.Activity
import android.os.Bundle

class SmsActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Role eligibility only; this fixture has no message composer.
    finish()
  }
}
