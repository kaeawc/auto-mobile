export class HierarchyRunnerError extends Error {
  constructor(readonly runnerError: string) {
    super(runnerError);
    this.name = "HierarchyRunnerError";
  }
}
