import { expect, test } from "bun:test";
import {
  sanitizeObserveResult,
  diffObserveResult,
} from "../../../../src/features/observe/output/ObserveResultOutput";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import raw from "../../../fixtures/observe/android-playground-raw-trim-candidates.json";
import empty from "../../../fixtures/observe/diff/text-input-empty.json";
import typed from "../../../fixtures/observe/diff/text-input-typed.json";

test("captured trim candidates preserve exact wire fields and key order", () => {
  const before = JSON.stringify(raw);
  expect(JSON.stringify(sanitizeObserveResult(raw as ObserveResult, { dropElements: true }))).toBe(
    '{"updatedAt":0,"screenSize":{"width":1080,"height":2400},"systemInsets":{"top":63,"bottom":63,"left":0,"right":0},"viewHierarchy":{"hierarchy":{"node":{"$":{},"className":"android.widget.FrameLayout","packageName":"dev.jasonpearson.automobile.playground","bounds":{"left":0,"top":0,"right":1080,"bottom":2400},"node":[{"resource-id":"android:id/content","$":{},"className":"android.widget.FrameLayout","packageName":"dev.jasonpearson.automobile.playground","bounds":{"left":0,"top":0,"right":1080,"bottom":2400},"node":[{"resource-id":"navigation.HomeDestination","$":{},"className":"android.view.View","packageName":"dev.jasonpearson.automobile.playground","bounds":{"left":0,"top":0,"right":1080,"bottom":2400},"node":[{"text":"Swipe","$":{},"className":"android.widget.TextView","packageName":"dev.jasonpearson.automobile.playground","bounds":{"left":274,"top":330,"right":374,"bottom":383},"node":[]}]}]}]}}}}',
  );
  expect(JSON.stringify(raw)).toBe(before);
});

test("captured text entry preserves exact diff fields and key order", () => {
  expect(JSON.stringify(diffObserveResult(empty as ObserveResult, typed as ObserveResult))).toBe(
    '{"isDiff":true,"skeleton":[],"added":[{"key":"\\u000084,871,996,1018\\u0000SignOff3051\\u00001","attributes":{"text":"SignOff3051","view-id":"763cf961-5e5b-fcd0-5e13-177303451c69","className":"android.widget.EditText","clickable":"true","focusable":"true","focused":"true","long-clickable":"true","extras":{"androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_START_KEY":"[]","android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL":"354"},"bounds":{"left":84,"top":871,"right":996,"bottom":1018}}}],"removed":[{"key":"\\u000084,871,996,1018\\u0000\\u00001","attributes":{"view-id":"763cf961-5e5b-fcd0-5e13-177303451c69","className":"android.widget.EditText","clickable":"true","focusable":"true","focused":"true","long-clickable":"true","bounds":{"left":84,"top":871,"right":996,"bottom":1018}}},{"key":"\\u0000126,903,476,1029\\u0000\\u00002","attributes":{"view-id":"82085003-5843-be13-f808-72de01e613c2","bounds":{"left":126,"top":903,"right":476,"bottom":1029}}},{"key":"\\u0000126,934,476,997\\u0000Enter some text...\\u00000","attributes":{"text":"Enter some text...","view-id":"b0a6a234-634a-6d28-e444-2b108fca15c3","bounds":{"left":126,"top":934,"right":476,"bottom":997}}}],"changed":[{"key":"com.android.systemui:id/mobile_combo\\u0000930,2,969,60\\u0000\\u00001","selector":{"elementId":"com.android.systemui:id/mobile_combo","label":"Phone three bars."},"changes":{"content-desc":{"from":"Phone two bars.","to":"Phone three bars."}}},{"key":"\\u0000126,934,954,997\\u0000\\u00001","fromKey":"\\u0000476,934,954,997\\u0000\\u00001","selector":{"elementId":"362e47c2-be56-cd6c-f7f9-f5ad8b905f3e"},"changes":{"bounds":{"from":{"left":476,"top":934,"right":954,"bottom":997},"to":{"left":126,"top":934,"right":954,"bottom":997}}}}],"fields":{"focusedElement":{"from":{"className":"android.widget.EditText","clickable":"true","focusable":"true","focused":true,"long-clickable":"true","bounds":{"left":84,"top":871,"right":996,"bottom":1018}},"to":{"text":"SignOff3051","className":"android.widget.EditText","clickable":"true","focusable":"true","focused":true,"long-clickable":"true","bounds":{"left":84,"top":871,"right":996,"bottom":1018}}}}}',
  );
});

