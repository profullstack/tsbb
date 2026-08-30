import { now, one, run } from './client.ts';
import { migrate } from './migrate.ts';

/**
 * Bring a fresh database up to a board somebody can actually use.
 *
 * Idempotent: every insert is guarded, so running it against an existing board
 * adds only what is missing. That matters because it runs from `tsbb init` and
 * people will run that twice.
 */
export async function seed(options: { quiet?: boolean } = {}): Promise<void> {
  await migrate(undefined, { quiet: true });
  const log = (message: string) => {
    if (!options.quiet) console.log(`  ${message}`);
  };
  const timestamp = now();

  // --- Groups -------------------------------------------------------------
  const groups: [string, string, number, number][] = [
    // slug, name, is_default, priority
    ['guests', 'Guests', 0, 0],
    ['members', 'Members', 1, 10],
    ['moderators', 'Moderators', 0, 20],
    ['administrators', 'Administrators', 0, 30],
  ];
  for (const [slug, name, isDefault, priority] of groups) {
    await run(
      `INSERT INTO groups (slug, name, is_default, is_system, priority, created_at)
       VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT (slug) DO NOTHING`,
      [slug, name, isDefault, priority, timestamp],
    );
  }
  log('groups');

  const guestId = await groupId('guests');
  const memberId = await groupId('members');
  const modId = await groupId('moderators');

  // --- Board-wide permissions --------------------------------------------
  // Guests read; members post; moderators moderate. A per-forum row overrides
  // any of these, and an explicit deny there beats an allow here.
  await grant(guestId, { can_view: 1, can_read: 1, can_post: 0, can_reply: 0 });
  await grant(memberId, {
    can_view: 1, can_read: 1, can_post: 1, can_reply: 1,
    can_edit_own: 1, can_delete_own: 1, can_attach: 1, can_poll: 1,
  });
  await grant(modId, { can_view: 1, can_read: 1, can_post: 1, can_reply: 1, can_moderate: 1 });
  log('permissions');

  // --- Ranks --------------------------------------------------------------
  const ranks: [string, number][] = [
    ['New member', 0],
    ['Member', 10],
    ['Regular', 100],
    ['Veteran', 500],
    ['Legend', 2000],
  ];
  for (const [title, minPosts] of ranks) {
    const exists = await one<{ id: number }>('SELECT id FROM ranks WHERE title = ?', [title]);
    if (!exists) {
      await run('INSERT INTO ranks (title, min_posts) VALUES (?, ?)', [title, minPosts]);
    }
  }
  log('ranks');

  // --- A starter forum tree ----------------------------------------------
  const hasForums = await one<{ id: number }>('SELECT id FROM forums LIMIT 1');
  if (!hasForums) {
    const community = await insertForum({ kind: 'category', slug: 'community', name: 'Community', position: 0 });
    await insertForum({
      parentId: community, slug: 'announcements', name: 'Announcements',
      description: 'News about the board itself.', position: 0,
    });
    await insertForum({
      parentId: community, slug: 'general', name: 'General discussion',
      description: 'Anything that does not fit anywhere else.', position: 1,
    });
    await insertForum({
      parentId: community, slug: 'introductions', name: 'Introductions',
      description: 'New here? Say hello.', position: 2,
    });

    const support = await insertForum({ kind: 'category', slug: 'support', name: 'Support', position: 1 });
    await insertForum({
      parentId: support, slug: 'help', name: 'Questions and help',
      description: 'Ask, and mark the answer that worked.', position: 0,
    });
    await insertForum({
      parentId: support, slug: 'bugs', name: 'Bug reports',
      description: 'Something broken? Tell us here.', position: 1,
    });
    log('forums');
  }

  // --- Settings -----------------------------------------------------------
  const hasSettings = await one<{ key: string }>("SELECT key FROM settings WHERE key = 'board.name'");
  if (!hasSettings) {
    for (const [key, value] of Object.entries({
      'board.name': 'A tsbb board',
      'board.tagline': 'A TypeScript bulletin board',
    })) {
      await run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [
        key,
        JSON.stringify(value),
        timestamp,
      ]);
    }
    log('settings');
  }
}

async function groupId(slug: string): Promise<number> {
  const row = await one<{ id: number }>('SELECT id FROM groups WHERE slug = ?', [slug]);
  return Number(row?.id ?? 0);
}

async function grant(group: number, permissions: Record<string, number>): Promise<void> {
  const columns = Object.keys(permissions);
  const values = Object.values(permissions);
  await run(
    `INSERT INTO forum_permissions (forum_id, group_id, ${columns.join(', ')})
     VALUES (NULL, ?, ${columns.map(() => '?').join(', ')})
     ON CONFLICT (forum_id, group_id) DO NOTHING`,
    [group, ...values],
  );
}

async function insertForum(input: {
  parentId?: number;
  kind?: string;
  slug: string;
  name: string;
  description?: string;
  position: number;
}): Promise<number> {
  const result = await run(
    `INSERT INTO forums (parent_id, kind, slug, name, description, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      input.parentId ?? null,
      input.kind ?? 'forum',
      input.slug,
      input.name,
      input.description ?? null,
      input.position,
      now(),
    ],
  );
  return Number((result.rows[0] as { id: number }).id);
}

if (import.meta.filename === process.argv[1]) {
  console.log('Seeding:');
  await seed();
  console.log('Done.');
  process.exit(0);
}
