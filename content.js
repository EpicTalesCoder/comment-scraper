// ═══════════════════════════════════════════════════════════════════════════
// Facebook Comment Scraper — CONTENT SCRIPT (scraper-only, v1.22.0)
// Khong telemetry (bo Sentry/Mixpanel), khong remote config, khong driver dang bai.
// ═══════════════════════════════════════════════════════════════════════════

let config = null;

// Default selectors and settings (fallback neu file config local doc loi)
const defaultConfig = {
  postSelectors: [
    'div[role="feed"] > div > div',
    ".x1lliihq .x1n2onr6.xh8yej3.x1ja2u2z.xod5an3",
  ],
  contentSelectors: [
    'div[data-ad-preview="message"]',
    'div[dir="auto"]',
    'div[data-visualcompletion="ignore-dynamic"]',
  ],
  buttonClassName: "log-button",
  postButtonSelector: 'div[aria-label="Post"]',
};

// CONTENT SCRIPT READINESS: Respond to ping from background worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "ping") {
    sendResponse({ pong: true });
  }
  return false;
});

// CONFIG: doc file config dong goi trong extension (khong fetch remote)
async function loadConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL('domselector.config.json'));
    if (res.ok) config = await res.json();
  } catch (_) {}
  if (!config || !config.postSelectors) config = defaultConfig;
  config.contentSelector = (config.contentSelectors || defaultConfig.contentSelectors)[0];
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
const SCRAPE_COMMENTS_LOAD_CLICKS_MAX = 30;

const SCRAPE_TIME_BUDGET_MS_DEFAULT = 240000; // 4p — nho hon timeout 5p cua background
const SCRAPE_EMPTY_PASSES_BEFORE_STOP = 3;
const __scraperLogBuf = [];

function __scraperLog(msg) {
  const line = new Date().toLocaleTimeString() + ' ' + msg;
  try { console.log('[scraper]', msg); } catch (_) {}
  try {
    __scraperLogBuf.push(line);
    if (__scraperLogBuf.length > 200) __scraperLogBuf.shift();
    chrome.storage.local.set({ scrapeLogs: __scraperLogBuf.slice() });
  } catch (_) {}
}

function __scraperMakeDeadline(opts) {
  const budget = typeof opts.timeBudgetMs === 'number' ? opts.timeBudgetMs : SCRAPE_TIME_BUDGET_MS_DEFAULT;
  return Date.now() + budget;
}
function __scraperTimeLeft(deadline) { return deadline - Date.now(); }

// Mo rong "See more" trong 1 post (dung lai ham co san expandSeeMore)
function __scraperExpandAllSeeMore(root) {
  try {
    const els = Array.from(root.querySelectorAll('div,span,a')).filter(
      (el) => (el.innerText || '').trim() === 'See more' || (el.innerText || '').trim() === 'Xem thêm'
    );
    els.forEach((e) => e.click());
    return els.length;
  } catch (_) { return 0; }
}

// Tim phan tu chua comment: aria-label chua "Comment by" / "Bình luận của" / "Reply by" / "Phản hồi của"
const __SCRAPER_COMMENT_LABEL_RE = /(comment by|bình luận của|reply by|phản hồi của)/i;
function __scraperFindCommentContainers(root) {
  const results = [];
  try {
    const candidates = root.querySelectorAll('div[aria-label]');
    for (const el of candidates) {
      const label = el.getAttribute('aria-label') || '';
      if (__SCRAPER_COMMENT_LABEL_RE.test(label)) {
        results.push(el);
      }
    }
  } catch (_) {}
  return results;
}

// Cac dialog dang mo (FB mo khung comment o lop dialog ben NGOAI feed)
function __scraperGetDialogs() {
  try { return Array.from(document.querySelectorAll("div[role='dialog']")); } catch (_) { return []; }
}

// Dong moi dialog dang mo (nut Close / Đóng, fallback Escape) de feed khong bi chan
async function __scraperCloseDialogs() {
  try {
    const dialogs = __scraperGetDialogs();
    if (!dialogs.length) return;
    for (const d of dialogs) {
      const btns = d.querySelectorAll("div[aria-label], div[role='button'], button");
      for (const b of btns) {
        const l = (b.getAttribute('aria-label') || '').trim().toLowerCase();
        if (l === 'close' || l === 'đóng') {
          try { b.click(); await new Promise(r => setTimeout(r, 600)); } catch (_) {}
          break;
        }
      }
    }
    if (__scraperGetDialogs().length) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
    }
    __scraperLog('closed dialogs, remaining: ' + __scraperGetDialogs().length);
  } catch (_) {}
}

