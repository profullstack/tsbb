import { Hono } from 'hono';
import { all, now, one, run } from '@tsbb/db';
import {
  KEEP_REVISIONS,
  handleGet,
  handlePut,
  handleRevisions,
  type Snapshot,
  type SnapshotStore,
  type StoredSnapshot,
} from '@profullstack/synconfig/server';
import type { AppEnv, Services } from '../context.ts';

/**
 * Settings sync: a member's tsbb settings (which boards they use) as one
 * snapshot under a revision, so `tsbb sync load` on another machine gets
 * them. The handlers and the conflict rule are @profullstack/synconfig's;
 * this file is the store over this board's database and the three routes.
 *
 *   GET  /api/v1/settings            the latest snapshot; `empty: true` when none
 *   PUT  /api/v1/settings            { snapshot, ifRevision }: a new revision, or 409
 *   GET  /api/v1/settings/revisions  the last ten
 *
 * The board never reads a snapshot's files: it stores what the client sent
 * and hands it back. A token is never in one, by the client's policy.
 */

interface Row {
  revision: number;
  digest: string;
  host: string | null;
  version: string | null;
  size: number;
  body: string;
  created_at: number;
}

const shape = (row: Row): StoredSnapshot => ({
  revision: Number(row.revision),
  digest: row.digest,
  host: row.host,
  version: row.version,
  size: Number(row.size),
  body: JSON.parse(row.body) as Snapshot,
  savedAt: new Date(Number(row.created_at) * 1000).toISOString(),
});

const store: SnapshotStore = {
  async latest(userId) {
    const row = await one<Row>(
      'SELECT revision, digest, host, version, size, body, created_at FROM settings_snapshots WHERE user_id = ? ORDER BY revision DESC LIMIT 1',
      [userId],
    );
    return row ? shape(row) : null;
  },

  async insert(userId, entry, ifRevision) {
    const createdAt = now();
    const body = JSON.stringify(entry.body);
    // The revision is chosen inside the INSERT, and the precondition is
    // checked there too, by a HAVING on the same aggregate, so two machines
    // saving at once produce one revision and one conflict. GROUP BY user_id
    // is what libSQL's parser needs before a HAVING; the unconditional branch
    // has no HAVING and so works on an empty table.
    const sql =
      ifRevision === null
        ? `INSERT INTO settings_snapshots (user_id, revision, digest, host, version, size, body, created_at)
           SELECT ?, COALESCE(MAX(revision), 0) + 1, ?, ?, ?, ?, ?, ?
             FROM settings_snapshots WHERE user_id = ?
           RETURNING revision`
        : `INSERT INTO settings_snapshots (user_id, revision, digest, host, version, size, body, created_at)
           SELECT ?, COALESCE(MAX(revision), 0) + 1, ?, ?, ?, ?, ?, ?
             FROM settings_snapshots WHERE user_id = ?
            GROUP BY user_id
           HAVING COALESCE(MAX(revision), 0) = ?
           RETURNING revision`;
    const values: (string | number | null)[] = [userId, entry.digest, entry.host, entry.version, entry.size, body, createdAt, userId];
    if (ifRevision !== null) values.push(ifRevision);
    let inserted: { revision: number } | null;
    try {
      inserted = await one<{ revision: number }>(sql, values);
    } catch (error) {
      if (/UNIQUE|constraint/i.test(String((error as Error).message))) inserted = null;
      else throw error;
    }
    if (!inserted) {
      const current = await this.latest(userId);
      return { conflict: true, revision: current?.revision ?? 0 };
    }
    const revision = Number(inserted.revision);
    await run('DELETE FROM settings_snapshots WHERE user_id = ? AND revision <= ?', [userId, revision - KEEP_REVISIONS]);
    return { revision, savedAt: new Date(createdAt * 1000).toISOString() };
  },

  async list(userId, limit) {
    const rows = await all<Omit<Row, 'body'>>(
      'SELECT revision, digest, host, version, size, created_at FROM settings_snapshots WHERE user_id = ? ORDER BY revision DESC LIMIT ?',
      [userId, limit],
    );
    return rows.map((row) => ({
      revision: Number(row.revision),
      digest: row.digest,
      host: row.host,
      version: row.version,
      size: Number(row.size),
      savedAt: new Date(Number(row.created_at) * 1000).toISOString(),
    }));
  },
};

export function settingsRoutes(_services: Services) {
  const app = new Hono<AppEnv>();

  const userOf = (c: { get(key: 'viewer'): AppEnv['Variables']['viewer'] }) => c.get('viewer').user;

  app.get('/api/v1/settings', async (c) => {
    const user = userOf(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const reply = await handleGet(store, String(user.id), { emptyStatus: 200 });
    return c.json(reply.body, reply.status as 200);
  });

  app.put('/api/v1/settings', async (c) => {
    const user = userOf(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const reply = await handlePut(store, String(user.id), body);
    return c.json(reply.body, reply.status as 200);
  });

  app.get('/api/v1/settings/revisions', async (c) => {
    const user = userOf(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const reply = await handleRevisions(store, String(user.id));
    return c.json(reply.body, reply.status as 200);
  });

  return app;
}