import home from "../../../fixtures/observe/android-home.json";

test("captured audit with present replacements preserves exact wire telemetry", () => {
  const input = {
    updatedAt: home.updatedAt,
    perfTiming: home.perfTiming,
    performanceAudit: structuredClone(home.performanceAudit),
  } as ObserveResult;
  input.gfxMetrics = {
    packageName: "captured.app",
    percentile50thMs: 12,
    percentile90thMs: 18,
    percentile95thMs: 22,
    percentile99thMs: 30,
    missedVsyncCount: 1,
    slowUiThreadCount: 1,
    frameDeadlineMissedCount: 0,
    pollCount: 7,
    stabilityWaitMs: 350,
    isStable: true,
  };

  expect(JSON.stringify(sanitizeObserveResult(input, { dropElements: false }))).toBe(
    '{"updatedAt":1782909171267,"performanceAudit":{"passed":false,"metrics":{"p50Ms":4950,"p90Ms":4950,"p95Ms":4950,"p99Ms":4950,"jankCount":0,"missedVsyncCount":0,"slowUiThreadCount":0,"frameDeadlineMissedCount":0,"cpuUsagePercent":0.11411323571043924,"threadCount":48,"touchLatencyMs":null,"anrDetected":false,"anrDetails":null,"timeToFirstFrameMs":null,"timeToInteractiveMs":null,"frameRateFps":null,"gfxinfoRaw":null,"cpuStatsRaw":null},"violations":[{"metric":"p50","threshold":15.000000000000002,"actual":4950,"severity":"warning","contributionWeight":0.6},{"metric":"p90","threshold":16.666666666666668,"actual":4950,"severity":"warning","contributionWeight":0.7},{"metric":"p95","threshold":20,"actual":4950,"severity":"critical","contributionWeight":0.8},{"metric":"p99","threshold":25,"actual":4950,"severity":"warning","contributionWeight":0.4}],"deviceCapabilities":{"refreshRate":60,"frameTimeMs":16.666666666666668}},"gfxMetrics":{"packageName":"captured.app","pollCount":7,"stabilityWaitMs":350,"isStable":true}}',
  );
});

