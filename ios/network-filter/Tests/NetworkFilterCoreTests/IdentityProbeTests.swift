import Foundation
@testable import NetworkFilterCore
import XCTest

final class IdentityProbeTests: XCTestCase {
    func testOnlyInactiveProviderResponseIsTransientDuringReadbackStartup() {
        XCTAssertTrue(ProbeReadbackStartupState.isTransient(ProbeReadbackStartupState.inactiveProviderMessage))
        XCTAssertFalse(ProbeReadbackStartupState.isTransient("Unsupported identity-probe protocol version"))
        XCTAssertFalse(ProbeReadbackStartupState.isTransient(nil))
    }

    private final class FakeResolver: ProbeIdentityResolver {
        var tokens: [Data] = []
        var identity: ProbeCodeIdentity?
        var onResolve: (() -> Void)?

        func resolve(auditToken: Data) -> ProbeCodeIdentity? {
            tokens.append(auditToken)
            onResolve?()
            return identity
        }
    }

    func testMissingTokensRemainUnattributed() {
        let resolver = FakeResolver()
        let probe = IdentityProbe(resolver: resolver)
        probe.record(sourceAppAuditToken: nil, sourceProcessAuditToken: nil)
        XCTAssertEqual(probe.snapshot().observedFlows, 1)
        XCTAssertEqual(probe.snapshot().flows, [ProbeFlow(sourceApp: nil, sourceProcess: nil, delegated: nil)])
        XCTAssertTrue(resolver.tokens.isEmpty)
    }

    func testMalformedTokensNeverReachSecurityResolver() {
        let resolver = FakeResolver()
        let probe = IdentityProbe(resolver: resolver)
        probe.record(sourceAppAuditToken: Data([1]), sourceProcessAuditToken: Data(count: 33))
        XCTAssertEqual(probe.snapshot().flows.count, 1)
        XCTAssertTrue(resolver.tokens.isEmpty)
    }

    func testDelegatedProcessIsRecordedSeparately() {
        let probe = IdentityProbe(resolver: FakeResolver())
        let app = Data(repeating: 1, count: 32)
        let helper = Data(repeating: 2, count: 32)
        probe.record(sourceAppAuditToken: app, sourceProcessAuditToken: helper)
        XCTAssertEqual(probe.snapshot().flows.first?.sourceApp?.auditToken, app)
        XCTAssertEqual(probe.snapshot().flows.first?.sourceProcess?.auditToken, helper)
        XCTAssertEqual(probe.snapshot().flows.first?.delegated, true)
    }

    func testProcessGenerationSurvivesSamePIDAndBundleIdentifier() {
        let resolver = FakeResolver()
        resolver.identity = ProbeCodeIdentity(signingIdentifier: "same.app", teamIdentifier: nil, executablePath: nil)
        let probe = IdentityProbe(resolver: resolver)
        let first = Data(repeating: 1, count: 32)
        var second = first
        second[31] = 2
        probe.record(sourceAppAuditToken: first, sourceProcessAuditToken: first)
        probe.record(sourceAppAuditToken: second, sourceProcessAuditToken: second)
        XCTAssertEqual(probe.snapshot().flows.count, 2)
        XCTAssertEqual(probe.snapshot().flows.first?.sourceApp?.auditToken, first)
        XCTAssertEqual(probe.snapshot().flows.last?.sourceApp?.auditToken, second)
        XCTAssertEqual(probe.snapshot().flows.first?.delegated, false)
    }

    func testFailedCodeLookupPreservesTokenWithoutClaimingAttribution() {
        let probe = IdentityProbe(resolver: FakeResolver())
        let token = Data(repeating: 9, count: 32)
        probe.record(sourceAppAuditToken: token, sourceProcessAuditToken: nil)
        XCTAssertEqual(probe.snapshot().flows.first?.sourceApp?.auditToken, token)
        XCTAssertNil(probe.snapshot().flows.first?.sourceApp?.code)
        XCTAssertNil(probe.snapshot().flows.first?.delegated)
        XCTAssertEqual(probe.snapshot().mode, "allow_only")
        XCTAssertFalse(probe.snapshot().limitations.isEmpty)
    }

