import { definePlugin, type SlotName } from '@tsbb/plugin-api';

/**
 * CrawlProof ads, bundled and enabled by default.
 *
 * Two decisions here are worth explaining, because both look wrong until you
 * know what goes wrong otherwise.
 *
 * 1. It renders an <iframe> pointing at /api/ads/frame, not the ad.js script.
 *
 *    ad.js injects the creative as a `srcdoc` iframe, and a srcdoc document
 *    inherits the embedder's Content-Security-Policy. The creative is an inline
 *    <style> block plus inline style attributes and remote images, so ad.js only
 *    renders on a page carrying 'unsafe-inline' in style-src and a wide-open
 *    img-src — site-wide, forever. Nothing errors; the unit just stays empty.
 *    A board should not have to weaken its CSP to carry an advert. The frame
 *    path is a full cross-origin document with its own policy, so the cost to
 *    the publisher is one frame-src entry and nothing else: no script-src, no
 *    connect-src, no cookie, and no visitor id written into the board's own
 *    localStorage. Impressions meter server-side either way, so it earns the
 *    same.
 *
 * 2. It never passes a &theme=.
 *
 *    The frame path defaults to a creative that ships both palettes and answers
 *    prefers-color-scheme inside the frame — so the reader's own browser
 *    decides. Naming a theme replaces that with a guess, and on this board the
 *    theme is a cookie the frame cannot see, so the guess would often be wrong.
 */

type Placement = {
  slot: SlotName;
  key: string;
  label: string;
  defaultOn: boolean;
  /** Formats that cannot crop in this position. See the note on widths below. */
  format: string;
};

/*
 * Every banner creative hard-codes its format's pixel width, so a narrower
 * container crops it rather than reflowing. `text_link` is the only fluid
 * format — full width, 40px tall, carries its own "Sponsored" mark — which
 * makes it the only safe choice for a full-width position on a board that is
 * read on phones. `banner_300x250` is the widest fixed creative that fits a
 * 320px viewport, so it is what the block positions use.
 *
 * The obvious alternative — render a desktop and a mobile unit and hide one
 * with CSS — is wrong and expensive: both fill, and filling is what meters the
 * impression, so the hidden one burns an impression nobody ever saw.
 */
const PLACEMENTS: Placement[] = [
  {
    slot: 'board:below_categories',
    key: 'placement.boardIndex',
    label: 'Board index, below the forum list',
    defaultOn: true,
    format: 'banner_300x250',
  },
  {
    slot: 'forum:below_topics',
    key: 'placement.forum',
    label: 'Forum page, below the topic list',
    defaultOn: false,
    format: 'text_link',
  },
  {
    slot: 'topic:above_posts',
    key: 'placement.topicTop',
    label: 'Topic page, above the first post',
    defaultOn: false,
    format: 'text_link',
  },
  {
    slot: 'topic:below_posts',
    key: 'placement.topicBottom',
    label: 'Topic page, below the last post',
    defaultOn: true,
    format: 'banner_300x250',
  },
];

const FRAME_HEIGHT: Record<string, number> = {
  text_link: 40,
  banner_300x250: 250,
  banner_728x90: 90,
  banner_320x50: 50,
};

const ORIGIN = 'https://crawlproof.com';

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

export default definePlugin({
  manifest: {
    slug: 'crawlproof-ads',
    name: 'CrawlProof Ads',
    version: '0.1.0',
    description:
      'Serve ads from the crawlproof.com/ads network. On by default; switch it off or move the units in administration.',
    author: 'Profullstack, Inc.',
    homepage: 'https://crawlproof.com/ads',
    license: 'MIT',
    // Bundled and on from a fresh install. Consulted only the first time the
    // plugin is seen — after that the database wins, so an administrator who
    // turns it off keeps it off across upgrades.
    defaultEnabled: true,
    capabilities: ['render:pages'],
    settings: [
      {
        key: 'slotId',
        label: 'Ad slot ID',
        type: 'string',
        default: '',
        placeholder: 'from crawlproof.com/ads/slots',
        help:
          'Create a slot at crawlproof.com/ads/slots and paste its ID here. New slots are created INACTIVE and serve nothing until you activate them there — an inactive slot looks exactly like a misconfigured one.',
      },
      {
        key: 'hideForStaff',
        label: 'Hide ads from administrators and moderators',
        type: 'boolean',
        default: true,
        help: 'Staff read far more pages than anyone else; their impressions are noise.',
      },
      {
        key: 'hideForMembers',
        label: 'Hide ads from signed-in members',
        type: 'boolean',
        default: false,
        help: 'Most boards show ads to everyone. Turn this on to make an account ad-free.',
      },
      ...PLACEMENTS.map((p) => ({
        key: p.key,
        label: p.label,
        type: 'boolean' as const,
        default: p.defaultOn,
      })),
    ],
  },

  setup(ctx) {
    /**
     * One frame-src entry is the entire cost to the board's own policy. It is
     * added through the filter rather than being written into the server, so
     * disabling the plugin takes the permission away with it.
     */
    ctx.filter('security:csp', (directives) => ({
      ...directives,
      'frame-src': [...(directives['frame-src'] ?? ["'self'"]), ORIGIN],
    }));

    const unit = (format: string) => {
      const slotId = String(ctx.settings.get('slotId') ?? '').trim();
      // Without a slot there is nothing to ask for. Render nothing at all
      // rather than an empty reserved box — an unconfigured board should look
      // finished, not broken.
      if (!slotId) return null;

      const height = FRAME_HEIGHT[format] ?? 250;
      const src = `${ORIGIN}/api/ads/frame?slot=${encodeURIComponent(slotId)}&format=${encodeURIComponent(format)}`;

      return (
        `<div class="cp-ad-unit" style="display:flex;justify-content:center;margin:1.25rem 0">` +
        `<iframe src="${escapeAttribute(src)}" width="100%" height="${height}" loading="lazy" ` +
        `title="Advertisement" scrolling="no" ` +
        `style="border:0;display:block;max-width:100%;height:${height}px;color-scheme:light dark" ` +
        `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe>` +
        `</div>`
      );
    };

    for (const placement of PLACEMENTS) {
      ctx.slot(
        placement.slot,
        (props) => {
          if (ctx.settings.get(placement.key) !== true) return null;

          const viewer = props.viewer;
          if (viewer.isAdmin || viewer.isModerator) {
            if (ctx.settings.get('hideForStaff') === true) return null;
          } else if (viewer.user && ctx.settings.get('hideForMembers') === true) {
            return null;
          }

          return unit(placement.format);
        },
        // A late weight keeps ads below whatever else a slot is carrying.
        100,
      );
    }

    ctx.log.info(
      String(ctx.settings.get('slotId') ?? '').trim()
        ? 'serving ads from crawlproof.com'
        : 'no slot ID set — ads are off until one is configured in administration',
    );
  },
});
