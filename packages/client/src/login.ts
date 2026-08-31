import { ApiError, type BoardClient } from './client.ts';

/**
 * The device authorisation flow, without a UI.
 *
 * The terminal client drives this itself, interleaved with its own event loop;
 * anything that can simply block — the CLI, a script, an MCP server being set
 * up — uses this instead of writing the polling loop again.
 */
export interface LoginOptions {
  /** What the token is called in the member's session list. */
  label: string;
  /** Called once, with the code and the page a human has to open. */
  onPrompt: (grant: { userCode: string; verifyUrl: string; expiresAt: number }) => void;
  /** Overridable so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

export class LoginError extends Error {}

export async function login(client: BoardClient, options: LoginOptions): Promise<string> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let grant: Awaited<ReturnType<BoardClient['startDeviceAuth']>>;
  try {
    grant = await client.startDeviceAuth(options.label);
  } catch (error) {
    // A board that does not answer the device endpoint is either not a tsbb
    // board or is too old for one, and "404" alone does not say which.
    if (error instanceof ApiError && error.status === 404) {
      throw new LoginError(
        `${client.server} has no device sign-in endpoint. Is it a tsbb board, and recent enough?`,
      );
    }
    throw error;
  }

  options.onPrompt({
    userCode: grant.userCode,
    verifyUrl: grant.verifyUrl,
    expiresAt: grant.expiresAt,
  });

  // The board tells us how often it wants to be asked. Ignoring that interval
  // is how a client gets itself rate-limited on the one request it cannot skip.
  const interval = Math.max(1, grant.interval || 2) * 1000;

  for (;;) {
    await sleep(interval);
    const poll = await client.pollDeviceAuth(grant.deviceCode);
    if (poll.status === 'approved' && poll.token) {
      client.setToken(poll.token);
      return poll.token;
    }
    if (poll.status === 'expired') {
      throw new LoginError('That code expired before it was approved. Run the command again.');
    }
  }
}
