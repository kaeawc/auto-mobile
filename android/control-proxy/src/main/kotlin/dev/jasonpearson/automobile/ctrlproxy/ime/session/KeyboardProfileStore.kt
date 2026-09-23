package dev.jasonpearson.automobile.ctrlproxy.ime.session

import android.content.Context
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.KeyboardProfiles

interface KeyboardProfileStore {
  fun activeProfileId(): String

  fun setActiveProfileId(id: String)
}

class SharedPreferencesKeyboardProfileStore(context: Context) : KeyboardProfileStore {
  private val preferences = context.getSharedPreferences("ctrlproxy_keyboard", Context.MODE_PRIVATE)

  override fun activeProfileId(): String {
    val id = preferences.getString("profile_id", KeyboardProfiles.DEFAULT.id)
    return KeyboardProfiles.byId(id.orEmpty())?.id ?: KeyboardProfiles.DEFAULT.id
  }

  override fun setActiveProfileId(id: String) {
    preferences.edit().putString("profile_id", id).apply()
  }
}
