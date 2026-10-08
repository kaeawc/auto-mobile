package dev.jasonpearson.automobile.sdk.capabilities

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.DebugInspectorAccess

/**
 * Debug-only app-context endpoint that hands CtrlProxy the versioned capability and capture-policy
 * snapshot (issue #5191). Read-only; every entry point enforces the existing caller policy.
 */
class SdkCapabilitiesProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
    DebugInspectorAccess.enforceCaller(context)
    require(method == "snapshot") { "Unsupported method: $method" }
    return Bundle().apply { putString("result", AutoMobileSDK.capabilities.toSnapshotJson()) }
  }

  override fun query(
    uri: Uri,
    projection: Array<String>?,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String?,
  ): Cursor? {
    DebugInspectorAccess.enforceCaller(context)
    throw UnsupportedOperationException("Use call for the read-only snapshot")
  }

  override fun getType(uri: Uri): String? {
    DebugInspectorAccess.enforceCaller(context)
    return null
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? {
    DebugInspectorAccess.enforceCaller(context)
    throw UnsupportedOperationException("Capability snapshot is read-only")
  }

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int {
    DebugInspectorAccess.enforceCaller(context)
    throw UnsupportedOperationException("Capability snapshot is read-only")
  }

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<String>?,
  ): Int {
    DebugInspectorAccess.enforceCaller(context)
    throw UnsupportedOperationException("Capability snapshot is read-only")
  }
}