    func testBoundedHistoryKeepsNewestFlows() {
        let probe = IdentityProbe(resolver: FakeResolver())
        for index in 0 ..< IdentityProbe.capacity + 5 {
            probe.record(sourceAppAuditToken: Data(repeating: UInt8(index), count: 32), sourceProcessAuditToken: nil)
        }
        let snapshot = probe.snapshot()
        XCTAssertEqual(snapshot.observedFlows, UInt64(IdentityProbe.capacity + 5))
        XCTAssertEqual(snapshot.discardedFlows, 5)
        XCTAssertEqual(snapshot.flows.count, IdentityProbe.capacity)
        XCTAssertEqual(snapshot.flows.first?.sourceApp?.auditToken, Data(repeating: 5, count: 32))
    }

    func testRestartStartsWithNoRetainedIdentity() {
        let resolver = FakeResolver()
        let before = IdentityProbe(resolver: resolver)
        before.record(sourceAppAuditToken: Data(count: 32), sourceProcessAuditToken: nil)
        let after = IdentityProbe(resolver: resolver)
        XCTAssertTrue(after.snapshot().flows.isEmpty)
        XCTAssertEqual(after.snapshot().observedFlows, 0)
    }

    func testFlowCallbackDoesNotPerformSecurityLookup() {
        let resolver = FakeResolver()
        let probe = IdentityProbe(resolver: resolver)
        probe.record(sourceAppAuditToken: Data(count: 32), sourceProcessAuditToken: Data(count: 32))
        XCTAssertTrue(resolver.tokens.isEmpty)
        _ = probe.snapshot()
        XCTAssertEqual(resolver.tokens.count, 2)
    }

    func testBridgeRejectsUnknownVersionWithoutResolvingIdentities() {
        let resolver = FakeResolver()
        let probe = IdentityProbe(resolver: resolver)
        probe.record(sourceAppAuditToken: Data(count: 32), sourceProcessAuditToken: nil)
        var replies = 0
        ProbeService(probe: probe).snapshot(version: 99) { data, error in
            replies += 1
            XCTAssertNil(data)
            XCTAssertNotNil(error)
        }
        XCTAssertEqual(replies, 1)
        XCTAssertTrue(resolver.tokens.isEmpty)
    }

    func testBridgeReturnsVersionedReadback() throws {
        let probe = IdentityProbe(resolver: FakeResolver())
        probe.record(sourceAppAuditToken: nil, sourceProcessAuditToken: nil)
        var response: Data?
        let service = ProbeService(probe: probe)
        XCTAssertTrue(service.finishStartup(generation: service.stopOrBeginStartup(), succeeded: true))
        service.snapshot(version: IdentityProbe.version) { data, error in
            response = data
            XCTAssertNil(error)
        }
        let snapshot = try JSONDecoder().decode(ProbeSnapshot.self, from: XCTUnwrap(response))
        XCTAssertEqual(snapshot.version, IdentityProbe.version)
        XCTAssertEqual(snapshot.observedFlows, 1)
        XCTAssertEqual(snapshot.mode, "allow_only")
    }

    func testStoppedProviderRejectsLateStartupCompletion() {
        let service = ProbeService(probe: IdentityProbe(resolver: FakeResolver()))
        let starting = service.stopOrBeginStartup()
        service.stopOrBeginStartup()
        XCTAssertFalse(service.finishStartup(generation: starting, succeeded: true))
        service.snapshot(version: IdentityProbe.version) { data, error in
            XCTAssertNil(data)
            XCTAssertNotNil(error)
        }
    }

    func testRestartDuringMetadataLookupRejectsStaleReadback() {
        let resolver = FakeResolver()
        let probe = IdentityProbe(resolver: resolver)
        probe.record(sourceAppAuditToken: Data(count: 32), sourceProcessAuditToken: nil)
        let service = ProbeService(probe: probe)
        XCTAssertTrue(service.finishStartup(generation: service.stopOrBeginStartup(), succeeded: true))
        resolver.onResolve = {
            XCTAssertTrue(service.finishStartup(generation: service.stopOrBeginStartup(), succeeded: true))
        }
        service.snapshot(version: IdentityProbe.version) { data, error in
            XCTAssertNil(data)
            XCTAssertNotNil(error)
        }
    }
}
