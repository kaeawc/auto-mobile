export interface SelectedElementDetection {
  method: "accessibility" | "visual";
  confidence: number;
  reason?: string;
}

export interface SelectedElement {
  text?: string;
  resourceId?: string;
  contentDesc?: string;
  selectedState?: SelectedElementDetection;
}
