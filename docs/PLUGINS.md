# Writing a tsbb plugin

A plugin is a directory. Drop it in `plugins/`, restart, and it appears in
*Administration → Plugins*. There is no build step, no registry to publish to,
and no CLI to run.

Copy `plugins/hello-world/` to start.

---

## The shape of one

```
plugins/my-plugin/
  package.json          optional
  plugin.json           optional — anything the manifest leaves out
  migrations/           optional — your own tables
    0001_init.sql
  src/
    index.ts            required — default-exports the plugin
```

```ts
import { definePlugin } from '@tsbb/plugin-api';

export default definePlugin({
  manifest: {
    slug: 'my-plugin',
    name: 'My Plugin',
    version: '1.0.0',
    description: 'What it does, in one line.',
    license: 'MIT',
    migrations: 'migrations',
    capabilities: ['render:pages'],
    settings: [
      { key: 'greeting', label: 'Greeting', type: 'string', default: 'Hello' },
      { key: 'enabled', label: 'Show the banner', type: 'boolean', default: true },
    ],
  },

  setup(ctx) {
    // register everything here
  },

  teardown(ctx) {
    // optional: called before the plugin is disabled
  },
});
```

`slug` is the identity: it is the URL prefix (`/p/my-plugin`), the configuration
key and the row in the database. Do not change it after release — a new slug is
a new plugin with no settings.

## The trust model, stated plainly

A plugin is code running inside the board's own process, exactly as in phpBB or
WordPress. `ctx` is an ergonomic API, not a sandbox: a plugin that wants to
bypass it can. `capabilities` in the manifest is a *declaration* shown to the
administrator, not an enforced limit.

Installing a plugin is installing code. The admin panel says so, and so should
your README.

## Three mechanisms

### Filters — change a value

A filter receives a value and must return one. Handlers run in registration
order (lowest weight first), each seeing the previous one's output.

```ts
ctx.filter('post:render', (html, { post, author, viewer }) => {
  return html.replace(/:shipit:/g, '<img src="/p/my-plugin/shipit.png" alt="shipit">');
});
```

**Return the value.** A filter that returns nothing blanks whatever it was
filtering. If a filter throws, it is skipped and the previous value carries on —
a broken plugin cannot blank a page — and the failure is recorded against your
slug and shown in the admin panel.

| Filter | Value | When |
|---|---|---|
| `post:render` | rendered HTML | after the markup pipeline, before display |
| `signature:render` | rendered HTML | same, for a signature that has passed the gate |
| `signature:min_posts` | `number` | how many posts before a signature shows |
| `post:before_save` | `PostDraft` | before a post is written — **throw to refuse it** |
| `topic:before_save` | `string` | a topic title, before it is written |
| `permissions:resolve` | `Permissions` | after group resolution |
| `nav:items` | `NavItem[]` | the main navigation |
| `page:head` | `SlotNode[]` | extra tags for `<head>` |
| `notify:recipients` | `Id[]` | after subscription fan-out and blocking |
| `mail:before_send` | `{to, subject, html, text}` | immediately before the transport |
| `security:csp` | `CspDirectives` | the page's Content-Security-Policy |

Refusing a post is a filter that throws:

```ts
ctx.filter('post:before_save', (draft, { viewer }) => {
  if (draft.body.includes('buy cheap')) throw new Error('That looks like spam.');
  return draft;
});
```

The filter runs before anything is written, so a refusal leaves no trace.

### Actions — react to something

```ts
ctx.on('post:created', async ({ post, topic, viewer }) => {
  await fetch('https://hooks.example.com/…', { method: 'POST', body: JSON.stringify({ post }) });
});
```

Actions run concurrently and their return values are ignored. **A rejected
action is logged and swallowed** — it cannot fail the write that raised it,
which is why a slow webhook here is safe and the same code in a filter would
not be.

`boot`, `shutdown`, `post:created`, `post:updated`, `post:deleted`,
`topic:created`, `topic:locked`, `topic:moved`, `user:registered`, `user:login`,
`user:banned`, `report:created`, `reaction:added`.

### Slots — render into a page

```ts
ctx.slot('topic:below_posts', ({ topic, viewer }) => {
  if (!viewer.user) return null;
  return `<div class="card"><div class="card-content">Reading ${escape(topic.title)}</div></div>`;
});
```

Return a string of HTML, or `null` for nothing. Slot output is inserted as
**trusted** HTML — escape anything that came from a person. Handlers run
concurrently and are ordered by weight afterwards, so the page is stable however
the network behaved.

