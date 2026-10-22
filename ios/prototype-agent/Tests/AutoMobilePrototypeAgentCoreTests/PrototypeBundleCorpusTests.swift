@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeBundleCorpusTests: XCTestCase {
    override static func setUp() {
        super.setUp()
        _ = PrototypeBundleFixtures.corpus
    }

    private func check(_ index: Int, file: StaticString = #filePath, line: UInt = #line) throws {
        let fixture = try PrototypeBundleFixtures.corpus.get().cases[index]
        do {
            _ = try PrototypeBundle.read(fixture.bundleBase64)
            XCTAssertEqual(fixture.expect, "accept", fixture.name, file: file, line: line)
        } catch let error as PrototypeBundleFailure {
            XCTAssertEqual(fixture.expect, "reject", "\(fixture.name): \(error)", file: file, line: line)
            XCTAssertEqual(error.code.rawValue, fixture.code, fixture.name, file: file, line: line)
            XCTAssertEqual(
                error.path.map { Data($0.utf8) },
                fixture.path.map { Data($0.utf8) },
                fixture.name,
                file: file,
                line: line
            )
        }
    }

    private func golden(_ index: Int) throws {
        let fixture = try PrototypeBundleFixtures.corpus.get().cases[index]
        let input = try XCTUnwrap(fixture.exportInputs)
        XCTAssertEqual(try PrototypeBundle.export(input.input), fixture.bundleBase64, fixture.name)
    }

    func test000GoldenMinimal() throws { try check(0) }
    func testExport000GoldenMinimal() throws { try golden(0) }
    func test001GoldenImageFont() throws { try check(1) }
    func testExport001GoldenImageFont() throws { try golden(1) }
    func test002GoldenContentDedup() throws { try check(2) }
    func testExport002GoldenContentDedup() throws { try golden(2) }
    func test003GoldenUnicodeOpaqueIds() throws { try check(3) }
    func testExport003GoldenUnicodeOpaqueIds() throws { try golden(3) }
    func test004ValidDeflate() throws { try check(4) }
    func test005ValidJpegWebp() throws { try check(5) }
    func test006Max36Entries() throws { try check(6) }
    func test007ForbiddenSpecJson() throws { try check(7) }
    func test008ForbiddenSpecJson() throws { try check(8) }
    func test009ForbiddenAssetsBadPng() throws { try check(9) }
    func test010ForbiddenBadU0000name() throws { try check(10) }
    func test011ForbiddenCaf() throws { try check(11) }
    func test012ForbiddenMACOSXX() throws { try check(12) }
    func test013ForbiddenAssets() throws { try check(13) }
    func test014OutsideAllowlist() throws { try check(14) }
    func test015DuplicateExact() throws { try check(15) }
    func test016DuplicateCase() throws { try check(16) }
    func test017Symlink() throws { try check(17) }
    func test018Fifo() throws { try check(18) }
    func test019Socket() throws { try check(19) }
    func test020DirectoryMode() throws { try check(20) }
    func test021RegularUnixMode() throws { try check(21) }
    func test022Encrypted1() throws { try check(22) }
    func test023Encrypted64() throws { try check(23) }
    func test024DescriptorOnly() throws { try check(24) }
    func test025MethodUnsupported() throws { try check(25) }
    func test026MultiDiskEocd() throws { try check(26) }
    func test027MultiDiskEntry() throws { try check(27) }
    func test028Zip64Eocd() throws { try check(28) }
    func test029Zip64Entry() throws { try check(29) }
    func test030ExtraFieldCentral() throws { try check(30) }
    func test031ExtraFieldLocal() throws { try check(31) }
    func test032ArchiveComment() throws { try check(32) }
    func test033LocalName() throws { try check(33) }
    func test034LocalMethod() throws { try check(34) }
    func test035LocalSize() throws { try check(35) }
    func test036LocalCompressed() throws { try check(36) }
    func test037LocalCrc() throws { try check(37) }
    func test038Overlap() throws { try check(38) }
    func test039TrailingBytes() throws { try check(39) }
    func test040TwoEocd() throws { try check(40) }
    func test041NoEocd() throws { try check(41) }
    func test042TooManyEntries37() throws { try check(42) }
    func test043CrcLie() throws { try check(43) }
    func test044SizeLie01() throws { try check(44) }
    func test045SizeLie01() throws { try check(45) }
    func test046SizeLie81() throws { try check(46) }
    func test047SizeLie81() throws { try check(47) }
    func test048UnusedDeflateInput() throws { try check(48) }
    func test049BrokenDeflate() throws { try check(49) }
    func test050Ratio100Exact() throws { try check(50) }
    func test051Ratio100PlusOneByte() throws { try check(51) }
    func test052ManifestDuplicateKey() throws { try check(52) }
    func test053ManifestEscapedDuplicate() throws { try check(53) }
    func test054ManifestExtraLabel() throws { try check(54) }
    func test055ManifestExtraSource() throws { try check(55) }
    func test056ManifestExtraStorage() throws { try check(56) }
    func test057ManifestExtraLibrary() throws { try check(57) }
    func test058ManifestExtraSourceUrl() throws { try check(58) }
    func test059ManifestExtraLastOpenedAt() throws { try check(59) }
    func test060ManifestExtraThumbnail() throws { try check(60) }
    func test061ManifestExtraUnknown() throws { try check(61) }
    func test062ManifestVersion() throws { try check(62) }
    func test063ManifestNotJson() throws { try check(63) }
    func test064ManifestDepth() throws { try check(64) }
    func test065RequiresZA() throws { try check(65) }
    func test066RequiresAA() throws { try check(66) }
    func test067RequiresBadName() throws { try check(67) }
    func test068Requires1() throws { try check(68) }
    func test069RequiresA() throws { try check(69) }
    func test070ManifestBom() throws { try check(70) }
    func test071SpecShaMismatch() throws { try check(71) }
    func test072SpecNotJson() throws { try check(72) }
    func test073SpecDuplicateKey() throws { try check(73) }
    func test074SpecDepth() throws { try check(74) }
    func test075SpecInvalidSchema() throws { try check(75) }
    func test076SpecBom() throws { try check(76) }
    func test077SpecInvalidUtf8() throws { try check(77) }
    func test078MissingImage() throws { try check(78) }
    func test079MissingFont() throws { try check(79) }
    func test080ManifestWithoutZip() throws { try check(80) }
    func test081ZipWithoutManifest() throws { try check(81) }
    func test082ListedUnreferenced() throws { try check(82) }
    func test083WrongShaStem() throws { try check(83) }
    func test084WrongMediaMagic() throws { try check(84) }
    func test085WrongFontTag() throws { try check(85) }
    func test086ManifestFileMismatch() throws { try check(86) }
    func test087ManifestEmptyId() throws { try check(87) }
    func test088ManifestDuplicateId() throws { try check(88) }
    func test089ManifestDuplicateIdAcrossKinds() throws { try check(89) }
    func test090ImageCapExact() throws { try check(90) }
    func test091ImageCapPlusOne() throws { try check(91) }
    func test092FontCapExact() throws { try check(92) }
    func test093FontCapPlusOne() throws { try check(93) }
    func test094SpecCapExact() throws { try check(94) }
    func test095SpecCapPlusOne() throws { try check(95) }
    func test096ManifestCapExact() throws { try check(96) }
    func test097ManifestCapPlusOne() throws { try check(97) }
    func test098Bomb20mRatio() throws { try check(98) }
    func test099Bomb20mBelowRatio() throws { try check(99) }
}
