import { definePlugin } from '@tsbb/plugin-api';
import { footerHtml, latestTemplate } from '@profullstack/footer';

/**
 * The Profullstack network footer (@profullstack/footer), for boards that
 * Profullstack runs: the << Profullstack >> webring row, the built.indie and
 * pwamart badges and the copyright line, under the board's own footer.
 *
 * Ships DISABLED. Joining a webring and showing someone else's badges is the
 * operator's choice, not something an upgrade should decide for every board.
 *
 * Two things shape it:
 *
 * 1. It renders on the server, into the page. The ring's verifier reads the
 *    HTML and never runs script, so a footer drawn by the browser would never
 *    count as a ring member.
 *
 * 2. Its CSS is served from the board, not inlined. The board's policy is
 *    style-src 'self' with no 'unsafe-inline', which refuses the package's
 *    inline <style>, so the markup is rendered with css:false and the same CSS
 *    comes from /p/profullstack-footer/footer.css. Both follow the @latest
 *    template the package fetches (15 min cache), so a footer release reaches
 *    the board without a redeploy.
 */

const BADGE_HOSTS = ['https://built.indie.pit.world', 'https://pwamart.com'];

export default definePlugin({
  manifest: {
    slug: 'profullstack-footer',
    name: 'Profullstack Footer',
    version: '0.1.0',
    description:
      'The Profullstack network footer: webring row plus the built.indie and pwamart badges. Off by default; for boards run by Profullstack.',
    author: 'Profullstack, Inc.',
    homepage: 'https://github.com/profullstack/footer',
    license: 'MIT',
    defaultEnabled: false,
    capabilities: ['render:pages'],
    settings: [
      {
        key: 'site',
        label: 'Site homepage',
        type: 'string',
        default: '',
        placeholder: 'https://example.com/',
        help:
          'The homepage that is the ring member and the badge listing. Leave empty to use the board URL.',
      },
      {
        key: 'since',
        label: 'First copyright year',
        type: 'number',
        default: 0,
        help: 'Renders "since–this year" on the copyright line. 0 shows only this year.',
      },
    ],
  },

  setup(ctx) {
    const site = () => String(ctx.settings.get('site') ?? '').trim() || ctx.url('/');

    // img-src is normally https: already; name the two badge hosts anyway so a
    // board that narrows img-src keeps its badges.
    ctx.filter('security:csp', (directives) => {
      const img = directives['img-src'];
      if (!img || img.includes('https:') || img.includes('*')) return directives;
      return { ...directives, 'img-src': [...img, ...BADGE_HOSTS.filter((h) => !img.includes(h))] };
    });

    ctx.slot('layout:head', () => `<link rel="stylesheet" href="${ctx.url('/p/profullstack-footer/footer.css')}">`);

    ctx.slot(
      'layout:footer',
      async () => {
        const since = Number(ctx.settings.get('since') ?? 0);
        return footerHtml({ site: site(), css: false, ...(since > 0 ? { since } : {}) });
      },
      // Last in the footer, below anything another plugin puts there.
      1000,
    );

    ctx.route('GET', '/footer.css', async () => {
      const template = await latestTemplate();
      return new Response(template.css, {
        headers: {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'public, max-age=900',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    });

    ctx.log.info(`Profullstack footer for ${site()}`);
  },
});
