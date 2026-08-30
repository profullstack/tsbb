import { definePlugin } from '@tsbb/plugin-api';

/**
 * A worked example of every extension point, kept small enough to read in one
 * sitting. Copy this directory to start a plugin of your own.
 *
 * It ships DISABLED. A bundled plugin that turns itself on is a surprise, and
 * the ads plugin is the only one that has earned that.
 */
export default definePlugin({
  manifest: {
    slug: 'hello-world',
    name: 'Hello World',
    version: '0.1.0',
    description: 'An example plugin demonstrating filters, actions, slots, routes and storage.',
    license: 'MIT',
    defaultEnabled: false,
    migrations: 'migrations',
    capabilities: ['render:pages', 'read:posts'],
    settings: [
      { key: 'greeting', label: 'Greeting', type: 'string', default: 'Hello from a plugin' },
      { key: 'showBanner', label: 'Show a banner on the board index', type: 'boolean', default: true },
      {
        key: 'tone',
        label: 'Tone',
        type: 'select',
        default: 'friendly',
        options: [
          { value: 'friendly', label: 'Friendly' },
          { value: 'formal', label: 'Formal' },
        ],
      },
    ],
  },

  async setup(ctx) {
    // --- A slot: contribute markup at a named place in a page --------------
    ctx.slot('board:below_categories', () => {
      if (ctx.settings.get('showBanner') !== true) return null;
      const greeting = String(ctx.settings.get('greeting') ?? 'Hello');
      // Slot output is inserted as trusted HTML, so escape anything that came
      // from a person. Settings are administrator-authored, but an admin is
      // still a person who can paste a stray angle bracket.
      const safe = greeting.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return `<div class="alert"><div><div class="alert-title">${safe}</div>
        <div class="alert-description">This banner comes from the hello-world plugin.</div></div></div>`;
    });

    // --- A filter: transform a value on its way through --------------------
    ctx.filter('post:render', (html, { post }) => {
      if (ctx.settings.get('tone') !== 'formal') return html;
      // Filters must return the value. Returning nothing blanks the post.
      return post.body.includes('hello') ? `${html}<p class="muted tiny">Good day.</p>` : html;
    });

    // --- An action: react to something that happened -----------------------
    ctx.on('post:created', async ({ post, topic }) => {
      await ctx.data.set(`last-post`, { postId: post.id, topicId: topic.id, at: Date.now() });
    });

    // --- A route: mounted at /p/hello-world/... -----------------------------
    ctx.route('GET', '/status', async () => {
      const last = await ctx.data.get<{ postId: number; at: number }>('last-post');
      const rows = await ctx.query<{ n: number }>('SELECT COUNT(*) AS n FROM posts');
      return { ok: true, greeting: ctx.settings.get('greeting'), posts: rows[0]?.n ?? 0, last };
    });

    ctx.route(
      'GET',
      '/secret',
      async (req) => ({ hello: req.viewer.user?.username ?? null }),
      { requires: 'user' },
    );

    ctx.log.info('ready');
  },
});
