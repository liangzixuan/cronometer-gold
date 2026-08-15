import type { FastifyPluginAsync } from "fastify";

const versionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["apiVersion"],
      properties: {
        apiVersion: { type: "string", const: "v1" },
      },
    },
  },
} as const;

/**
 * Every business module is registered from this plugin so its public routes are
 * versioned together. Domain modules will be added here as they are built.
 */
export const v1Routes: FastifyPluginAsync = async (app) => {
  app.get(
    "/",
    {
      schema: {
        response: { 200: versionResponseSchema },
      },
    },
    async () => ({ data: { apiVersion: "v1" as const } }),
  );
};
