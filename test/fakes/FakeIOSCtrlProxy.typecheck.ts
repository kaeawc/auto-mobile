import type { IOSCtrlProxy } from "../../src/features/observe/ios";
import type { FakeIOSCtrlProxy } from "./FakeIOSCtrlProxy";

type Assert<Condition extends true> = Condition;

/** Compile-only regression check for the iOS CtrlProxy test double contract. */
export type FakeIOSCtrlProxyContractChecks = [
  Assert<FakeIOSCtrlProxy extends IOSCtrlProxy ? true : false>,
];
