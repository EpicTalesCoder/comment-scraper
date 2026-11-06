// ═══════════════════════════════════════════════════════════════════════════
// Facebook Comment Scraper — CONTENT SCRIPT (scraper-only, v1.25.0)
// Khong telemetry (bo Sentry/Mixpanel), khong remote config, khong driver dang bai.
// ═══════════════════════════════════════════════════════════════════════════

let config = null;

// Default selectors and settings (fallback neu file config local doc loi)
const defaultConfig = {
  postSelectors: [
    'div[role="feed"] > div',
    'div[aria-posinset]',
    '[data-pagelet^="FeedUnit"]',
  ],
  contentSelectors: [
    '[data-ad-preview="message"]',
    '[data-ad-comet-preview="message"]',
    '[data-ad-rendering-role="story_message"]',
  ],
};

// CONTENT SCRIPT READINESS: Respond to ping from background worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "ping") {
    sendResponse({ pong: true, visible: document.visibilityState === 'visible' });
  }
  return false;
});

// CONFIG: doc file config dong goi trong extension (khong fetch remote)
async function loadConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL('domselector.config.json'));
    if (res.ok) config = await res.json();
  } catch (_) {}
  if (!config) config = {};
  if (!Array.isArray(config.postSelectors) || !config.postSelectors.length) config.postSelectors = defaultConfig.postSelectors;
  if (!Array.isArray(config.contentSelectors) || !config.contentSelectors.length) config.contentSelectors = defaultConfig.contentSelectors;
}
loadConfig();

// Marker
window.__myExtensionContentLoaded = true;

// ═══════════════════════════════════════════════════════════════════════════
// COMMENT SCRAPER MODE — scrape posts + comments from Facebook groups/pages
// ═══════════════════════════════════════════════════════════════════════════

let __scraperActive = false;
let __scraperAbort = false;
const SCRAPE_SCROLL_STEP_DELAY_MS = 2500;
const SCRAPE_MAX_SCROLLS_DEFAULT = 10;
const SCRAPE_COMMENTS_LOAD_CLICKS_MAX = 150;

const SCRAPE_TIME_BUDGET_MS_DEFAULT = 240000; // 4p — nho hon timeout 5p cua background
const SCRAPE_EMPTY_PASSES_BEFORE_STOP = 4;
const SCRAPE_EXPAND_IDLE_PASSES = 3; // so lan scroll lien tiep khong co comment moi -> coi nhu het
const __scraperLogBuf = [];

const __sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sau khi reload extension, content script cũ trên tab FB vẫn chạy nhưng mất
// kết nối -> mọi lệnh chrome.* ném "Extension context invalidated".
function __extContextValid() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
}

// Ghi storage an toàn: context chết thì dừng scraper cũ thay vì văng lỗi
function __safeStorageSet(obj) {
  if (!__extContextValid()) {
    __scraperAbort = true;
    return;
  }
  try {
    chrome.storage.local.set(obj, () => void chrome.runtime.lastError);
  } catch (_) {
    __scraperAbort = true;
  }
}

function __scraperLog(msg) {
  const line = new Date().toLocaleTimeString() + ' ' + msg;
  try { console.log('[scraper]', msg); } catch (_) {}
  __scraperLogBuf.push(line);
  if (__scraperLogBuf.length > 200) __scraperLogBuf.shift();
  __safeStorageSet({ scrapeLogs: __scraperLogBuf.slice() });
}

function __scraperMakeDeadline(opts) {
  const budget = typeof opts.timeBudgetMs === 'number' ? opts.timeBudgetMs : SCRAPE_TIME_BUDGET_MS_DEFAULT;
  return Date.now() + budget;
}
function __scraperTimeLeft(deadline) { return deadline - Date.now(); }

