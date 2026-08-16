import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AuthPrincipal, AuthService } from "../modules/auth/auth-service.js";
import { HttpProblem } from "./problem.js";

declare module "fastify" {
  interface FastifyRequest {
    authPrincipal: AuthPrincipal | null;
  }
}

export function registerAuthContext(app: FastifyInstance): void {
  app.decorateRequest("authPrincipal", null);
}

export function authenticationRequired(): HttpProblem {
  return new HttpProblem({
    statusCode: 401,
    code: "UNAUTHORIZED",
    title: "Unauthorized",
    detail: "Valid authentication credentials are required.",
    expose: true,
  });
}

function authUnavailable(cause?: unknown): HttpProblem {
  return new HttpProblem({
    statusCode: 503,
    code: "SERVICE_NOT_READY",
    title: "Service Unavailable",
    detail: "Account services are temporarily unavailable.",
    expose: true,
    cause,
  });
}

export function requireAuthentication(authService: AuthService | undefined): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!authService) throw authUnavailable();
    try {
      const header = request.headers.authorization;
      const principal = await authService.authenticate(header);
      if (!principal) {
        reply.header("www-authenticate", 'Bearer realm="nutrition-api"');
        throw authenticationRequired();
      }
      request.authPrincipal = principal;
    } catch (error) {
      if (error instanceof HttpProblem) throw error;
      throw authUnavailable(error);
    }
  };
}

export function authenticatedPrincipal(request: FastifyRequest): AuthPrincipal {
  if (!request.authPrincipal) throw authenticationRequired();
  return request.authPrincipal;
}
