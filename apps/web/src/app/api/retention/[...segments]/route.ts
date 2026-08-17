import { privateJsonError } from "../../../../lib/private-api";
import { proxyRetentionRequest } from "../proxy";

export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ readonly segments: string[] }>;
}

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const { segments } = await context.params;
  if (
    !Array.isArray(segments) ||
    segments.length < 1 ||
    segments.length > 4 ||
    segments.some((segment) => !/^[a-z0-9_-]{1,64}$/u.test(segment))
  )
    return privateJsonError(400, "The private account path is invalid.");
  return proxyRetentionRequest(request, segments);
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context);
}