// Cửa sổ bị che/thu nhỏ -> Chrome ngừng render, FB không lazy-load bài/comment
function __scraperWarnIfHidden() {
  if (document.visibilityState !== 'visible') {
    __scraperLog('⚠️ cửa sổ cào đang bị che/thu nhỏ — FB sẽ không tải thêm bài/comment. Đừng che cửa sổ này.');
  }
}

function __isVisible(el) {
  return !!(el && (el.offsetParent || el.getClientRects().length));
}

// Mo rong "See more" (bai viet + comment bi cat ngan)
function __scraperExpandAllSeeMore(root) {
  try {
    const els = Array.from(root.querySelectorAll('div[role="button"], span[role="button"]')).filter((el) => {
      const t = (el.innerText || '').trim().toLowerCase();
      return t === 'see more' || t === 'xem thêm';
    });
    els.forEach((e) => { try { e.click(); } catch (_) {} });
    return els.length;
  } catch (_) { return 0; }
}

// ═══ NHẬN DIỆN COMMENT ═══
// 1) aria-label "Comment by X" / "Bình luận dưới tên X" / "Phản hồi của X"...
// 2) Fallback cấu trúc: [role=article] chứa đúng 1 link comment_id của chính nó
function __scraperFindCommentContainers(root) {
  const found = new Set();
  try {
    root.querySelectorAll('[aria-label]').forEach((el) => {
      if (ScraperCore.isCommentLabel(el.getAttribute('aria-label'))) found.add(el);
    });
    root.querySelectorAll('a[href*="comment_id="]').forEach((a) => {
      const art = a.closest('[role="article"]');
      if (!art || found.has(art) || !root.contains(art)) return;
      const ids = new Set();
      art.querySelectorAll('a[href*="comment_id="]').forEach((x) => {
        if (x.closest('[role="article"]') === art) ids.add(ScraperCore.extractCommentId(x.href));
      });
      if (ids.size === 1) found.add(art);
    });
  } catch (_) {}
  return Array.from(found);
}

// Phần tử thuộc "chính" comment này (không thuộc reply/comment lồng bên trong)
function __ownedBy(container, el) {
  let cur = el.parentElement;
  while (cur && cur !== container) {
    if (cur.getAttribute('role') === 'article' || ScraperCore.isCommentLabel(cur.getAttribute('aria-label'))) return false;
    cur = cur.parentElement;
  }
  return cur === container;
}

function __scraperParseComment(c, postUrl) {
  const label = c.getAttribute('aria-label') || '';
  let author = ScraperCore.parseAuthorFromLabel(label);
  if (!author) {
    const a = Array.from(c.querySelectorAll('a[role="link"], a[href]')).find(
      (x) => __ownedBy(c, x) && (x.innerText || '').trim() && !/comment_id=/.test(x.href || '')
    );
    if (a) author = (a.innerText || '').trim().split('\n')[0];
  }

  // Nội dung: các div[dir=auto] (thân comment) thuộc chính comment, lấy lớp ngoài cùng
  const parts = Array.from(c.querySelectorAll('div[dir="auto"]')).filter((el) => __ownedBy(c, el) && !el.closest('a'));
  const top = parts.filter((el) => !parts.some((o) => o !== el && o.contains(el)));
  let text = ScraperCore.stripUiLines(top.map((el) => (el.innerText || '').trim()).filter(Boolean).join('\n'));
  if (!text) {
    // Fallback: innerText bỏ reply lồng bên trong + dòng UI (Thích/Phản hồi/2 giờ...)
    const clone = c.cloneNode(true);
    clone.querySelectorAll('[role="article"]').forEach((n) => n.remove());
    text = ScraperCore.cleanCommentText(ScraperCore.stripAuthorPrefix((clone.innerText || '').trim(), author), author);
  }

  let href = '';
  const links = Array.from(c.querySelectorAll('a[href*="comment_id="]')).filter((a) => __ownedBy(c, a));
  const replyLink = links.find((a) => /reply_comment_id=/.test(a.href));
  href = (replyLink || links[0] || {}).href || '';
  const commentId = ScraperCore.extractCommentId(href);
  const link = ScraperCore.buildCommentLink(href, postUrl);
  const isReply = ScraperCore.isReplyLabel(label) || /reply_comment_id=/.test(href);
  return { author, text: text.trim(), link, commentId, isReply };
}

