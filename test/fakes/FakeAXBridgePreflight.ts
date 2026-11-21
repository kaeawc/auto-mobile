import type { AXBridgePreflight } from "../../src/utils/ios/AXBridgePreflight";

export class FakeAXBridgePreflight implements AXBridgePreflight {
  aqua = true;
  trusted = true;
  aquaCalls = 0;
  trustCalls = 0;
  async isAquaSession(): Promise<boolean> {
    this.aquaCalls++;
    return this.aqua;
  }
  isAccessibilityTrusted(): boolean {
    this.trustCalls++;
    return this.trusted;
  }
}
