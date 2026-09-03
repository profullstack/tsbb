import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Self-updating. The network and the shell are both injected, so what is
 * tested is the decisions: which release counts as newer, what is refused,
 * what is recorded for the admin panel, and the order of the commands run.
 */
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-updates-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3996';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const core = await import('../packages/core/src/index.ts');
const db = await import('../packages/db/src/index.ts');

/** A fake GitHub that publishes one release. */
function github(tag: string | null, status = 200): typeof fetch {
  return (async () =>
    new Response(
      tag === null ? 'Not Found' : JSON.stringify({ tag_name: tag, html_url: `https://example.com/${tag}`, body: 'notes' }),
      { status: tag === null ? 404 : status, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
}

describe('version comparison', () => {
  it('orders dotted versions numerically, not as strings', () => {
    assert.ok(core.compareVersions('0.10.0', '0.9.0') > 0);
    assert.ok(core.compareVersions('1.0.0', '0.99.99') > 0);
    assert.equal(core.compareVersions('v0.3.0', '0.3.0'), 0);
    assert.ok(core.compareVersions('0.3.0-rc.1', '0.3.0') < 0, 'a prerelease sits below its release');
    assert.ok(core.compareVersions('0.3', '0.3.0') === 0);
  });

  it('acts only on release tags', () => {
    assert.ok(core.isReleaseTag('v0.3.0'));
    assert.ok(core.isReleaseTag('v1.2.3-beta.1'));
    assert.ok(!core.isReleaseTag('0.3.0'));
    assert.ok(!core.isReleaseTag('main'));
    assert.ok(!core.isReleaseTag('v0.3.0; rm -rf /'));
  });
});

describe('checking for a release', () => {
  before(async () => {
    await seed({ quiet: true });
  });
  after(() => db.setDb(null));

  it('reports a newer release and records it for the panel', async () => {
    const check = await core.checkForUpdate({ fetch: github('v99.0.0') });
    assert.equal(check.available, true);
    assert.equal(check.latest?.version, '99.0.0');
    assert.equal(check.current, core.currentVersion());

    const state = await core.updateState();
    assert.equal(state.latestVersion, '99.0.0');
    assert.equal(state.available, true);
    assert.equal(state.checkError, null);
    assert.equal(state.auto, true, 'automatic updates are on unless an administrator says otherwise');
  });

  it('is not tempted by an older or equal release', async () => {
    const check = await core.checkForUpdate({ fetch: github(`v${core.currentVersion()}`) });
    assert.equal(check.available, false);
    const older = await core.checkForUpdate({ fetch: github('v0.0.1') });
    assert.equal(older.available, false);
  });

  it('treats no release at all as nothing to do', async () => {
    const check = await core.checkForUpdate({ fetch: github(null) });
    assert.equal(check.latest, null);
    assert.equal(check.available, false);
  });

  it('records a failed check instead of hiding it', async () => {
    await assert.rejects(core.checkForUpdate({ fetch: github('v1.0.0', 503) }), /503/);
    const state = await core.updateState();
    assert.match(String(state.checkError), /503/);
  });

  it('knows a container from a checkout', () => {
    assert.equal(core.installKind(scratch), 'image', 'no .git means nothing to fetch into');
    assert.equal(core.installKind(), 'git', 'the repository these tests run in is a checkout');
  });
});

describe('applying a release', () => {
  before(async () => {
    await seed({ quiet: true });
  });
  after(() => db.setDb(null));

  it('refuses a container, a bad tag, and a checkout with local changes', async () => {
    await assert.rejects(core.applyUpdate('1.0.0', { root: scratch }), /redeploy/);
    await assert.rejects(core.applyUpdate('main', { root: scratch }), /not a release tag/);

    const dirty = join(scratch, 'dirty');
    mkdirSync(join(dirty, '.git'), { recursive: true });
    const calls: string[] = [];
    await assert.rejects(
      core.applyUpdate('1.0.0', {
        root: dirty,
        run: async (file, args) => {
          calls.push(`${file} ${args.join(' ')}`);
          return { stdout: ' M apps/server/src/app.ts\n' };
        },
      }),
      /local changes/,
    );
    assert.equal(calls.length, 1, 'nothing runs after the refusal');
    assert.match(calls[0] ?? '', /^git status/);
  });

  it('fetches the tag, checks it out, installs, and records it', async () => {
    const root = join(scratch, 'clean');
    mkdirSync(join(root, '.git'), { recursive: true });
    const calls: string[] = [];
    await core.applyUpdate('v1.2.3', {
      root,
      run: async (file, args) => {
        const line = `${file} ${args.join(' ')}`;
        calls.push(line);
        if (line.startsWith('git rev-parse --abbrev-ref')) return { stdout: 'main\n' };
        return { stdout: '' };
      },
    });
    assert.deepEqual(calls, [
      'git status --porcelain --untracked-files=no',
      'git rev-parse --abbrev-ref HEAD',
      'git fetch --quiet --tags origin refs/tags/v1.2.3:refs/tags/v1.2.3',
      'git -c advice.detachedHead=false checkout --quiet v1.2.3',
      'pnpm install --frozen-lockfile --ignore-scripts',
    ]);
    const state = await core.updateState();
    assert.equal(state.appliedVersion, '1.2.3');
    assert.equal(state.applyError, null);
  });

  it('puts the previous version back when the install fails', async () => {
    const root = join(scratch, 'broken');
    mkdirSync(join(root, '.git'), { recursive: true });
    const calls: string[] = [];
    await assert.rejects(
      core.applyUpdate('1.2.4', {
        root,
        run: async (file, args) => {
          const line = `${file} ${args.join(' ')}`;
          calls.push(line);
          if (line.startsWith('git rev-parse --abbrev-ref')) return { stdout: 'HEAD\n' };
          if (line === 'git rev-parse HEAD') return { stdout: 'abc123\n' };
          if (line === 'pnpm install --frozen-lockfile --ignore-scripts') throw new Error('ERR_PNPM_NO_OFFLINE');
          return { stdout: '' };
        },
      }),
      /previous version was restored/,
    );
    assert.ok(calls.includes('git checkout --quiet abc123'), 'a detached checkout goes back to its commit');
    const state = await core.updateState();
    assert.match(String(state.applyError), /ERR_PNPM/);
  });
});

describe('the admin panel', () => {
  let app: { fetch: (req: Request) => Response | Promise<Response> };
  let cookie = '';
  const url = (path: string) => `http://localhost:3996${path}`;
  const get = (path: string) => app.fetch(new Request(url(path), { headers: { cookie }, redirect: 'manual' }));
  const post = (path: string, body: Record<string, string> = {}) =>
    app.fetch(
      new Request(url(path), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      }),
    );

  before(async () => {
    await seed({ quiet: true });
    app = (await boot({ listen: false })).app;
    const admin = await core.createUser({ username: 'root', email: 'root@example.com', isAdmin: true });
    cookie = `tsbb_session=${(await core.createSession(admin.id)).id}`;
  });
  after(() => db.setDb(null));

  it('shows the running version and offers a check', async () => {
    const body = await (await get('/admin')).text();
    assert.ok(body.includes('Updates'), 'the overview has an Updates card');
    assert.ok(body.includes(core.currentVersion()));
    assert.ok(body.includes('/admin/updates/check'));
    assert.ok(body.includes('Automatic updates are'));
  });

  it('says when a new version is out, and offers to install it', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = github('v99.0.0');
    try {
      const response = await post('/admin/updates/check');
      assert.equal(response.status, 303);
    } finally {
      globalThis.fetch = realFetch;
    }
    const body = await (await get('/admin')).text();
    assert.ok(body.includes('Version 99.0.0'), 'the card names the release');
    assert.ok(body.includes('/admin/updates/apply'), 'a checkout is offered the install');
  });

  it('lets an administrator turn automatic updates off', async () => {
    const form = await (await get('/admin/settings')).text();
    assert.ok(form.includes('name="updates.auto" checked'), 'on by default');

    const response = await post('/admin/settings', { 'board.name': 'Test board' });
    assert.equal(response.status, 303);
    const state = await core.updateState();
    assert.equal(state.auto, false, 'an unticked box is off');
    const overview = await (await get('/admin')).text();
    assert.ok(overview.includes('>off</a>'));
  });
});
