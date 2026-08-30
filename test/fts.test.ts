import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { toFtsQuery } from '../packages/db/src/fts.ts';

describe('FTS5 query building', () => {
  it('never passes raw punctuation through to MATCH', () => {
    // FTS5 MATCH takes a query language, not a string. Raw input containing
    // punctuation raises `fts5: syntax error` and the search 500s — which is
    // exactly what people paste into a forum search box.
    for (const input of [
      'Error: cannot read property "x" of undefined',
      'a@b.com',
      'foo AND OR NOT bar',
      'C++ / C#',
      '((()))',
      '"unterminated',
      'NEAR(a b)',
      '*',
      '-',
    ]) {
      const query = toFtsQuery(input);
      if (query === null) continue;
      assert.ok(!/[^\w\s"*]/u.test(query.replace(/ AND /g, ' ')), `unsafe query from ${input}: ${query}`);
    }
  });

  it('keeps quoted phrases as phrases', () => {
    assert.equal(toFtsQuery('"exact phrase"'), '"exact phrase"');
  });

  it('returns null when there is nothing to search for', () => {
    assert.equal(toFtsQuery('   '), null);
    assert.equal(toFtsQuery('!!!'), null);
  });

  it('adds a prefix wildcard so search feels live', () => {
    assert.equal(toFtsQuery('data'), '"data"*');
    assert.equal(toFtsQuery('data', { prefix: false }), '"data"');
  });

  it('bounds the term count', () => {
    const query = toFtsQuery(Array.from({ length: 100 }, (_, i) => `word${i}`).join(' '));
    assert.ok((query?.split(' AND ').length ?? 0) <= 24);
  });
});
