import { createHash } from 'node:crypto';
import { createBridgeClient, createCoinPayClient, type BridgeClient } from '@profullstack/bridges';
import { boardUrl } from '@tsbb/core';

/**
 * A way to sign in through someone else's accounts: a host site (bridge) or
 * an OAuth 2.1 provider (CoinPay). Both have the same begin/complete shape, so
 * one pair of routes serves each: /auth/<id> and /auth/<id>/callback.
 */
export interface SignInProvider {
  /** The route segment: /auth/bridge, /auth/coinpay. */
  id: 'bridge' | 'coinpay';
  /** Recorded on each linked identity. */
  provider: string;
  /** "Continue with <name>". */
  name: string;
  client: BridgeClient;
}

/**
 * CoinPay sign-in, when the board is registered as a CoinPay OAuth client:
 *
 *   TSBB_COINPAY_CLIENT_ID       the client id CoinPay issued
 *   TSBB_COINPAY_CLIENT_SECRET   its secret (vault, never the repo)
 *   TSBB_COINPAY_URL             another CoinPay deployment; default coinpayportal.com
 *
 * Register the callback <board>/auth/coinpay/callback with CoinPay.
 */
export function coinpayConfig(baseUrl: string, env: NodeJS.ProcessEnv = process.env): SignInProvider | null {
  const clientId = env.TSBB_COINPAY_CLIENT_ID?.trim();
  const clientSecret = env.TSBB_COINPAY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const base = env.TSBB_COINPAY_URL?.trim() || 'https://coinpayportal.com';
  try {
    return {
      id: 'coinpay',
      provider: new URL(base).host,
      name: 'CoinPay',
      client: createCoinPayClient({
        baseUrl: base,
        clientId,
        clientSecret,
        redirectUri: boardUrl('/auth/coinpay/callback', baseUrl),
        // The state cookie is the board's own: sealed with a key derived from
        // the session secret, whatever length CoinPay's secret happens to be.
        stateSecret: createHash('sha256')
          .update(`tsbb-coinpay-state\u0000${env.TSBB_SESSION_SECRET ?? clientSecret}`)
          .digest('hex'),
      }),
    };
  } catch (error) {
    console.warn(`[tsbb] coinpay: ${error instanceof Error ? error.message : String(error)}; CoinPay sign-in off`);
    return null;
  }
}

/**
 * A host site whose accounts work here (@profullstack/bridges).
 *
 * Configured from the environment, because one of the values is a secret:
 *
 *   TSBB_BRIDGE_AUTHORIZE_URL   the host's authorize endpoint
 *   TSBB_BRIDGE_TOKEN_URL       the host's token endpoint
 *   TSBB_BRIDGE_CLIENT_ID       this board's id at the host
 *   TSBB_BRIDGE_SECRET          the shared secret (vault, never the repo)
 *   TSBB_BRIDGE_NAME            what the button says: "Continue with <name>"
 *   TSBB_BRIDGE_AUTO_COOKIE     a cookie the HOST sets for signed-in users,
 *                               visible here when the board shares its origin
 *                               (c0upons.com/bbs sees c0upons.com's cp_session).
 *                               Automatic sign-in only bounces when it is
 *                               present, so guests and crawlers never do.
 *   TSBB_BRIDGE_AUTO=off        never sign in automatically, only by button
 */
export interface BridgeConfig extends SignInProvider {
  id: 'bridge';
  auto: boolean;
  autoCookie: string | null;
}

export const BRIDGE_STATE_COOKIE = 'tsbb_bridge';
/** Set when a silent attempt found nobody signed in, or after signing out here. */
export const BRIDGE_SKIP_COOKIE = 'tsbb_bridge_skip';

export function bridgeConfig(baseUrl: string, env: NodeJS.ProcessEnv = process.env): BridgeConfig | null {
  const authorizeUrl = env.TSBB_BRIDGE_AUTHORIZE_URL?.trim();
  const tokenUrl = env.TSBB_BRIDGE_TOKEN_URL?.trim();
  const clientId = env.TSBB_BRIDGE_CLIENT_ID?.trim();
  const clientSecret = env.TSBB_BRIDGE_SECRET?.trim();
  if (!authorizeUrl || !tokenUrl || !clientId || !clientSecret) return null;
  let provider: string;
  try {
    provider = new URL(authorizeUrl).host;
  } catch {
    console.warn('[tsbb] bridge: TSBB_BRIDGE_AUTHORIZE_URL is not a URL; bridge off');
    return null;
  }
  try {
    const client = createBridgeClient({
      authorizeUrl,
      tokenUrl,
      clientId,
      clientSecret,
      redirectUri: boardUrl('/auth/bridge/callback', baseUrl),
    });
    return {
      id: 'bridge',
      provider,
      name: env.TSBB_BRIDGE_NAME?.trim() || provider,
      client,
      auto: env.TSBB_BRIDGE_AUTO !== 'off',
      autoCookie: env.TSBB_BRIDGE_AUTO_COOKIE?.trim() || null,
    };
  } catch (error) {
    console.warn(`[tsbb] bridge: ${error instanceof Error ? error.message : String(error)}; bridge off`);
    return null;
  }
}

/** A board-relative path, or `/`. A redirect target is never taken on trust. */
export function localPath(value: string | null | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

const BOT = /bot|crawl|spider|slurp|preview|fetch|monitor|curl|wget|python|httpclient|headless/i;

/** Paths a silent sign-in must never interrupt. */
const QUIET = /^\/(auth|api|assets|icons|p|uploads|admin|link)(\/|$)|^\/(healthz|sw\.js|register-sw\.js|manifest\.webmanifest|robots\.txt|llms\.txt|feed\.xml|favicon\.ico)$|^\/sitemap|^\/\.well-known\//;

/**
 * Whether this request should take a silent detour to the host first.
 * Only a guest's page navigation, only once per skip window, and only when
 * the host's own cookie says they are probably signed in there.
 */
export function wantsSilentSignIn(
  bridge: BridgeConfig,
  request: { method: string; path: string; accept: string; userAgent: string; cookie: (name: string) => string | undefined },
): boolean {
  if (!bridge.auto || request.method !== 'GET') return false;
  if (!request.accept.includes('text/html') || QUIET.test(request.path)) return false;
  if (request.cookie(BRIDGE_SKIP_COOKIE)) return false;
  if (bridge.autoCookie) return Boolean(request.cookie(bridge.autoCookie));
  return !BOT.test(request.userAgent);
}
