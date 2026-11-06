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

// ── v1.25: nhãn comment FB mới (EN + VI) ──
test('parseAuthorFromLabel: VI "dưới tên" + đuôi thời gian', () => {
  assert.strictEqual(SC.parseAuthorFromLabel('Bình luận dưới tên Nguyễn Văn A vào 3 giờ trước'), 'Nguyễn Văn A');
  assert.strictEqual(SC.parseAuthorFromLabel('Phản hồi dưới tên Lê B 2 ngày trước'), 'Lê B');
  assert.strictEqual(SC.parseAuthorFromLabel('Comment by Alice Nguyen 2 hours ago'), 'Alice Nguyen');
  assert.strictEqual(SC.parseAuthorFromLabel('Reply by Bob a day ago'), 'Bob');
});
test('isCommentLabel / isReplyLabel', () => {
  assert.ok(SC.isCommentLabel('Bình luận dưới tên X'));
  assert.ok(!SC.isCommentLabel('Viết bình luận'));
  assert.ok(SC.isReplyLabel('Phản hồi dưới tên X'));
  assert.ok(!SC.isReplyLabel('Comment by X'));
});
test('cleanCommentText bỏ dòng UI', () => {
  assert.strictEqual(SC.cleanCommentText('Alice\nhay quá\nThích\nPhản hồi\n3 giờ', 'Alice'), 'hay quá');
  assert.strictEqual(SC.cleanCommentText('great\nLike\nReply\n2h', ''), 'great');
});
test('buildCommentKey ưu tiên comment id', () => {
  assert.strictEqual(SC.buildCommentKey('A', 'x', '123'), 'id:123');
});

// ── URL bài viết ──
test('isPostUrl nhận diện permalink, không nhận group feed', () => {
  assert.ok(SC.isPostUrl('https://www.facebook.com/groups/123/posts/456/'));
  assert.ok(SC.isPostUrl('https://www.facebook.com/groups/abc/permalink/456/'));
  assert.ok(SC.isPostUrl('https://www.facebook.com/somepage/posts/pfbid02abc'));
  assert.ok(SC.isPostUrl('https://www.facebook.com/permalink.php?story_fbid=1&id=2'));
  assert.ok(SC.isPostUrl('https://www.facebook.com/photo/?fbid=99&set=a.1'));
  assert.ok(SC.isPostUrl('https://www.facebook.com/share/p/1AbCd/'));
  assert.ok(!SC.isPostUrl('https://www.facebook.com/groups/123'));
  assert.ok(!SC.isPostUrl('https://www.facebook.com/somepage'));
  assert.ok(!SC.isPostUrl(''));
});
test('normalizePostUrl bỏ tracking, giữ id', () => {
  assert.strictEqual(
    SC.normalizePostUrl('https://www.facebook.com/groups/1/posts/2/?__cft__[0]=x&__tn__=R&comment_id=5'),
    'https://www.facebook.com/groups/1/posts/2/');
  assert.strictEqual(
    SC.normalizePostUrl('https://www.facebook.com/photo/?fbid=99&set=a.1&__tn__=x'),
    'https://www.facebook.com/photo/?fbid=99&set=a.1');
});
test('extractCommentId + buildCommentLink', () => {
  const href = 'https://www.facebook.com/groups/1/posts/2/?comment_id=10&reply_comment_id=11&__cft__=z';
  assert.strictEqual(SC.extractCommentId(href), '11');
  assert.strictEqual(SC.extractCommentId('https://x/?comment_id=10'), '10');
  assert.strictEqual(SC.buildCommentLink(href), 'https://www.facebook.com/groups/1/posts/2/?comment_id=10&reply_comment_id=11');
  assert.strictEqual(SC.buildCommentLink('https://www.facebook.com/x'), '');
});

// ── Số đếm + nút mở thêm ──
test('parseCount hiểu K / N / dấu phẩy', () => {
  assert.strictEqual(SC.parseCount('1,2K bình luận'), 1200);
  assert.strictEqual(SC.parseCount('3.4K comments'), 3400);
  assert.strictEqual(SC.parseCount('120 bình luận'), 120);
  assert.strictEqual(SC.parseCount('1.234'), 1234);
  assert.strictEqual(SC.parseCount('abc'), null);
});
test('isExpandButtonText: EN + VI, bỏ qua "Ẩn"', () => {
  for (const t of ['View more comments', 'View all 5 replies', 'View 1 reply', '3 Replies', 'See more comments',
    'View previous comments', 'Bob replied · 2 Replies', 'Xem thêm bình luận', 'Xem tất cả 12 phản hồi',
    'Xem 1 phản hồi', '4 phản hồi', 'Xem các bình luận trước', 'An đã trả lời · 3 phản hồi']) {
    assert.ok(SC.isExpandButtonText(t), t);
  }
  for (const t of ['Hide replies', 'Ẩn phản hồi', 'Reply', 'Phản hồi', 'Write a comment…', '']) {
    assert.ok(!SC.isExpandButtonText(t), t);
  }
});

// ── Lọc dòng rác giao diện FB (chỉ lọc dòng toàn token UI) ──
test('isUiJunkLine: dòng UI dính liền -> rác', () => {
  for (const t of ['· 5 giờThíchTrả lờiChia sẻ1', '· 5 giờThíchTrả lờiChia sẻ', '2 ngàyThíchPhản hồi',
    '· 3 tuần trướcThích Trả lời', '5hLikeReplyShare2', '· Đã chỉnh sửa', 'Thích', '· 1 phút', '3 giờ', '·']) {
    assert.ok(SC.isUiJunkLine(t), t);
  }
});
test('isUiJunkLine: dòng có nội dung thật -> giữ', () => {
  for (const t of ['Tôi thích bài này', 'Shop trả lời giúp em với', 'sản phẩm tốt 5 sao', '100',
    'ok 1 giờ nữa mình qua', 'Chia sẻ kinh nghiệm hay quá']) {
    assert.ok(!SC.isUiJunkLine(t), t);
  }
});
test('stripUiLines chỉ bỏ dòng rác, giữ dòng nội dung', () => {
  assert.strictEqual(SC.stripUiLines('Hàng đẹp lắm\n· 5 giờThíchTrả lờiChia sẻ1'), 'Hàng đẹp lắm');
  assert.strictEqual(SC.stripUiLines('dòng 1\ndòng 2 thích quá'), 'dòng 1\ndòng 2 thích quá');
  assert.strictEqual(SC.stripUiLines('· 5 giờThíchTrả lờiChia sẻ1'), '');
});
test('resultsToCsvRows bỏ comment chỉ toàn rác UI', () => {
  const rows = SC.resultsToCsvRows([{ url: 'u', posts: [{ postUrl: 'p', comments: [
    { text: '· 5 giờThíchTrả lờiChia sẻ1' }, { text: 'Đẹp quá\n2 giờThíchTrả lời' },
  ] }] }]);
  assert.deepStrictEqual(rows.slice(1), [['"Đẹp quá"', '"p"']]);
});
