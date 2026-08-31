import {
  ApiError,
  BoardClient,
  currentBoard,
  loadConfig,
  login,
  LoginError,
  normaliseServer,
  rememberBoard,
  saveConfig,
} from '@tsbb/client';

/**
 * The half of the CLI that talks to a board over the network.
 *
 * Everything in commands.ts operates on the database this process can open: it
 * is how you run *your* board. This file is the other thing people want from a
 * `tsbb` binary — reading and posting on a board somebody else runs, from a
 * script or a pipeline, with no database and no browser.
 *
 * Every command takes `--json`, because the reason to have a CLI rather than
 * only a terminal client is that its output can be somebody else's input.
 */

export interface RemoteFlags {
  json?: boolean;
  server?: string;
  limit?: number;
}

class UsageError extends Error {}

/** Print a value as JSON, or hand it to a formatter for a human. */
function emit(flags: RemoteFlags, value: unknown, human: () => string): void {
  if (flags.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  const text = human();
  if (text) console.log(text);
}

function when(seconds: number | null | undefined): string {
  if (!seconds) return 'never';
  const delta = Math.floor(Date.now() / 1000) - seconds;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

/**
 * Which board, and with whose token.
 *
 * `--server` names one explicitly; otherwise it is whichever board `tsbb login`
 * last signed in to. A `--server` that has been logged in to before still gets
 * its token, so `tsbb latest --server other.example` works without switching.
 */
export function clientFor(flags: RemoteFlags): BoardClient {
  const config = loadConfig();
  if (flags.server) {
    const server = normaliseServer(flags.server);
    return new BoardClient({ server, token: config.boards[server]?.token ?? null });
  }

  const board = currentBoard(config);
  if (!board) {
    throw new UsageError(
      'No board configured. Run `tsbb login <server>` first, or pass --server <url>.',
    );
  }
  return new BoardClient({ server: board.server, token: board.token });
}

/** Read a post body from an argument, or from a pipe when it is not given. */
async function bodyFrom(args: string[], index: number): Promise<string> {
  const inline = args.slice(index).join(' ').trim();
  if (inline) return inline;

  if (process.stdin.isTTY) {
    throw new UsageError('No body given. Pass it as an argument, or pipe it in on stdin.');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const piped = Buffer.concat(chunks).toString('utf8').trim();
  if (!piped) throw new UsageError('Nothing arrived on stdin.');
  return piped;
}

// --- account ---------------------------------------------------------------

export async function loginCommand(server: string | undefined, flags: RemoteFlags): Promise<void> {
  const target = server ?? flags.server;
  if (!target) throw new UsageError('Which board? Run `tsbb login <server>`.');

  const client = new BoardClient({ server: normaliseServer(target) });

  // Ask the board what it is before asking it for a token: a typo'd hostname
  // that answers HTTP should not produce a wait for a code that never comes.
  const index = await client.index().catch(() => null);
  if (!flags.json && index) console.log(`${index.board.name} at ${client.server}\n`);

  const token = await login(client, {
    label: 'tsbb cli',
    onPrompt: (grant) => {
      if (flags.json) return;
      console.log('  Open this page and approve the code:\n');
      console.log(`    ${grant.verifyUrl}`);
      console.log(`    code: ${grant.userCode}\n`);
      console.log('  Waiting…');
    },
  });

  const me = await client.me();
  rememberBoard({ server: client.server, token, username: me.user?.username ?? null });
  emit(flags, { server: client.server, username: me.user?.username ?? null }, () =>
    `Signed in to ${client.server} as ${me.user?.username ?? 'someone'}.`,
  );
}

export function logoutCommand(server: string | undefined, flags: RemoteFlags): void {
  const config = loadConfig();
  const target = normaliseServer(server ?? flags.server ?? config.current ?? '');
  if (!target || !config.boards[target]) {
    throw new UsageError('Not signed in to that board.');
  }
  delete config.boards[target];
  if (config.current === target) {
    config.current = Object.keys(config.boards)[0] ?? null;
  }
  saveConfig(config);
  emit(flags, { server: target, signedOut: true }, () => `Forgot the token for ${target}.`);
}

export function boardsCommand(flags: RemoteFlags): void {
  const config = loadConfig();
  const boards = Object.values(config.boards);
  emit(flags, { current: config.current, boards }, () => {
    if (!boards.length) return 'No boards configured. Run `tsbb login <server>`.';
    return boards
      .map((board) => {
        const mark = board.server === config.current ? '*' : ' ';
        const who = board.username ? ` as ${board.username}` : ' (not signed in)';
        return `  ${mark} ${board.server}${who}`;
      })
      .join('\n');
  });
}

export function useCommand(server: string, flags: RemoteFlags): void {
  const config = loadConfig();
  const target = normaliseServer(server);
  const board = config.boards[target];
  if (!board) throw new UsageError(`Not signed in to ${target}. Run \`tsbb login ${target}\`.`);
  config.current = target;
  saveConfig(config);
  emit(flags, { current: target }, () => `Now using ${target}.`);
}

export async function whoamiCommand(flags: RemoteFlags): Promise<void> {
  const client = clientFor(flags);
  const me = await client.me();
  emit(flags, me, () =>
    me.authenticated
      ? `${me.user?.username} on ${client.server} — ${me.user?.postCount ?? 0} posts, ${me.unread ?? 0} unread.`
      : `Not signed in to ${client.server}.`,
  );
}

// --- reading ---------------------------------------------------------------

export async function forumsCommand(flags: RemoteFlags): Promise<void> {
  const client = clientFor(flags);
  const { forums } = await client.forums();
  emit(flags, { forums }, () =>
    forums.length
      ? forums
          .map(
            (forum) =>
              `${'  '.repeat(forum.depth)}${forum.name}${forum.kind === 'category' ? '' : `  (${forum.slug}) ${forum.topics} topics`}`,
          )
          .join('\n')
      : 'No forums are visible here.',
  );
}

function topicLines(topics: { id: number; title: string; author: string | null; replies: number; lastPostAt: number | null }[]): string {
  return topics
    .map(
      (topic) =>
        `  ${String(topic.id).padStart(5)}  ${topic.title}\n         ${topic.author ?? 'someone'} · ${topic.replies} replies · ${when(topic.lastPostAt)}`,
    )
    .join('\n');
}

export async function latestCommand(flags: RemoteFlags): Promise<void> {
  const client = clientFor(flags);
  const { topics } = await client.latest(flags.limit ?? 20);
  emit(flags, { topics }, () => (topics.length ? topicLines(topics) : 'Nothing posted yet.'));
}

export async function topicsCommand(slug: string, flags: RemoteFlags): Promise<void> {
  if (!slug) throw new UsageError('Which forum? Run `tsbb forums` for the slugs.');
  const client = clientFor(flags);
  const result = await client.topics(slug, flags.limit ?? 20);
  emit(flags, result, () =>
    result.topics.length ? topicLines(result.topics) : `No topics in ${slug}.`,
  );
}

export async function readCommand(id: string, flags: RemoteFlags): Promise<void> {
  const topicId = Number(id);
  if (!Number.isInteger(topicId) || topicId <= 0) {
    throw new UsageError('Which topic? Pass its id, as shown by `tsbb latest`.');
  }
  const client = clientFor(flags);
  const result = await client.topic(topicId, flags.limit ?? 50);
  emit(flags, result, () => {
    const head = `${result.topic.title}\nin ${result.forum.name}${result.topic.locked ? ' · locked' : ''}\n`;
    const posts = result.posts
      .map(
        (post) =>
          `\n--- #${post.id} ${post.author ?? 'someone'} · ${when(post.createdAt)} ---\n${post.text}`,
      )
      .join('\n');
    return `${head}${posts}`;
  });
}

export async function searchCommand(query: string[], flags: RemoteFlags): Promise<void> {
  const q = query.join(' ').trim();
  if (!q) throw new UsageError('Search for what?');
  const client = clientFor(flags);
  const result = await client.search(q, flags.limit ?? 20);
  emit(flags, result, () =>
    result.hits.length
      ? result.hits
          .map(
            (hit) =>
              `  topic ${hit.topicId} post ${hit.postId}  ${hit.title}\n         ${hit.author ?? 'someone'}: ${hit.snippet}`,
          )
          .join('\n')
      : `Nothing matched "${q}".`,
  );
}

export async function inboxCommand(flags: RemoteFlags): Promise<void> {
  const client = clientFor(flags);
  const result = await client.notifications(flags.limit ?? 20);
  emit(flags, result, () =>
    result.notifications.length
      ? `${result.unread} unread\n\n${result.notifications
          .map((n) => `  ${n.readAt ? ' ' : '*'} ${n.kind}  ${n.title ?? ''}${n.excerpt ? ` — ${n.excerpt}` : ''}`)
          .join('\n')}`
      : 'Nothing waiting.',
  );
}

// --- writing ---------------------------------------------------------------

export async function postCommand(args: string[], flags: RemoteFlags): Promise<void> {
  const [slug, title] = args;
  if (!slug || !title) {
    throw new UsageError('Usage: tsbb post <forum> "<title>" [body]  (body may be piped in)');
  }
  const body = await bodyFrom(args, 2);
  const client = clientFor(flags);
  const created = await client.newTopic(slug, title, body);
  emit(flags, { ...created, url: `${client.server}${created.url}` }, () =>
    `Posted topic ${created.id}: ${client.server}${created.url}`,
  );
}

export async function replyCommand(args: string[], flags: RemoteFlags): Promise<void> {
  const topicId = Number(args[0]);
  if (!Number.isInteger(topicId) || topicId <= 0) {
    throw new UsageError('Usage: tsbb reply <topic-id> [body]  (body may be piped in)');
  }
  const body = await bodyFrom(args, 1);
  const client = clientFor(flags);
  const created = await client.reply(topicId, body);
  emit(flags, { ...created, url: `${client.server}${created.url}` }, () =>
    `Replied: ${client.server}${created.url}`,
  );
}

// --- errors ----------------------------------------------------------------

/**
 * Turn a failure into one line and a non-zero exit.
 *
 * A stack trace from a CLI is noise: the reader wants to know whether they
 * typed something wrong, are not signed in, or the board is down.
 */
export function reportRemoteError(error: unknown): void {
  process.exitCode = 1;
  if (error instanceof UsageError || error instanceof LoginError) {
    console.error(error.message);
    return;
  }
  if (error instanceof ApiError) {
    if (error.code === 'unauthorized') {
      console.error('Not signed in. Run `tsbb login <server>`.');
      return;
    }
    if (error.code === 'forbidden') {
      console.error('The board will not let this account do that here.');
      return;
    }
    console.error(error.message);
    return;
  }
  console.error((error as Error).message);
}
