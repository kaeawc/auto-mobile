package dev.jasonpearson.automobile.sdk.carapp

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import dev.jasonpearson.automobile.sdk.DebugInspectorAccess

/**
 * Debug-only, read-only route for Car App Library template snapshots (#16751). It answers `enabled:
 * false` until the app calls `AutoMobileCarAppTemplates.enable`, and never loads a Car App Library
 * class itself, so it is safe in apps that do not link the library.
 */
class CarAppTemplatesProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
    DebugInspectorAccess.enforceCaller(context)
    require(method == "snapshot") { "Unsupported method: $method" }
    return Bundle().apply { putString("result", CarAppTemplateRoute.snapshotJson()) }
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
    throw UnsupportedOperationException("Car app template snapshot is read-only")
  }

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int {
    DebugInspectorAccess.enforceCaller(context)
    throw UnsupportedOperationException("Car app template snapshot is read-only")
  }

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<String>?,
  ): Int {
    DebugInspectorAccess.enforceCaller(context)
    throw UnsupportedOperationException("Car app template snapshot is read-only")
  }
}
