/** An error carrying an HTTP status code, thrown by services and mapped to a response. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Optional structured payload (e.g. a list of submit-validation issues). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
