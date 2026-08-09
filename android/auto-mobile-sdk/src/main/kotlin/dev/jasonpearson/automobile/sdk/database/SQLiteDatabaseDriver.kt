package dev.jasonpearson.automobile.sdk.database

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteReadOnlyDatabaseException
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * SQLite implementation of [DatabaseDriver].
 *
 * Discovers and provides access to SQLite databases within the app's data directory. Databases are
 * opened read-only by default; write access is only used for mutation queries.
 */
class SQLiteDatabaseDriver(private val context: Context) : DatabaseDriver {

  private val databaseLock = Any()
  private val openDatabases = ConcurrentHashMap<String, SQLiteDatabase>()

  override fun getDatabases(): List<DatabaseDescriptor> {
    val declared =
      context
        .databaseList()
        .filterNot { it.isJournalSidecar() }
        .mapNotNull { name ->
          context
            .getDatabasePath(name)
            .takeIf { it.exists() && it.isFile }
            ?.let { file ->
              DatabaseDescriptor(name = name, path = file.absolutePath)
            }
        }

    // Also scan the databases directory. listFiles() returns null when the directory is
    // absent or is not a directory, which the orEmpty() below folds into "nothing found".
    val scanned =
      File(context.applicationInfo.dataDir, "databases")
        .listFiles { file -> file.isFile && !file.name.isJournalSidecar() }
        ?.map { DatabaseDescriptor(name = it.name, path = it.absolutePath) }
        .orEmpty()

    // distinctBy keeps the first occurrence, so databaseList() entries win on a path
    // collision -- the same precedence the previous "only add if not already in list" had.
    return (declared + scanned).distinctBy { it.path }.sortedBy { it.name }
  }

  /** SQLite write-ahead/journal companions that sit next to a real database file. */
  private fun String.isJournalSidecar(): Boolean =
    endsWith("-journal") || endsWith("-wal") || endsWith("-shm")

