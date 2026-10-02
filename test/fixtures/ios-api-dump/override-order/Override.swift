import Foundation

public class Override: NSObject {
  public override func startLoading() { }
  override public func stopLoading() { }
  override public class func canInit(
    with request: URLRequest
  ) -> Bool {
    return true
  }
  @discardableResult override public func loadCount() -> Int { return 1 }
  override func hidden() { }
}
