const test = require('node:test');
const assert = require('node:assert');
const SC = require('../lib/scraper-core.js');

// ── parseAuthorFromLabel ──
test('parseAuthorFromLabel: EN label', () => {
  assert.strictEqual(SC.parseAuthorFromLabel('Comment by Alice Nguyen'), 'Alice Nguyen');
});
test('parseAuthorFromLabel: VI label', () => {
  assert.strictEqual(SC.parseAuthorFromLabel('Bình luận của Trần Văn B'), 'Trần Văn B');
});
test('parseAuthorFromLabel: reply labels', () => {
  assert.strictEqual(SC.parseAuthorFromLabel('Reply by Bob'), 'Bob');
  assert.strictEqual(SC.parseAuthorFromLabel('Phản hồi của Carol'), 'Carol');
});
test('parseAuthorFromLabel: suffix "on ..." stripped', () => {
  assert.strictEqual(SC.parseAuthorFromLabel('Comment by Alice on Some Post'), 'Alice');
});
test('parseAuthorFromLabel: non-comment label -> empty', () => {
  assert.strictEqual(SC.parseAuthorFromLabel('Like this post'), '');
  assert.strictEqual(SC.parseAuthorFromLabel(''), '');
  assert.strictEqual(SC.parseAuthorFromLabel(null), '');
});

// ── stripAuthorPrefix ──
test('stripAuthorPrefix removes author header line', () => {
  assert.strictEqual(SC.stripAuthorPrefix('Alice\nhello world', 'Alice'), 'hello world');
});
test('stripAuthorPrefix keeps text when author empty', () => {
  assert.strictEqual(SC.stripAuthorPrefix('just text', ''), 'just text');
});
test('stripAuthorPrefix escapes regex specials in author', () => {
  assert.strictEqual(SC.stripAuthorPrefix('T.E.S.T (1)\nbody', 'T.E.S.T (1)'), 'body');
});

// ── buildCommentKey ──
test('buildCommentKey dedupes on author + first 80 chars', () => {
  const a = SC.buildCommentKey('Al', 'x'.repeat(100));
  const b = SC.buildCommentKey('Al', 'x'.repeat(100) + 'extra');
  assert.strictEqual(a, b);
  assert.notStrictEqual(SC.buildCommentKey('Al', 'a'), SC.buildCommentKey('Bob', 'a'));
});

// ── buildPostKey ──
test('buildPostKey prefers postUrl', () => {
  assert.strictEqual(SC.buildPostKey('https://fb.com/x/posts/1', 'https://fb.com/group', 'c'),
    'https://fb.com/x/posts/1');
});
test('buildPostKey falls back to pageUrl + content prefix (120 chars)', () => {
  const k1 = SC.buildPostKey('', 'https://fb.com/group', 'y'.repeat(200));
  const k2 = SC.buildPostKey('', 'https://fb.com/group', 'y'.repeat(200));
  const k3 = SC.buildPostKey('', 'https://fb.com/group', 'z');
  assert.strictEqual(k1, k2);
  assert.notStrictEqual(k1, k3);
  assert.ok(k1.startsWith('https://fb.com/group::'));
  assert.ok(k1.length < 'https://fb.com/group::'.length + 121);
});

// ── resultsToCsvRows (2 cot: cmt_col, link_cmt) ──
test('resultsToCsvRows: header cmt_col/link_cmt, one row per comment', () => {
  const results = [{
    url: 'u',
    posts: [{
      postUrl: 'pu', content: 'line1\nline2', numComments: 2, numReactions: 5,
      comments: [
        { author: 'A', text: 'hi "there"' },
        { author: 'B', text: 'yo', link: 'pu?comment_id=9' },
      ],
    }],
  }];
  const rows = SC.resultsToCsvRows(results);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], ['cmt_col', 'link_cmt']);
  assert.strictEqual(rows[1][0], '"hi ""there"""'); // escaped quotes + wrapped, CSV-correct
  assert.strictEqual(rows[1][1], '"pu"');           // khong co link comment -> fallback link bai
  assert.strictEqual(rows[2][0], '"yo"');
  assert.strictEqual(rows[2][1], '"pu?comment_id=9"'); // uu tien link comment
  assert.strictEqual(String(rows[1][0]).includes('\n'), false);
});

test('resultsToCsvRows: post without comments -> single empty row with link', () => {
  const rows = SC.resultsToCsvRows([{ url: 'u', posts: [{ postUrl: 'link1', content: 'c', comments: [] }] }]);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[1], ['""', '"link1"']);
});
