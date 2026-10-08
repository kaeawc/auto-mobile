import Darwin
import Foundation
@testable import NetworkFilterCore
import XCTest

/// Exercises the real process table against the test process itself, so every
/// value is a live capture rather than a hand-written fixture.
final class DarwinProcessTableTests: XCTestCase {
    private let table = DarwinProcessTable()

    private func ownAuditToken() throws -> audit_token_t {
        var token = audit_token_t()
        var count = mach_msg_type_number_t(MemoryLayout<audit_token_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &token) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_AUDIT_TOKEN), $0, &count)
            }
        }
        try XCTSkipUnless(result == KERN_SUCCESS, "TASK_AUDIT_TOKEN unavailable")
        return token
    }

    private func data(_ token: audit_token_t) -> Data {
        withUnsafeBytes(of: token) { Data($0) }
    }

    func testOwnTokenResolvesToThisGeneration() throws {
        let token = try ownAuditToken()
        let generation = try XCTUnwrap(table.generation(auditToken: data(token)))
        XCTAssertEqual(generation.pid, getpid())
        let byToken = try XCTUnwrap(table.process(auditToken: data(token)))
        let byPID = try XCTUnwrap(table.process(pid: getpid()))
        XCTAssertEqual(byToken, byPID)
        XCTAssertEqual(byToken.parentPID, getppid())
        XCTAssertTrue(byToken.executablePath.hasPrefix("/"))
    }

    func testTokenWithAnotherPidVersionDoesNotResolve() throws {
        var token = try ownAuditToken()
        // The same pid with a different pid version is a different (reused) process.
        token.val.7 &+= 1
        XCTAssertEqual(table.generation(auditToken: data(token))?.pid, getpid())
        XCTAssertNil(table.process(auditToken: data(token)))
    }

    func testParentStartedNoLaterThanChild() throws {
        let own = try XCTUnwrap(table.process(pid: getpid()))
        let parent = try XCTUnwrap(table.process(pid: own.parentPID))
        XCTAssertLessThanOrEqual(parent.startTime, own.startTime)
    }

    func testArgumentsMatchThisProcess() throws {
        let own = try XCTUnwrap(table.process(pid: getpid()))
        XCTAssertEqual(table.arguments(of: own), CommandLine.arguments)
    }

    func testArgumentsRejectAnotherProcessGeneration() throws {
        let own = try XCTUnwrap(table.process(pid: getpid()))
        let stale = ProcessRecord(
            pid: own.pid,
            parentPID: own.parentPID,
            startTime: own.startTime &+ 1,
            executablePath: own.executablePath
        )
        XCTAssertNil(table.arguments(of: stale))
    }

    func testMalformedTokenAndMissingPIDDoNotResolve() {
        XCTAssertNil(table.generation(auditToken: Data(count: 31)))
        XCTAssertNil(table.process(auditToken: Data(count: 33)))
        XCTAssertNil(table.process(pid: -1))
    }

    /// The well-formed layout is covered by `testArgumentsMatchThisProcess`.
    func testProcessArgumentsParserRejectsTruncatedBuffers() {
        XCTAssertNil(DarwinProcessTable.parseProcessArguments([1, 0]))
        // argc 2 but only one terminated argument.
        XCTAssertNil(DarwinProcessTable.parseProcessArguments([2, 0, 0, 0] + Array("/x\0\0a\0".utf8)))
    }
}
