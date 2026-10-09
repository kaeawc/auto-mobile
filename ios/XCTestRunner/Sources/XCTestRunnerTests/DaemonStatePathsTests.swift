import XCTest
@testable import XCTestRunner

/// #10906: the runner must resolve the same control socket and PID file as the daemon it launches
/// (`resolveDaemonStatePath` in `src/daemon/constants.ts`). Both are tested against the shared
/// vectors in `test/fixtures/daemon-isolation-paths.json`, as are the JUnit runner and desktop ports.
final class DaemonStatePathsTests: XCTestCase {
    private struct Vectors: Decodable {
        let uid: String
        let cases: [Vector]
    }

    private struct Vector: Decodable {
        let name: String
        let env: [String: String]
        let suffix: String
        let socketPath: String
        let pidFilePath: String
    }

    private func loadVectors() throws -> Vectors {
        // .../ios/XCTestRunner/Sources/XCTestRunnerTests/DaemonStatePathsTests.swift
        //  -> repo root is five directories up from this source file.
        var repoRoot = URL(fileURLWithPath: #filePath)
        for _ in 0 ..< 5 {
            repoRoot.deleteLastPathComponent()
        }
        let url = repoRoot.appendingPathComponent("test/fixtures/daemon-isolation-paths.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testSocketAndPidPathsMatchTheSharedDaemonVectors() throws {
        let vectors = try loadVectors()
        XCTAssertFalse(vectors.cases.isEmpty)
        // Every vector is absolute or names an absolute launch cwd, so the cwd must never be used.
        let currentDirectory = "/never/used"
        for vector in vectors.cases {
            XCTAssertEqual(
                DaemonStatePaths.isolationSuffix(environment: vector.env, currentDirectory: currentDirectory),
                vector.suffix,
                vector.name
            )
            XCTAssertEqual(
                DaemonStatePaths.resolve(
                    .socket, environment: vector.env, userId: { vectors.uid }, currentDirectory: currentDirectory
                ),
                vector.socketPath,
                vector.name
            )
            XCTAssertEqual(
                DaemonStatePaths.resolve(
                    .pid, environment: vector.env, userId: { vectors.uid }, currentDirectory: currentDirectory
                ),
                vector.pidFilePath,
                vector.name
            )
        }
    }

    func testExplicitOverrideSkipsTheUidLookup() {
        let path = DaemonStatePaths.resolve(
            .socket,
            environment: ["AUTOMOBILE_DAEMON_SOCKET_PATH": "/run/am.sock"],
            userId: {
                XCTFail("an explicit override must not resolve the uid")
                return "0"
            }
        )
        XCTAssertEqual(path, "/run/am.sock")
    }
}