  override fun getTables(databasePath: String): List<String> {
    synchronized(databaseLock) {
      val db = openDatabase(databasePath, readOnly = true)
      val tables = mutableListOf<String>()

      db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", null).use {
        cursor ->
        while (cursor.moveToNext()) {
          val name = cursor.getString(0)
          // Exclude internal SQLite tables
          if (!name.startsWith("sqlite_") && !name.startsWith("android_")) {
            tables.add(name)
          }
        }
      }

      return tables
    }
  }

  override fun getTableData(
    databasePath: String,
    table: String,
    limit: Int,
    offset: Int,
  ): TableDataResult {
    synchronized(databaseLock) {
      val db = openDatabase(databasePath, readOnly = true)

      // Validate table exists
      if (!tableExists(db, table)) {
        throw DatabaseError.TableNotFound(table)
      }

      // Get total count
      val total =
        db.rawQuery("SELECT COUNT(*) FROM \"${table.replace("\"", "\"\"")}\"", null).use { cursor ->
          cursor.moveToFirst()
          cursor.getInt(0)
        }

      // Get paginated data
      val columns = mutableListOf<String>()
      val rows = mutableListOf<List<Any?>>()

      db
        .rawQuery(
          "SELECT * FROM \"${table.replace("\"", "\"\"")}\" LIMIT ? OFFSET ?",
          arrayOf(limit.toString(), offset.toString()),
        )
        .use { cursor ->
          // Get column names
          columns.addAll(cursor.columnNames)

          // Get row data
          while (cursor.moveToNext()) {
            rows.add((0 until cursor.columnCount).map { getColumnValue(cursor, it) })
          }
        }

      return TableDataResult(columns = columns, rows = rows, total = total)
    }
  }

  override fun getTableStructure(databasePath: String, table: String): TableStructureResult {
    synchronized(databaseLock) {
      val db = openDatabase(databasePath, readOnly = true)

      // Validate table exists
      if (!tableExists(db, table)) {
        throw DatabaseError.TableNotFound(table)
      }

      val columns = mutableListOf<ColumnInfo>()

      db.rawQuery("PRAGMA table_info(\"${table.replace("\"", "\"\"")}\")", null).use { cursor ->
        while (cursor.moveToNext()) {
          // Columns: cid, name, type, notnull, dflt_value, pk
          val name = cursor.getString(1)
          val type = cursor.getString(2) ?: "TEXT"
          val notNull = cursor.getInt(3) == 1
          val defaultValue = if (cursor.isNull(4)) null else cursor.getString(4)
          val isPrimaryKey = cursor.getInt(5) > 0

          columns.add(
            ColumnInfo(
              name = name,
              type = type,
              nullable = !notNull,
              primaryKey = isPrimaryKey,
              defaultValue = defaultValue,
            )
          )
        }
      }

      return TableStructureResult(columns = columns)
    }
  }

  override fun executeSQL(databasePath: String, query: String): SQLExecutionResult {
    synchronized(databaseLock) {
      val trimmedQuery = query.trim()
      val (returnsRows, readOnly) = classifySQL(trimmedQuery)

      return if (returnsRows) {
        executeQuery(databasePath, trimmedQuery, readOnly = readOnly)
      } else {
        executeMutation(databasePath, trimmedQuery)
      }
    }
  }

  /** Executes arbitrary SQL without granting the statement a writable database handle. */
  @JvmSynthetic
  internal fun executeReadOnlySQL(databasePath: String, query: String): SQLExecutionResult.Query {
    synchronized(databaseLock) {
      val trimmedQuery = query.trim()
      val (_, classifiedReadOnly) = classifySQL(stripLeadingSqlComments(trimmedQuery))
      if (!classifiedReadOnly) throw DatabaseError.MutationNotAllowed()

      return executeQuery(
        databasePath,
        trimmedQuery,
        readOnly = true,
        requireExactReadOnly = true,
        mapReadOnlyFailureToPolicyError = true,
      )
    }
  }

  /** Returns whether the coarse statement family is in the read-only allowlist. */
  internal fun isMutationQuery(query: String): Boolean {
    val (_, classifiedReadOnly) = classifySQL(stripLeadingSqlComments(query.trim()))
    return !classifiedReadOnly
  }

  private fun classifySQL(query: String): Pair<Boolean, Boolean> {
    val statement = findTopLevelStatement(query)
    val keyword = statement?.first ?: return Pair(false, false)
    val statementIndex = statement.second

    if (keyword == "SELECT" || keyword == "VALUES" || keyword == "PRAGMA" || keyword == "EXPLAIN") {
      return Pair(true, true)
    }

    if (keyword == "INSERT" || keyword == "UPDATE" || keyword == "DELETE") {
      val hasReturning =
        findTopLevelKeyword(query, statementIndex + keyword.length, listOf("RETURNING")) != null
      return Pair(hasReturning, false)
    }

    return Pair(false, false)
  }

  private fun startsWithKeyword(text: String, keyword: String): Boolean =
    matchesKeywordAt(text, 0, keyword)

  private fun matchesKeywordAt(text: String, index: Int, keyword: String): Boolean {
    if (index > 0 && isWordChar(text[index - 1])) return false
    if (!text.regionMatches(index, keyword, 0, keyword.length, ignoreCase = true)) return false
    val nextChar = text.getOrNull(index + keyword.length)
    return nextChar == null || !isWordChar(nextChar)
  }

  private fun isWordChar(char: Char): Boolean = char.isLetterOrDigit() || char == '_'

  private fun stripLeadingSqlComments(query: String): String {
    var index = 0
    while (index < query.length) {
      while (query.getOrNull(index)?.isWhitespace() == true) index++
      when {
        query.startsWith("--", index) -> {
          val lineEnd = query.indexOfAny(charArrayOf('\n', '\r'), startIndex = index + 2)
          if (lineEnd < 0) return ""
          index = lineEnd + 1
        }
        query.startsWith("/*", index) -> {
          val commentEnd = query.indexOf("*/", startIndex = index + 2)
          if (commentEnd < 0) return ""
          index = commentEnd + 2
        }
        else -> return query.substring(index)
      }
    }
    return ""
  }

  private fun findTopLevelStatement(query: String): Pair<String, Int>? {
    val keywords = listOf("SELECT", "VALUES", "PRAGMA", "EXPLAIN", "INSERT", "UPDATE", "DELETE")
    if (!startsWithKeyword(query, "WITH")) {
      return keywords
        .firstOrNull { keyword -> startsWithKeyword(query, keyword) }
        ?.let { keyword ->
          Pair(keyword, 0)
        }
    }

    return findTopLevelKeyword(
      query,
      "WITH".length,
      keywords,
    )
  }

  private fun findTopLevelKeyword(
    query: String,
    startIndex: Int,
    keywords: List<String>,
  ): Pair<String, Int>? {
    var depth = 0
    var i = startIndex
    var inSingleQuote = false
    var inDoubleQuote = false
    var inBacktickQuote = false
    var inBracketQuote = false
    var inLineComment = false
    var inBlockComment = false

    while (i < query.length) {
      val char = query[i]
      val next = query.getOrNull(i + 1)

      when {
        inLineComment -> if (char == '\n' || char == '\r') inLineComment = false
        inBlockComment -> {
          if (char == '*' && next == '/') {
            inBlockComment = false
            i++
          }
        }
        inSingleQuote -> {
          if (char == '\'' && next == '\'') {
            i++
          } else if (char == '\'') {
            inSingleQuote = false
          }
        }
        inDoubleQuote -> {
          if (char == '"' && next == '"') {
            i++
          } else if (char == '"') {
            inDoubleQuote = false
          }
        }
        inBacktickQuote -> if (char == '`') inBacktickQuote = false
        inBracketQuote -> if (char == ']') inBracketQuote = false
        char == '-' && next == '-' -> {
          inLineComment = true
          i++
        }
        char == '/' && next == '*' -> {
          inBlockComment = true
          i++
        }
        char == '\'' -> inSingleQuote = true
        char == '"' -> inDoubleQuote = true
        char == '`' -> inBacktickQuote = true
        char == '[' -> inBracketQuote = true
        char == '(' -> depth++
        char == ')' && depth > 0 -> depth--
        depth == 0 -> {
          for (keyword in keywords) {
            if (matchesKeywordAt(query, i, keyword)) {
              return Pair(keyword, i)
            }
          }
        }
      }
      i++
    }

    return null
  }

  private fun executeQuery(
    databasePath: String,
    query: String,
    readOnly: Boolean,
    requireExactReadOnly: Boolean = false,
    mapReadOnlyFailureToPolicyError: Boolean = false,
  ): SQLExecutionResult.Query {
    val db =
      openDatabase(
        databasePath,
        readOnly = readOnly,
        requireExactReadOnly = requireExactReadOnly,
      )
    val columns = mutableListOf<String>()
    val rows = mutableListOf<List<Any?>>()

    try {
      db.rawQuery(query, null).use { cursor ->
        columns.addAll(cursor.columnNames)

        while (cursor.moveToNext()) {
          rows.add((0 until cursor.columnCount).map { getColumnValue(cursor, it) })
        }
      }
    } catch (e: SQLiteReadOnlyDatabaseException) {
      if (mapReadOnlyFailureToPolicyError) throw DatabaseError.MutationNotAllowed()
      throw DatabaseError.SqlError(e.message ?: "Unknown SQL error")
    } catch (e: Exception) {
      throw DatabaseError.SqlError(e.message ?: "Unknown SQL error")
    }

    return SQLExecutionResult.Query(columns = columns, rows = rows)
  }

  private fun executeMutation(databasePath: String, query: String): SQLExecutionResult.Mutation {
    val db = openDatabase(databasePath, readOnly = false)

    try {
      // Use compileStatement().executeUpdateDelete() instead of execSQL().
      //
      // On Android 15 (API 35) with WAL-mode databases managed by Room, calling
      // execSQL() fails with "Queries can be performed using SQLiteDatabase query
      // or rawQuery methods only." because Android marks the secondary READWRITE
      // connection as read-only when Room already holds the WAL write connection.
      //
      // compileStatement().executeUpdateDelete() bypasses the Java-level isReadOnly()
      // check and goes directly through the native SQLite connection pool, allowing
      // writes when Room's WAL lock is not actively held.
      //
      // It also returns the affected row count directly, avoiding the need for a
      // separate SELECT changes() call on a potentially different connection.
      val rowsAffected = db.compileStatement(query).executeUpdateDelete()
      return SQLExecutionResult.Mutation(rowsAffected = rowsAffected)
    } catch (e: Exception) {
      throw DatabaseError.SqlError(e.message ?: "Unknown SQL error")
    }
  }

  private fun openDatabase(
    path: String,
    readOnly: Boolean,
    requireExactReadOnly: Boolean = false,
  ): SQLiteDatabase {
    validatePath(path)

    // Check if we have a cached connection with compatible mode
    val cached = openDatabases[path]
    if (cached != null && cached.isOpen) {
      val needsWritableConnection = !readOnly && cached.isReadOnly
      val needsExactReadOnlyConnection = readOnly && requireExactReadOnly && !cached.isReadOnly
      if (needsWritableConnection || needsExactReadOnlyConnection) {
        cached.close()
        openDatabases.remove(path)
      } else {
        return cached
      }
    }

    // Open the database
    val file = File(path)
    if (!file.exists()) {
      throw DatabaseError.NotFound(path)
    }

    val flags = if (readOnly) SQLiteDatabase.OPEN_READONLY else SQLiteDatabase.OPEN_READWRITE

    try {
      val db = SQLiteDatabase.openDatabase(path, null, flags)
      if (!readOnly) {
        setBusyTimeout(db)
      }
      openDatabases[path] = db
      return db
    } catch (e: Exception) {
      throw DatabaseError.SqlError("Failed to open database: ${e.message}")
    }
  }

  private fun setBusyTimeout(db: SQLiteDatabase) {
    // Allow up to 5 seconds waiting for write locks held by Room or other connections.
    // Without this, SQLite fails immediately with "database is locked" if the app has
    // an active write transaction open on the same database.
    //
    // Use compileStatement().execute() instead of execSQL() here for the same reason as
    // in executeMutation: on Android 15 (API 35) with WAL-mode databases, execSQL() calls
    // throwIfReadOnly() which throws even on OPEN_READWRITE connections when Room holds
    // the WAL write connection. compileStatement().execute() bypasses that check.
    try {
      db.compileStatement("PRAGMA busy_timeout=5000").execute()
    } catch (_: RuntimeException) {
      db.rawQuery("PRAGMA busy_timeout=5000", null).use { cursor ->
        while (cursor.moveToNext()) {
          // Exhaust the cursor so SQLite applies the pragma on Robolectric.
        }
      }
    }
  }

  private fun validatePath(path: String) {
    val dataDir = context.applicationInfo.dataDir
    val normalizedPath = File(path).canonicalPath
    val normalizedDataDir = File(dataDir).canonicalPath

    if (
      normalizedPath != normalizedDataDir &&
        !normalizedPath.startsWith(normalizedDataDir + File.separator)
    ) {
      throw DatabaseError.InvalidPath(path)
    }
  }

  private fun tableExists(db: SQLiteDatabase, table: String): Boolean {
    return db
      .rawQuery(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        arrayOf(table),
      )
      .use { cursor -> cursor.count > 0 }
  }

  private fun getColumnValue(cursor: Cursor, columnIndex: Int): Any? {
    return when (cursor.getType(columnIndex)) {
      Cursor.FIELD_TYPE_NULL -> null
      Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(columnIndex)
      Cursor.FIELD_TYPE_FLOAT -> cursor.getDouble(columnIndex)
      Cursor.FIELD_TYPE_STRING -> cursor.getString(columnIndex)
      Cursor.FIELD_TYPE_BLOB -> {
        // Return blob as base64 for JSON serialization
        val blob = cursor.getBlob(columnIndex)
        android.util.Base64.encodeToString(blob, android.util.Base64.NO_WRAP)
      }
      else -> cursor.getString(columnIndex)
    }
  }

  /** Close all open database connections. */
  fun closeAll() {
    synchronized(databaseLock) {
      openDatabases.values.forEach { db ->
        try {
          if (db.isOpen) {
            db.close()
          }
        } catch (_: Exception) {
          // Ignore close errors
        }
      }
      openDatabases.clear()
    }
  }
}
