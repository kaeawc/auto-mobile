@testable import CtrlProxy
import XCTest

final class RotationChangeGenerationTests: XCTestCase {
    func testRejectsABARotationDuringCapture() {
        let generation = RotationChangeGeneration()
        let beforeCapture = generation.captureSample(rotation: 0)

        generation.recordOrientationChange()
        generation.recordOrientationChange()

        let afterCapture = generation.captureSample(rotation: 0)

        XCTAssertNil(
            RotationCaptureSample.stableRotation(between: beforeCapture, and: afterCapture),
            "A→B→A must invalidate capture rotation even when endpoint orientation returns to A"
        )
    }

    func testKeepsRotationWhenNoOrientationChangeOccursDuringCapture() {
        let generation = RotationChangeGeneration()
        let beforeCapture = generation.captureSample(rotation: 3)
        let afterCapture = generation.captureSample(rotation: 3)

        XCTAssertEqual(
            RotationCaptureSample.stableRotation(between: beforeCapture, and: afterCapture),
            3
        )
    }
}
