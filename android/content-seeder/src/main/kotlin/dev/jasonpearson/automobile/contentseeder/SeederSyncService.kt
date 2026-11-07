package dev.jasonpearson.automobile.contentseeder

import android.accounts.Account
import android.app.Service
import android.content.AbstractThreadedSyncAdapter
import android.content.ContentProviderClient
import android.content.Context
import android.content.Intent
import android.content.SyncResult
import android.os.Bundle
import android.os.IBinder

class SeederSyncService : Service() {
  private val adapter by lazy { LocalSyncAdapter(this) }

  override fun onBind(intent: Intent): IBinder = adapter.syncAdapterBinder

  private class LocalSyncAdapter(context: Context) : AbstractThreadedSyncAdapter(context, false) {
    override fun onPerformSync(
      account: Account,
      extras: Bundle,
      authority: String,
      provider: ContentProviderClient,
      syncResult: SyncResult,
    ) {
      // No remote source: all fixture data is inserted by SeedReceiver.
    }
  }
}