// Click "Load more comments"/"View more comments"/"Xem thêm bình luận" de load them
async function __scraperExpandComments(root, maxClicks = SCRAPE_COMMENTS_LOAD_CLICKS_MAX) {
  let clicks = 0;
  const selectors = [
    'span[dir="auto"]',
    'div[role="button"]',
    'a',
  ];
  const wanted = [
    'view more comments', 'load more comments', 'view previous comments',
    'see more comments', 'more replies',
    'xem thêm bình luận', 'tải thêm bình luận', 'xem các bình luận trước đó', 'câu trả lời khác',
  ];
  while (clicks < maxClicks && !__scraperAbort) {
    let clicked = false;
    outer:
    for (const sel of selectors) {
      const els = Array.from(root.querySelectorAll(sel));
      for (const el of els) {
        const t = (el.innerText || '').trim().toLowerCase();
        if (t && wanted.some(w => t === w || t.startsWith(w))) {
          try {
            el.scrollIntoView({ block: 'center' });
            await new Promise(r => setTimeout(r, 300));
            el.click();
            clicked = true;
            clicks++;
            await new Promise(r => setTimeout(r, 1200));
            break outer;
          } catch (_) {}
        }
      }
    }
    if (!clicked) break;
  }
  return clicks;
}

// Lay comment tu 1 post element (kem ca dialog comment dang mo ben ngoai feed)
async function __scraperExtractComments(postEl, opts = {}) {
  const comments = [];
  const seen = new Set();
  const collectFrom = (roots) => {
    for (const root of roots) {
      for (const c of __scraperFindCommentContainers(root)) {
        if (__scraperAbort) return;
        try {
          const label = c.getAttribute('aria-label') || '';
          const author = ScraperCore.parseAuthorFromLabel(label);
          const text = (c.innerText || '').trim();
          if (!text) continue;
          const body = ScraperCore.stripAuthorPrefix(text, author);
          const key = ScraperCore.buildCommentKey(author, body);
          if (seen.has(key)) continue;
          seen.add(key);
          comments.push({ author, text: body });
        } catch (_) {}
      }
    }
  };

  try {
    // 1) Comment inline ngay trong post (permalink / feed hien comment san)
    collectFrom([postEl]);

    // 2) Khong co inline -> bam nut "N bình luận" mo khung comment (dialog)
    if (comments.length === 0 && opts.openComments !== false) {
      const commentButtons = Array.from(postEl.querySelectorAll("div[role='button'], span, a")).filter((el) => {
        const t = (el.innerText || '').trim().toLowerCase();
        const l = ((el.getAttribute && el.getAttribute('aria-label')) || '').trim().toLowerCase();
        return /^(\d[\d.,]*)?\s*(bình luận|comments?|phản hồi|replies?)$/.test(t) ||
               t === 'xem bình luận' || t === 'view comments' ||
               /^(\d[\d.,]*)?\s*(bình luận|comments?)$/.test(l);
      });
      if (commentButtons.length) {
        try {
          commentButtons[0].click();
          await new Promise(r => setTimeout(r, 1800));
        } catch (_) {}
        const dialogs = __scraperGetDialogs();
        const target = dialogs.length ? dialogs[0] : postEl;
        // Mo rong binh luan trong dialog (hoac trong post neu khong co dialog)
        await __scraperExpandComments(target, opts.maxCommentClicks ?? SCRAPE_COMMENTS_LOAD_CLICKS_MAX);
        collectFrom(dialogs.length ? dialogs : [postEl]);
        // DONG dialog de feed khong bi chan (day chinh la ly do truoc day scraper dung yen o bai dau)
        if (dialogs.length) await __scraperCloseDialogs();
      }
    }
  } catch (_) {}
  return comments;
}

// Lay thong tin 1 post tu element
function __scraperExtractPost(postEl) {
  try {
    // Link bai viet: tim <a> co href chua /posts/ hoac /permalink/ hoac /videos/ hoac /photo
    let postUrl = '';
    const links = postEl.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.href || '';
      if (/facebook\.com\/.*(\/posts\/|\/permalink\/|\/videos\/|\/photos?\/|\/reel\/)/.test(href)) {
        postUrl = href.split('?')[0];
        break;
      }
    }

    // Noi dung: thu contentSelectors tu config, sau do fallback div[dir="auto"]
    let content = '';
    const sels = (config && config.contentSelectors) || defaultConfig.contentSelectors;
    for (const sel of sels) {
      const els = postEl.querySelectorAll(sel);
      for (const el of els) {
        const t = (el.innerText || '').trim();
        if (t && t.length > content.length) content = t;
      }
    }

    // Anh
    const images = [];
    postEl.querySelectorAll('img[src]').forEach((img) => {
      const src = img.src || '';
      if (src.includes('scontent') && !src.includes('profile')) images.push(src.split('&')[0] + '...');
    });

    // So comment / like
    let numComments = null;
    const cm = (postEl.innerText || '').match(/(\d[\d.,]*)\s*(comments|bình luận)/i);
    if (cm) numComments = parseInt(cm[1].replace(/[.,]/g, ''), 10);
    let numReactions = null;
    const rm = (postEl.innerText || '').match(/(\d[\d.,]*)\s*(reactions|likes|lượt|thích)/i);
    if (rm) numReactions = parseInt(rm[1].replace(/[.,]/g, ''), 10);

    return { postUrl, content, images, numComments, numReactions };
  } catch (e) {
    return { postUrl: '', content: '', images: [], numComments: null, numReactions: null };
  }
}

