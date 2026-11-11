import { Hono } from 'hono';
import { html } from 'hono/html';
import { boardUrl, type Settings } from '@tsbb/core';
import { Card, CardContent } from '@tsbb/ui';
import { render, type AppEnv, type Services } from '../context.ts';
import { contactAddress } from './discovery.ts';

/**
 * /privacy and /terms.
 *
 * Generated from the board's own configuration rather than shipped as fixed
 * text, because the honest answer to "what does this board collect" depends on
 * it: which mail transport sends the sign-in links, whether CoinPay or a host
 * site's accounts can sign in here, whether the ads plugin is on. A sentence
 * about a provider this install does not use would be a claim the board cannot
 * back, so each one appears only when the thing it describes is switched on.
 *
 * The defaults describe Profullstack, Inc. running the board, which is what
 * `board.operator` defaults to. A self-hoster who sets their own operator and
 * contact address gets those names here instead of Profullstack's.
 */

export const LEGAL_EFFECTIVE_DATE = 'November 11, 2026';

const PROFULLSTACK = 'Profullstack, Inc.';
const PROFULLSTACK_ADDRESS = '16375 Bonnie Lane, Los Gatos, CA 95032, USA';
const PROFULLSTACK_CONTACT = 'support@profullstack.com';

interface LegalFacts {
  name: string;
  host: string;
  operator: string;
  address: string | null;
  contact: string | null;
  mcpUrl: string;
  mail: 'resend' | 'smtp' | null;
  coinpay: boolean;
  bridgeName: string | null;
  ads: boolean;
  adStats: boolean;
  footerBadges: boolean;
}

function factsFor(settings: Settings, services: Services): LegalFacts {
  const operator = String(settings['board.operator'] ?? '').trim() || 'the administrators of this board';
  const isProfullstack = operator === PROFULLSTACK;
  const configured = String(settings['board.contactEmail'] ?? '').trim();
  const transport = (process.env.TSBB_MAIL_TRANSPORT ?? '').trim().toLowerCase();
  const adsOn = services.registry.enabled.has('crawlproof-ads');
  const adConfig = adsOn ? services.registry.config('crawlproof-ads') : {};
  let host = services.baseUrl;
  try {
    host = new URL(services.baseUrl).host;
  } catch {
    // A malformed base URL still names the board; leave it as written.
  }
  return {
    name: String(settings['board.name'] ?? 'tsbb'),
    host,
    operator,
    address: isProfullstack ? PROFULLSTACK_ADDRESS : null,
    contact: configured || (isProfullstack ? PROFULLSTACK_CONTACT : contactAddress(settings)),
    mcpUrl: boardUrl('/api/mcp', services.baseUrl),
    mail: transport === 'resend' ? 'resend' : transport === 'smtp' ? 'smtp' : null,
    coinpay: Boolean(services.coinpay),
    bridgeName: services.bridge?.name ?? null,
    ads: adsOn && String(adConfig.slotId ?? '').trim() !== '',
    adStats: adsOn && String(adConfig.statsSiteId ?? '').trim() !== '',
    footerBadges: services.registry.enabled.has('profullstack-footer'),
  };
}

function contactLine(facts: LegalFacts) {
  return facts.contact
    ? html`Email <a href="mailto:${facts.contact}">${facts.contact}</a>.`
    : html`Contact the administrators of this board.`;
}

function operatorLine(facts: LegalFacts) {
  return facts.address ? html`${facts.operator}, ${facts.address}` : html`${facts.operator}`;
}

function page(title: string, body: unknown) {
  return html`
    <div class="page-head">
      <div>
        <h1 class="page-title">${title}</h1>
        <p class="page-subtitle">Effective date: ${LEGAL_EFFECTIVE_DATE}</p>
      </div>
    </div>
    ${Card(CardContent(html`<div class="post-body about-body legal-body">${body}</div>`))}`;
}

