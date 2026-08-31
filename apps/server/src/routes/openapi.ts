import type { Settings } from '@tsbb/core';

/**
 * The API, described.
 *
 * Written by hand rather than generated, because the alternative is decorating
 * every route with a schema library the board does not otherwise need. The cost
 * is that this file has to be edited when a route is: `test/api.test.ts` walks
 * every path here and asks the board for it, so a description that drifts from
 * the routes fails the suite rather than misleading a reader.
 */
export function openApiDocument(baseUrl: string, settings: Settings): Record<string, unknown> {
  const base = baseUrl.replace(/\/+$/, '');
  const name = String(settings['board.name'] ?? 'tsbb');

  const limit = {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
  };
  const offset = {
    name: 'offset',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 0, default: 0 },
  };

  const json = (description: string) => ({
    description,
    content: { 'application/json': { schema: { type: 'object' } } },
  });

  const errors = {
    '401': json('No token, or a token that is no longer valid.'),
    '403': json('The token is valid but not allowed to see or do this.'),
    '404': json('No such forum, topic, post or member — or none this token may see.'),
  };

  return {
    openapi: '3.1.0',
    info: {
      title: `${name} — tsbb API`,
      version: '1.0.0',
      description:
        'The REST API of a tsbb bulletin board. Every response is resolved through the same permission checks as the HTML pages, so a token never sees what a browser would hide. Reading is open to whatever the board shows guests; posting needs a token from the device flow.',
    },
    servers: [{ url: base }],
    security: [{}, { bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A token from the device flow: POST /api/v1/device/start, have a human approve the code in a browser, then poll /api/v1/device/poll. A token is never an administrator, however it was minted.',
        },
      },
    },
    paths: {
      '/api/v1': {
        get: {
          operationId: 'getIndex',
          summary: 'What this board is and where everything else lives.',
          responses: { '200': json('The index, including the MCP endpoint.') },
        },
      },
      '/api/v1/openapi.json': {
        get: {
          operationId: 'getOpenApi',
          summary: 'This document.',
          responses: { '200': json('An OpenAPI 3.1 description of this board.') },
        },
      },
      '/api/v1/me': {
        get: {
          operationId: 'getMe',
          summary: 'Who the current token is, and how much is unread.',
          responses: { '200': json('Authenticated false for a guest, rather than a 401.') },
        },
      },
      '/api/v1/board': {
        get: {
          operationId: 'getBoard',
          summary: 'The forum tree, filtered to what this token may see.',
          responses: { '200': json('The board name and a nested forum tree.') },
        },
      },
      '/api/v1/forums': {
        get: {
          operationId: 'listForums',
          summary: 'The same forums, flattened, with a depth on each.',
          responses: { '200': json('A flat list of forums.') },
        },
      },
      '/api/v1/stats': {
        get: {
          operationId: 'getStats',
          summary: 'Member, topic and post counts.',
          responses: { '200': json('Counts, and the newest member.') },
        },
      },
      '/api/v1/latest': {
        get: {
          operationId: 'listLatest',
          summary: 'The most recently active topics across every readable forum.',
          parameters: [limit, offset],
          responses: { '200': json('Topic summaries, most recently posted in first.') },
        },
      },
      '/api/v1/forums/{slug}/topics': {
        get: {
          operationId: 'listTopics',
          summary: 'Topics in one forum.',
          parameters: [
            { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
            limit,
            offset,
          ],
          responses: { '200': json('The forum, and its topics.'), ...errors },
        },
        post: {
          operationId: 'createTopic',
          summary: 'Start a topic.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title', 'body'],
                  properties: {
                    title: { type: 'string' },
                    body: { type: 'string' },
                    format: { type: 'string', enum: ['markdown', 'bbcode'], default: 'markdown' },
                  },
                },
              },
            },
          },
          responses: {
            '201': json('The new topic id, slug and URL.'),
            '400': json('The board refused the post — too short, too fast, or a banned word.'),
            ...errors,
          },
        },
      },
      '/api/v1/topics/{id}': {
        get: {
          operationId: 'getTopic',
          summary: 'One topic and its posts, with a plain-text rendering of each body.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
            limit,
            offset,
          ],
          responses: { '200': json('The topic, its forum, and a page of posts.'), ...errors },
        },
      },
      '/api/v1/topics/{id}/posts': {
        post: {
          operationId: 'replyToTopic',
          summary: 'Reply to a topic.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['body'],
                  properties: {
                    body: { type: 'string' },
                    format: { type: 'string', enum: ['markdown', 'bbcode'], default: 'markdown' },
                  },
                },
              },
            },
          },
          responses: {
            '201': json('The new post id and URL.'),
            '400': json('The board refused the post.'),
            ...errors,
          },
        },
      },
      '/api/v1/posts/{id}': {
        get: {
          operationId: 'getPost',
          summary: 'One post on its own, with the topic it belongs to.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { '200': json('The post, its topic, and a URL.'), ...errors },
        },
      },
      '/api/v1/users/{username}': {
        get: {
          operationId: 'getUser',
          summary: "A member's public profile.",
          parameters: [{ name: 'username', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': json('The profile.'), ...errors },
        },
      },
      '/api/v1/search': {
        get: {
          operationId: 'search',
          summary: 'Full-text search over readable posts, titles weighted above bodies.',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            limit,
          ],
          responses: { '200': json('Hits, each with the topic and post it is in.') },
        },
      },
      '/api/v1/notifications': {
        get: {
          operationId: 'listNotifications',
          summary: 'Replies, mentions, quotes and messages for the signed-in member.',
          security: [{ bearerAuth: [] }],
          parameters: [
            limit,
            { name: 'unread', in: 'query', required: false, schema: { type: 'string', enum: ['1'] } },
          ],
          responses: { '200': json('The unread count and the notifications.'), ...errors },
        },
      },
      '/api/v1/notifications/read': {
        post: {
          operationId: 'markNotificationsRead',
          summary: 'Mark everything read.',
          security: [{ bearerAuth: [] }],
          responses: { '200': json('ok'), ...errors },
        },
      },
      '/api/v1/device/start': {
        post: {
          operationId: 'startDeviceAuth',
          summary: 'Begin the device flow: get a short code for a human to approve.',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { label: { type: 'string' }, publicKey: { type: 'string' } },
                },
              },
            },
          },
          responses: { '200': json('A device code, a user code, and where to approve it.') },
        },
      },
      '/api/v1/device/poll': {
        post: {
          operationId: 'pollDeviceAuth',
          summary: 'Ask whether the code has been approved yet.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['deviceCode'],
                  properties: { deviceCode: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': json('pending, or approved with a token.'),
            '410': json('The code expired before anybody approved it.'),
          },
        },
      },
      '/api/mcp': {
        post: {
          operationId: 'mcp',
          summary: 'Model Context Protocol over streamable HTTP. One JSON-RPC message per request.',
          security: [{}, { bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['jsonrpc', 'method'],
                  properties: {
                    jsonrpc: { type: 'string', const: '2.0' },
                    id: { type: ['string', 'integer', 'null'] },
                    method: { type: 'string' },
                    params: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: {
            '200': json('The JSON-RPC response.'),
            '202': json('A notification was accepted; there is nothing to answer.'),
          },
        },
      },
    },
  };
}
