export class SendKeysBudgetError extends Error {
  constructor() {
    super(
      "sendKeys request budget exhausted; stopping to allow cancellation and keyboard restoration",
    );
  }
}
