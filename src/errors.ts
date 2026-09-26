/**
 * Typed errors shared across modules. Thrown at the source, mapped once in the CLI.
 */

/** A human must do exactly one thing; the message is that one sentence. Exit code 3. */
export class NeedsHumanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeedsHumanError';
  }
}

/** The main document answered with an HTTP status that means "not for you" (401/403). */
export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    /** Response looked like it came from Vercel (deployment protection). */
    public readonly vercel = false,
  ) {
    super(`${status} for ${url}`);
    this.name = 'HttpStatusError';
  }
}

export type NavigationFailure = 'refused' | 'timeout' | 'dns' | 'other';

/** page.goto failed before any document arrived. */
export class NavigationError extends Error {
  constructor(public readonly kind: NavigationFailure, public readonly url: string, cause: Error) {
    super(cause.message.split('\n')[0]);
    this.name = 'NavigationError';
  }
}

export class BrowserNotFoundError extends Error {
  constructor(public readonly cause?: Error | null, /** true when an install just ran and launch still failed */ public readonly installed = false) {
    super('No usable Chromium found');
    this.name = 'BrowserNotFoundError';
  }
}

export class GitHubError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

export const GH_LOGIN_HINT = 'Run: gh auth login   (or set GH_TOKEN with repo access), then re-run.';

/**
 * The same instruction for a machine without the gh CLI, which is every hosted
 * agent sandbox measured so far. There "gh auth login" names a command that
 * does not exist, and nobody is at the machine to run it: the only fix left is
 * a variable, set where the environment is configured.
 */
export const TOKEN_ENV_HINT = "Set PRE_POST_GH_TOKEN to a GitHub token with contents and pull-requests write access (in a hosted agent session, add it to the environment's variables and start a new session), then re-run.";

export function isVercelResponse(headers: { get(name: string): string | null }): boolean {
  return Boolean(headers.get('x-vercel-id') || headers.get('server')?.toLowerCase().includes('vercel'));
}
