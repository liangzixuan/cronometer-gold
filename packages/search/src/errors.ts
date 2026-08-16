export class FoodSearchError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FoodSearchError";
    this.code = code;
  }
}

export class InvalidSearchQueryError extends FoodSearchError {
  constructor(message: string) {
    super("INVALID_SEARCH_QUERY", message);
    this.name = "InvalidSearchQueryError";
  }
}

export class InvalidCursorError extends FoodSearchError {
  constructor(message = "The search cursor is invalid or does not match this query") {
    super("INVALID_SEARCH_CURSOR", message);
    this.name = "InvalidCursorError";
  }
}

export class SearchBackendError extends FoodSearchError {
  readonly status: number | null;

  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super("SEARCH_BACKEND_ERROR", message, options);
    this.name = "SearchBackendError";
    this.status = status;
  }
}

export class SearchTaskError extends FoodSearchError {
  readonly taskUid: number;

  constructor(taskUid: number, message: string) {
    super("SEARCH_TASK_FAILED", message);
    this.name = "SearchTaskError";
    this.taskUid = taskUid;
  }
}

export class SearchTimeoutError extends FoodSearchError {
  constructor(message: string) {
    super("SEARCH_TIMEOUT", message);
    this.name = "SearchTimeoutError";
  }
}