// Cao du lieu 1 trang: scroll n lan de load them bai viet
async function __scraperScrapeCurrentPage(opts = {}) {
  const { maxScrolls = SCRAPE_MAX_SCROLLS_DEFAULT, scrollDelayMs = SCRAPE_SCROLL_STEP_DELAY_MS, withComments = true, maxCommentClicks = SCRAPE_COMMENTS_LOAD_CLICKS_MAX } = opts;
  const feedSel = (config && config.postSelector) || defaultConfig.postSelectors[0];
  const seen = new Set();
  const posts = [];

  const collectOnce = async () => {
    const postEls = Array.from(document.querySelectorAll(feedSel));
    for (const postEl of postEls) {
      if (__scraperAbort) break;
      if (__scraperTimeLeft(deadline) <= 0) {
        __scraperLog('het time budget/URL — dung lai, giu phan da cao');
        return true; // outOfTime
      }
      try {
        __scraperExpandAllSeeMore(postEl);
        await new Promise(r => setTimeout(r, 400));
        const { postUrl, content, images, numComments, numReactions } = __scraperExtractPost(postEl);
        if (!content && !postUrl) continue; // bo qua element rac
        const key = ScraperCore.buildPostKey(postUrl, location.href.split('?')[0], content);
        if (seen.has(key)) continue;
        seen.add(key);
        const post = { postUrl, content, images, numComments, numReactions, expectedComments: numComments, comments: [] };
        if (withComments) {
          post.comments = await __scraperExtractComments(postEl, { maxCommentClicks });
        }
        posts.push(post);
        __scraperLog(`Post ${posts.length}: ${content.slice(0, 50)}... comments ${post.comments.length}/${numComments ?? '?'}`);
      } catch (_) {}
    }
  };

  // Cho feed xuat hien
  const deadline = __scraperMakeDeadline(opts);
  for (let i = 0; i < 20 && !__scraperAbort; i++) {
    if (document.querySelector(feedSel)) break;
    if (__scraperTimeLeft(deadline) <= 0) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  // Scroll tu dong 1 buoc: cuon cua so so; neu khong di chuyen thi thu scroll container cua feed
  const scrollOneStep = async () => {
    const sc = document.scrollingElement || document.documentElement;
    const before = sc.scrollTop;
    window.scrollBy({ top: Math.max(600, Math.round(window.innerHeight * 0.8)), behavior: 'instant' });
    await new Promise(r => setTimeout(r, 400));
    if ((document.scrollingElement || document.documentElement).scrollTop <= before + 10) {
      try {
        let el = document.querySelector(feedSel);
        while (el && el !== document.body) {
          const st = getComputedStyle(el);
          if (/(auto|scroll)/.test(st.overflowY || '') && el.scrollHeight > el.clientHeight + 50) {
            el.scrollTop += el.clientHeight;
            break;
          }
          el = el.parentElement;
        }
      } catch (_) {}
    }
  };

  let emptyPasses = 0;
  let postsBefore = -1;
  await collectOnce();
  for (let s = 0; s < maxScrolls && !__scraperAbort; s++) {
    if (__scraperTimeLeft(deadline) <= 0) {
      __scraperLog('het time budget/URL — dung lai, giu phan da cao');
      break;
    }
    postsBefore = posts.length;
    await scrollOneStep();
    await new Promise(r => setTimeout(r, scrollDelayMs));
    const outOfTime = await collectOnce();
    // An toan: dialog comment bat khong dong se chan feed -> dong di
    if (__scraperGetDialogs().length) await __scraperCloseDialogs();
    // Early-stop: nhieu lan scroll lien tiep khong co bai moi
    if (posts.length === postsBefore) {
      emptyPasses++;
      __scraperLog(`scroll ${s + 1}/${maxScrolls}: khong co bai moi (${emptyPasses}/${SCRAPE_EMPTY_PASSES_BEFORE_STOP})`);
      if (emptyPasses >= SCRAPE_EMPTY_PASSES_BEFORE_STOP) {
        __scraperLog('het bai moi — dung scroll som');
        break;
      }
    } else {
      emptyPasses = 0;
    }
    if (outOfTime) break;
    try {
      const progress = { scraperProgress: { scroll: s + 1, maxScrolls, postsSoFar: posts.length, timeLeftMs: __scraperTimeLeft(deadline) } };
      chrome.storage.local.set(progress);
    } catch (_) {}
  }
  __scraperLog(`xong: ${posts.length} posts`);
  return posts;
}

// Handler chinh
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'contentScrapePosts') {
    (async () => {
      try {
        __scraperActive = true;
        __scraperAbort = false;
        const opts = msg.options || {};
        const posts = await __scraperScrapeCurrentPage(opts);
        chrome.storage.local.set({ operationDone: 'successful', scrapedPosts: posts }, () => {});
      } catch (e) {
        __scraperLog('error: ' + e.message);
        chrome.storage.local.set({ operationDone: 'failed', scrapedPosts: [] }, () => {});
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
