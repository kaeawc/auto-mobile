import Foundation
import XCTest

@testable import Playground

final class PhotosAuthorizationProbeTests: XCTestCase {
    func testStatusNamesPreserveRawValuesIncludingUnknown() {
        let cases = [
            (0, "notDetermined"),
            (1, "restricted"),
            (2, "denied"),
            (3, "authorized"),
            (4, "limited"),
            (99, "unknown"),
        ]

        for (rawValue, name) in cases {
            let status = PhotosAuthorizationSnapshot.Status(rawValue: rawValue)
            XCTAssertEqual(status.rawValue, rawValue)
            XCTAssertEqual(status.name, name)
        }
    }

    func testWriteRecordsBothLevelsAsSortedJSONWithFixedDate() throws {
        let cases = [(0, "notDetermined"), (3, "authorized"), (4, "limited")]
        let directoryURL = URL(fileURLWithPath: "/tmp/photos-authorization-tests", isDirectory: true)
        let date = Date(timeIntervalSince1970: 1_704_067_200)

        for (rawValue, name) in cases {
            let provider = FakePhotosAuthorizationStatusProvider(readWrite: rawValue, addOnly: 3)
            let writer = FakePhotosAuthorizationFileWriter()
            let probe = PhotosAuthorizationProbe(
                provider: provider,
                dateProvider: { date },
                directoryURL: directoryURL,
                fileWriter: writer
            )

            try probe.write()

            let expected = "{\"addOnly\":{\"name\":\"authorized\",\"rawValue\":3},"
                + "\"observedAt\":\"2024-01-01T00:00:00Z\","
                + "\"readWrite\":{\"name\":\"\(name)\",\"rawValue\":\(rawValue)}}"
            XCTAssertEqual(writer.data, Data(expected.utf8))
            XCTAssertEqual(writer.url, directoryURL.appendingPathComponent("photos-authorization.json"))
            XCTAssertEqual(writer.options, .atomic)
            XCTAssertEqual(writer.writeCount, 1)
            XCTAssertEqual(provider.queries, [true, false])
            let data = try XCTUnwrap(writer.data)
            XCTAssertEqual(
                try JSONDecoder().decode(PhotosAuthorizationSnapshot.self, from: data),
                PhotosAuthorizationSnapshot(readWrite: rawValue, addOnly: 3, observedAt: date)
            )
        }
    }

    func testWritePropagatesFileWriterFailure() {
        let writer = FakePhotosAuthorizationFileWriter()
        writer.shouldFail = true
        let probe = PhotosAuthorizationProbe(
            provider: FakePhotosAuthorizationStatusProvider(readWrite: 0, addOnly: 0),
            dateProvider: { Date(timeIntervalSince1970: 0) },
            directoryURL: URL(fileURLWithPath: "/tmp/photos-authorization-tests", isDirectory: true),
            fileWriter: writer
        )

        XCTAssertThrowsError(try probe.write()) { error in
            XCTAssertEqual(error as? CocoaError, CocoaError(.fileWriteNoPermission))
        }
    }
}

private final class FakePhotosAuthorizationStatusProvider: PhotosAuthorizationStatusProviding {
    let readWrite: Int
    let addOnly: Int
    private(set) var queries: [Bool] = []

    init(readWrite: Int, addOnly: Int) {
        self.readWrite = readWrite
        self.addOnly = addOnly
    }

    func rawStatus(readWrite: Bool) -> Int {
        queries.append(readWrite)
        return readWrite ? self.readWrite : addOnly
    }
}

private final class FakePhotosAuthorizationFileWriter: PhotosAuthorizationFileWriting {
    private(set) var data: Data?
    private(set) var url: URL?
    private(set) var options: Data.WritingOptions?
    private(set) var writeCount = 0
    var shouldFail = false

    func write(_ data: Data, to url: URL, options: Data.WritingOptions) throws {
        if shouldFail {
            throw CocoaError(.fileWriteNoPermission)
        }
        self.data = data
        self.url = url
        self.options = options
        writeCount += 1
    }
}
