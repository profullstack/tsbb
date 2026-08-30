import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  excerpt,
  extractMentions,
  jsonForScript,
  quoteBody,
  render,
  renderSignature,
  safeUrl,
  toPlainText,
} from '../packages/markup/src/index.ts';

describe('markup safety', () => {
  it('escapes raw HTML in both formats rather than sanitising it', () => {
    // The property that matters is that no *tag* from the source survives.
    // The words `onerror=` and `script` do appear in the output, as escaped
    // text — that is the correct result, not a leak.
    for (const format of ['markdown', 'bbcode'] as const) {
      const html = render('<script>alert(1)</script><img src=x onerror=alert(1)>', format);
      assert.ok(!html.includes('<script'), `${format} emitted a script tag`);
      assert.ok(!html.includes('<img src=x'), `${format} emitted an img tag`);
      assert.ok(html.includes('&lt;script&gt;'));
      assert.ok(html.includes('&lt;img'));
    }
  });

  it('refuses javascript: in every link position', () => {
    assert.equal(safeUrl('javascript:alert(1)'), null);
    assert.equal(safeUrl('java\nscript:alert(1)'), null);
    assert.equal(safeUrl('  JaVaScRiPt:alert(1)'), null);
    assert.ok(!render('[click](javascript:alert(1))', 'markdown').includes('<a '));
    assert.ok(!render('[url=javascript:alert(1)]x[/url]', 'bbcode').includes('<a '));
    assert.ok(!render('[img]javascript:alert(1)[/img]', 'bbcode').includes('<img '));
  });

  it('will not let a post forge a code-span placeholder', () => {
    // The renderer lifts code spans out behind private-use sentinels. A post
    // that contains one must not be able to capture another span's content.
    const html = render('evil \u{E000}0\u{E001} and `real`', 'markdown');
    assert.ok(html.includes('<code>real</code>'));
    assert.ok(!html.includes('\u{E000}'));
  });

  it('does not collide with ordinary numbers in prose', () => {
    const html = render('I have 0 apples and `code` here', 'markdown');
    assert.ok(html.includes('I have 0 apples'));
    assert.ok(html.includes('<code>code</code>'));
  });

  it('escapes for a script element so a body cannot close it', () => {
    const out = jsonForScript({ body: '</script><script>alert(1)</script>' });
    assert.ok(!out.includes('</script'));
    assert.ok(out.includes('\\u003c'));
  });

  it('never nests an anchor inside an anchor', () => {
    const html = render('[url]https://example.com/x[/url]', 'bbcode');
    assert.equal(html.match(/<a /g)?.length, 1);
  });

  it('leaves code blocks unlinkified', () => {
    const html = render('[code]https://example.com[/code]', 'bbcode');
    assert.ok(!html.includes('<a '));
  });

  it('closes list items and unbalanced tags', () => {
    assert.equal(
      render('[list][*]one[*]two[/list]', 'bbcode'),
      '<ul class="bb-list"><li>one</li><li>two</li></ul>',
    );
    assert.ok(render('[b]never closed', 'bbcode').endsWith('</strong></p>'));
  });

  it('rejects a colour that is not a colour', () => {
    assert.ok(!render('[color=red;background:url(x)]x[/color]', 'bbcode').includes('<span'));
    assert.ok(render('[color=#ff0000]x[/color]', 'bbcode').includes('color:#ff0000'));
  });

  it('marks external links nofollow and leaves internal ones alone', () => {
    const options = { internalHosts: ['board.test'] };
    assert.ok(render('[a](https://other.test)', 'markdown', options).includes('nofollow'));
    assert.ok(!render('[a](https://board.test/x)', 'markdown', options).includes('nofollow'));
  });
});

describe('signatures', () => {
  it('strips images whole, not just their syntax', () => {
    // Removing only the tags leaves the URL as text, which the autolinker then
    // turns into a live link — the image comes back as a hyperlink.
    const bb = renderSignature('[b]hi[/b] [img]https://x.test/y.png[/img]', 'bbcode');
    assert.ok(!bb.includes('y.png'), bb);
    const md = renderSignature('me ![pic](https://x.test/y.png) end', 'markdown');
    assert.ok(!md.includes('y.png'), md);
  });

  it('drops block constructs that would shout down a thread', () => {
    const html = renderSignature('before [quote=a]big[/quote] after', 'bbcode');
    assert.ok(!html.includes('blockquote'));
  });

  it('caps the height at four lines', () => {
    const html = renderSignature('a\nb\nc\nd\ne\nf', 'markdown');
    assert.equal(html.match(/<br \/>/g)?.length, 3);
    assert.ok(!html.includes('e'));
  });
});

describe('mentions and excerpts', () => {
  it('ignores mentions inside code', () => {
    const found = extractMentions('hi @ann and `@bob` and\n```\n@carl\n```\n');
    assert.deepEqual(found, ['ann']);
  });

  it('deduplicates and lowercases', () => {
    assert.deepEqual(extractMentions('@Ann @ann @ANN'), ['ann']);
  });

  it('does not treat an email address as a mention', () => {
    assert.deepEqual(extractMentions('write to a@example.com'), []);
  });

  it('strips markup for plain text and excerpts', () => {
    assert.equal(toPlainText('# Title\n\n**bold** text', 'markdown'), 'Title bold text');
    assert.equal(toPlainText('[b]bold[/b] text', 'bbcode'), 'bold text');
    assert.ok(excerpt('word '.repeat(100), 'markdown', 40).endsWith('…'));
  });

  it('quotes into the format the replier writes in', () => {
    const md = quoteBody({ author: 'Ann', body: '**hi**', sourceFormat: 'markdown', targetFormat: 'markdown' });
    assert.ok(md.includes('> hi'));
    const bb = quoteBody({ author: 'Ann', body: '**hi**', sourceFormat: 'markdown', targetFormat: 'bbcode' });
    assert.ok(bb.startsWith('[quote=Ann]hi[/quote]'));
  });
});
