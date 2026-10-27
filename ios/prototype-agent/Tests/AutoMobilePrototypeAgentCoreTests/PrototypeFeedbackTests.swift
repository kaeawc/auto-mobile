@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Haptic and sound feedback (#14329): the modules, the plan and sound tables, the log ring, the
/// owning node and the session wiring.
@MainActor
final class PrototypeFeedbackTests: XCTestCase {
    private final class FakeHaptics: PrototypeHapticsPlayer {
        var outcome = PrototypeFeedbackOutcome.played
        var performed: [PrototypeHapticEffect] = []
        func perform(_ effect: PrototypeHapticEffect) -> PrototypeFeedbackOutcome {
            performed.append(effect)
            return outcome
        }
    }

    private final class FakeSound: PrototypeSoundPlayer {
        var outcome = PrototypeFeedbackOutcome.played
        var played: [(PrototypeSoundCue, Int?)] = []
        func play(_ cue: PrototypeSoundCue, volume: Int?) -> PrototypeFeedbackOutcome {
            played.append((cue, volume))
            return outcome
        }
    }

    private func call(_ name: String, _ args: [String: JSONValue]) -> PlatformCall {
        PlatformCall(callId: "c", call: name, args: args)
    }

    func testEveryContractEffectAndSoundReachesItsPlayer() async {
        let haptics = FakeHaptics()
        let module = PrototypeHapticsModule(player: haptics)
        for effect in PrototypeHapticEffect.allCases {
            let result = await module.call(call("haptics.perform", ["effect": .string(effect.rawValue)]))
            XCTAssertEqual(result, .success(.object(["suppressed": .bool(false)])), effect.rawValue)
        }
        XCTAssertEqual(haptics.performed, PrototypeHapticEffect.allCases)
        XCTAssertEqual(
            PrototypeHapticEffect.allCases.map(\.rawValue),
            [
                "click",
                "tick",
                "heavyClick",
                "doubleClick",
                "selection",
                "success",
                "warning",
                "error",
                "impactLight",
                "impactMedium",
                "impactHeavy",
                "longPress",
            ]
        )
        let sound = FakeSound()
        let soundModule = PrototypeSoundModule(player: sound)
        for cue in PrototypeSoundCue.allCases {
            _ = await soundModule.call(call("sound.play", ["sound": .string(cue.rawValue)]))
        }
        _ = await soundModule.call(call("sound.play", ["sound": .string("send"), "volume": .number(80)]))
        XCTAssertEqual(sound.played.map(\.0), PrototypeSoundCue.allCases + [.send])
        XCTAssertEqual(sound.played.last?.1, 80)
    }

    func testBadArgumentsFailTypedAndNeverReachAPlayer() async {
        let haptics = FakeHaptics()
        let sound = FakeSound()
        let results = [
            await PrototypeHapticsModule(player: haptics).call(call("haptics.perform", ["effect": .string("buzz")])),
            await PrototypeSoundModule(player: sound).call(call("sound.play", ["sound": .string("cheer")])),
            await PrototypeSoundModule(player: sound).call(
                call("sound.play", ["sound": .string("click"), "volume": .number(101)])
            ),
            await PrototypeSoundModule(player: sound).call(
                call("sound.play", ["sound": .string("click"), "volume": .number(50.5)])
            ),
        ]
        for result in results {
            guard case let .failure(code, _) = result else { return XCTFail("expected failure") }
            XCTAssertEqual(code, .invalidArgs)
        }
        guard case let .failure(code, _) = await PrototypeHapticsModule(player: haptics).call(call(
            "haptics.vibrate",
            [:]
        ))
        else { return XCTFail("expected failure") }
        XCTAssertEqual(code, .unsupported)
        XCTAssertTrue(haptics.performed.isEmpty && sound.played.isEmpty)
    }

    func testUnavailableFailsAndSuppressedSucceedsFlagged() async {
        let haptics = FakeHaptics()
        haptics.outcome = .unavailable
        guard case let .failure(code, _) = await PrototypeHapticsModule(player: haptics)
            .call(call("haptics.perform", ["effect": .string("click")]))
        else { return XCTFail("expected failure") }
        XCTAssertEqual(code, .unavailable)
        haptics.outcome = .suppressed
        let result = await PrototypeHapticsModule(player: haptics).call(call(
            "haptics.perform",
            ["effect": .string("click")]
        ))
        XCTAssertEqual(result, .success(.object(["suppressed": .bool(true)])))
    }

    func testPlansAndSystemSoundsCoverEveryEffectAndCue() {
        XCTAssertEqual(PrototypeHapticPlan.plan(for: .selection), .selection)
        XCTAssertEqual(PrototypeHapticPlan.plan(for: .success), .notification(.success))
        XCTAssertEqual(PrototypeHapticPlan.plan(for: .error), .notification(.error))
        XCTAssertEqual(PrototypeHapticPlan.plan(for: .impactHeavy), .impact(.heavy))
        XCTAssertEqual(PrototypeHapticPlan.plan(for: .doubleClick), .double(.medium, gapMs: 80))
        for effect in PrototypeHapticEffect.allCases {
            _ = PrototypeHapticPlan.plan(for: effect)
        }
        XCTAssertEqual(
            Set(PrototypeSoundCue.allCases.map(PrototypeSystemSound.id(for:))).count,
            PrototypeSoundCue.allCases.count
        )
    }

    func testTheRingKeepsTheNewest64EntriesOldestFirst() {
        var log = PrototypeFeedbackLog()
        for index in 0 ..< 70 {
            log.record(PrototypeFeedbackEntry(
                timeMs: index,
                effect: "tick",
                sound: nil,
                nodeId: nil,
                suppressed: false
            ))
        }
        XCTAssertEqual(log.entries.count, 64)
        XCTAssertEqual(log.entries.first?.timeMs, 6)
        XCTAssertEqual(log.entries.last?.timeMs, 69)
        XCTAssertNil(PrototypeFeedbackLog().wireArray)
    }

    func testEntriesOnlyForSuccessfulFeedbackCalls() {
        let args: [String: JSONValue] = ["effect": .string("tick")]
        XCTAssertNil(PrototypeFeedbackEntry.entry(
            call: "haptics.perform", args: args, result: .failure(.unavailable, "x"), nodeId: nil, timeMs: 1
        ))
        XCTAssertNil(PrototypeFeedbackEntry.entry(
            call: "test.echo", args: args, result: .success(.null), nodeId: nil, timeMs: 1
        ))
        let entry = PrototypeFeedbackEntry.entry(
            call: "haptics.perform", args: args, result: .success(.object(["suppressed": .bool(true)])),
            nodeId: "like", timeMs: 9
        )
        XCTAssertEqual(
            entry?.wireObject,
            .object([
                "timeMs": .number(9),
                "effect": .string("tick"),
                "nodeId": .string("like"),
                "suppressed": .bool(true),
            ])
        )
    }

    private func spec() throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"fb","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["haptics","sound"]},
         "root":{"type":"column","children":[
           {"type":"button","id":"like","label":"Like","onTap":[{"type":"platform","call":"haptics.perform","args":{"effect":{"value":"selection"}}}]},
           {"type":"button","id":"send","label":"Send","onTap":[{"type":"platform","call":"sound.play","args":{"sound":{"value":"send"}}}]}]}}
        """.utf8))
    }

    func testASessionLogsTheCallWithItsNodeAndTimeAndClearsOnShow() throws {
        var session = PrototypeSession()
        try session.show(spec())
        let like = try XCTUnwrap(session.spec?.root.children?.first?.onTap)
        _ = session.run(like)
        let job = try XCTUnwrap(session.takePlatformCommands().compactMap { command -> PrototypePlatformJob? in
            if case let .start(job) = command { return job } else { return nil }
        }.first)
        _ = session.completePlatformCall(
            job.call.callId, .success(.object(["suppressed": .bool(false)])), durationMs: 1, atMs: 1234
        )
        XCTAssertEqual(session.feedbackLog.entries, [
            PrototypeFeedbackEntry(timeMs: 1234, effect: "selection", sound: nil, nodeId: "like", suppressed: false),
        ])
        try session.show(spec())
        XCTAssertTrue(session.feedbackLog.entries.isEmpty)
    }

    func testTheOwningNodeIsTheOnlyNodeHoldingTheCall() throws {
        let spec = try spec()
        let like = try XCTUnwrap(spec.root.children?.first?.onTap?.first)
        XCTAssertEqual(PrototypeNode.owningNodeId(of: like, in: spec.root), "like")
        let orphan = try JSONDecoder().decode(PrototypeAction.self, from: Data(
            #"{"type":"platform","call":"haptics.perform","args":{"effect":{"value":"tick"}}}"#.utf8
        ))
        XCTAssertNil(PrototypeNode.owningNodeId(of: orphan, in: spec.root))
    }
}
