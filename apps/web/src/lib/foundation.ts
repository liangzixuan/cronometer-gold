export type MilestoneState = "ready" | "building" | "gated";

export interface FoundationMilestone {
  readonly title: string;
  readonly description: string;
  readonly state: MilestoneState;
}

export const foundationMilestones: readonly FoundationMilestone[] = [
  {
    title: "Workspace boundaries",
    description: "Pure domain rules stay independent from databases, networks, and UI code.",
    state: "ready",
  },
  {
    title: "Nutrition and serving engine",
    description: "Golden-vector calculations preserve explicit units, basis, and missing values.",
    state: "building",
  },
  {
    title: "Food source ingestion",
    description: "FDC and CNF publishing waits for pinned manifests and reproducible imports.",
    state: "gated",
  },
] as const;
