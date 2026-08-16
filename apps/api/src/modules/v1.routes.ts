import type { FastifyPluginAsync } from "fastify";

import { type AuthRoutesOptions, authRoutes } from "./auth/auth.routes.js";
import { type DiaryRoutesOptions, diaryRoutes } from "./diary/diary.routes.js";
import { type FoodRoutesOptions, foodRoutes } from "./foods/food.routes.js";
import { type ProfileRoutesOptions, profileRoutes } from "./profile/profile.routes.js";

export interface V1RoutesOptions
  extends FoodRoutesOptions,
    AuthRoutesOptions,
    ProfileRoutesOptions,
    DiaryRoutesOptions {}

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
export const v1Routes: FastifyPluginAsync<V1RoutesOptions> = async (app, options) => {
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
  void app.register(authRoutes, {
    prefix: "/auth",
    ...(options.authService ? { authService: options.authService } : {}),
  });
  void app.register(profileRoutes, {
    prefix: "/profile",
    ...(options.authService ? { authService: options.authService } : {}),
    ...(options.profileService ? { profileService: options.profileService } : {}),
  });
  void app.register(diaryRoutes, {
    prefix: "/diary",
    ...(options.authService ? { authService: options.authService } : {}),
    ...(options.diaryService ? { diaryService: options.diaryService } : {}),
  });
};