`layout:head`, `layout:header`, `layout:body_start`, `layout:body_end`,
`layout:footer`, `layout:sidebar`, `board:above_categories`,
`board:below_categories`, `forum:above_topics`, `forum:below_topics`,
`topic:above_posts`, `topic:between_posts`, `topic:below_posts`, `post:byline`,
`post:footer`, `profile:tabs`, `composer:toolbar`, `admin:nav`.

Use the board's own classes — `.card`, `.btn`, `.badge`, `.alert` — and your
plugin inherits the theme, light and dark, for free.

## Settings

Declare them in the manifest and the admin panel builds the form. No plugin
ships its own settings page, which is what keeps every plugin's configuration
looking and behaving the same.

```ts
settings: [
  { key: 'apiKey', label: 'API key', type: 'string', secret: true, help: 'From example.com/keys' },
  { key: 'limit', label: 'Items', type: 'number', default: 10 },
  { key: 'on', label: 'Enabled', type: 'boolean', default: true },
  { key: 'mode', label: 'Mode', type: 'select', default: 'a',
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  { key: 'notes', label: 'Notes', type: 'text', rows: 6 },
]
```

```ts
ctx.settings.get<string>('apiKey');
ctx.settings.all();
await ctx.settings.set('apiKey', 'new');
```

Only keys the manifest declares are ever written. A form field you did not ask
for is not a setting, whatever it is called.

## Storage

For a little state, use the key/value store — no migration needed:

```ts
await ctx.data.set('cursor', { at: Date.now() });
const cursor = await ctx.data.get<{ at: number }>('cursor');
await ctx.data.keys('prefix:');
```

For real tables, ship migrations. They are tracked in `plugin_migrations`, apart
from the board's own ledger, so removing your plugin never disturbs it. Files
are applied in filename order, once each, forever — **never rename or edit one
that has shipped**; add another.

Reads against the board's own tables go through `ctx.query`, which is read-only
by design:

```ts
const rows = await ctx.query<{ n: number }>('SELECT COUNT(*) AS n FROM posts WHERE forum_id = ?', [3]);
```

A plugin that needs to write owns tables of its own through a migration. That
keeps a plugin's writes visible in the schema rather than hidden inside
arbitrary SQL.

## Routes

```ts
ctx.route('GET', '/status', async (req) => ({ ok: true, who: req.viewer.user?.username }));
ctx.route('POST', '/hook', async (req) => {
  const body = await req.json<{ event: string }>();
  return new Response('ok');
}, { requires: 'admin' });
```

Mounted under `/p/<slug>`. Return a `Response`, a string (sent as HTML), or an
object (sent as JSON).

`requires` is enforced by the host, not by you — `guest`, `user`, `moderator` or
`admin`. A plugin that forgets to check would otherwise be a hole in the board.

## Notifications

```ts
await ctx.notify({
  userId: 42,
  title: 'Something happened',
  excerpt: 'A short line of context.',
  url: '/t/a-topic-1',
  dedupeKey: 'my-plugin:thing:1',
});
```

The kind is `plugin:<your-slug>`, so members can turn your notifications off
without turning off anything else. `dedupeKey` collapses repeats while the row
is still unread.

## Being enabled by default

```ts
manifest: { defaultEnabled: true }
```

Only honoured the **first time** the board sees your plugin. After that the
database row wins, so an administrator who turns it off keeps it off across
upgrades. Reserve this for plugins bundled with the board itself.

## Failure

- A filter or slot that throws is skipped; the page still renders.
- An action that rejects is logged; the write still succeeds.
- A plugin that throws in `setup` is **disabled**, and the board still boots.

In every case the error is recorded against your slug and shown in the admin
panel, so an administrator sees which plugin is misbehaving instead of a stack
trace with no owner.

## Types

```ts
import type {
  Plugin, PluginContext, PluginManifest, SettingSpec,
  User, Forum, Topic, Post, PostDraft, Viewer, Permissions, Notification,
  FilterMap, ActionMap, SlotMap,
} from '@tsbb/plugin-api';
```

Add your own hooks by augmenting the maps:

```ts
declare module '@tsbb/plugin-api' {
  interface FilterMap {
    'my-plugin:score': { value: number; ctx: { post: Post } };
  }
}
```

## Checklist

- [ ] `slug` is final
- [ ] Every setting a person can type is escaped before it reaches a slot
- [ ] Filters return their value on every path
- [ ] Network calls are in actions, not filters
- [ ] Migrations are additive; nothing shipped has been edited
- [ ] `defaultEnabled` is off unless the plugin ships with the board
- [ ] The README says what the plugin reaches
