import CryptoKit
import Foundation

extension Data {
    func sha1() -> Data {
        Data(Insecure.SHA1.hash(data: self))
    }
}