export function privacyBody(facts: LegalFacts) {
  return page(
    'Privacy Policy',
    html`
      <p>
        This policy covers ${facts.name} at ${facts.host}, a bulletin board run by ${operatorLine(facts)} on the
        open-source <a href="https://github.com/profullstack/tsbb" rel="noopener">tsbb</a> software. It describes
        what the board stores, why, and who else is involved.
      </p>

      <h2>1. Reading without an account</h2>
      <p>
        You can read every public forum, search, follow the RSS feeds and use the read-only API and MCP tools
        without an account. None of that asks for anything about you.
      </p>

      <h2>2. What an account stores</h2>
      <ul>
        <li>
          <strong>Your email address.</strong> It is your account: sign-in links are sent to it, and so are the
          notification emails you leave switched on.
        </li>
        <li>
          <strong>Your profile.</strong> Your username, and whatever you choose to add: display name, avatar,
          signature, title, location, website, bio, time zone and language.
        </li>
        <li>
          <strong>What you post.</strong> Topics, replies and their edit history, reactions, poll votes,
          attachments and uploaded avatars, and private messages, which are stored so the people in the
          conversation can read them.
        </li>
        <li>
          <strong>Your activity on the board.</strong> Topics you follow, notifications, which topics you have
          read, your notification and display preferences, members you block, reports you file, your post and
          topic counts, and when you were last active.
        </li>
        <li>
          <strong>Sign-in records.</strong> For each sign-in link: a hash of the link, its expiry (20 minutes) and
          a hashed IP address, used to rate-limit requests. For each session: a random session ID, its expiry
          (30 days), your browser's user agent and a hashed IP address. Passkeys, if you register one: the
          public key and a signature counter; the private key never leaves your device. API tokens you create:
          a hash of the token, its label, scopes and when it was last used.
        </li>
        ${facts.coinpay || facts.bridgeName
          ? html`<li>
              <strong>Linked sign-in accounts.</strong> If you sign in with
              ${facts.coinpay ? 'CoinPay' : ''}${facts.coinpay && facts.bridgeName ? ' or ' : ''}${facts.bridgeName ?? ''},
              the identifier that service gives us for your account, linked to your account here.
            </li>`
          : ''}
        <li>
          <strong>IP addresses</strong> are only stored as a salted hash, on sign-in links, sessions, posts and
          moderation records, so abuse can be traced to a source without keeping the address itself.
        </li>
      </ul>
      <p>There is no password to store, because there is no password: you sign in with an emailed link or a passkey.</p>

      <h2>3. Cookies</h2>
      <p>
        One cookie, set when you sign in, holds your session ID. It is HttpOnly and SameSite=Lax, and is sent
        only over HTTPS. If you pick a light or dark theme, a second cookie remembers that choice.
        ${facts.coinpay || facts.bridgeName
          ? 'Signing in through another service sets a short-lived cookie that ties the round trip together.'
          : ''}
        The board itself sets no advertising or tracking cookies.
      </p>

      <h2>4. Who else is involved</h2>
      <ul>
        ${facts.mail === 'resend'
          ? html`<li><strong>Resend</strong> delivers the board's email (sign-in links and notifications), so it processes your address to send them.</li>`
          : facts.mail === 'smtp'
            ? html`<li><strong>Our mail server</strong> delivers the board's email (sign-in links and notifications).</li>`
            : ''}
        ${facts.coinpay
          ? html`<li><strong>CoinPay</strong> handles sign-in if you choose "Continue with CoinPay".</li>`
          : ''}
        ${facts.bridgeName
          ? html`<li><strong>${facts.bridgeName}</strong> handles sign-in if you choose to continue with your ${facts.bridgeName} account.</li>`
          : ''}
        ${facts.ads
          ? html`<li>
              <strong>CrawlProof</strong> (crawlproof.com) serves the ad units, inside a sandboxed frame loaded
              from crawlproof.com${facts.adStats ? ', and a CrawlProof statistics script counts page views' : ''}.
              Your browser contacts crawlproof.com to load them, which sees your IP address and browser details.
            </li>`
          : ''}
        <li>
          <strong>Gravatar</strong>, only if you choose a Gravatar avatar: your avatar is then loaded from
          gravatar.com using a hash of your email address.
        </li>
        <li>
          <strong>Images from other sites.</strong> Some images on the page${facts.footerBadges ? ', such as the logo and the footer badges,' : ''}
          and images members link in posts are loaded by your browser directly from the sites that host them,
          which see the request the way any visit to their site would.
        </li>
      </ul>
      <p>Nothing is sold, and no advertising profile is built from you.</p>

      <h2>5. What is public</h2>
      <p>
        Your profile (everything in it except your email address), the members list with join and last-active
        times, and everything you post in a forum that guests can read are public. That includes the board's
        RSS feeds, the API, the MCP tools and search engines. Private forums and private messages are shown only
        to the people allowed to see them. Your email address is never shown publicly; the board's
        administrators can see it.
      </p>

      <h2>6. AI agents and MCP</h2>
      <p>
        The board is also an MCP server, at <code>${facts.mcpUrl}</code> (streamable HTTP; <code>tsbb-mcp</code>
        does the same over stdio). Without credentials, an MCP client can use the read-only tools: the board
        overview, forum and topic lists, reading topics and posts, search, and member profiles. They return
        exactly what a guest sees on the pages. With an API token a member created in their settings (or through
        <code>tsbb</code> CLI sign-in), it can also see who it is signed in as, list that member's notifications,
        and start topics or reply as that member. The MCP endpoint ignores cookies; only a bearer token
        identifies a caller, and a token is never an administrator.
      </p>
      <p>
        MCP and API requests are logged (time, tool or route, IP address, and the account or token if any) for
        abuse prevention and rate limiting. No MCP data is sold or used for advertising.
      </p>

      <h2>7. Keeping and deleting it</h2>
      <p>
        Sign-in links expire after 20 minutes and sessions after 30 days; signing out ends a session at once.
        You can revoke API tokens in your settings at any time. Everything else is kept while your account
        exists. To have your account deleted, write to us from the address you signed up with.
      </p>

      <h2>8. Security</h2>
      <p>
        The board is served over HTTPS, stores sign-in links and API tokens only as hashes, and stores IP
        addresses only as salted hashes. No system is perfectly secure, and we cannot guarantee absolute security.
      </p>

      <h2>9. Children</h2>
      <p>${facts.name} is not directed at children under 13, and we do not knowingly collect personal information from them.</p>

      <h2>10. Your rights</h2>
      <p>
        Depending on where you live, you may have the right to access, correct, delete or export your personal
        data. Contact us to exercise them.
      </p>

      <h2>11. Changes</h2>
      <p>If the board changes what it collects, this page changes with it. The effective date above says when it last did.</p>

      <h2>12. Contact</h2>
      <p>${operatorLine(facts)}. ${contactLine(facts)}</p>
    `,
  );
}

export function termsBody(facts: LegalFacts) {
  return page(
    'Terms of Service',
    html`
      <h2>1. Acceptance of terms</h2>
      <p>
        By using ${facts.name} at ${facts.host} (the "Service"), run by ${operatorLine(facts)}, you agree to these
        Terms of Service. If you do not agree, do not use the Service.
      </p>

      <h2>2. The Service</h2>
      <p>
        ${facts.name} is a bulletin board: forums, topics and replies, private messages, feeds, a REST API and an
        MCP server. Reading is free and needs no account. An account is free and lets you post.
      </p>

      <h2>3. Accounts</h2>
      <p>
        Your account is your email address. You are responsible for keeping that inbox, your passkeys and any
        API tokens you create safe, and for everything done with them. Tell us at once if you think someone else
        is using your account.
      </p>

      <h2>4. What you post</h2>
      <p>
        Posts in public forums are shown to everyone, including through the board's feeds, API and MCP tools. By
        posting you confirm you have the right to share what you post, and you allow the board to store and show
        it in those places. Moderators may hide or remove posts and suspend accounts that break these terms.
      </p>

      <h2>5. Acceptable use</h2>
      <p>
        Do not post anything unlawful, spam, malware, harassment, or content that infringes someone else's
        rights, and do not impersonate anyone. Do not hammer the board with automated traffic heavy enough to
        degrade it for anyone else: the feeds, the sitemap and the API are there so you do not have to scrape.
      </p>

      <h2>6. MCP and API use</h2>
      <p>
        The same rules apply to the API and the MCP server at <code>${facts.mcpUrl}</code>. An agent using your
        token acts as you, and what it posts is your responsibility. Requests may be rate-limited, and tokens
        used for abuse may be revoked.
      </p>

      ${facts.ads
        ? html`<h2>7. Third-party content</h2>
            <p>
              Ads on the board are served by CrawlProof, and members' posts are their own. Neither is an
              endorsement by ${facts.operator}.
            </p>`
        : html`<h2>7. Third-party content</h2>
            <p>Members' posts are their own and are not an endorsement by ${facts.operator}.</p>`}

      <h2>8. Intellectual property</h2>
      <p>
        The board's name, design and content other than members' posts belong to ${facts.operator} or its
        licensors. The tsbb software is open source under the MIT license.
      </p>

      <h2>9. Disclaimer of warranties</h2>
      <p>
        The Service is provided "as is" without warranties of any kind. We do not guarantee that it will be
        uninterrupted, secure or error-free, or that anything posted on it is accurate.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, ${facts.operator} shall not be liable for any indirect,
        incidental, special, consequential or punitive damages arising out of your use of the Service.
      </p>

      <h2>11. Changes to these terms</h2>
      <p>We may update these Terms from time to time. Continued use of the Service after a change means you accept the revised Terms.</p>

      <h2>12. Contact</h2>
      <p>Questions about these Terms? ${contactLine(facts)}</p>
    `,
  );
}

export function legalRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get('/privacy', async (c) => {
    const facts = factsFor(c.get('settings'), services);
    return render(c, services, {
      title: 'Privacy Policy',
      description: `What ${facts.name} stores about you, why, and who else is involved.`,
      body: privacyBody(facts),
    });
  });

  app.get('/terms', async (c) => {
    const facts = factsFor(c.get('settings'), services);
    return render(c, services, {
      title: 'Terms of Service',
      description: `The terms for using ${facts.name}, its API and its MCP server.`,
      body: termsBody(facts),
    });
  });

  return app;
}
