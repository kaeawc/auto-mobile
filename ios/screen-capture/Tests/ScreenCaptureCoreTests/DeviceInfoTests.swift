import XCTest
@testable import ScreenCaptureCore

final class DeviceInfoTests: XCTestCase {
    func testRoundTripsThroughJSON() throws {
        let original = DeviceListResponse(devices: [
            DeviceInfo(
                uniqueID: "00008140-001A2B3C0AE2401E",
                localizedName: "iPhone",
                modelID: "iPhone15,2",
                manufacturer: "Apple"
            )
        ])
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(DeviceListResponse.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    func testJSONUsesExpectedKeys() throws {
        let device = DeviceInfo(
            uniqueID: "id",
            localizedName: "name",
            modelID: "model",
            manufacturer: "vendor"
        )
        let data = try JSONEncoder().encode(device)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: String]
        )
        XCTAssertEqual(json["uniqueID"], "id")
        XCTAssertEqual(json["localizedName"], "name")
        XCTAssertEqual(json["modelID"], "model")
        XCTAssertEqual(json["manufacturer"], "vendor")
    }
}
