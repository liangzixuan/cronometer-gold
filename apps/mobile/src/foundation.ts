export type FoundationState = "ready" | "building" | "gated";

export interface FoundationItem {
  readonly title: string;
  readonly description: string;
  readonly state: FoundationState;
}

export const foundationItems: readonly FoundationItem[] = [
  {
    title: "Private token boundary",
    description: "The client will keep OIDC tokens in platform-secure storage and out of logs.",
    state: "gated",
  },
  {
    title: "Pure nutrition rules",
    description: "Serving and recipe calculations run from shared, deterministic domain code.",
    state: "building",
  },
  {
    title: "Honest empty state",
    description: "The interface marks unavailable data instead of filling the diary with fixtures.",
    state: "ready",
  },
] as const;
