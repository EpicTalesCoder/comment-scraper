// scraper-core.js — Pure helpers dùng chung cho content script, UI và unit test Node.
// Không được phụ thuộc DOM/chrome.* — chỉ logic thuần.
(function (root) {
  'use strict';

  const COMMENT_LABEL_RE = /(?:comment by|bình luận của|reply by|phản hồi của)\s+(.+?)(?:\s+on\s+|$)/i;

  // "Comment by Alice" / "Bình luận của Trần B" / "... on Post" -> "Alice"
  function parseAuthorFromLabel(label) {
    if (!label) return '';
    const m = String(label).match(COMMENT_LABEL_RE);
    return m ? m[1].trim() : '';
  }

  // Bo dong header trung ten tac gia khoi noi dung comment
  function stripAuthorPrefix(text, author) {
    if (!author) return text;
    const escaped = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(text).replace(new RegExp('^' + escaped + '\\n?'), '');
  }

  // Key dedupe comment: author + 80 ky tu dau cua body
  function buildCommentKey(author, body) {
    return (author || '') + '::' + String(body || '').slice(0, 80);
  }

  // Key dedupe post: uu tien postUrl; khong co thi pageUrl + 120 ky tu dau content
  function buildPostKey(postUrl, pageUrl, content) {
    if (postUrl) return postUrl;
    return (pageUrl || '') + '::' + String(content || '').slice(0, 120);
  }

  // One row per comment; post khong comment -> 1 row rong. Trả mảng row (UI join sau).
  function resultsToCsvRows(results) {
    const rows = [['post_url', 'post_content', 'num_comments', 'num_reactions', 'comment_author', 'comment_text']];
    for (const r of (results || [])) {
      for (const p of (r.posts || [])) {
        const pc = quoteCsvCell(p.content || '');
        if (p.comments && p.comments.length) {
          for (const c of p.comments) {
            rows.push([
              p.postUrl || '',
              pc,
              p.numComments != null ? p.numComments : p.comments.length,
              p.numReactions != null ? p.numReactions : '',
              c.author || '',
              quoteCsvCell(c.text || ''),
            ]);
          }
        } else {
          rows.push([p.postUrl || '', pc, 0, p.numReactions != null ? p.numReactions : '', '', '']);
        }
      }
    }
    return rows;
  }

  // Vo hieu hoa xuong dong + quote trong 1 cell
  function flattenCsvCell(v) {
    return String(v).replace(/"/g, '""').replace(/\n/g, ' ');
  }

  // Cell van ban CSV: escape roi boc quote (giong exporter goc)
  function quoteCsvCell(v) {
    return '"' + flattenCsvCell(v) + '"';
  }

  const api = { parseAuthorFromLabel, stripAuthorPrefix, buildCommentKey, buildPostKey, resultsToCsvRows, flattenCsvCell };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScraperCore = api;
})(typeof self !== 'undefined' ? self : this);
