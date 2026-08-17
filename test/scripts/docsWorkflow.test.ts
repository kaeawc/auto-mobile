import { describe, expect, test } from "bun:test";
import { loadWorkflow } from "../helpers/workflowSteps";

// Guards #3578 and #5311: only the deployment job may receive Pages/OIDC
// write credentials, and it must deploy main's changed documentation only.
const workflow = loadWorkflow(".github/workflows/docs.yml");
const check = workflow.jobs?.check;
const deployDocs = workflow.jobs?.["deploy-docs"];

describe("docs deployment workflow", () => {
  test("workflow defaults to the least privileges needed by its check job", () => {
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(check).toBeDefined();
    expect(check?.permissions).toBeUndefined();
  });

  test("deploy-docs alone has the Pages and OIDC deployment permissions", () => {
    expect(deployDocs?.permissions).toEqual({
      actions: "read",
      contents: "read",
      pages: "write",
      "id-token": "write"
    });
  });

  test("deploy-docs queues Pages deploys without cancelling a predecessor", () => {
    expect(workflow.concurrency).toBeUndefined();
    expect(deployDocs?.concurrency).toEqual({ group: "pages", "cancel-in-progress": false });
  });

  test("deploy-docs publishes only changed documentation from main", () => {
    expect(deployDocs?.if).toBe("github.ref == 'refs/heads/main' && needs.check.outputs.changed == 'true'");
  });
});
