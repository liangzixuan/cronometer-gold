import type { FastifyPluginAsync } from "fastify";

import { type FoodRoutesOptions, foodRoutes } from "./foods/food.routes.js";

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
export const v1Routes: FastifyPluginAsync<FoodRoutesOptions> = async (app, options) => {
  app.get(
    "/",
    {
      schema: {
        response: { 200: versionResponseSchema },
      },
    },
    async () => ({ data: { apiVersion: "v1" as const } }),
  );

  void app.register(foodRoutes, {
    prefix: "/foods",
    ...(options.foodSearchService ? { foodSearchService: options.foodSearchService } : {}),
  });
};
