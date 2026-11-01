package dev.jasonpearson.automobile.playground

import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.util.Xml
import java.io.File
import java.io.IOException
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserException

/** Reads directly so framework recovery cannot hide or delete the damaged fixture. */
internal class AppFileReader {
  private val errorHandler = DatabaseErrorHandler {
    throw SQLiteDatabaseCorruptException("Corrupt database: ${it.path}")
  }

  fun read(file: File, seed: Boolean = false): Result<String> = runCatching {
    val isXml = file.name.endsWith(".xml")
    if (seed && !file.exists()) seed(file, isXml)
    if (!file.isFile || file.length() == 0L) throw IOException("Missing or empty file: $file")
    if (isXml) readXml(file) else readDatabase(file)
  }

  private fun seed(file: File, isXml: Boolean) {
    val parent = file.parentFile ?: throw IOException("Missing parent directory")
    if (!parent.isDirectory && !parent.mkdirs()) throw IOException("Cannot create $parent")
    // Never replace an existing file, including an empty or already corrupted fixture.
    if (!file.createNewFile()) return
    if (isXml) {
      file.writeText(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><map><string name=\"probe\">ok</string></map>",
      )
    } else {
      SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE, errorHandler)
        .use {
          it.execSQL("CREATE TABLE probe (value TEXT NOT NULL)")
          it.execSQL("INSERT INTO probe (value) VALUES ('ok')")
        }
    }
  }

  private fun readXml(file: File): String {
    val parser = Xml.newPullParser()
    parser.setFeature("http://xmlpull.org/v1/doc/features.html#relaxed", false)
    var elements = 0
    file.inputStream().use { input ->
      parser.setInput(input, null)
      while (parser.next() != XmlPullParser.END_DOCUMENT) {
        if (parser.eventType == XmlPullParser.START_TAG) elements++
      }
    }
    if (elements == 0) throw XmlPullParserException("Missing XML root element")
    return "XML elements=$elements"
  }

  private fun readDatabase(file: File): String {
    SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY, errorHandler).use {
      db ->
      db.rawQuery("PRAGMA integrity_check", null).use { cursor ->
        if (!cursor.moveToFirst()) throw SQLiteDatabaseCorruptException("No integrity_check result")
        do {
          val detail = cursor.getString(0)
          if (detail != "ok") throw SQLiteDatabaseCorruptException(detail)
        } while (cursor.moveToNext())
      }
    }
    return "SQLite integrity_check=ok"
  }
}
