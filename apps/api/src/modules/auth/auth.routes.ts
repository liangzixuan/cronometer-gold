import {
  type AuthCredentialsRequest,
  authCredentialsRequestSchema,
  type CurrentAccountResponse,
  currentAccountResponseSchema,
  problemDetailsSchema,
  type ReauthenticationRequest,
  type ReauthenticationResponse,
  type RegisterAccountRequest,
  reauthenticationRequestSchema,
  reauthenticationResponseSchema,
  registerAccountRequestSchema,
  type SessionCreatedResponse,
  sessionCreatedResponseSchema,
} from "@nutrition-tracker/contracts";
import type { FastifyPluginAsync } from "fastify";

import { authenticatedPrincipal, requireAuthentication } from "../../http/authentication.js";
import { HttpProblem } from "../../http/problem.js";
import {
  rejectUnexpectedBodyKeys,
  rejectUnexpectedQueryKeys,
} from "../../http/request-validation.js";
import {
  AccountAlreadyExistsError,
  AuthRateLimitedError,
  type AuthService,
  InvalidCredentialsError,
} from "./auth-service.js";

export interface AuthRoutesOptions {
  readonly authService?: AuthService;
}

function unavailable(cause?: unknown): HttpProblem {
  return new HttpProblem({
    statusCode: 503,
    code: "SERVICE_NOT_READY",
    title: "Service Unavailable",
    detail: "Account services are temporarily unavailable.",
    expose: true,
    cause,
  });
}

function mapAuthError(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof InvalidCredentialsError) {
    return new HttpProblem({
      statusCode: 401,
      code: "UNAUTHORIZED",
      title: "Unauthorized",
      detail: "Email or password is incorrect.",
      expose: true,
    });
  }
  if (error instanceof AuthRateLimitedError) {
    return new HttpProblem({
      statusCode: 429,
      code: "RATE_LIMITED",
      title: "Too Many Requests",
      detail: "Too many authentication attempts. Try again later.",
      expose: true,
    });
  }
  if (error instanceof RangeError) {
    return new HttpProblem({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      title: "Bad Request",
      detail: "One or more account fields are invalid.",
      expose: true,
    });
  }
  if (error instanceof AccountAlreadyExistsError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Conflict",
      detail: "An account with this email already exists.",
      expose: true,
    });
  }
  return unavailable(error);
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const requireAuth = requireAuthentication(options.authService);

  app.post<{ Body: RegisterAccountRequest }>(
    "/register",
    {
      preValidation: [
        rejectUnexpectedQueryKeys([]),
        rejectUnexpectedBodyKeys(["email", "password", "timeZone", "displayName"]),
      ],
      schema: {
        body: registerAccountRequestSchema,
        response: {
          201: sessionCreatedResponseSchema,
          400: problemDetailsSchema,
          409: problemDetailsSchema,
          429: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<SessionCreatedResponse> => {
      if (!options.authService) throw unavailable();
      try {
        const result = await options.authService.register(request.body);
        reply.header("cache-control", "no-store").status(201);
        return result;
      } catch (error) {
        throw mapAuthError(error);
      }
    },
  );

  app.post<{ Body: AuthCredentialsRequest }>(
    "/login",
    {
      preValidation: [
        rejectUnexpectedQueryKeys([]),
        rejectUnexpectedBodyKeys(["email", "password"]),
      ],
      schema: {
        body: authCredentialsRequestSchema,
        response: {
          200: sessionCreatedResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          429: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<SessionCreatedResponse> => {
      if (!options.authService) throw unavailable();
      try {
        const result = await options.authService.login(request.body.email, request.body.password);
        reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        throw mapAuthError(error);
      }
    },
  );

  app.post<{ Body: ReauthenticationRequest }>(
    "/reauthenticate",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys([]),
        rejectUnexpectedBodyKeys(["password", "purpose"]),
      ],
      schema: {
        body: reauthenticationRequestSchema,
        response: {
          200: reauthenticationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          429: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<ReauthenticationResponse> => {
      const principal = authenticatedPrincipal(request);
      if (!options.authService) throw unavailable();
      try {
        const result = await options.authService.reauthenticate(
          principal.userId,
          principal.sessionTokenHash,
          principal.account.user.email,
          request.body.password,
          request.body.purpose,
        );
        reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        throw mapAuthError(error);
      }
    },
  );

  app.get(
    "/me",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys([]),
      schema: {
        response: {
          200: currentAccountResponseSchema,
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<CurrentAccountResponse> => {
      const principal = authenticatedPrincipal(request);
      reply.header("cache-control", "no-store");
      return { data: principal.account };
    },
  );

  app.post(
    "/logout",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys([]),
      schema: {
        response: {
          204: { type: "null" },
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<void> => {
      const principal = authenticatedPrincipal(request);
      if (!options.authService) throw unavailable();
      try {
        await options.authService.logout(request.headers.authorization, principal.userId);
      } catch (error) {
        throw unavailable(error);
      }
      reply.header("cache-control", "no-store").status(204);
    },
  );
};
