package dev.jasonpearson.automobile.contentseeder

import android.accounts.AbstractAccountAuthenticator
import android.accounts.Account
import android.accounts.AccountAuthenticatorResponse
import android.accounts.AccountManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.IBinder

class SeederAuthenticatorService : Service() {
  private val authenticator by lazy { LocalAuthenticator(this) }

  override fun onBind(intent: Intent): IBinder = authenticator.iBinder

  private class LocalAuthenticator(context: Context) : AbstractAccountAuthenticator(context) {
    override fun editProperties(
      response: AccountAuthenticatorResponse,
      accountType: String,
    ): Bundle = unsupported()

    override fun addAccount(
      response: AccountAuthenticatorResponse,
      accountType: String,
      authTokenType: String?,
      requiredFeatures: Array<out String>?,
      options: Bundle?,
    ): Bundle = unsupported()

    override fun confirmCredentials(
      response: AccountAuthenticatorResponse,
      account: Account,
      options: Bundle?,
    ): Bundle = unsupported()

    override fun getAuthToken(
      response: AccountAuthenticatorResponse,
      account: Account,
      authTokenType: String,
      options: Bundle?,
    ): Bundle = unsupported()

    override fun getAuthTokenLabel(authTokenType: String): String = "No authentication"

    override fun updateCredentials(
      response: AccountAuthenticatorResponse,
      account: Account,
      authTokenType: String?,
      options: Bundle?,
    ): Bundle = unsupported()

    override fun hasFeatures(
      response: AccountAuthenticatorResponse,
      account: Account,
      features: Array<out String>,
    ): Bundle = Bundle().apply { putBoolean(AccountManager.KEY_BOOLEAN_RESULT, false) }

    private fun unsupported(): Bundle =
      Bundle().apply {
        putInt(AccountManager.KEY_ERROR_CODE, AccountManager.ERROR_CODE_UNSUPPORTED_OPERATION)
        putString(AccountManager.KEY_ERROR_MESSAGE, "Local fixture account; seed via SeedReceiver")
      }
  }
}
