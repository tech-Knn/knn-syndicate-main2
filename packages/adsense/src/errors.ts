/** Thrown when AdSense/AFS API access isn't configured (no OAuth token / account). */
export class AdsenseNotConfiguredError extends Error {
  constructor(message = 'AdSense API is not configured') {
    super(message);
    this.name = 'AdsenseNotConfiguredError';
  }
}

/** Thrown when the AdSense Management API returns a non-OK response or bad shape. */
export class AdsenseRequestError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AdsenseRequestError';
    this.status = status;
  }
}
