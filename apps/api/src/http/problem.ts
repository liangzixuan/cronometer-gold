import type { ProblemCode, ProblemIssue } from "@nutrition-tracker/contracts";

interface HttpProblemOptions {
  statusCode: number;
  code: ProblemCode;
  title: string;
  detail: string;
  type?: string;
  issues?: readonly ProblemIssue[];
  expose?: boolean;
  cause?: unknown;
}

export class HttpProblem extends Error {
  readonly statusCode: number;
  readonly code: ProblemCode;
  readonly title: string;
  readonly detail: string;
  readonly type: string;
  readonly issues: readonly ProblemIssue[] | undefined;
  readonly expose: boolean;

  constructor(options: HttpProblemOptions) {
    super(options.detail, { cause: options.cause });
    this.name = "HttpProblem";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.title = options.title;
    this.detail = options.detail;
    this.type = options.type ?? "about:blank";
    this.issues = options.issues;
    this.expose = options.expose ?? options.statusCode < 500;
  }
}
