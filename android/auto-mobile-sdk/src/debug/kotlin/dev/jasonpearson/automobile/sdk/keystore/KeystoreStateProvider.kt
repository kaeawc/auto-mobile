package dev.jasonpearson.automobile.sdk.keystore

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.DebugInspectorAccess
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityDescriptor
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityState

/** Debug-only app-context endpoint; every entry point enforces the existing caller policy. */
class KeystoreStateProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    registerCapability()
    return true
  }

  private fun registerCapability() {
    AutoMobileSDK.registerCapability(
      SdkCapabilityDescriptor("storage.keystore", SdkCapabilityState.DISABLED),
    )
  }

  override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
    DebugInspectorAccess.enforceCaller(context)
    // Re-contribute after SDK shutdown clears the registry.
    registerCapability()
    val response =
      KeystoreStateHandler(AndroidKeystoreBackend(), AndroidDeviceLockProbe(context))
        .handle(method, extras?.getString("scope"), extras?.getString("alias"))
    return Bundle().apply { putString("result", response.toString()) }
  }

  override fun query(
    uri: Uri,
    projection: Array<String>?,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String?,
  ): Cursor? {
    DebugInspectorAccess.enforceCaller(context)
    throw UnsupportedOperationException("Use call for read-only metadata")
  }

  override fun getType(uri: Uri): String? {
    DebugInspectorAccess.enforceCaller(context)
    return null
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? {
    DebugInspectorAccess.enforceCaller(context)
    throw UnsupportedOperationException("Keystore mutation is unsupported")
  }

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int {
    DebugInspectorAccess.enforceCaller(context)
    throw UnsupportedOperationException("Keystore mutation is unsupported")
  }

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<String>?,
  ): Int {
    DebugInspectorAccess.enforceCaller(context)
    throw UnsupportedOperationException("Keystore mutation is unsupported")
  }
}
