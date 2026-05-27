/** An error carrying an HTTP status code, thrown by services and mapped to a response. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
