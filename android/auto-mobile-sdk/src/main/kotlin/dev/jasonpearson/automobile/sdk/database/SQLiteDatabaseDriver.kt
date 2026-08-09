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
      val (returnsRows, readOnly) = classifySQL(stripLeadingSqlComments(trimmedQuery))

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

    if (keyword == "SELECT" || keyword == "VALUES") {
      return Pair(true, true)
    }

    if (keyword == "EXPLAIN") {
      return Pair(true, isReadOnlyExplain(query, statementIndex))
    }

    if (keyword == "PRAGMA") {
      return Pair(true, isReadOnlyPragma(query, statementIndex))
    }

    if (keyword == "INSERT" || keyword == "UPDATE" || keyword == "DELETE") {
      val hasReturning =
        findTopLevelKeyword(query, statementIndex + keyword.length, listOf("RETURNING")) != null
      return Pair(hasReturning, false)
    }

    return Pair(false, false)
  }

  private fun isReadOnlyExplain(query: String, statementIndex: Int): Boolean {
    var explainedIndex = skipSqlTrivia(query, statementIndex + "EXPLAIN".length) ?: return false
    if (matchesKeywordAt(query, explainedIndex, "QUERY")) {
      explainedIndex = skipSqlTrivia(query, explainedIndex + "QUERY".length) ?: return false
      if (!matchesKeywordAt(query, explainedIndex, "PLAN")) return false
      explainedIndex = skipSqlTrivia(query, explainedIndex + "PLAN".length) ?: return false
    }

    val explainedQuery = query.substring(explainedIndex)
    val explainedStatement = findTopLevelStatement(explainedQuery)
    if (explainedStatement?.first != "PRAGMA") return true

    return isReadOnlyPragma(explainedQuery, explainedStatement.second)
  }

  private fun isReadOnlyPragma(query: String, statementIndex: Int): Boolean {
    var index = skipSqlTrivia(query, statementIndex + "PRAGMA".length) ?: return false

    val firstIdentifier = readIdentifier(query, index) ?: return false
    var pragmaName = firstIdentifier.first
    index = skipSqlTrivia(query, firstIdentifier.second) ?: return false

    if (query.getOrNull(index) == '.') {
      val pragmaIdentifier = readIdentifier(query, index + 1) ?: return false
      pragmaName = pragmaIdentifier.first
      index = skipSqlTrivia(query, pragmaIdentifier.second) ?: return false
    }

    pragmaName = pragmaName.lowercase()
    if (!isObservablePragma(pragmaName)) return false

    val suffix = query.substring(index).trim()
    if (hasOnlyPragmaTerminatorAndComments(suffix)) return true

    return isObservablePragmaWithArgument(pragmaName) && hasSinglePragmaArgument(suffix)
  }

  private fun hasSinglePragmaArgument(suffix: String): Boolean {
    val parenthesized = suffix.startsWith('(')
    if (!parenthesized && !suffix.startsWith('=')) return false

    var index = skipSqlTrivia(suffix, 1) ?: return false
    if (suffix.getOrNull(index) == '+' || suffix.getOrNull(index) == '-') index++
    index = readPragmaValueEnd(suffix, index) ?: return false
    index = skipSqlTrivia(suffix, index) ?: return false

    if (parenthesized) {
      if (suffix.getOrNull(index) != ')') return false
      index++
    }

    return hasOnlyPragmaTerminatorAndComments(suffix.substring(index))
  }

  private fun readPragmaValueEnd(text: String, startIndex: Int): Int? {
    var index = startIndex
    val quoteEnd =
      when (text.getOrNull(index)) {
        '\'',
        '"' -> text[index]
        '`' -> '`'
        '[' -> ']'
        else -> null
      }
    if (quoteEnd != null) {
      index++
      while (index < text.length) {
        if (text[index] == quoteEnd) {
          if (quoteEnd != ']' && text.getOrNull(index + 1) == quoteEnd) {
            index += 2
            continue
          }
          return index + 1
        }
        index++
      }
      return null
    }

    if (
      text.getOrNull(index)?.isDigit() == true ||
        (text.getOrNull(index) == '.' && text.getOrNull(index + 1)?.isDigit() == true)
    ) {
      return readNumericLiteralEnd(text, index)
    }

    val valueStart = index
    while (text.getOrNull(index)?.let(::isWordChar) == true) index++
    return index.takeIf { it > valueStart }
  }

  private fun readNumericLiteralEnd(text: String, startIndex: Int): Int? {
    var index = startIndex
    var hasDigits = false

    while (text.getOrNull(index)?.isDigit() == true) {
      hasDigits = true
      index++
    }
    if (text.getOrNull(index) == '.') {
      index++
      while (text.getOrNull(index)?.isDigit() == true) {
        hasDigits = true
        index++
      }
    }
    if (!hasDigits) return null

    if (text.getOrNull(index)?.let { it == 'e' || it == 'E' } == true) {
      index++
      if (text.getOrNull(index)?.let { it == '+' || it == '-' } == true) index++
      val exponentStart = index
      while (text.getOrNull(index)?.isDigit() == true) index++
      if (index == exponentStart) return null
    }

    return index
  }

  private fun hasOnlyPragmaTerminatorAndComments(suffix: String): Boolean {
    var index = 0
    var hasTerminator = false

    while (index < suffix.length) {
      while (suffix.getOrNull(index)?.isWhitespace() == true) index++
      if (index >= suffix.length) return true

      when {
        suffix.startsWith("--", index) -> {
          val lineEnd = suffix.indexOfAny(charArrayOf('\n', '\r'), startIndex = index + 2)
          if (lineEnd < 0) return true
          index = lineEnd + 1
        }
        suffix.startsWith("/*", index) -> {
          val commentEnd = suffix.indexOf("*/", startIndex = index + 2)
          if (commentEnd < 0) return false
          index = commentEnd + 2
        }
        suffix[index] == ';' && !hasTerminator -> {
          hasTerminator = true
          index++
        }
        else -> return false
      }
    }

    return true
  }

  // OPEN_READONLY blocks database-file writes, but some PRAGMAs mutate connection or process
  // state. Keep policy-enforced access to an explicit observation allowlist.
  private fun isObservablePragma(pragmaName: String): Boolean =
    when (pragmaName) {
      "application_id",
      "collation_list",
      "compile_options",
      "data_version",
      "database_list",
      "encoding",
      "foreign_key_check",
      "foreign_key_list",
      "freelist_count",
      "function_list",
      "index_info",
      "index_list",
      "index_xinfo",
      "integrity_check",
      "module_list",
      "page_count",
      "page_size",
      "pragma_list",
      "quick_check",
      "schema_version",
      "table_info",
      "table_list",
      "table_xinfo",
      "user_version" -> true
      else -> false
    }

  private fun isObservablePragmaWithArgument(pragmaName: String): Boolean =
    when (pragmaName) {
      "foreign_key_check",
      "foreign_key_list",
      "index_info",
      "index_list",
      "index_xinfo",
      "integrity_check",
      "quick_check",
      "table_info",
      "table_list",
      "table_xinfo" -> true
      else -> false
    }

  private fun readIdentifier(query: String, startIndex: Int): Pair<String, Int>? {
    var index = skipSqlTrivia(query, startIndex) ?: return null
    val quoteEnd =
      when (query.getOrNull(index)) {
        '"' -> '"'
        '`' -> '`'
        '[' -> ']'
        else -> null
      }
    if (quoteEnd != null) {
      val identifier = StringBuilder()
      index++
      while (index < query.length) {
        val char = query[index]
        if (char == quoteEnd) {
          if (quoteEnd != ']' && query.getOrNull(index + 1) == quoteEnd) {
            identifier.append(quoteEnd)
            index += 2
            continue
          }
          return Pair(identifier.toString(), index + 1)
        }
        identifier.append(char)
        index++
      }
      return null
    }

    val identifierStart = index
    while (query.getOrNull(index)?.let(::isWordChar) == true) index++
    if (identifierStart == index) return null
    return Pair(query.substring(identifierStart, index), index)
  }

  private fun skipSqlTrivia(query: String, startIndex: Int): Int? {
    var index = startIndex
    while (index < query.length) {
      while (query.getOrNull(index)?.let(::isSqlTriviaWhitespace) == true) index++
      when {
        query.startsWith("--", index) -> {
          val lineEnd = query.indexOfAny(charArrayOf('\n', '\r'), startIndex = index + 2)
          if (lineEnd < 0) return query.length
          index = lineEnd + 1
        }
        query.startsWith("/*", index) -> {
          val commentEnd = query.indexOf("*/", startIndex = index + 2)
          if (commentEnd < 0) return null
          index = commentEnd + 2
        }
        else -> return index
      }
    }
    return index
  }

  private fun startsWithKeyword(text: String, keyword: String): Boolean =
    matchesKeywordAt(text, 0, keyword)

  private fun matchesKeywordAt(text: String, index: Int, keyword: String): Boolean {
    if (index > 0 && isWordChar(text[index - 1])) return false
    if (!text.regionMatches(index, keyword, 0, keyword.length, ignoreCase = true)) return false
    val nextChar = text.getOrNull(index + keyword.length)
    return nextChar == null || !isWordChar(nextChar)
  }

  private fun isWordChar(char: Char): Boolean =
    char != '\uFEFF' && (char.isLetterOrDigit() || char == '_' || char == '$' || char.code >= 0x80)

  private fun isSqlTriviaWhitespace(char: Char): Boolean = char.isWhitespace() || char == '\uFEFF'

  private fun stripLeadingSqlComments(query: String): String {
    var index = 0
    while (index < query.length) {
      while (query.getOrNull(index)?.let(::isSqlTriviaWhitespace) == true) index++
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
      requireCompletedGroupSinceLastComma = true,
    )
  }

  private fun findTopLevelKeyword(
    query: String,
    startIndex: Int,
    keywords: List<String>,
    requireCompletedGroupSinceLastComma: Boolean = false,
  ): Pair<String, Int>? {
    var depth = 0
    var completedGroupSinceLastComma = false
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
        char == ')' && depth > 0 -> {
          depth--
          if (depth == 0) completedGroupSinceLastComma = true
        }
        char == ',' && depth == 0 -> completedGroupSinceLastComma = false
        depth == 0 && (!requireCompletedGroupSinceLastComma || completedGroupSinceLastComma) -> {
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
