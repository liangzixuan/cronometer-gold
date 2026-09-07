import {
  problemDetailsSchema,
  type UpdateUserProfileRequest,
  type UserProfile,
  type UserProfilePatch,
  type UserProfileResponse,
  updateUserProfileRequestSchema,
  userProfileResponseSchema,
} from "@nutrition-tracker/contracts";
import type { FastifyPluginAsync } from "fastify";

import { authenticatedPrincipal, requireAuthentication } from "../../http/authentication.js";
import { requireRevision, revisionEtag } from "../../http/preconditions.js";
import { HttpProblem } from "../../http/problem.js";
import {
  rejectUnexpectedBodyKeys,
  rejectUnexpectedQueryKeys,
} from "../../http/request-validation.js";
import type { AuthService } from "../auth/auth-service.js";
import { normalizeProfilePatch } from "./profile-validation.js";

export interface ProfileService {
  get(userId: string): Promise<UserProfile | null>;
  update(input: {
    readonly userId: string;
    readonly expectedRevision: string;
    readonly patch: UserProfilePatch;
  }): Promise<UserProfile>;
}

export interface ProfileRoutesOptions {
  readonly authService?: AuthService;
  readonly profileService?: ProfileService;
}

export class ProfileRevisionConflictServiceError extends Error {
  constructor() {
    super("Profile revision conflict");
    this.name = "ProfileRevisionConflictServiceError";
  }
}

export class ProfileValidationServiceError extends Error {
  constructor() {
    super("Profile validation failed");
    this.name = "ProfileValidationServiceError";
  }
}

function unavailable(cause?: unknown): HttpProblem {
  return new HttpProblem({
    statusCode: 503,
    code: "SERVICE_NOT_READY",
    title: "Service Unavailable",
    detail: "Profile services are temporarily unavailable.",
    expose: true,
    cause,
  });
}

function mapProfileError(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof ProfileRevisionConflictServiceError) {
    return new HttpProblem({
      statusCode: 412,
      code: "PRECONDITION_FAILED",
      title: "Precondition Failed",
      detail: "The profile changed. Refresh it and retry your edit.",
      expose: true,
    });
  }
  if (error instanceof ProfileValidationServiceError || error instanceof RangeError) {
    return new HttpProblem({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      title: "Bad Request",
      detail: "One or more profile fields are invalid.",
      expose: true,
    });
  }
  return unavailable(error);
}

export const profileRoutes: FastifyPluginAsync<ProfileRoutesOptions> = async (app, options) => {
  const requireAuth = requireAuthentication(options.authService);

  app.get(
    "/",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys([]),
      schema: {
        response: {
          200: userProfileResponseSchema,
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<UserProfileResponse> => {
      if (!options.profileService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      try {
        const profile = await options.profileService.get(principal.userId);
        if (!profile) throw unavailable();
        reply.header("cache-control", "no-store").header("etag", revisionEtag(profile.revision));
        return { data: { profile } };
      } catch (error) {
        throw mapProfileError(error);
      }
    },
  );

  app.patch<{ Body: UpdateUserProfileRequest }>(
    "/",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys([]),
        rejectUnexpectedBodyKeys([
          "displayName",
          "birthDate",
          "sexAtBirth",
          "heightCm",
          "baselineWeightKg",
          "activityLevelCode",
          "locale",
          "timeZone",
          "unitSystem",
          "diaryGroups",
          "expectedOwnerUserId",
        ]),
      ],
      schema: {
        body: updateUserProfileRequestSchema,
        response: {
          200: userProfileResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<UserProfileResponse> => {
      if (!options.profileService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const { expectedOwnerUserId, ...profilePatch } = request.body;
      if (expectedOwnerUserId !== undefined && expectedOwnerUserId !== principal.userId) {
        throw new HttpProblem({
          statusCode: 409,
          code: "PROFILE_OWNER_CHANGED",
          title: "Conflict",
          detail: "The signed-in account changed. Reload before updating the profile.",
          expose: true,
        });
      }
      const expectedRevision = requireRevision(request.headers["if-match"], { allowZero: true });
      try {
        const profile = await options.profileService.update({
          userId: principal.userId,
          expectedRevision,
          patch: normalizeProfilePatch(profilePatch),
        });
        reply.header("cache-control", "no-store").header("etag", revisionEtag(profile.revision));
        return { data: { profile } };
      } catch (error) {
        throw mapProfileError(error);
      }
    },
  );
};
