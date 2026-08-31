import { ApiError, type BoardClient } from '@tsbb/client';

/**
 * What an assistant can do with a board.
 *
 * Every tool is a thin call onto the REST API, which is the point: an assistant
 * holds a token minted by the device flow, so it sees exactly what that member
 * would see in a browser and can do exactly what they could do. There is no
 * second permission model here to fall out of step with the first one.
 */
export interface ToolContext {
  client: BoardClient;
  /** Writes are off unless the server was given a token and told to allow them. */
  allowWrites: boolean;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** A write tool is hidden entirely when the server is read-only. */
  write?: boolean;
  run: (context: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const LIMIT = {
  type: 'integer',
  minimum: 1,
  maximum: 100,
  description: 'How many to return. Defaults to 30.',
};

function text(body: string, structured?: Record<string, unknown>): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text: body }] };
  if (structured) result.structuredContent = structured;
  return result;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolInputError(`${key} is required.`);
  }
  return value.trim();
}

function int(args: Record<string, unknown>, key: string): number {
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ToolInputError(`${key} must be a positive whole number.`);
  }
  return value;
}

function optionalInt(args: Record<string, unknown>, key: string, fallback: number): number {
  if (args[key] === undefined || args[key] === null) return fallback;
  const value = Number(args[key]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export class ToolInputError extends Error {}

/** A timestamp a model can reason about, rather than a Unix second count. */
function when(seconds: number | null | undefined): string {
  if (!seconds) return 'never';
  return new Date(seconds * 1000).toISOString();
}

function topicLine(topic: {
  id: number;
  title: string;
  author: string | null;
  replies: number;
  views: number;
  lastPostAt: number | null;
  locked: boolean;
  solved: boolean;
}): string {
  const marks = [topic.locked ? 'locked' : null, topic.solved ? 'solved' : null]
    .filter(Boolean)
    .join(', ');
  return `#${topic.id} ${topic.title}${marks ? ` (${marks})` : ''}\n    by ${topic.author ?? 'someone'} · ${topic.replies} replies · ${topic.views} views · last post ${when(topic.lastPostAt)}`;
}

export const TOOLS: Tool[] = [
  {
    name: 'board_overview',
    title: 'Board overview',
    description:
      'What this board is: its name, tagline, size, and the forums the current token may see. Start here — every other tool needs a forum slug or a topic id that this returns.',
    inputSchema: schema({}),
    async run({ client }) {
      const [board, stats] = await Promise.all([client.board(), client.stats()]);
      const lines: string[] = [
        `${board.board.name}${board.board.tagline ? ` — ${board.board.tagline}` : ''}`,
        `${stats.members} members · ${stats.topics} topics · ${stats.posts} posts`,
        '',
        'Forums:',
      ];
      const walk = (nodes: typeof board.forums, depth: number): void => {
        for (const node of nodes) {
          const indent = '  '.repeat(depth + 1);
          const label = node.kind === 'category' ? node.name : `${node.name} (${node.slug})`;
          lines.push(`${indent}${label} — ${node.topics} topics, ${node.posts} posts`);
          walk(node.children, depth + 1);
        }
      };
      walk(board.forums, 0);
      return text(lines.join('\n'), { board: board.board, stats, forums: board.forums });
    },
  },
  {
    name: 'list_forums',
    title: 'List forums',
    description:
      'Every forum the current token may read, as a flat list with slugs. Use a slug with list_topics or create_topic.',
    inputSchema: schema({}),
    async run({ client }) {
      const { forums } = await client.forums();
      if (!forums.length) return text('No forums are visible to this token.', { forums });
      const lines = forums.map(
        (forum) =>
          `${'  '.repeat(forum.depth)}${forum.slug ? `${forum.slug} — ` : ''}${forum.name}${forum.kind === 'category' ? ' [category]' : ` (${forum.topics} topics)`}`,
      );
      return text(lines.join('\n'), { forums });
    },
  },
  {
    name: 'list_topics',
    title: 'List topics',
    description:
      'Topics in one forum, or the most recently active topics across the whole board when no forum is given.',
    inputSchema: schema({
      forum: { type: 'string', description: 'A forum slug, from list_forums. Omit for the whole board.' },
      limit: LIMIT,
    }),
    async run({ client }, args) {
      const limit = optionalInt(args, 'limit', 30);
      const forum = typeof args.forum === 'string' && args.forum.trim() ? args.forum.trim() : null;
      const result = forum ? await client.topics(forum, limit) : await client.latest(limit);
      const topics = result.topics;
      const heading = forum ? `Topics in ${forum}` : 'Latest topics';
      if (!topics.length) return text(`${heading}: none.`, { topics });
      return text(
        `${heading} (${topics.length}):\n\n${topics.map((t) => `  ${topicLine(t)}`).join('\n')}`,
        { topics },
      );
    },
  },
  {
    name: 'read_topic',
    title: 'Read a topic',
    description:
      'The posts in one topic, oldest first, as plain text. Markdown and BBCode are already rendered down.',
    inputSchema: schema(
      {
        topicId: { type: 'integer', description: 'The topic id, from list_topics or search_posts.' },
        limit: { ...LIMIT, description: 'How many posts to return. Defaults to 50.' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many posts, to page through a long topic.' },
      },
      ['topicId'],
    ),
    async run({ client }, args) {
      const id = int(args, 'topicId');
      const limit = optionalInt(args, 'limit', 50);
      const result = await client.topic(id, limit);
      const head = `${result.topic.title}\nin ${result.forum.name} · ${result.topic.replies} replies${result.topic.locked ? ' · locked' : ''}\n`;
      const body = result.posts
        .map((post) => `--- post #${post.id} by ${post.author ?? 'someone'} at ${when(post.createdAt)} ---\n${post.text}`)
        .join('\n\n');
      return text(`${head}\n${body}`, {
        topic: result.topic,
        forum: result.forum,
        canReply: result.canReply,
        posts: result.posts,
      });
    },
  },
  {
    name: 'read_post',
    title: 'Read one post',
    description: 'A single post by id, with the topic it belongs to. Useful after search_posts.',
    inputSchema: schema({ postId: { type: 'integer' } }, ['postId']),
    async run({ client }, args) {
      const result = await client.post(int(args, 'postId'));
      return text(
        `post #${result.post.id} in "${result.topic.title}" by ${result.post.author ?? 'someone'} at ${when(result.post.createdAt)}\n\n${result.post.text}`,
        { post: result.post, topic: result.topic, url: result.url },
      );
    },
  },
  {
    name: 'search_posts',
    title: 'Search the board',
    description:
      'Full-text search across posts the current token may read. Titles are weighted above bodies, so a topic name finds the topic.',
    inputSchema: schema({ query: { type: 'string' }, limit: LIMIT }, ['query']),
    async run({ client }, args) {
      const query = str(args, 'query');
      const result = await client.search(query, optionalInt(args, 'limit', 30));
      if (!result.hits.length) return text(`Nothing matched "${query}".`, { hits: [] });
      const lines = result.hits.map(
        (hit) =>
          `  topic #${hit.topicId} post #${hit.postId} — ${hit.title}\n    ${hit.author ?? 'someone'}: ${hit.snippet}`,
      );
      return text(`${result.hits.length} results for "${query}":\n\n${lines.join('\n')}`, {
        query,
        hits: result.hits,
      });
    },
  },
  {
    name: 'get_member',
    title: 'Look up a member',
    description: 'One member’s public profile: their title, bio, post count and when they were last seen.',
    inputSchema: schema({ username: { type: 'string' } }, ['username']),
    async run({ client }, args) {
      const { user } = await client.user(str(args, 'username'));
      const lines = [
        `${user.username}${user.displayName ? ` (${user.displayName})` : ''}${user.isModerator ? ' — staff' : ''}`,
        user.title ? `Title: ${user.title}` : null,
        `${user.postCount} posts · joined ${when(user.createdAt)} · last seen ${when(user.lastSeenAt)}`,
        user.bio ? `\n${user.bio}` : null,
      ].filter(Boolean);
      return text(lines.join('\n'), { user });
    },
  },
  {
    name: 'whoami',
    title: 'Who this token is',
    description:
      'Whether this server is signed in, as whom, and whether it may post. Call this when a write fails.',
    inputSchema: schema({}),
    async run({ client, allowWrites }) {
      const me = await client.me();
      if (!me.authenticated) {
        return text(
          'Not signed in. This server can read whatever the board shows to guests, and cannot post. Run `tsbb login` to authorise it.',
          { authenticated: false, canWrite: false },
        );
      }
      return text(
        `Signed in as ${me.user?.username} (${me.user?.postCount ?? 0} posts, ${me.unread ?? 0} unread). Writes are ${allowWrites ? 'enabled' : 'disabled on this server'}.`,
        { authenticated: true, user: me.user, unread: me.unread, canWrite: allowWrites },
      );
    },
  },
  {
    name: 'list_notifications',
    title: 'List notifications',
    description: 'Replies, mentions, quotes and private messages waiting for the signed-in member.',
    inputSchema: schema({ limit: LIMIT }),
    async run({ client }, args) {
      const result = await client.notifications(optionalInt(args, 'limit', 30));
      if (!result.notifications.length) {
        return text('Nothing waiting.', { unread: result.unread, notifications: [] });
      }
      const lines = result.notifications.map(
        (n) => `  ${n.readAt ? ' ' : '*'} ${n.kind}: ${n.title ?? ''}${n.excerpt ? ` — ${n.excerpt}` : ''}`,
      );
      return text(`${result.unread} unread:\n\n${lines.join('\n')}`, result as never);
    },
  },
  {
    name: 'create_topic',
    title: 'Start a topic',
    description:
      'Post a new topic in a forum. The body is Markdown. This writes to the board under the signed-in member’s name — confirm with the person you are helping before calling it.',
    write: true,
    inputSchema: schema(
      {
        forum: { type: 'string', description: 'A forum slug, from list_forums.' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown.' },
      },
      ['forum', 'title', 'body'],
    ),
    async run({ client }, args) {
      const created = await client.newTopic(str(args, 'forum'), str(args, 'title'), str(args, 'body'));
      return text(`Posted topic #${created.id} at ${client.server}${created.url}`, {
        id: created.id,
        url: `${client.server}${created.url}`,
      });
    },
  },
  {
    name: 'reply_to_topic',
    title: 'Reply to a topic',
    description:
      'Add a reply to an existing topic. The body is Markdown. This writes to the board under the signed-in member’s name — confirm with the person you are helping before calling it.',
    write: true,
    inputSchema: schema(
      { topicId: { type: 'integer' }, body: { type: 'string', description: 'Markdown.' } },
      ['topicId', 'body'],
    ),
    async run({ client }, args) {
      const created = await client.reply(int(args, 'topicId'), str(args, 'body'));
      return text(`Replied as post #${created.id} at ${client.server}${created.url}`, {
        id: created.id,
        url: `${client.server}${created.url}`,
      });
    },
  },
];

/** The tools this server offers, which is fewer than all of them when read-only. */
export function toolsFor(allowWrites: boolean): Tool[] {
  return allowWrites ? TOOLS : TOOLS.filter((tool) => !tool.write);
}

/**
 * Run a tool and turn any failure into a result the model can act on.
 *
 * A tool that throws a JSON-RPC error tells the model only that something broke.
 * `isError` with the board's own words — "forbidden", "you must sign in" — lets
 * it recover, which for an unauthenticated server usually means saying so.
 */
export async function runTool(
  tool: Tool,
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    return await tool.run(context, args);
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
    if (error instanceof ApiError) {
      const hint =
        error.code === 'unauthorized'
          ? ' This server is not signed in — run `tsbb login` and restart it.'
          : error.code === 'forbidden'
            ? ' The signed-in member is not allowed to do that here.'
            : '';
      return {
        content: [{ type: 'text', text: `${error.message}${hint}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `The board could not answer: ${(error as Error).message}` }],
      isError: true,
    };
  }
}