// Thu thập comment từ các root vào `out` (dedupe qua `seen`) — dùng chung
function __scraperCollectCommentsFrom(roots, seen, out, postUrl) {
  for (const root of roots) {
    if (__scraperAbort) return;
    for (const c of __scraperFindCommentContainers(root)) {
      try {
        const cm = __scraperParseComment(c, postUrl);
        if (!cm.text) continue;
        const key = ScraperCore.buildCommentKey(cm.author, cm.text, cm.commentId);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cm);
      } catch (_) {}
    }
  }
}

// Cac dialog dang mo (FB mo khung comment o lop dialog ben NGOAI feed)
function __scraperGetDialogs() {
  try { return Array.from(document.querySelectorAll("div[role='dialog']")).filter(__isVisible); } catch (_) { return []; }
}

// Dong moi dialog dang mo (nut Close / Đóng, fallback Escape) de feed khong bi chan
async function __scraperCloseDialogs() {
  try {
    for (const d of __scraperGetDialogs()) {
      const btn = Array.from(d.querySelectorAll('[aria-label]')).find((b) => {
        const l = (b.getAttribute('aria-label') || '').trim().toLowerCase();
        return l === 'close' || l === 'đóng';
      });
      if (btn) { try { btn.click(); await __sleep(600); } catch (_) {} }
    }
    if (__scraperGetDialogs().length) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      await __sleep(600);
    }
  } catch (_) {}
}

// ═══ CHỌN FILTER "ALL COMMENTS" ═══
// FB mặc định hiển thị "Most relevant"/"Phù hợp nhất" -> thiếu comment.
const __SCRAPER_FILTER_ALL_RE = /^(all comments|tất cả bình luận)$/i;
const __SCRAPER_FILTER_TRIGGER_RE = /^(all comments|tất cả bình luận|most relevant|phù hợp nhất|newest|mới nhất|top comments|bình luận hàng đầu)$/i;

function __firstLine(el) {
  return ((el && el.innerText) || '').trim().split('\n')[0].trim();
}

async function __scraperSelectAllCommentsFilter(scope) {
  try {
    const trigger = Array.from(scope.querySelectorAll('div[role="button"], span[role="button"]'))
      .find((el) => __isVisible(el) && __SCRAPER_FILTER_TRIGGER_RE.test((el.innerText || '').trim()));
    if (!trigger) return 'not-found';
    const cur = (trigger.innerText || '').trim();
    if (__SCRAPER_FILTER_ALL_RE.test(cur)) return 'already-all';

    trigger.scrollIntoView({ block: 'center' });
    await __sleep(300);
    trigger.click();
    await __sleep(1000);

    // Menu là overlay nằm ngoài scope -> tìm trên toàn document
    let item = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]'))
      .find((el) => __SCRAPER_FILTER_ALL_RE.test(__firstLine(el)));
    if (!item) {
      item = Array.from(document.querySelectorAll('[role="menu"] span, [role="dialog"] span'))
        .find((el) => __SCRAPER_FILTER_ALL_RE.test((el.innerText || '').trim()));
    }
    if (!item) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      return 'menu-not-found';
    }
    (item.closest('[role="menuitem"], [role="menuitemradio"], [role="option"]') || item).click();
    await __sleep(2000);
    return 'selected: ' + cur + ' -> all';
  } catch (_) {
    return 'error';
  }
}

// Phần tử cuộn được lớn nhất trong scope (dialog bài viết có thanh cuộn riêng)
function __scraperScrollableIn(scope) {
  let best = null;
  for (const el of scope.querySelectorAll('div')) {
    if (el.scrollHeight <= el.clientHeight + 50) continue;
    const oy = getComputedStyle(el).overflowY;
    if (!/(auto|scroll)/.test(oy)) continue;
    if (!best || el.clientHeight > best.clientHeight) best = el;
  }
  return best;
}

