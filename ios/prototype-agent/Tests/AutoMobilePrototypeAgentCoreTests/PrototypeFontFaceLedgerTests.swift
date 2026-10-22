@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Font face ownership across presentations (#14483), with a fake font manager keyed by face name.
final class PrototypeFontFaceLedgerTests: XCTestCase {
    private final class FakeFontManager {
        var registered: [String] = []
        var unregistered: [String] = []
        var refuse = false

        func register(_ font: String) -> PrototypeFontRegistrationResult {
            if refuse { return .failed }
            if registered.contains(font) { return .alreadyRegistered }
            registered.append(font)
            return .registered
        }

        func unregister(_ font: String) {
            unregistered.append(font)
            registered.removeAll { $0 == font }
        }
    }

    private let manager = FakeFontManager()
    private let ledger = PrototypeFontFaceLedger<String, Int>()

    private func register(digest: Int, font: String = "PS-Face") -> Bool {
        ledger.register(
            face: "PS-Face", digest: digest, font: font,
            register: manager.register, unregister: manager.unregister
        )
    }

    func testFirstRegistrationRecordsTheFace() {
        XCTAssertTrue(register(digest: 1))
        XCTAssertEqual(manager.registered, ["PS-Face"])
        XCTAssertTrue(manager.unregistered.isEmpty)
    }

    func testTheSameBytesAgainReuseTheRegisteredFace() {
        XCTAssertTrue(register(digest: 1))
        XCTAssertTrue(register(digest: 1))
        XCTAssertEqual(manager.registered, ["PS-Face"])
        XCTAssertTrue(manager.unregistered.isEmpty)
    }

    func testUpdatedBytesReplaceTheObsoleteFace() {
        XCTAssertTrue(register(digest: 1))
        XCTAssertTrue(register(digest: 2))
        XCTAssertEqual(manager.unregistered, ["PS-Face"])
        XCTAssertEqual(manager.registered, ["PS-Face"])
        // The replacement is now the recorded owner, so its bytes keep reusing the face.
        XCTAssertTrue(register(digest: 2))
        XCTAssertEqual(manager.unregistered, ["PS-Face"])
    }

    func testANameRegisteredOutsideTheLedgerIsRefused() {
        manager.registered = ["PS-Face"]
        XCTAssertFalse(register(digest: 1))
    }

    func testAFailedRegistrationRecordsNothing() {
        manager.refuse = true
        XCTAssertFalse(register(digest: 1))
        manager.refuse = false
        XCTAssertTrue(register(digest: 2))
        XCTAssertTrue(manager.unregistered.isEmpty)
    }
}
