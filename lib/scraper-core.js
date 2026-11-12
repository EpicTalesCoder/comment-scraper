// scraper-core.js — Pure helpers dùng chung cho content script, background, UI và unit test Node.
// Không được phụ thuộc DOM/chrome.* — chỉ logic thuần.
(function (root) {
  'use strict';

  // aria-label của comment trên FB (EN + VI, nhiều phiên bản UI):
  //   "Comment by Alice 2 hours ago", "Reply by Bob", "Bình luận của Trần B",
  //   "Bình luận dưới tên Trần B vào 3 giờ trước", "Phản hồi dưới tên C", "Trả lời của D"
  const COMMENT_LABEL_RE = /(?:comment by|reply by|bình luận của|bình luận dưới tên|phản hồi của|phản hồi dưới tên|trả lời của|trả lời dưới tên)\s+(.+)$/i;
  // Đuôi thời gian / ngữ cảnh sau tên tác giả cần cắt bỏ
  const LABEL_TAIL_RES = [
    /\s+on\s+.*$/i,                                   // "... on Some Post"
    /\s+vào\s+.*$/i,                                  // "... vào 3 giờ trước"
    /\s+(?:an?|\d+)\s+\w+\s+ago$/i,                   // "... 2 hours ago" / "a day ago"
    /\s+\d+\s*(?:giây|phút|giờ|ngày|tuần|tháng|năm)\s+trước$/i, // "... 3 giờ trước"
  ];

  // "Comment by Alice" / "Bình luận dưới tên Trần B vào 3 giờ trước" -> tên tác giả
  function parseAuthorFromLabel(label) {
    if (!label) return '';
    const m = String(label).match(COMMENT_LABEL_RE);
    if (!m) return '';
    let name = m[1].trim();
    for (const re of LABEL_TAIL_RES) name = name.replace(re, '');
    return name.trim();
  }

  function isCommentLabel(label) {
    return !!label && COMMENT_LABEL_RE.test(String(label));
  }

  function isReplyLabel(label) {
    return /^(reply by|phản hồi|trả lời)/i.test(String(label || '').trim());
  }

  // Bo dong header trung ten tac gia khoi noi dung comment
  function stripAuthorPrefix(text, author) {
    if (!author) return text;
    const escaped = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(text).replace(new RegExp('^' + escaped + '\\n?'), '');
  }

  // Dòng UI rác cuối comment khi phải fallback về innerText
  // Token giao diện FB có thể dính liền nhau: "· 5 giờThíchTrả lờiChia sẻ1"
  const UI_TOKEN_RE = /(đã chỉnh sửa|xem bản dịch|see translation|vừa xong|just now|hôm qua|yesterday|trả lời|phản hồi|chia sẻ|thích|reply|share|like|edited|tác giả|author|fan cứng|top fan|theo dõi|follow|\d+\s*(giây|phút|giờ|ngày|tuần|tháng|năm)(\s*trước)?|\d+\s*(mins?|hrs?|[smhdwy])|\d+|[·•]|\s+)/gi;
  const UI_SIGNAL_RE = /(thích|like|trả lời|phản hồi|reply|chia sẻ|share|đã chỉnh sửa|edited|\d+\s*(giây|phút|giờ|ngày|tuần|tháng|năm|mins?|hrs?|[smhdwy])|vừa xong|just now|hôm qua|yesterday|[·•])/i;

  // Dòng CHỈ gồm token giao diện (thời gian/Thích/Trả lời/Chia sẻ/số đếm/·).
  // Dòng có nội dung thật (dù chứa chữ "thích") không bị coi là rác.
  function isUiJunkLine(line) {
    const t = String(line || '').trim();
    if (!t) return true;
    if (t.replace(UI_TOKEN_RE, '') !== '') return false;
    return UI_SIGNAL_RE.test(t);
  }

  // Bỏ các dòng rác giao diện, giữ nguyên các dòng nội dung
  function stripUiLines(text) {
    return String(text || '').split('\n').filter((l) => !isUiJunkLine(l)).join('\n').trim();
  }

  // Lọc dòng UI + dòng tên tác giả khỏi innerText của comment (fallback)
  function cleanCommentText(text, author) {
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const out = lines.filter((l, i) => !(i === 0 && author && l === author));
    return stripUiLines(out.join('\n'));
  }

  // Làm sạch kết quả đã cào (kể cả dữ liệu cũ): lọc dòng rác, bỏ comment rỗng
  function cleanResults(results) {
    return (results || []).map((r) => ({
      ...r,
      posts: (r.posts || []).map((p) => ({
        ...p,
        comments: (p.comments || [])
          .map((c) => ({ ...c, text: stripUiLines(c.text) }))
          .filter((c) => c.text),
      })),
    }));
  }

  // Key dedupe comment: uu tien comment id; khong co thi author + 80 ky tu dau cua body
  function buildCommentKey(author, body, commentId) {
    if (commentId) return 'id:' + commentId;
    return (author || '') + '::' + String(body || '').slice(0, 80);
  }

  // Key dedupe post: uu tien postUrl; khong co thi pageUrl + 120 ky tu dau content
  function buildPostKey(postUrl, pageUrl, content) {
    if (postUrl) return postUrl;
    return (pageUrl || '') + '::' + String(content || '').slice(0, 120);
  }

  // Link tới 1 bài viết cụ thể (không phải group/page feed)
  const POST_QUERY_KEEP = ['story_fbid', 'fbid', 'id', 'v', 'set', 'multi_permalinks'];
  const FB_HOST_RE = /(^|\.)(facebook\.com|fb\.com|fb\.watch)$/i;

  function parseFbUrl(url) {
    try {
      const u = new URL(String(url || '').trim());
      return FB_HOST_RE.test(u.hostname) ? u : null;
    } catch (_) {
      return null;
    }
  }

  // Link tới 1 bài viết cụ thể (không phải feed group/page/profile)
  function isPostUrl(url) {
    const u = parseFbUrl(url);
    if (!u) return false;
    const p = u.pathname;
    const q = u.searchParams;
    if (/^fb\.watch$/i.test(u.hostname)) return true;
    if (/\/(posts|permalink|videos|reel|reels)\/[^/]+/i.test(p)) return true;  // /groups/x/posts/1, /reel/1
    if (/\/photos\/[^/]+\/\d+/i.test(p)) return true;                            // /page/photos/a.1/2
    if (/^\/share\/[prv]\/[^/]+/i.test(p)) return true;                          // /share/p/xxx
    if (/^\/(photo|photo\.php|permalink\.php|story\.php|watch)\/?$/i.test(p)) {
      return q.has('fbid') || q.has('story_fbid') || q.has('v');
    }
    return q.has('multi_permalinks') || q.has('story_fbid');
  }

  // 'post' = cào toàn bộ comment của đúng bài đó; 'group' = cào feed (group/page/profile)
  function classifyUrl(url) {
    if (!parseFbUrl(url)) return 'invalid';
    return isPostUrl(url) ? 'post' : 'group';
  }

  // Link bài -> dạng mở ra CHỈ có bài đó: fb.com/m. -> www, và
  // /groups/X/?multi_permalinks=Y (FB hiện kèm cả feed group) -> /groups/X/posts/Y/
  function canonicalPostUrl(url) {
    const u = parseFbUrl(url);
    if (!u) return String(url || '').trim();
    if (/^fb\.watch$/i.test(u.hostname)) return u.href; // link rút gọn, để FB tự chuyển hướng
    const g = u.pathname.match(/^\/groups\/([^/]+)\/?$/);
    const mp = (u.searchParams.get('multi_permalinks') || '').split(',')[0];
    if (g && mp) return `https://www.facebook.com/groups/${g[1]}/posts/${mp}/`;
    u.protocol = 'https:';
    u.hostname = 'www.facebook.com';
    return normalizePostUrl(u.href);
  }

  // Bỏ query tracking (__cft__, __tn__, comment_id...) nhưng giữ query định danh bài
  function normalizePostUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      const keep = new URLSearchParams();
      for (const k of POST_QUERY_KEEP) if (u.searchParams.has(k)) keep.set(k, u.searchParams.get(k));
      const q = keep.toString();
      return u.origin + u.pathname + (q ? '?' + q : '');
    } catch (_) {
      return String(url).split('#')[0];
    }
  }

  // comment_id / reply_comment_id trong href -> id (reply ưu tiên vì cụ thể hơn)
  function extractCommentId(href) {
    if (!href) return '';
    const s = String(href);
    const r = s.match(/[?&]reply_comment_id=(\d+)/);
    if (r) return r[1];
    const c = s.match(/[?&]comment_id=(\d+)/);
    return c ? c[1] : '';
  }

  // Permalink comment sạch: link bài + comment_id (+ reply_comment_id)
  function buildCommentLink(href, fallbackPostUrl) {
    if (!href) return '';
    try {
      const u = new URL(href);
      const base = normalizePostUrl(href) || fallbackPostUrl || '';
      const params = [];
      for (const k of ['comment_id', 'reply_comment_id']) {
        if (u.searchParams.has(k)) params.push(k + '=' + u.searchParams.get(k));
      }
      if (!params.length) return '';
      return base + (base.includes('?') ? '&' : '?') + params.join('&');
    } catch (_) {
      return '';
    }
  }

  // "1,2K bình luận" / "3.4K comments" / "1 Tr" / "120" -> số
  function parseCount(text) {
    if (text == null) return null;
    const m = String(text).trim().match(/^(\d+(?:[.,]\d+)?)\s*(k|n|nghìn|m|tr|triệu)?\b/i);
    if (!m) return null;
    const unit = (m[2] || '').toLowerCase();
    if (!unit) return parseInt(m[1].replace(/[.,]/g, ''), 10);
    const num = parseFloat(m[1].replace(',', '.'));
    const mult = /^(k|n|nghìn)$/.test(unit) ? 1e3 : 1e6;
    return Math.round(num * mult);
  }

  // Text nút "tải thêm comment / phản hồi" (EN + VI). Không khớp "Hide replies"/"Ẩn phản hồi".
  const EXPAND_BUTTON_RES = [
    /^(view|see|load) (more|previous|all|\d+)?\s*(\d+\s*)?(more\s+)?(comments?|replies|reply)\b/i,
    /^\d+\s+(more\s+)?(replies|reply)$/i,
    /\breplied\s*·\s*\d+\s+repl(y|ies)$/i,
    /^xem (thêm|tất cả|các)?\s*(\d+\s*)?(bình luận|phản hồi|câu trả lời)/i,
    /^xem (các )?bình luận trước/i,
    /^tải thêm (bình luận|phản hồi)/i,
    /^\d+\s+(phản hồi|câu trả lời)$/i,
    /đã (phản hồi|trả lời)\s*·\s*\d+\s+(phản hồi|câu trả lời)$/i,
  ];

  function isExpandButtonText(text) {
    const t = String(text || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length > 60) return false;
    return EXPAND_BUTTON_RES.some((re) => re.test(t));
  }

  // CSV 2 cot (yeu cau cua mq): cmt_col = noi dung comment, link_cmt = link comment
  // (permalink neu co, fallback ve link bai viet). Post khong comment -> 1 row rong + link.
  function resultsToCsvRows(results) {
    const rows = [['cmt_col', 'link_cmt']];
    for (const r of cleanResults(results)) {
      for (const p of (r.posts || [])) {
        const postLink = p.postUrl || '';
        if (p.comments && p.comments.length) {
          for (const c of p.comments) {
            rows.push([quoteCsvCell(c.text || ''), quoteCsvCell(c.link || postLink)]);
          }
        } else {
          rows.push([quoteCsvCell(''), quoteCsvCell(postLink)]);
        }
      }
    }
    return rows;
  }

  // Vo hieu hoa xuong dong + quote trong 1 cell
  function flattenCsvCell(v) {
    return String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ');
  }

  // Cell van ban CSV: escape roi boc quote (giong exporter goc)
  function quoteCsvCell(v) {
    return '"' + flattenCsvCell(v) + '"';
  }

  const api = {
    parseAuthorFromLabel, isCommentLabel, isReplyLabel, stripAuthorPrefix, cleanCommentText,
    isUiJunkLine, stripUiLines, cleanResults,
    buildCommentKey, buildPostKey, isPostUrl, classifyUrl, canonicalPostUrl, normalizePostUrl, extractCommentId, buildCommentLink,
    parseCount, isExpandButtonText, resultsToCsvRows, flattenCsvCell,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScraperCore = api;
})(typeof self !== 'undefined' ? self : this);
