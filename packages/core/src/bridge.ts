import { now, one, run } from '@tsbb/db';
import type { User } from '@tsbb/plugin-api';
import { sha256 } from './util.ts';
import { createUser, freeUsername, userById, userByEmail } from './users.ts';
import { userCount } from './auth.ts';

/** What a host site vouches for (see @profullstack/bridges). Only `sub` links. */
export interface BridgeClaims {
  sub: string;
  name?: string;
  username?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
}

/**
 * The board account for a host site's user, creating and linking one the
 * first time they arrive.
 *
 * Found by the host's id for them (`sub`), never by email or name: those can
 * change on the host, and following them could move someone into another
 * person's account. The one exception is the first arrival, when an existing
 * board account with the same email is linked, and only if the host says it
 * verified that email; otherwise anyone could claim an account here by
 * typing its address into their profile there.
 */
export async function bridgeAccount(provider: string, claims: BridgeClaims): Promise<User> {
  const linked = await one<{ user_id: number }>(
    'SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?',
    [provider, claims.sub],
  );
  if (linked) {
    const user = await userById(linked.user_id);
    if (user) {
      await run('UPDATE user_identities SET last_used_at = ? WHERE provider = ? AND subject = ?', [
        now(),
        provider,
        claims.sub,
      ]);
      return user;
    }
  }

  const email = claims.email?.trim().toLowerCase();
  let user = email && claims.email_verified ? await userByEmail(email) : null;
  if (!user) {
    // An email the host could not vouch for, or one already in use here, is
    // not reused: the account gets a placeholder nothing is ever sent to.
    const usable = email && claims.email_verified && !(await userByEmail(email)) ? email : null;
    const placeholder = `${sha256(`${provider}\u0000${claims.sub}`).slice(0, 24)}@bridge.invalid`;
    user = await createUser({
      username: await freeUsername(claims.username ?? claims.name ?? email?.split('@')[0] ?? 'member'),
      email: usable ?? placeholder,
      isAdmin: (await userCount()) === 0,
    });
    if (claims.name) await run('UPDATE users SET display_name = ? WHERE id = ?', [claims.name, user.id]);
  }

  await run(
    `INSERT INTO user_identities (provider, subject, user_id, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (provider, subject) DO UPDATE SET user_id = excluded.user_id, last_used_at = excluded.last_used_at`,
    [provider, claims.sub, user.id, now(), now()],
  );
  return (await userById(user.id)) ?? user;
}
