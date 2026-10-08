import Foundation
@testable import NetworkFilterCore
import XCTest

/// Code identity keyed by the token's pid; counts lookups.
final class FakeIdentityResolver: ProbeIdentityResolver {
    var identifiers: [Int32: String] = [:]
    private(set) var lookups = 0

    func resolve(auditToken: Data) -> ProbeCodeIdentity? {
        lookups += 1
        let words = auditToken.withUnsafeBytes { Array($0.bindMemory(to: UInt32.self)) }
        guard let identifier = identifiers[Int32(bitPattern: words[5])] else { return nil }
        return ProbeCodeIdentity(signingIdentifier: identifier, teamIdentifier: nil, executablePath: nil)
    }
}

final class AppFlowPolicyTests: XCTestCase {
    private var clock = FakeMonotonicClock()
    private var store = NetworkRuleStore(clock: FakeMonotonicClock())
    private var table = FakeProcessTable()
    private var identities = FakeIdentityResolver()
    private var policy: AppFlowPolicy!

    override func setUp() {
        super.setUp()
        clock = FakeMonotonicClock()
        store = NetworkRuleStore(clock: clock)
        table = FakeProcessTable()
        identities = FakeIdentityResolver()
        policy = AppFlowPolicy(store: store, processTable: table, identityResolver: identities)
    }

    private func applyOffline(owner: String = "session-a", revision: UInt64 = 1) {
        let result = store.execute(RuleFixtures.apply(RuleFixtures.ownership(owner, revision: revision)))
        XCTAssertEqual(result.outcome, .applied)
    }

    /// The fixture app on `udid`, signed with `bundleId`.
    @discardableResult
    private func addApp(
        pid: Int32,
        udid: String = CapturedSimulator.udid,
        bundleId: String = RuleFixtures.bundleId
    )
        -> Data
    {
        identities.identifiers[pid] = bundleId
        return table.add(pid: pid, parent: 400, path: CapturedSimulator.appExecutable(udid: udid))
    }

    func testNoActiveRuleAllowsWithoutAnyLookup() {
        let token = addApp(pid: 501)
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token), .allow)
        XCTAssertEqual(table.tokenLookups, 0)
        XCTAssertEqual(identities.lookups, 0)
    }

    func testTargetedAppIsDroppedAndCounted() {
        applyOffline()
        let token = addApp(pid: 501)
        guard case let .drop(ticket) = policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token) else {
            return XCTFail("expected a drop")
        }
        XCTAssertEqual(ticket.revision, 1)
        XCTAssertEqual(store.activeRules().first?.droppedFlows, 1)
    }

    func testSameBundleOnASiblingSimulatorIsAllowed() {
        applyOffline()
        let token = addApp(pid: 502, udid: RuleFixtures.sibling.udid)
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token), .allow)
    }

    func testAnotherAppOnTheTargetedSimulatorIsAllowed() {
        applyOffline()
        let token = addApp(pid: 503, bundleId: "dev.example.other")
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token), .allow)
    }

    func testNativeMacProcessWithTheSameIdentifierIsAllowed() {
        applyOffline()
        identities.identifiers[504] = RuleFixtures.bundleId
        let token = table.add(pid: 504, parent: 1, path: "/Applications/Fixture.app/Contents/MacOS/Fixture")
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token), .allow)
    }

    func testUnattributableFlowsFailOpen() {
        applyOffline()
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: nil), .allow)
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: Data([1, 2, 3])), .allow)
        let exited = FakeProcessTable.token(pid: 777, pidVersion: 1)
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: exited), .allow)
        let unsigned = table.add(pid: 505, parent: 400, path: CapturedSimulator.appExecutable())
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: unsigned), .allow)
    }

    func testDelegatedFlowIsAttributedThroughTheApp() {
        applyOffline()
        let app = addApp(pid: 510)
        table.add(
            pid: 300,
            parent: 1,
            startTime: 100,
            path: CapturedSimulator.launchdSimPath,
            arguments: CapturedSimulator.launchdSimArguments()
        )
        let helper = table.add(pid: 520, parent: 300, path: CapturedSimulator.nsurlsessiondPath)
        identities.identifiers[520] = "com.apple.nsurlsessiond"
        guard case .drop = policy.verdict(sourceAppAuditToken: app, sourceProcessAuditToken: helper) else {
            return XCTFail("a helper acting for the targeted app is dropped")
        }
        // The helper on its own is a system process, never the target.
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: helper), .allow)
    }

    func testExpiredRuleAllows() {
        applyOffline()
        let token = addApp(pid: 501)
        clock.advance(milliseconds: 15000)
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token), .allow)
    }

    func testCodeIdentityIsCachedPerProcessGeneration() {
        applyOffline()
        let token = addApp(pid: 501)
        _ = policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token)
        _ = policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token)
        XCTAssertEqual(identities.lookups, 1)
        // The pid is reused by a new generation: a different token, looked up afresh.
        identities.identifiers[501] = "dev.example.other"
        let reused = table.add(pid: 501, pidVersion: 2, parent: 400, path: CapturedSimulator.appExecutable())
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: reused), .allow)
        XCTAssertEqual(identities.lookups, 2)
    }

    // MARK: - Delayed decisions

    func testResetDuringAttributionAllowsTheFlow() {
        applyOffline()
        let token = addApp(pid: 501)
        table.onTokenLookup = { [store] in
            _ = store.execute(RuleFixtures.reset(RuleFixtures.ownership(revision: 2)))
        }
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token), .allow)
        XCTAssertNil(store.evaluationSnapshot())
    }

    func testExpiryDuringAttributionAllowsTheFlow() {
        applyOffline()
        let token = addApp(pid: 501)
        table.onTokenLookup = { [clock] in clock.advance(milliseconds: 15000) }
        XCTAssertEqual(policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token), .allow)
    }

    func testReapplyDuringAttributionCommitsAgainstTheNewRevision() {
        applyOffline(revision: 1)
        let token = addApp(pid: 501)
        table.onTokenLookup = { [store] in
            _ = store.execute(RuleFixtures.apply(RuleFixtures.ownership(revision: 2)))
        }
        guard case let .drop(ticket) = policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token) else {
            return XCTFail("the target is still offline under the new revision")
        }
        XCTAssertEqual(ticket.revision, 2)
    }

    func testAnotherOwnerTakingOverDuringAttributionStillDropsUnderTheCurrentRule() {
        applyOffline(owner: "session-a", revision: 1)
        let token = addApp(pid: 501)
        table.onTokenLookup = { [store, clock] in
            clock.advance(milliseconds: 15000)
            _ = store.execute(RuleFixtures.apply(RuleFixtures.ownership("session-b", revision: 1)))
        }
        guard case let .drop(ticket) = policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token) else {
            return XCTFail("expected a drop under session-b's rule")
        }
        XCTAssertEqual(ticket.owner, "session-b")
    }
}
