import Foundation
import SQLite3
import XCTest

/// Real temporary SQLite files in a per-test directory, plus raw connections that stand in for the
/// host app's own SQLite usage. Everything stays on the host; no simulator is involved.
final class SQLiteTestFixture {
    let directoryURL: URL
    let databaseURL: URL

    init(name: String = "app.sqlite") throws {
        directoryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        databaseURL = directoryURL.appendingPathComponent(name)
    }

    var path: String { databaseURL.path }

    func cleanUp() {
        try? FileManager.default.removeItem(at: directoryURL)
    }

    /// Creates the database file from scratch with one `t(v)` table holding `value`.
    func createDatabase(value: String) throws {
        let connection = try openRaw()
        defer { sqlite3_close(connection) }
        try Self.exec(connection, "CREATE TABLE t (v TEXT)")
        try Self.exec(connection, "INSERT INTO t (v) VALUES ('\(value)')")
    }

    /// Removes the database and its journal siblings, like an app resetting its store.
    func deleteDatabase() throws {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let url = URL(fileURLWithPath: path + suffix)
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
        }
    }

    func openRaw() throws -> OpaquePointer {
        var connection: OpaquePointer?
        guard sqlite3_open(path, &connection) == SQLITE_OK, let connection else {
            throw NSError(domain: "SQLiteTestFixture", code: 1)
        }
        return connection
    }

    func values() throws -> [String] {
        let connection = try openRaw()
        defer { sqlite3_close(connection) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection, "SELECT v FROM t ORDER BY rowid", -1, &statement, nil) == SQLITE_OK else {
            throw NSError(domain: "SQLiteTestFixture", code: 2)
        }
        defer { sqlite3_finalize(statement) }
        var result: [String] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            result.append(sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? "")
        }
        return result
    }

    static func exec(_ connection: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(connection, sql, nil, nil, nil) == SQLITE_OK else {
            throw NSError(
                domain: "SQLiteTestFixture",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(connection))]
            )
        }
    }
}
