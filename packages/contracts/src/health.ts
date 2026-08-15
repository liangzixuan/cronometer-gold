export interface ProbeResponse {
  readonly status: "ok";
}

export const probeResponseSchema = {
  $id: "ProbeResponse",
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "ok" },
  },
} as const;