function __scraperScrollToBottom(scope) {
  const sc = scope !== document ? __scraperScrollableIn(scope) : null;
  if (sc) sc.scrollTop = sc.scrollHeight;
  else window.scrollTo(0, (document.scrollingElement || document.documentElement).scrollHeight);
}

function __scraperFindExpandButton(scope, clickCounts) {
  const els = scope.querySelectorAll('div[role="button"], span[role="button"], a[role="button"]');
  for (const el of els) {
    if ((clickCounts.get(el) || 0) >= 3) continue;
    if (!__isVisible(el) || el.closest('[contenteditable="true"], form')) continue;
    if (ScraperCore.isExpandButtonText(el.innerText)) return el;
  }
  return null;
}

// Tải TOÀN BỘ comment + reply trong scope: bấm "Xem thêm bình luận/phản hồi",
// cuộn xuống đáy để FB lazy-load, thu thập dần sau mỗi bước (chống virtualization)
async function __scraperLoadAllComments(scope, { maxClicks, deadline, collect }) {
  const clickCounts = new WeakMap();
  let clicks = 0;
  let idle = 0;
  let lastCount = collect();
  while (clicks < maxClicks && !__scraperAbort && __scraperTimeLeft(deadline) > 0) {
    __scraperExpandAllSeeMore(scope);
    const btn = __scraperFindExpandButton(scope, clickCounts);
    if (btn) {
      clickCounts.set(btn, (clickCounts.get(btn) || 0) + 1);
      try {
        btn.scrollIntoView({ block: 'center' });
        await __sleep(250);
        btn.click();
      } catch (_) {}
      clicks++;
      await __sleep(1500);
      lastCount = collect();
      idle = 0;
      continue;
    }
    __scraperScrollToBottom(scope);
    await __sleep(1800);
    const n = collect();
    if (n > lastCount) { lastCount = n; idle = 0; } else if (++idle >= SCRAPE_EXPAND_IDLE_PASSES) break;
  }
  __scraperExpandAllSeeMore(scope);
  await __sleep(400);
  collect();
  return clicks;
}

// ═══ NHẬN DIỆN BÀI VIẾT TRONG FEED ═══
function __scraperFindPostElements() {
  for (const sel of config.postSelectors || defaultConfig.postSelectors) {
    let els = [];
    try { els = Array.from(document.querySelectorAll(sel)); } catch (_) { continue; }
    els = els.filter((el) => (el.innerText || '').trim().length > 20);
    // Bỏ phần tử nằm trong phần tử khác của cùng danh sách
    els = els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
    if (els.length) return els;
  }
  return [];
}

// FB để href="#" cho link thời gian/bài viết, chỉ điền link thật khi hover/focus
async function __scraperRevealLinks(postEl, commentEls) {
  const anchors = Array.from(postEl.querySelectorAll('a')).filter((a) => !commentEls.some((c) => c.contains(a)));
  const hidden = anchors.filter((a) => !a.href || a.getAttribute('href') === '#' || /__cft__/.test(a.href)).slice(0, 12);
  for (const a of hidden) {
    try {
      a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      a.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      a.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    } catch (_) {}
  }
  if (hidden.length) await __sleep(300);
  return anchors;
}

