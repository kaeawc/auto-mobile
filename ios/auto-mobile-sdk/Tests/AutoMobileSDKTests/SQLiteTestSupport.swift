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

/// Replaces SQLite's sleep seam while the synchronous operation runs. The first busy sleep releases
/// the app lock; returning the requested duration advances SQLite's retry budget without real sleep.
/// Registering a VFS leaves the driver's actual busy handler and configured timeout intact.
enum SQLiteTestBusySleeper {
    private final class State {
        let holder: OpaquePointer
        var sleeps: [Int32] = []

        init(holder: OpaquePointer) { self.holder = holder }
    }

    private static let lock = NSLock()
    private nonisolated(unsafe) static var states: [UInt: State] = [:]

    private static let sleep: @convention(c) (UnsafeMutablePointer<sqlite3_vfs>?, Int32)
        -> Int32 = { vfs, microseconds in
            guard let vfs else { return 0 }
            lock.lock()
            defer { lock.unlock() }
            guard let state = states[UInt(bitPattern: vfs)] else { return 0 }
            state.sleeps.append(microseconds)
            if state.sleeps.count == 1 {
                sqlite3_exec(state.holder, "ROLLBACK", nil, nil, nil)
            }
            return microseconds
        }

    static func releasingLockOnBusySleep<T>(holder: OpaquePointer, operation: () throws -> T) throws -> (T, [Int32]) {
        let original = try XCTUnwrap(sqlite3_vfs_find(nil))
        let vfs = UnsafeMutablePointer<sqlite3_vfs>.allocate(capacity: 1)
        vfs.initialize(to: original.pointee)
        let name = try XCTUnwrap(strdup("sqlite-test-\(UUID().uuidString)"))
        vfs.pointee.zName = UnsafePointer(name)
        vfs.pointee.pNext = nil
        vfs.pointee.xSleep = sleep
        let state = State(holder: holder)
        lock.lock()
        states[UInt(bitPattern: vfs)] = state
        lock.unlock()
        defer {
            sqlite3_vfs_register(original, 1)
            sqlite3_vfs_unregister(vfs)
            lock.lock()
            states.removeValue(forKey: UInt(bitPattern: vfs))
            lock.unlock()
            free(name)
            vfs.deinitialize(count: 1)
            vfs.deallocate()
        }
        let registered = sqlite3_vfs_register(vfs, 1)
        guard registered == SQLITE_OK else {
            throw NSError(domain: "SQLiteTestBusySleeper", code: Int(registered))
        }
        // Any connections opened by the operation must close before this VFS is unregistered.
        let result = try operation()
        return (result, state.sleeps)
    }
}
