import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// The bundled catalog: no network in tests.
process.env.CROSS_PROMO = 'bundled';
const { welcomeEmail } = await import('../packages/mail/src/templates.ts');

const promoLinks = (html: string) =>
  [...html.matchAll(/href="(https?:\/\/[^"]*utm_campaign=cross-promo[^"]*)"/g)].map((m) => new URL(m[1]!.replace(/&amp;/g, '&')));

describe('the welcome email', () => {
  it('ends with the network block for developers, after the profile button', async () => {
    const mail = await welcomeEmail({ boardName: 'Test Board', baseUrl: 'https://bbs.example.com', username: 'ada', email: 'ada@example.com' });
    const links = promoLinks(mail.html);
    assert.ok(links.length > 0, 'the html carries the promo block');
    assert.ok(mail.html.indexOf('utm_campaign=cross-promo') > mail.html.indexOf('Set up your profile'), 'below the call to action');
    assert.ok(mail.html.indexOf('utm_campaign=cross-promo') < mail.html.indexOf('an account was created'), 'above the footer');
    assert.match(mail.text, /utm_campaign=cross-promo/, 'the text part carries it too');
    for (const u of links) assert.equal(u.searchParams.get('utm_source'), 'bbs.example.com');
  });

  it('never promotes the board that is sending', async () => {
    // A board hosted on a catalog property must not link to itself.
    const mail = await welcomeEmail({ boardName: 'BufferOverride', baseUrl: 'https://bufferoverride.com', username: 'ada' });
    const links = promoLinks(mail.html);
    assert.ok(links.length > 0);
    for (const u of links) assert.notEqual(u.hostname.replace(/^www\./, ''), 'bufferoverride.com');
    assert.doesNotMatch(mail.text.slice(mail.text.indexOf('/settings') + 9), /https:\/\/(www\.)?bufferoverride\.com/);
  });
});
