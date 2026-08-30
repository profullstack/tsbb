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
 * Every placement is a THIN BAR, and that is a constraint rather than a default.
 *
 * `text_link` is the only fluid format the network serves: full width, 40px
 * tall, carrying its own "Sponsored" mark inside the frame. Every banner
 * creative hard-codes its format's pixel width, so a narrower column CROPS it
 * rather than reflowing — which is why a 300x250 square in a content column is
 * not merely ugly, it is broken on a phone.
 *
 * The obvious alternative — render a desktop banner and a mobile one and hide
 * whichever does not fit — is wrong and expensive: both fill, and filling is
 * what meters the impression, so the hidden one burns an impression nobody saw.
 * A server cannot measure the viewport, so it picks one format that works at
 * every width. That format is text_link.
 *
 * banner_728x90 is offered for a board that knows its readers are on desktop,
 * but it is never the default: it crops below 728px.
 */
const FORMAT_CHOICES = [
  { value: 'text_link', label: 'Thin bar — fluid, 40px, works at any width' },
  { value: 'banner_728x90', label: 'Leaderboard 728x90 — crops below 728px' },
];

/*
 * Placements sit at the EDGES of content, never inside it. A unit between two
 * posts interrupts the only thing anybody came to the page for.
 */
const PLACEMENTS: Placement[] = [
  { slot: 'layout:header', key: 'placement.header',
    label: 'Under the navigation, on every page', defaultOn: false, format: 'text_link' },
  { slot: 'board:below_categories', key: 'placement.boardIndex',
    label: 'Board index, under the forum list', defaultOn: true, format: 'text_link' },
  { slot: 'forum:below_topics', key: 'placement.forum',
    label: 'Forum page, under the topic list', defaultOn: true, format: 'text_link' },
  { slot: 'topic:below_posts', key: 'placement.topicBottom',
    label: 'Thread page, under the last post', defaultOn: true, format: 'text_link' },
  { slot: 'topic:between_posts', key: 'placement.betweenPosts',
    label: 'Thread page, between posts (interrupts reading)', defaultOn: false, format: 'text_link' },
  { slot: 'layout:footer', key: 'placement.footer',
    label: 'Above the footer, on every page', defaultOn: false, format: 'text_link' },
];

const FRAME_HEIGHT: Record<string, number> = {
  text_link: 40,
  banner_728x90: 90,
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
        key: 'statsSiteId',
        label: 'Analytics site ID',
        type: 'string',
        default: '',
        placeholder: 'from crawlproof.com/stats',
        help:
          'Optional. Adds the CrawlProof analytics tag. Leave empty and no third-party script is loaded at all — the board ships none of its own.',
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
      {
        key: 'format',
        label: 'Unit format',
        type: 'select',
        default: 'text_link',
        options: FORMAT_CHOICES,
        help:
          'The thin bar is fluid and safe at every width. The leaderboard is wider but crops below 728px, so pick it only if your readers are on desktop.',
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
    /*
     * The board's own policy is script-src 'self' with no 'unsafe-inline'
     * anywhere, so a third-party tag pasted into the layout is simply blocked —
     * silently, which is the worst way for analytics to fail. Widening the
     * policy therefore has to be the plugin's doing, so that turning the plugin
     * off takes the permission with it. Nothing is granted that is not used:
     * script-src is only widened when an analytics ID is actually set.
     */
    ctx.filter('security:csp', (directives) => {
      const next: typeof directives = {
        ...directives,
        'frame-src': [...(directives['frame-src'] ?? ["'self'"]), ORIGIN],
      };
      if (String(ctx.settings.get('statsSiteId') ?? '').trim()) {
        next['script-src'] = [...(directives['script-src'] ?? ["'self'"]), ORIGIN];
        next['connect-src'] = [...(directives['connect-src'] ?? ["'self'"]), ORIGIN];
      }
      return next;
    });

    // The analytics tag, injected at the end of the body like any other slot.
    ctx.slot('layout:body_end', () => {
      const siteId = String(ctx.settings.get('statsSiteId') ?? '').trim();
      if (!siteId) return null;
      return (
        `<script data-site="${escapeAttribute(siteId)}" ` +
        `src="${ORIGIN}/stats.js" async></script>`
      );
    });

    const unit = (format: string) => {
      const slotId = String(ctx.settings.get('slotId') ?? '').trim();
      // Without a slot there is nothing to ask for. Render nothing at all
      // rather than an empty reserved box — an unconfigured board should look
      // finished, not broken.
      if (!slotId) return null;

      const height = FRAME_HEIGHT[format] ?? 40;
      const src = `${ORIGIN}/api/ads/frame?slot=${encodeURIComponent(slotId)}&format=${encodeURIComponent(format)}`;

      /*
       * Kept deliberately quiet: no border, no card, no heading, and a max
       * width matched to the content column so it reads as a footnote rather
       * than a billboard. The creative carries its own "Sponsored" mark, so
       * adding a label here would say it twice.
       */
      return (
        `<div class="cp-ad-unit" role="complementary" aria-label="Advertisement">` +
        `<iframe src="${escapeAttribute(src)}" width="100%" height="${height}" loading="lazy" ` +
        `title="Advertisement" scrolling="no" ` +
        `style="border:0;display:block;width:100%;height:${height}px;color-scheme:light dark" ` +
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

          // One format across the whole board: mixing them per placement makes
          // a page look assembled out of spare parts.
          return unit(String(ctx.settings.get('format') ?? placement.format));
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
