import { expect, test } from "bun:test";
import {
  extractArtifactUploads,
  type LocalActionLoader,
} from "../../scripts/ci/workflowArtifactNames";

function fakeActions(actions: Record<string, string>): LocalActionLoader {
  return (ref) => {
    const text = actions[ref];
    if (text === undefined) {
      throw new Error(`unexpected local action ${ref}`);
    }
    return text;
  };
}

const noActions = fakeActions({});

test("reads uploads regardless of key order and quoting, with default names", () => {
  const workflow = `
jobs:
  build:
    steps:
      - with: {name: alpha}
        uses: actions/upload-artifact@v6
      - uses: "actions/upload-artifact@v6"
        with: {name: beta}
      - uses: actions/upload-artifact@v6
      - uses: actions/upload-artifact/merge@v6
      - uses: actions/upload-artifact-lookalike@v1
        with: {name: ignored}
  reusable:
    uses: ./.github/workflows/other.yml
`;
  expect(extractArtifactUploads(workflow, noActions)).toEqual([
    { job: "build", name: "alpha" },
    { job: "build", name: "beta" },
    { job: "build", name: "artifact" },
    { job: "build", name: "merged-artifacts" },
  ]);
});

test("expands nested local composites once per invocation and skips non-composites", () => {
  const loadAction = fakeActions({
    "./.github/actions/outer": `
runs:
  using: composite
  steps:
    - uses: ./.github/actions/inner/
      with: {label: "\${{ inputs.label }}-\${{ github.job }}"}
    - uses: ./.github/actions/node
inputs:
  label: {default: outer}
`,
    "./.github/actions/inner": `
inputs:
  label: {}
runs:
  using: composite
  steps:
    - uses: actions/upload-artifact@v6
      with: {name: "inner-\${{ inputs.label }}"}
`,
    "./.github/actions/node": "runs: {using: node20, main: index.js}",
  });
  const workflow = `
jobs:
  a:
    steps:
      - uses: ./.github/actions/outer
      - uses: ./.github/actions/outer
        with: {label: custom}
`;
  expect(extractArtifactUploads(workflow, loadAction)).toEqual([
    { job: "a", name: "inner-outer-a" },
    { job: "a", name: "inner-custom-a" },
  ]);
});

test("keys names that still depend on inputs by exactly the inputs they read", () => {
  const loadAction = fakeActions({
    "./.github/actions/gradle": `
inputs:
  tasks: {}
  home: {default: "~/.gradle"}
  suffix: {default: ""}
runs:
  using: composite
  steps:
    - id: sanitize
      run: echo "name=\${{ inputs.tasks }}" >> "$GITHUB_OUTPUT"
    - uses: actions/upload-artifact@v6
      with:
        name: report-\${{ steps.sanitize.outputs.name }}\${{ inputs.suffix && '-x' || '' }}
    - uses: actions/upload-artifact@v6
      with:
        name: opaque-\${{ steps.missing.outputs.name }}
`,
  });
  const workflow = `
jobs:
  a:
    steps:
      - uses: ./.github/actions/gradle
        with: {tasks: build, home: /a}
`;
  const names = extractArtifactUploads(workflow, loadAction).map((upload) => upload.name);
  expect(names).toEqual([
    "report-${{ steps.sanitize.outputs.name }}${{ inputs.suffix && '-x' || '' }} " +
      '[inputs {"suffix":"","tasks":"build"}]',
    // An untraceable step output may read any input, so all of them key it.
    'opaque-${{ steps.missing.outputs.name }} [inputs {"home":"/a","suffix":"","tasks":"build"}]',
  ]);
});

test("leaves workflow-level expressions other than github.job literal", () => {
  const workflow = `
jobs:
  lint:
    steps:
      - uses: actions/upload-artifact@v6
        with: {name: "logs-\${{ github.job }}-\${{ matrix.os }}-\${{ inputs.tier }}"}
`;
  expect(extractArtifactUploads(workflow, noActions)).toEqual([
    { job: "lint", name: "logs-lint-${{ matrix.os }}-${{ inputs.tier }}" },
  ]);
});

test("fails loudly on a local action cycle", () => {
  const loadAction = fakeActions({
    "./.github/actions/loop": "runs: {using: composite, steps: [{uses: ./.github/actions/loop}]}",
  });
  const workflow = "jobs: {a: {steps: [{uses: ./.github/actions/loop}]}}";
  expect(() => extractArtifactUploads(workflow, loadAction)).toThrow("local action cycle");
});