test("captured audit with null replacements preserves exact wire telemetry", () => {
  const input = {
    updatedAt: home.updatedAt,
    perfTiming: home.perfTiming,
    performanceAudit: structuredClone(home.performanceAudit),
  } as ObserveResult;
  input.gfxMetrics = {
    packageName: "captured.app",
    percentile50thMs: 12,
    percentile90thMs: 18,
    percentile95thMs: 22,
    percentile99thMs: 30,
    missedVsyncCount: 1,
    slowUiThreadCount: 1,
    frameDeadlineMissedCount: 0,
    pollCount: 7,
    stabilityWaitMs: 350,
    isStable: true,
  };
  for (const key of [
    "p50Ms",
    "p90Ms",
    "p95Ms",
    "p99Ms",
    "missedVsyncCount",
    "slowUiThreadCount",
    "frameDeadlineMissedCount",
  ] as const) {
    input.performanceAudit!.metrics[key] = null;
  }
  expect(JSON.stringify(sanitizeObserveResult(input, { dropElements: false }))).toBe(
    '{"updatedAt":1782909171267,"performanceAudit":{"passed":false,"metrics":{"p50Ms":null,"p90Ms":null,"p95Ms":null,"p99Ms":null,"jankCount":0,"missedVsyncCount":null,"slowUiThreadCount":null,"frameDeadlineMissedCount":null,"cpuUsagePercent":0.11411323571043924,"threadCount":48,"touchLatencyMs":null,"anrDetected":false,"anrDetails":null,"timeToFirstFrameMs":null,"timeToInteractiveMs":null,"frameRateFps":null,"gfxinfoRaw":null,"cpuStatsRaw":null},"violations":[{"metric":"p50","threshold":15.000000000000002,"actual":4950,"severity":"warning","contributionWeight":0.6},{"metric":"p90","threshold":16.666666666666668,"actual":4950,"severity":"warning","contributionWeight":0.7},{"metric":"p95","threshold":20,"actual":4950,"severity":"critical","contributionWeight":0.8},{"metric":"p99","threshold":25,"actual":4950,"severity":"warning","contributionWeight":0.4}],"deviceCapabilities":{"refreshRate":60,"frameTimeMs":16.666666666666668}},"gfxMetrics":{"packageName":"captured.app","percentile50thMs":12,"percentile90thMs":18,"percentile95thMs":22,"percentile99thMs":30,"missedVsyncCount":1,"slowUiThreadCount":1,"frameDeadlineMissedCount":0,"pollCount":7,"stabilityWaitMs":350,"isStable":true}}',
  );
});

test("captured audit with undefined replacements preserves exact wire telemetry", () => {
  const input = {
    updatedAt: home.updatedAt,
    perfTiming: home.perfTiming,
    performanceAudit: structuredClone(home.performanceAudit),
  } as ObserveResult;
  input.gfxMetrics = {
    packageName: "captured.app",
    percentile50thMs: 12,
    percentile90thMs: 18,
    percentile95thMs: 22,
    percentile99thMs: 30,
    missedVsyncCount: 1,
    slowUiThreadCount: 1,
    frameDeadlineMissedCount: 0,
    pollCount: 7,
    stabilityWaitMs: 350,
    isStable: true,
  };
  for (const key of [
    "p50Ms",
    "p90Ms",
    "p95Ms",
    "p99Ms",
    "missedVsyncCount",
    "slowUiThreadCount",
    "frameDeadlineMissedCount",
  ] as const) {
    input.performanceAudit!.metrics[key] = undefined;
  }
  expect(JSON.stringify(sanitizeObserveResult(input, { dropElements: false }))).toBe(
    '{"updatedAt":1782909171267,"performanceAudit":{"passed":false,"metrics":{"jankCount":0,"cpuUsagePercent":0.11411323571043924,"threadCount":48,"touchLatencyMs":null,"anrDetected":false,"anrDetails":null,"timeToFirstFrameMs":null,"timeToInteractiveMs":null,"frameRateFps":null,"gfxinfoRaw":null,"cpuStatsRaw":null},"violations":[{"metric":"p50","threshold":15.000000000000002,"actual":4950,"severity":"warning","contributionWeight":0.6},{"metric":"p90","threshold":16.666666666666668,"actual":4950,"severity":"warning","contributionWeight":0.7},{"metric":"p95","threshold":20,"actual":4950,"severity":"critical","contributionWeight":0.8},{"metric":"p99","threshold":25,"actual":4950,"severity":"warning","contributionWeight":0.4}],"deviceCapabilities":{"refreshRate":60,"frameTimeMs":16.666666666666668}},"gfxMetrics":{"packageName":"captured.app","percentile50thMs":12,"percentile90thMs":18,"percentile95thMs":22,"percentile99thMs":30,"missedVsyncCount":1,"slowUiThreadCount":1,"frameDeadlineMissedCount":0,"pollCount":7,"stabilityWaitMs":350,"isStable":true}}',
  );
});
