@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Pure behaviour of `style.effects` (#15130), driven by the shared contract fixtures and mirroring
/// Android's `PrototypeEffectsTest`. No GPU: the shaders themselves are device-verified.
final class PrototypeEffectsTests: XCTestCase {
    private func fixture(_ name: String) throws -> PrototypeSpec {
        let url = PrototypeSpecFixtures.directory.appendingPathComponent("valid/\(name)")
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
    }

    private func allEffects() throws -> [JSONValue] {
        let root = try fixture("z-effects-all-types.json").root
        return (root.children ?? []).flatMap { $0.style?.effects ?? [] }
    }

    func testTheFixtureCoversAllTenEffectsAndEachOneDecodes() throws {
        let parsed = try allEffects().compactMap(PrototypeEffects.parse)
        XCTAssertEqual(parsed.count, 10)
        XCTAssertEqual(
            Set(parsed.map(\.type)),
            [
                "noise", "gradientMesh", "shimmer", "glow", "vignette", "blur", "pixelate",
                "chromaticAberration", "wave", "ripple",
            ]
        )
    }

    func testOmittedParamsTakeTheSameConservativeDefaultsAsAndroid() throws {
        func parse(_ json: String) throws -> PrototypeEffect {
            let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
            return try XCTUnwrap(PrototypeEffects.parse(value))
        }
        XCTAssertEqual(
            try parse(#"{"type":"glow","color":"primary"}"#).look,
            .glow(color: .single("primary"), radius: 12, intensity: 0.6)
        )
        XCTAssertEqual(
            try parse(#"{"type":"vignette"}"#).look, .vignette(color: nil, intensity: 0.4, radius: 0.7)
        )
        XCTAssertEqual(
            try parse(#"{"type":"ripple"}"#).look,
            .ripple(amplitude: 4, wavelength: 48, centerX: 0.5, centerY: 0.5)
        )
        XCTAssertEqual(
            try parse(#"{"type":"noise"}"#).look, .noise(amount: 0.1, grain: 1, seed: 0, monochrome: true)
        )
    }

    func testOnlyShimmerWaveAndRippleCycle() throws {
        let cycling = try allEffects().compactMap(PrototypeEffects.parse).filter(\.cycles).map(\.type)
        XCTAssertEqual(Set(cycling), ["shimmer", "wave", "ripple"])
    }

    func testPhaseHoldsTheAuthoredValueWithoutAnimateAndLoopsWithIt() {
        let still = PrototypeEffect(look: .wave(amplitude: 4, wavelength: 48, angle: 0), periodMs: nil, phase: 0.25)
        XCTAssertEqual(PrototypeEffects.phase(of: still, elapsed: 9), 0.25, accuracy: 1e-9)
        let loop = PrototypeEffect(look: .wave(amplitude: 4, wavelength: 48, angle: 0), periodMs: 1000, phase: 0)
        XCTAssertEqual(PrototypeEffects.phase(of: loop, elapsed: 0.5), 0.5, accuracy: 1e-9)
        let shifted = PrototypeEffect(
            look: .ripple(amplitude: 4, wavelength: 48, centerX: 0.5, centerY: 0.5),
            periodMs: 1000,
            phase: 0.25
        )
        XCTAssertEqual(PrototypeEffects.phase(of: shifted, elapsed: 1.5), 0.75, accuracy: 1e-9)
        // A static look ignores animate entirely.
        let blur = PrototypeEffect(look: .blur(radius: 4), periodMs: 1000, phase: 0.3)
        XCTAssertEqual(PrototypeEffects.phase(of: blur, elapsed: 0.7), 0.3, accuracy: 1e-9)
    }

    func testTheClockIsFrozenUnderMotionNoneAndReduceMotion() {
        XCTAssertTrue(PrototypeEffects.runs(PrototypeMotion(specMotion: nil, reduceMotion: false)))
        XCTAssertFalse(PrototypeEffects.runs(PrototypeMotion(specMotion: "none", reduceMotion: false)))
        XCTAssertFalse(PrototypeEffects.runs(PrototypeMotion(specMotion: nil, reduceMotion: true)))
        XCTAssertFalse(PrototypeEffects.runs(PrototypeMotion(specMotion: "reduced", reduceMotion: false)))
        // Frozen means the shaders see the authored phase.
        let loop = PrototypeEffect(look: .wave(amplitude: 4, wavelength: 48, angle: 0), periodMs: 2000, phase: 0.3)
        XCTAssertEqual(PrototypeEffects.phase(of: loop, elapsed: 0), 0.3, accuracy: 1e-9)
    }

    func testNoiseSeedsPickDistinctDeterministicPatterns() {
        XCTAssertEqual(PrototypeEffects.noiseSeedOffset(7).x, PrototypeEffects.noiseSeedOffset(7).x)
        XCTAssertNotEqual(PrototypeEffects.noiseSeedOffset(7).x, PrototypeEffects.noiseSeedOffset(8).x)
        XCTAssertNotEqual(PrototypeEffects.noiseSeedOffset(0).y, PrototypeEffects.noiseSeedOffset(256).y)
    }

    func testDirectionRunsLeftToRightAtZeroAndTopToBottomAtNinety() {
        XCTAssertEqual(PrototypeEffects.direction(degrees: 0).x, 1, accuracy: 1e-9)
        XCTAssertEqual(PrototypeEffects.direction(degrees: 90).y, 1, accuracy: 1e-9)
    }

    func testEveryEffectDrawsOnAPlainNodeAndOnlyLayerSamplingOnesDegradeOverPlatformViews() throws {
        let raw = try allEffects()
        XCTAssertEqual(PrototypeEffects.plan(raw, platformBackedSubtree: false).drawn.count, 10)
        XCTAssertTrue(PrototypeEffects.plan(raw, platformBackedSubtree: false).omitted.isEmpty)
        let degraded = PrototypeEffects.plan(raw, platformBackedSubtree: true)
        XCTAssertEqual(
            Set(degraded.omitted.map(\.effect.type)), ["pixelate", "chromaticAberration", "wave", "ripple"]
        )
        XCTAssertEqual(degraded.drawn.count, 6)
    }

    func testDegradedEffectsAreReportedAtTheNodeAndAuthoredIndex() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(#"""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"root":{"type":"column","children":[
          {"type":"box","style":{"effects":[{"type":"blur","radius":4},{"type":"pixelate","cell":6}]},
           "children":[{"type":"textField","id":"name","stateKey":"name","label":"Name"}]},
          {"type":"text","text":"plain","style":{"effects":[{"type":"wave"}]}},
          {"type":"box","visibleWhen":{"key":"name","equals":"never"},
           "style":{"effects":[{"type":"wave"}]},"children":[{"type":"slider","stateKey":"v","min":0,"max":1}]}
        ]},"state":{"name":"","v":0}}
        """#.utf8))
        let report = PrototypeEffects.degraded(root: spec.root, state: [:])
        XCTAssertEqual(report, [[
            "path": "root.children[0].style.effects[1]", "type": "pixelate",
            "reason": PrototypeEffects.platformReason,
        ]])
    }

    func testADescendantWithAnIdAndAStackAreTreatedAsPlatformBacked() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(#"""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"root":{"type":"column","children":[
          {"type":"box","children":[{"type":"text","id":"label","text":"x"}]},
          {"type":"box","children":[{"type":"text","text":"y"}]}
        ]}}
        """#.utf8))
        XCTAssertTrue(try PrototypeEffects.hasPlatformBackedSubtree(XCTUnwrap(spec.root.children?[0])))
        XCTAssertFalse(try PrototypeEffects.hasPlatformBackedSubtree(XCTUnwrap(spec.root.children?[1])))
        XCTAssertTrue(PrototypeEffects.platformBackedTypes.isSuperset(of: ["stack", "dialog"]))
        XCTAssertFalse(PrototypeEffects.platformBackedTypes.contains("switch"))
    }

    func testPlatformBackedSubtreeIsOnlyWalkedWhenAnEffectSamplesPixels() throws {
        var walked = 0
        let blurOnly = try JSONDecoder().decode([JSONValue].self, from: Data(#"[{"type":"blur","radius":2}]"#.utf8))
        _ = PrototypeEffects.plan(blurOnly, platformBackedSubtree: {
            walked += 1
            return true
        }())
        XCTAssertEqual(walked, 0)
    }

    func testAuthoredEffectsAreStableAcrossStyleWhen() throws {
        let node = try JSONDecoder().decode(PrototypeNode.self, from: Data(
            #"{"type":"box","styleWhen":[{"when":{"key":"a","equals":true},"style":{"effects":[{"type":"blur","radius":2}]}}]}"#
                .utf8
        ))
        XCTAssertTrue(PrototypeEffects.authorsEffects(node))
    }

    func testTheFixtureDegradesNothingWithoutPlatformViews() throws {
        let spec = try fixture("z-effects-all-types.json")
        XCTAssertTrue(PrototypeEffects.degraded(root: spec.root, state: [:]).isEmpty)
    }

    func testTheReportFollowsTheStyleWhenInForce() throws {
        let spec = try fixture("z-effects-style-when.json")
        // Whatever the fixture authors, a report entry always names a style effects path.
        for entry in PrototypeEffects.degraded(root: spec.root, state: spec.state ?? [:]) {
            XCTAssertTrue(entry["path"]?.contains(".style.effects[") == true)
        }
    }
}
