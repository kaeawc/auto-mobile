import { ActionableError } from "../../models/ActionableError";
import {
  PERFORMANCE_TRACE_TEMPLATES,
  XCTRACE_TEMPLATE_NAMES,
  type PerformanceTraceTemplate,
} from "./performanceTraceTemplates";

/** The installed Xcode does not ship the Instruments template a performanceTrace template maps to. */
export class XctraceTemplateUnavailableError extends ActionableError {
  readonly instrumentsTemplate: string;
  /** AutoMobile templates whose Instruments template is installed. */
  readonly availableTemplates: PerformanceTraceTemplate[];

  constructor(
    readonly template: PerformanceTraceTemplate,
    installed: ReadonlySet<string>,
  ) {
    const instrumentsTemplate = XCTRACE_TEMPLATE_NAMES[template];
    const availableTemplates = PERFORMANCE_TRACE_TEMPLATES.filter((candidate) =>
      installed.has(XCTRACE_TEMPLATE_NAMES[candidate]),
    );
    const alternatives =
      availableTemplates.length > 0
        ? `Use one of the available templates instead: ${availableTemplates.join(", ")}.`
        : "No performanceTrace template is available on this Xcode; check `xcrun xctrace list templates` and the selected Xcode (`xcode-select -p`).";
    super(
      `The ${template} template needs the "${instrumentsTemplate}" Instruments template, ` +
        `which the installed Xcode does not ship. ${alternatives}`,
    );
    this.name = "XctraceTemplateUnavailableError";
    this.instrumentsTemplate = instrumentsTemplate;
    this.availableTemplates = availableTemplates;
  }
}
