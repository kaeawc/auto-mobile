import Foundation
import SQLite3

/// Full SQLite database driver implementation.
/// iOS equivalent of Android's SQLiteDatabaseDriver.
/// Uses the SQLite C API directly (available on all Apple platforms).
public final class SQLiteDatabaseDriver: DatabaseDriver, @unchecked Sendable {
    private let lock = NSLock()
    private let operationLock = NSLock()
    private let searchPaths: [String]
    private var openDatabases: [String: OpaquePointer] = [:]

    public init() {
        searchPaths = [
            NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true),
            NSSearchPathForDirectoriesInDomains(.libraryDirectory, .userDomainMask, true),
            NSSearchPathForDirectoriesInDomains(.applicationSupportDirectory, .userDomainMask, true),
        ].flatMap { $0 }
    }

    init(searchPaths: [String]) {
        self.searchPaths = searchPaths
    }

    deinit {
        closeAll()
    }

    // MARK: - DatabaseDriver

    public func getDatabases() -> [DatabaseDescriptor] {
        var databases: [DatabaseDescriptor] = []
        var seenPaths = Set<String>()
        let fileManager = FileManager.default
        let extensions = ["sqlite", "db", "sqlite3"]
        let journalSuffixes = ["-journal", "-wal", "-shm"]

        for basePath in searchPaths {
            guard let enumerator = fileManager.enumerator(atPath: basePath) else { continue }
            while let file = enumerator.nextObject() as? String {
                let isJournal = journalSuffixes.contains { file.hasSuffix($0) }
                guard !isJournal else { continue }

                let ext = (file as NSString).pathExtension.lowercased()
                guard extensions.contains(ext) else { continue }

                let fullPath = (basePath as NSString).appendingPathComponent(file)
                guard seenPaths.insert(fullPath).inserted else { continue }
                let attrs = try? fileManager.attributesOfItem(atPath: fullPath)
                let size = attrs?[.size] as? Int64 ?? 0
                databases.append(DatabaseDescriptor(
                    name: (file as NSString).lastPathComponent,
                    path: fullPath,
                    sizeBytes: size
                ))
            }
        }

        return databases.sorted { $0.name < $1.name }
    }

    public func getTables(databasePath: String) -> [String] {
        operationLock.lock()
        defer { operationLock.unlock() }

        guard let db = openDatabase(path: databasePath, readOnly: true) else { return [] }

        let query = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }

        var tables: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let cString = sqlite3_column_text(stmt, 0) {
                let name = String(cString: cString)
                // Filter internal tables
                if !name.hasPrefix("sqlite_") {
                    tables.append(name)
                }
            }
        }
        return tables
    }

    public func getTableData(databasePath: String, table: String, limit: Int, offset: Int) -> TableDataResult {
        operationLock.lock()
        defer { operationLock.unlock() }

        guard let db = openDatabase(path: databasePath, readOnly: true) else {
            return TableDataResult(
                columns: [],
                rows: [],
                totalRows: 0,
                diagnostic: StorageDiagnostic(code: "store_unavailable", message: "Failed to open database read-only")
            )
        }

        // Keep the count and page in one read transaction so concurrent writes
        // cannot make the page and total describe different snapshots.
        _ = sqlite3_exec(db, "BEGIN", nil, nil, nil)
        defer { _ = sqlite3_exec(db, "ROLLBACK", nil, nil, nil) }

        let boundedLimit = max(0, min(limit, 500))
        let boundedOffset = max(0, offset)

        // Get total count
        let countQuery = "SELECT COUNT(*) FROM \"\(sanitizeIdentifier(table))\""
        var countStmt: OpaquePointer?
        var totalRows = 0
        guard sqlite3_prepare_v2(db, countQuery, -1, &countStmt, nil) == SQLITE_OK else {
            let message = sqlite3_errmsg(db).map { String(cString: $0) } ?? "Unknown error"
            return TableDataResult(columns: [], rows: [], totalRows: 0, diagnostic: Self.diagnostic(for: message))
        }
        defer { sqlite3_finalize(countStmt) }
        guard sqlite3_step(countStmt) == SQLITE_ROW else {
            let message = sqlite3_errmsg(db).map { String(cString: $0) } ?? "Unknown error"
            return TableDataResult(columns: [], rows: [], totalRows: 0, diagnostic: Self.diagnostic(for: message))
        }
        totalRows = Int(sqlite3_column_int64(countStmt, 0))

        // Get paginated data
        let dataQuery = "SELECT * FROM \"\(sanitizeIdentifier(table))\" ORDER BY rowid LIMIT ? OFFSET ?"
        var dataStmt: OpaquePointer?
        if sqlite3_prepare_v2(db, dataQuery, -1, &dataStmt, nil) != SQLITE_OK {
            let order = primaryKeyOrder(db: db, table: table)
            let fallbackQuery = order.isEmpty
                ? "SELECT * FROM \"\(sanitizeIdentifier(table))\" LIMIT ? OFFSET ?"
                : "SELECT * FROM \"\(sanitizeIdentifier(table))\" ORDER BY \(order) LIMIT ? OFFSET ?"
            guard sqlite3_prepare_v2(db, fallbackQuery, -1, &dataStmt, nil) == SQLITE_OK else {
                let message = sqlite3_errmsg(db).map { String(cString: $0) } ?? "Unknown error"
                return TableDataResult(
                    columns: [],
                    rows: [],
                    totalRows: totalRows,
                    diagnostic: Self.diagnostic(for: message)
                )
            }
        }
        defer { sqlite3_finalize(dataStmt) }

        sqlite3_bind_int64(dataStmt, 1, sqlite3_int64(boundedLimit))
        sqlite3_bind_int64(dataStmt, 2, sqlite3_int64(boundedOffset))

        let columnCount = Int(sqlite3_column_count(dataStmt))
        var columns: [String] = []
        for i in 0 ..< columnCount {
            if let name = sqlite3_column_name(dataStmt, Int32(i)) {
                columns.append(String(cString: name))
            }
        }

        var rows: [[String?]] = []
        var stepResult = sqlite3_step(dataStmt)
        while stepResult == SQLITE_ROW {
            var row: [String?] = []
            for i in 0 ..< columnCount {
                row.append(getColumnValue(stmt: dataStmt, index: Int32(i)))
            }
            rows.append(row)
            stepResult = sqlite3_step(dataStmt)
        }
        guard stepResult == SQLITE_DONE else {
            let message = sqlite3_errmsg(db).map { String(cString: $0) } ?? "Unknown error"
            return TableDataResult(
                columns: columns,
                rows: rows,
                totalRows: totalRows,
                diagnostic: Self.diagnostic(for: message)
            )
        }

        return TableDataResult(columns: columns, rows: rows, totalRows: totalRows)
    }

    public func getTableStructure(databasePath: String, table: String) -> TableStructureResult {
        operationLock.lock()
        defer { operationLock.unlock() }

        guard let db = openDatabase(path: databasePath, readOnly: true) else {
            return TableStructureResult(
                columns: [],
                diagnostic: StorageDiagnostic(code: "store_unavailable", message: "Failed to open database read-only")
            )
        }

        let query = "PRAGMA table_info(\"\(sanitizeIdentifier(table))\")"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK else {
            let message = sqlite3_errmsg(db).map { String(cString: $0) } ?? "Unknown error"
            return TableStructureResult(columns: [], diagnostic: Self.diagnostic(for: message))
        }
        defer { sqlite3_finalize(stmt) }

        var columns: [ColumnInfo] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let name = sqlite3_column_text(stmt, 1).map { String(cString: $0) } ?? ""
            let type = sqlite3_column_text(stmt, 2).map { String(cString: $0) } ?? ""
            let notNull = sqlite3_column_int(stmt, 3) != 0
            let defaultValue = sqlite3_column_text(stmt, 4).map { String(cString: $0) }
            let pk = sqlite3_column_int(stmt, 5) != 0

            columns.append(ColumnInfo(
                name: name,
                type: type,
                isNullable: !notNull,
                isPrimaryKey: pk,
                defaultValue: defaultValue
            ))
        }

        return TableStructureResult(columns: columns)
    }

    public func executeSQL(databasePath: String, query: String) -> SQLExecutionResult {
        operationLock.lock()
        defer { operationLock.unlock() }

        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let classification = classifySQL(trimmed)
        guard let db = openDatabase(path: databasePath, readOnly: classification.readOnly) else {
            let diagnostic = StorageDiagnostic(
                code: "store_unavailable",
                message: "Failed to open database in \(classification.readOnly ? "read-only" : "read-write") mode"
            )
            return SQLExecutionResult(
                columns: nil,
                rows: nil,
                rowsAffected: 0,
                error: diagnostic.message,
                diagnostic: diagnostic
            )
        }

        if classification.returnsRows {
            return executeQuery(db: db, query: trimmed, includeRowsAffected: !classification.readOnly)
        } else {
            return executeMutation(db: db, query: trimmed)
        }
    }

    // MARK: - Internal Helpers

    private func openDatabase(path: String, readOnly: Bool) -> OpaquePointer? {
        lock.lock()
        let cacheKey = "\(path):\(readOnly ? "ro" : "rw")"
        if let existing = openDatabases[cacheKey] {
            lock.unlock()
            return existing
        }
        lock.unlock()

        let flags = readOnly
            ? SQLITE_OPEN_READONLY
            : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)

        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK else {
            if let db = db {
                sqlite3_close(db)
            }
            return nil
        }

        if !readOnly {
            // Set busy timeout to wait for locks
            sqlite3_busy_timeout(db, 5000)
        }

        lock.lock()
        openDatabases[cacheKey] = db
        lock.unlock()

        return db
    }

    private func classifySQL(_ query: String) -> SQLClassification {
        guard let statement = findTopLevelStatement(in: query) else {
            return SQLClassification(returnsRows: false, readOnly: false)
        }

        switch statement.keyword {
        case "SELECT", "EXPLAIN":
            return SQLClassification(returnsRows: true, readOnly: true)
        case "PRAGMA":
            // PRAGMA is read-only unless it contains '=' (e.g. PRAGMA user_version = 1).
            return SQLClassification(returnsRows: !query.contains("="), readOnly: !query.contains("="))
        case "INSERT", "UPDATE", "DELETE":
            let hasReturning = findTopLevelKeyword(
                in: query,
                from: query.index(statement.index, offsetBy: statement.keyword.count),
                keywords: ["RETURNING"]
            ) != nil
            return SQLClassification(returnsRows: hasReturning, readOnly: false)
        default:
            return SQLClassification(returnsRows: false, readOnly: false)
        }
    }

    private func startsWithKeyword(_ text: String, _ keyword: String) -> Bool {
        matchesKeyword(in: text, at: text.startIndex, keyword: keyword)
    }

    private func matchesKeyword(in text: String, at index: String.Index, keyword: String) -> Bool {
        if index > text.startIndex, isWordChar(text[text.index(before: index)]) {
            return false
        }
        guard text[index...].range(of: keyword, options: [.anchored, .caseInsensitive]) != nil else {
            return false
        }
        guard let next = text.index(index, offsetBy: keyword.count, limitedBy: text.endIndex),
              next < text.endIndex
        else {
            return true
        }
        return !isWordChar(text[next])
    }

    private func isWordChar(_ char: Character) -> Bool {
        char.isLetter || char.isNumber || char == "_"
    }

    private func findTopLevelStatement(in query: String) -> SQLKeyword? {
        let keywords = ["SELECT", "PRAGMA", "EXPLAIN", "INSERT", "UPDATE", "DELETE"]
        if !startsWithKeyword(query, "WITH") {
            return keywords.first(where: { startsWithKeyword(query, $0) }).map {
                SQLKeyword(keyword: $0, index: query.startIndex)
            }
        }

        return findTopLevelKeyword(
            in: query,
            from: query.index(query.startIndex, offsetBy: "WITH".count),
            keywords: keywords
        )
    }

    private func findTopLevelKeyword(in query: String, from start: String.Index, keywords: [String]) -> SQLKeyword? {
        var depth = 0
        var i = start
        var inSingleQuote = false
        var inDoubleQuote = false
        var inBacktickQuote = false
        var inBracketQuote = false
        var inLineComment = false
        var inBlockComment = false

        while i < query.endIndex {
            let char = query[i]
            let nextIndex = query.index(after: i)
            let next = nextIndex < query.endIndex ? query[nextIndex] : nil

            if inLineComment {
                if char == "\n" || char == "\r" {
                    inLineComment = false
                }
            } else if inBlockComment {
                if char == "*", next == "/" {
                    inBlockComment = false
                    i = nextIndex
                }
            } else if inSingleQuote {
                if char == "'", next == "'" {
                    i = nextIndex
                } else if char == "'" {
                    inSingleQuote = false
                }
            } else if inDoubleQuote {
                if char == "\"", next == "\"" {
                    i = nextIndex
                } else if char == "\"" {
                    inDoubleQuote = false
                }
            } else if inBacktickQuote {
                if char == "`" {
                    inBacktickQuote = false
                }
            } else if inBracketQuote {
                if char == "]" {
                    inBracketQuote = false
                }
            } else if char == "-", next == "-" {
                inLineComment = true
                i = nextIndex
            } else if char == "/", next == "*" {
                inBlockComment = true
                i = nextIndex
            } else if char == "'" {
                inSingleQuote = true
            } else if char == "\"" {
                inDoubleQuote = true
            } else if char == "`" {
                inBacktickQuote = true
            } else if char == "[" {
                inBracketQuote = true
            } else if char == "(" {
                depth += 1
            } else if char == ")", depth > 0 {
                depth -= 1
            } else if depth == 0 {
                for keyword in keywords where matchesKeyword(in: query, at: i, keyword: keyword) {
                    return SQLKeyword(keyword: keyword, index: i)
                }
            }
            i = query.index(after: i)
        }
        return nil
    }

    private func executeQuery(
        db: OpaquePointer,
        query: String,
        includeRowsAffected: Bool = false
    )
        -> SQLExecutionResult
    {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK else {
            let error = sqlite3_errmsg(db).map { String(cString: $0) } ?? "Unknown error"
            let diagnostic = Self.diagnostic(for: error)
            return SQLExecutionResult(
                columns: nil,
                rows: nil,
                rowsAffected: 0,
                error: error,
                diagnostic: diagnostic
            )
        }
        defer { sqlite3_finalize(stmt) }

        let columnCount = Int(sqlite3_column_count(stmt))
        var columns: [String] = []
        for i in 0 ..< columnCount {
            if let name = sqlite3_column_name(stmt, Int32(i)) {
                columns.append(String(cString: name))
            }
        }

        var rows: [[String?]] = []
        var bytesRead = 0
        var truncated = false
        var stepResult = sqlite3_step(stmt)
        while stepResult == SQLITE_ROW {
            var row: [String?] = []
            for i in 0 ..< columnCount {
                row.append(getColumnValue(stmt: stmt, index: Int32(i)))
            }
            let rowBytes = row.reduce(0) { $0 + ($1?.utf8.count ?? 0) }
            if rows.count >= 500 || bytesRead + rowBytes > 512 * 1024 {
                truncated = true
                break
            }
            rows.append(row)
            bytesRead += rowBytes
            stepResult = sqlite3_step(stmt)
        }

        if !truncated && stepResult != SQLITE_DONE {
            let error = sqlite3_errmsg(db).map { String(cString: $0) } ?? "Unknown error"
            let diagnostic = Self.diagnostic(for: error)
            return SQLExecutionResult(
                columns: nil,
                rows: nil,
                rowsAffected: 0,
                error: error,
                diagnostic: diagnostic
            )
        }

        let rowsAffected = includeRowsAffected ? Int(sqlite3_changes(db)) : 0
        return SQLExecutionResult(columns: columns, rows: rows, rowsAffected: rowsAffected, truncated: truncated)
    }

    private func executeMutation(db: OpaquePointer, query: String) -> SQLExecutionResult {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK else {
            let error = sqlite3_errmsg(db).map { String(cString: $0) } ?? "Unknown error"
            return SQLExecutionResult(
                columns: nil,
                rows: nil,
                rowsAffected: 0,
                error: error,
                diagnostic: Self.diagnostic(for: error)
            )
        }
        defer { sqlite3_finalize(stmt) }

        let result = sqlite3_step(stmt)
        if result == SQLITE_DONE {
            let changes = Int(sqlite3_changes(db))
            return SQLExecutionResult(columns: nil, rows: nil, rowsAffected: changes)
        } else if result == SQLITE_ROW {
            // RETURNING clause produces rows — collect them like a query
            let columnCount = Int(sqlite3_column_count(stmt))
            var columns: [String] = []
            for i in 0 ..< columnCount {
                if let name = sqlite3_column_name(stmt, Int32(i)) {
                    columns.append(String(cString: name))
                }
            }
            var rows: [[String?]] = []
            var bytesRead = 0
            var truncated = false
            // First row is already stepped
            var finalResult = SQLITE_ROW
            repeat {
                var row: [String?] = []
                for i in 0 ..< columnCount {
                    row.append(getColumnValue(stmt: stmt, index: Int32(i)))
                }
                let rowBytes = row.reduce(0) { $0 + ($1?.utf8.count ?? 0) }
                if rows.count >= 500 || bytesRead + rowBytes > 512 * 1024 {
                    truncated = true
                    break
                }
                rows.append(row)
                bytesRead += rowBytes
                finalResult = sqlite3_step(stmt)
            } while finalResult == SQLITE_ROW
            guard truncated || finalResult == SQLITE_DONE else {
                let error = sqlite3_errmsg(db).map { String(cString: $0) } ?? "Unknown error"
                return SQLExecutionResult(
                    columns: nil,
                    rows: nil,
                    rowsAffected: 0,
                    error: error,
                    diagnostic: Self.diagnostic(for: error)
                )
            }
            let changes = Int(sqlite3_changes(db))
            return SQLExecutionResult(columns: columns, rows: rows, rowsAffected: changes, truncated: truncated)
        } else {
            let error = sqlite3_errmsg(db).map { String(cString: $0) } ?? "Unknown error"
            let diagnostic = Self.diagnostic(for: error)
            return SQLExecutionResult(
                columns: nil,
                rows: nil,
                rowsAffected: 0,
                error: error,
                diagnostic: diagnostic
            )
        }
    }

    private static func diagnostic(for message: String) -> StorageDiagnostic {
        let code: String
        switch message.lowercased() {
        case let value where value.contains("locked") || value.contains("busy"):
            code = "busy_lock"
        case let value where value.contains("malformed") || value.contains("corrupt"):
            code = "corrupt_store"
        case let value where value.contains("no such table") || value.contains("schema"):
            code = "migration_or_schema"
        case let value where value.contains("wal"):
            code = "wal_error"
        default:
            code = "sqlite_error"
        }
        return StorageDiagnostic(code: code, message: message)
    }

    private func getColumnValue(stmt: OpaquePointer?, index: Int32) -> String? {
        guard let stmt = stmt else { return nil }

        switch sqlite3_column_type(stmt, index) {
        case SQLITE_NULL:
            return nil
        case SQLITE_INTEGER:
            return String(sqlite3_column_int64(stmt, index))
        case SQLITE_FLOAT:
            return String(sqlite3_column_double(stmt, index))
        case SQLITE_TEXT:
            if let cString = sqlite3_column_text(stmt, index) {
                return String(cString: cString)
            }
            return nil
        case SQLITE_BLOB:
            if let bytes = sqlite3_column_blob(stmt, index) {
                let count = Int(sqlite3_column_bytes(stmt, index))
                guard count <= 512 * 1024 else { return "[TRUNCATED]" }
                let data = Data(bytes: bytes, count: count)
                return data.base64EncodedString()
            }
            return nil
        default:
            if let cString = sqlite3_column_text(stmt, index) {
                return String(cString: cString)
            }
            return nil
        }
    }

    private func primaryKeyOrder(db: OpaquePointer, table: String) -> String {
        let query = "PRAGMA table_info(\"\(sanitizeIdentifier(table))\")"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK else { return "" }
        defer { sqlite3_finalize(stmt) }
        var columns: [(Int, String)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let sequence = Int(sqlite3_column_int(stmt, 5))
            guard sequence > 0, let name = sqlite3_column_text(stmt, 1) else { continue }
            columns.append((sequence, String(cString: name)))
        }
        return columns.sorted { $0.0 < $1.0 }
            .map { "\"\(sanitizeIdentifier($0.1))\"" }
            .joined(separator: ", ")
    }

    private func sanitizeIdentifier(_ identifier: String) -> String {
        // Escape double quotes in identifier to prevent SQL injection
        return identifier.replacingOccurrences(of: "\"", with: "\"\"")
    }

    /// Close all open database connections.
    public func closeAll() {
        operationLock.lock()
        defer { operationLock.unlock() }

        lock.lock()
        for (_, db) in openDatabases {
            sqlite3_close(db)
        }
        openDatabases.removeAll()
        lock.unlock()
    }
}

private struct SQLClassification {
    let returnsRows: Bool
    let readOnly: Bool
}

private struct SQLKeyword {
    let keyword: String
    let index: String.Index
}