function __scraperPostUrlFrom(anchors) {
  const urls = anchors.map((a) => a.href || '').filter((h) => ScraperCore.isPostUrl(h));
  const best = urls.find((h) => /\/(posts|permalink)\//.test(h)) || urls[0] || '';
  return ScraperCore.normalizePostUrl(best);
}

// Lấy thông tin bài (nội dung/ảnh/số comment) — bỏ qua phần nằm trong comment
function __scraperExtractPostInfo(postEl, commentEls) {
  const inComment = (el) => commentEls.some((c) => c.contains(el));
  let content = '';
  for (const sel of config.contentSelectors || defaultConfig.contentSelectors) {
    const el = Array.from(postEl.querySelectorAll(sel)).find((x) => !inComment(x));
    if (el && (el.innerText || '').trim()) { content = el.innerText.trim(); break; }
  }
  if (!content) {
    for (const el of postEl.querySelectorAll('div[dir="auto"]')) {
      if (inComment(el)) continue;
      const t = (el.innerText || '').trim();
      if (t.length > content.length) content = t;
    }
  }

  const images = [];
  postEl.querySelectorAll('img[src]').forEach((img) => {
    if (inComment(img)) return;
    const src = img.src || '';
    if (src.includes('scontent') && img.width > 100) images.push(src);
  });

  let numComments = null;
  let numReactions = null;
  for (const el of postEl.querySelectorAll('span, div[role="button"]')) {
    if (inComment(el)) continue;
    const t = (el.innerText || '').trim();
    if (t.length > 30) continue;
    if (numComments == null && /^[\d.,]+\s*[KkNnMm]?\s*(comments?|bình luận)$/i.test(t)) numComments = ScraperCore.parseCount(t);
  }
  const rm = (postEl.innerText || '').match(/(?:all reactions|tất cả cảm xúc):?\s*\n?\s*([\d.,]+\s*[KkNnMm]?)/i);
  if (rm) numReactions = ScraperCore.parseCount(rm[1]);

  return { content, images: images.slice(0, 20), numComments, numReactions };
}

// Bài không có permalink: bấm nút comment -> FB mở dialog (thường đổi URL sang
// permalink). Lấy URL đó cho phase 2; không được thì cào luôn trong dialog.
async function __scraperOpenPostFromFeed(postEl, opts, deadline) {
  const before = location.href;
  let btn = postEl.querySelector('[data-ad-rendering-role="comment_button"]');
  if (!btn) {
    btn = Array.from(postEl.querySelectorAll('div[role="button"], span')).find((el) =>
      /^([\d.,]+\s*[KkNn]?\s*)?(bình luận|comments?)$/i.test((el.innerText || '').trim()));
  }
  if (!btn) return { postUrl: '', comments: [] };
  try {
    btn.scrollIntoView({ block: 'center' });
    await __sleep(300);
    btn.click();
  } catch (_) {}
  await __sleep(2500);

  let postUrl = '';
  if (location.href !== before && ScraperCore.isPostUrl(location.href)) postUrl = ScraperCore.normalizePostUrl(location.href);
  const dialogs = __scraperGetDialogs();
  let comments = [];
  if (!postUrl) {
    const scope = dialogs[0] || postEl;
    const anchors = await __scraperRevealLinks(scope, __scraperFindCommentContainers(scope));
    postUrl = __scraperPostUrlFrom(anchors);
    if (!postUrl && opts.inlineComments !== false) {
      const seen = new Set();
      __scraperLog('comment filter (feed dialog): ' + await __scraperSelectAllCommentsFilter(scope));
      await __scraperLoadAllComments(scope, {
        maxClicks: opts.maxCommentClicks ?? SCRAPE_COMMENTS_LOAD_CLICKS_MAX,
        deadline: Math.min(deadline, Date.now() + 90000),
        collect: () => { __scraperCollectCommentsFrom([scope], seen, comments, ''); return comments.length; },
      });
    }
  }
  if (dialogs.length) await __scraperCloseDialogs();
  if (location.href !== before) {
    // FB đã điều hướng sang trang bài (không phải dialog) -> quay lại feed
    history.back();
    await __sleep(2500);
  }
  return { postUrl, comments };
}

// PHASE 1: cuộn feed, thu danh sách bài + permalink
async function __scraperScrapeCurrentPage(opts = {}) {
  const { maxScrolls = SCRAPE_MAX_SCROLLS_DEFAULT, scrollDelayMs = SCRAPE_SCROLL_STEP_DELAY_MS } = opts;
  const deadline = __scraperMakeDeadline(opts);
  const seen = new Set();
  const processed = new WeakSet();
  const posts = [];
  __scraperWarnIfHidden();

  // Cho feed xuat hien
  for (let i = 0; i < 25 && !__scraperAbort; i++) {
    if (__scraperFindPostElements().length) break;
    await __sleep(1000);
  }
  __scraperLog(`feed: ${document.querySelectorAll('[role="feed"]').length} feed, ${__scraperFindPostElements().length} bài trong DOM`);

  const collectOnce = async () => {
    for (const postEl of __scraperFindPostElements()) {
      if (__scraperAbort) return false;
      if (__scraperTimeLeft(deadline) <= 0) return true;
      if (processed.has(postEl)) continue;
      try {
        __scraperExpandAllSeeMore(postEl);
        const commentEls = __scraperFindCommentContainers(postEl);
        const anchors = await __scraperRevealLinks(postEl, commentEls);
        let postUrl = __scraperPostUrlFrom(anchors);
        const info = __scraperExtractPostInfo(postEl, commentEls);
        if (!info.content && !postUrl && !info.images.length) continue; // phần tử rác / chưa render
        processed.add(postEl);
        const key = ScraperCore.buildPostKey(postUrl, location.href.split('?')[0], info.content);
        if (seen.has(key)) continue;
        seen.add(key);

        let comments = [];
        if (!postUrl) {
          const r = await __scraperOpenPostFromFeed(postEl, opts, deadline);
          postUrl = r.postUrl;
          comments = r.comments;
        }
        posts.push({ postUrl, ...info, expectedComments: info.numComments, comments });
        __scraperLog(`Bài ${posts.length}: ${postUrl ? 'có link' : 'KHÔNG link'} • ${info.content.slice(0, 40).replace(/\n/g, ' ')}… • ~${info.numComments ?? '?'} cmt`);
      } catch (e) {
        __scraperLog('lỗi đọc bài: ' + e.message);
      }
    }
    return false;
  };

  let emptyPasses = 0;
  await collectOnce();
  for (let s = 0; s < maxScrolls && !__scraperAbort; s++) {
    if (__scraperTimeLeft(deadline) <= 0) {
      __scraperLog('hết thời gian/URL — giữ phần đã cào');
      break;
    }
    const postsBefore = posts.length;
    window.scrollTo(0, (document.scrollingElement || document.documentElement).scrollHeight);
    await __sleep(scrollDelayMs);
    if (__scraperGetDialogs().length) await __scraperCloseDialogs();
    const outOfTime = await collectOnce();
    if (posts.length === postsBefore) {
      emptyPasses++;
      __scraperLog(`scroll ${s + 1}/${maxScrolls}: không có bài mới (${emptyPasses}/${SCRAPE_EMPTY_PASSES_BEFORE_STOP})`);
      __scraperWarnIfHidden();
      if (emptyPasses >= SCRAPE_EMPTY_PASSES_BEFORE_STOP) break;
      // Cuộn lên một chút rồi xuống lại để kích hoạt lazy-load
      window.scrollBy(0, -800);
      await __sleep(500);
    } else {
      emptyPasses = 0;
    }
    if (outOfTime) break;
    __safeStorageSet({ scraperProgress: { scroll: s + 1, maxScrolls, postsSoFar: posts.length, timeLeftMs: __scraperTimeLeft(deadline) } });
  }
  __scraperLog(`xong phase 1: ${posts.length} bài (${posts.filter((p) => p.postUrl).length} có link)`);
  return posts;
}

// Scope chứa bài đang mở: dialog bài viết (nếu FB mở dạng overlay) hoặc cả trang
function __scraperOpenPostScope() {
  const dialogs = __scraperGetDialogs().filter((d) => d.querySelector('[role="article"], [aria-label]') && (d.innerText || '').length > 200);
  if (dialogs.length) {
    return dialogs.sort((a, b) => __scraperFindCommentContainers(b).length - __scraperFindCommentContainers(a).length)[0];
  }
  return document.querySelector('[role="main"]') || document;
}

// ═══ PHASE 2: QUÉT 1 BÀI ĐÃ MỞ (trang permalink / photo mở thật) ═══
async function __scraperScrapeOpenPost(opts = {}) {
  const deadline = __scraperMakeDeadline({ timeBudgetMs: opts.timeBudgetMs || 240000 });
  const postUrl = ScraperCore.normalizePostUrl(location.href) || location.href;
  const comments = [];
  const seen = new Set();
  __scraperWarnIfHidden();

  // Đợi bài + khung comment render
  for (let i = 0; i < 20 && !__scraperAbort; i++) {
    const scope = __scraperOpenPostScope();
    if (__scraperFindCommentContainers(scope).length || scope.querySelector('div[role="button"]')) {
      if (i >= 2) break;
    }
    await __sleep(1000);
  }

  let scope = __scraperOpenPostScope();
  const info = __scraperExtractPostInfo(scope, __scraperFindCommentContainers(scope));
  __scraperExpandAllSeeMore(scope);

  const filterState = await __scraperSelectAllCommentsFilter(scope);
  __scraperLog('comment filter: ' + filterState);
  scope = __scraperOpenPostScope(); // filter có thể render lại dialog

  const clicks = await __scraperLoadAllComments(scope, {
    maxClicks: opts.maxCommentClicks ?? SCRAPE_COMMENTS_LOAD_CLICKS_MAX,
    deadline,
    collect: () => {
      __scraperCollectCommentsFrom([__scraperOpenPostScope()], seen, comments, postUrl);
      __safeStorageSet({ scrapeLiveComments: comments.length });
      return comments.length;
    },
  });
  for (const c of comments) if (!c.link) c.link = postUrl;
  __scraperLog(`bài: ${comments.length} comment (${comments.filter((c) => c.isReply).length} reply) / FB ~${info.numComments ?? '?'} • ${clicks} click`);
  if (!comments.length) {
    const labels = document.querySelectorAll('[role="article"]').length;
    __scraperLog(`chẩn đoán: ${labels} [role=article], ${document.querySelectorAll('a[href*="comment_id="]').length} link comment_id, scope=${scope === document ? 'document' : scope.getAttribute('role') || scope.tagName}`);
  }
  return { comments, info };
}

// Handler chinh
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'contentScrapePosts') {
    (async () => {
      try {
        __scraperActive = true;
        __scraperAbort = false;
        const posts = await __scraperScrapeCurrentPage(msg.options || {});
        __safeStorageSet({ operationDone: 'successful', scrapedPosts: posts });
      } catch (e) {
        __scraperLog('error: ' + e.message);
        __safeStorageSet({ operationDone: 'failed', scrapedPosts: [] });
      } finally {
        __scraperActive = false;
      }
    })();
    sendResponse({ accepted: true });
    return false;
  }
  if (msg.action === 'contentScrapePostComments') {
    // Chạy trên trang bài viết đã mở: quét full comment + filter "All comments"
    (async () => {
      try {
        __scraperActive = true;
        __scraperAbort = false;
        const { comments, info } = await __scraperScrapeOpenPost(msg.options || {});
        __safeStorageSet({ operationDone: 'successful', scrapedComments: comments, scrapedPostInfo: info });
      } catch (e) {
        __scraperLog('error(open post): ' + e.message);
        __safeStorageSet({ operationDone: 'failed', scrapedComments: [], scrapedPostInfo: null });
      } finally {
        __scraperActive = false;
      }
    })();
    sendResponse({ accepted: true });
    return false;
  }
  if (msg.action === 'stopScrapePosts') {
    __scraperAbort = true;
    sendResponse({ accepted: true });
    return false;
  }
});
