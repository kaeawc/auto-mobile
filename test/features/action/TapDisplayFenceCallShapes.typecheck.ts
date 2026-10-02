import type { DisplayFence } from "../../../src/features/action/BaseVisualChange";
import type { TapOnElement } from "../../../src/features/action/TapOnElement";
import type { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import type { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import type { TalkBackTapStrategy } from "../../../src/features/talkback/TalkBackTapStrategy";

// Compile-only contracts: tsconfig already includes **/*.typecheck.ts.
// Indexed private method types and Function.bind preserve the real signatures.
declare const fence: DisplayFence;
declare const tapOnElement: TapOnElement;
declare const element: Parameters<TapOnElement["executeAndroidTap"]>[4];
void tapOnElement.executeAndroidTap("tap", 10, 10, 50, element);
void tapOnElement.executeAndroidTap("tap", 10, 10, 50, element, undefined, {
  action: "tap",
  displayFence: fence,
});
const talkBackFlag = tapOnElement.executeAndroidTap.bind(
  tapOnElement,
  "tap",
  10,
  10,
  50,
  element,
  undefined,
  { action: "tap" },
);
void talkBackFlag(false);
// @ts-expect-error The eighth slot is a boolean, never a display fence.
void talkBackFlag(fence);
// @ts-expect-error The eighth slot is a boolean, never an array.
void talkBackFlag([]);
// @ts-expect-error The eighth slot is a boolean, never an object.
void talkBackFlag({});
// @ts-expect-error The eighth slot is a boolean, never an object.
void talkBackFlag({ assertCurrent: 1 });

// TapOnElement.executeAndroidTap
declare const call0: TapOnElement["executeAndroidTap"];
declare const args0: Parameters<typeof call0>;
void call0(...args0);
const options0 = call0.bind(undefined, args0[0], args0[1], args0[2], args0[3], args0[4], args0[5]);
void options0(args0[6], args0[7]);
void options0({ action: "tap", displayFence: fence }, args0[7]);
// @ts-expect-error A fence must implement assertCurrent(): void.
void options0({ action: "tap", displayFence: [] }, args0[7]);
// @ts-expect-error A fence must implement assertCurrent(): void.
void options0({ action: "tap", displayFence: {} }, args0[7]);
// @ts-expect-error A fence must implement assertCurrent(): void.
void options0({ action: "tap", displayFence: { assertCurrent: 1 } }, args0[7]);
// @ts-expect-error Arrays are not dispatch options.
void options0([], args0[7]);
// @ts-expect-error Extra positional slots never carry a fence.
void call0(...args0, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call0(...args0, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call0(...args0, { assertCurrent: 1 });

// TapOnElement.executeAndroidTapWithCoordinates
declare const call1: TapOnElement["executeAndroidTapWithCoordinates"];
declare const args1: Parameters<typeof call1>;
void call1(...args1);
const options1 = call1.bind(
  undefined,
  args1[0],
  args1[1],
  args1[2],
  args1[3],
  args1[4],
  args1[5],
  args1[6],
);
void options1();
void options1({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options1({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options1({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options1({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options1([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call1(...args1, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call1(...args1, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call1(...args1, { assertCurrent: 1 });

// TapOnElement.dispatchCoordinateTapOrAdbFallback
declare const call2: TapOnElement["dispatchCoordinateTapOrAdbFallback"];
declare const args2: Parameters<typeof call2>;
void call2(...args2);
const options2 = call2.bind(undefined, args2[0], args2[1], args2[2], args2[3]);
void options2();
void options2({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options2({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options2({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options2({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options2([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call2(...args2, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call2(...args2, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call2(...args2, { assertCurrent: 1 });

// TapOnElement.retryTapIfNoChange
declare const call3: TapOnElement["retryTapIfNoChange"];
declare const args3: Parameters<typeof call3>;
void call3(...args3);
const options3 = call3.bind(undefined, args3[0], args3[1], args3[2], args3[3], args3[4]);
void options3(args3[5], args3[6], args3[7], args3[8], args3[9]);
void options3({ action: "tap", displayFence: fence }, args3[6], args3[7], args3[8], args3[9]);
// @ts-expect-error A fence must implement assertCurrent(): void.
void options3({ action: "tap", displayFence: [] }, args3[6], args3[7], args3[8], args3[9]);
// @ts-expect-error A fence must implement assertCurrent(): void.
void options3({ action: "tap", displayFence: {} }, args3[6], args3[7], args3[8], args3[9]);
void options3(
  // @ts-expect-error A fence must implement assertCurrent(): void.
  { action: "tap", displayFence: { assertCurrent: 1 } },
  args3[6],
  args3[7],
  args3[8],
  args3[9],
);
// @ts-expect-error Arrays are not dispatch options.
void options3([], args3[6], args3[7], args3[8], args3[9]);
// @ts-expect-error Extra positional slots never carry a fence.
void call3(...args3, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call3(...args3, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call3(...args3, { assertCurrent: 1 });

// TapOnElement.executeAndroidTapWithAccessibility
declare const call4: TapOnElement["executeAndroidTapWithAccessibility"];
declare const args4: Parameters<typeof call4>;
void call4(...args4);
const options4 = call4.bind(undefined, args4[0], args4[1], args4[2], args4[3], args4[4]);
void options4(args4[5], args4[6]);
void options4({ action: "tap", displayFence: fence }, args4[6]);
// @ts-expect-error A fence must implement assertCurrent(): void.
void options4({ action: "tap", displayFence: [] }, args4[6]);
// @ts-expect-error A fence must implement assertCurrent(): void.
void options4({ action: "tap", displayFence: {} }, args4[6]);
// @ts-expect-error A fence must implement assertCurrent(): void.
void options4({ action: "tap", displayFence: { assertCurrent: 1 } }, args4[6]);
// @ts-expect-error Arrays are not dispatch options.
void options4([], args4[6]);
// @ts-expect-error Extra positional slots never carry a fence.
void call4(...args4, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call4(...args4, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call4(...args4, { assertCurrent: 1 });

// TapOnElement.executeiOSTap
declare const call5: TapOnElement["executeiOSTap"];
declare const args5: Parameters<typeof call5>;
void call5(...args5);
const options5 = call5.bind(undefined, args5[0], args5[1], args5[2], args5[3], args5[4], args5[5]);
void options5();
void options5({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options5({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options5({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options5({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options5([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call5(...args5, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call5(...args5, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call5(...args5, { assertCurrent: 1 });

// TapOnElement.executeiOSTapWithCoordinates
declare const call6: TapOnElement["executeiOSTapWithCoordinates"];
declare const args6: Parameters<typeof call6>;
void call6(...args6);
const options6 = call6.bind(undefined, args6[0], args6[1], args6[2], args6[3]);
void options6();
void options6({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options6({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options6({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options6({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options6([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call6(...args6, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call6(...args6, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call6(...args6, { assertCurrent: 1 });

// TapOnElement.executeIOSTapWithVoiceOver
declare const call7: TapOnElement["executeIOSTapWithVoiceOver"];
declare const args7: Parameters<typeof call7>;
void call7(...args7);
const options7 = call7.bind(undefined, args7[0], args7[1], args7[2], args7[3], args7[4]);
void options7();
void options7({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options7({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options7({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options7({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options7([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call7(...args7, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call7(...args7, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call7(...args7, { assertCurrent: 1 });

// TapOnElement.executeAndroidLongPress
declare const call8: TapOnElement["executeAndroidLongPress"];
declare const args8: Parameters<typeof call8>;
void call8(...args8);
const options8 = call8.bind(undefined, args8[0], args8[1], args8[2], args8[3], args8[4], args8[5]);
void options8();
void options8({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options8({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options8({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options8({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options8([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call8(...args8, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call8(...args8, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call8(...args8, { assertCurrent: 1 });

// TapAnyElement.executeAndroidTap
declare const call9: TapAnyElement["executeAndroidTap"];
declare const args9: Parameters<typeof call9>;
void call9(...args9);
const options9 = call9.bind(undefined, args9[0], args9[1], args9[2], args9[3], args9[4], args9[5]);
void options9();
void options9({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options9({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options9({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options9({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options9([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call9(...args9, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call9(...args9, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call9(...args9, { assertCurrent: 1 });

// TapAnyElement.executeAndroidTalkBackTap
declare const call10: TapAnyElement["executeAndroidTalkBackTap"];
declare const args10: Parameters<typeof call10>;
void call10(...args10);
const options10 = call10.bind(undefined, args10[0], args10[1], args10[2], args10[3], args10[4]);
void options10();
void options10({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options10({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options10({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options10({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options10([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call10(...args10, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call10(...args10, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call10(...args10, { assertCurrent: 1 });

// TapAnyElement.retryAndroidTapIfNoChange
declare const call11: TapAnyElement["retryAndroidTapIfNoChange"];
declare const args11: Parameters<typeof call11>;
void call11(...args11);
const options11 = call11.bind(
  undefined,
  args11[0],
  args11[1],
  args11[2],
  args11[3],
  args11[4],
  args11[5],
);
void options11();
void options11({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options11({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options11({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options11({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options11([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call11(...args11, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call11(...args11, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call11(...args11, { assertCurrent: 1 });

// TapAnyElement.executeIosTap
declare const call12: TapAnyElement["executeIosTap"];
declare const args12: Parameters<typeof call12>;
void call12(...args12);
const options12 = call12.bind(
  undefined,
  args12[0],
  args12[1],
  args12[2],
  args12[3],
  args12[4],
  args12[5],
);
void options12();
void options12({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options12({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options12({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options12({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options12([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call12(...args12, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call12(...args12, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call12(...args12, { assertCurrent: 1 });

// TapAnyElement.executeIosTapWithCoordinates
declare const call13: TapAnyElement["executeIosTapWithCoordinates"];
declare const args13: Parameters<typeof call13>;
void call13(...args13);
const options13 = call13.bind(
  undefined,
  args13[0],
  args13[1],
  args13[2],
  args13[3],
  args13[4],
  args13[5],
);
void options13();
void options13({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options13({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options13({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options13({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options13([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call13(...args13, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call13(...args13, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call13(...args13, { assertCurrent: 1 });

// ExecuteGesture.executeA11ySwipe
declare const call14: ExecuteGesture["executeA11ySwipe"];
declare const args14: Parameters<typeof call14>;
void call14(...args14);
const options14 = call14.bind(
  undefined,
  args14[0],
  args14[1],
  args14[2],
  args14[3],
  args14[4],
  args14[5],
  args14[6],
);
void options14();
void options14({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options14({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options14({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options14({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options14([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call14(...args14, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call14(...args14, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call14(...args14, { assertCurrent: 1 });

// ExecuteGesture.executeXCTestSwipe
declare const call15: ExecuteGesture["executeXCTestSwipe"];
declare const args15: Parameters<typeof call15>;
void call15(...args15);
const options15 = call15.bind(
  undefined,
  args15[0],
  args15[1],
  args15[2],
  args15[3],
  args15[4],
  args15[5],
  args15[6],
);
void options15();
void options15({ displayFence: fence });
void options15({ displayFence: fence, lockScreen: true, timeoutMs: 5000 });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options15({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options15({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options15({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options15([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call15(...args15, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call15(...args15, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call15(...args15, { assertCurrent: 1 });

// ExecuteGesture.execute
declare const call16: ExecuteGesture["execute"];
declare const args16: Parameters<typeof call16>;
void call16(...args16);
const options16 = call16.bind(undefined, args16[0], args16[1], args16[2]);
void options16();
void options16({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options16({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options16({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options16({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options16([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call16(...args16, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call16(...args16, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call16(...args16, { assertCurrent: 1 });

// ExecuteGesture.executeAndroidGesture
declare const call17: ExecuteGesture["executeAndroidGesture"];
declare const args17: Parameters<typeof call17>;
void call17(...args17);
const options17 = call17.bind(undefined, args17[0], args17[1], args17[2]);
void options17();
void options17({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options17({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options17({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options17({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options17([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call17(...args17, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call17(...args17, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call17(...args17, { assertCurrent: 1 });

// ExecuteGesture.executeiOSGesture
declare const call18: ExecuteGesture["executeiOSGesture"];
declare const args18: Parameters<typeof call18>;
void call18(...args18);
const options18 = call18.bind(undefined, args18[0], args18[1], args18[2]);
void options18();
void options18({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options18({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options18({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options18({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options18([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call18(...args18, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call18(...args18, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call18(...args18, { assertCurrent: 1 });

// TalkBackTapStrategy.executeCoordinateFallback
declare const call19: TalkBackTapStrategy["executeCoordinateFallback"];
declare const args19: Parameters<typeof call19>;
void call19(...args19);
const options19 = call19.bind(undefined, args19[0], args19[1], args19[2], args19[3], args19[4]);
void options19();
void options19({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options19({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options19({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options19({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options19([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call19(...args19, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call19(...args19, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call19(...args19, { assertCurrent: 1 });

// TalkBackTapStrategy.executeLongPress
declare const call20: TalkBackTapStrategy["executeLongPress"];
declare const args20: Parameters<typeof call20>;
void call20(...args20);
const options20 = call20.bind(undefined, args20[0], args20[1], args20[2], args20[3], args20[4]);
void options20();
void options20({ displayFence: fence });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options20({ displayFence: [] });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options20({ displayFence: {} });
// @ts-expect-error A fence must implement assertCurrent(): void.
void options20({ displayFence: { assertCurrent: 1 } });
// @ts-expect-error Arrays are not dispatch options.
void options20([]);
// @ts-expect-error Extra positional slots never carry a fence.
void call20(...args20, []);
// @ts-expect-error Extra positional slots never carry a fence.
void call20(...args20, {});
// @ts-expect-error Extra positional slots never carry a fence.
void call20(...args20, { assertCurrent: 1 });
