// ═══════════════════════════════════════════════════════════════════════════
// Facebook Comment Scraper — BACKGROUND SERVICE WORKER (v1.26.0)
// Chỉ còn luồng cào comment. Đã gỡ toàn bộ code của extension gốc
// (đăng bài, Mixpanel/Sentry/telemetry, snapshot/dom-analyze upload, Firebase,
// cookies, credits). Không gửi dữ liệu tới bất kỳ server nào: kết quả chỉ nằm
// trong chrome.storage.local của máy bạn.
// ═══════════════════════════════════════════════════════════════════════════

// Pure helpers dung chung (isPostUrl...) — classic service worker nen dung importScripts
importScripts('lib/scraper-core.js');

// Click icon extension -> mo trang scraper
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('scraper.html') });
});

function updatePostingStatus(message) {
  chrome.storage.local.set({ postingStatus: message }, () => void chrome.runtime.lastError);
}

function updatePostingProgress(status) {
  chrome.storage.local.set({ isPostingInProgress: status }, () => void chrome.runtime.lastError);
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearOperationDone() {
  await new Promise((resolve) => chrome.storage.local.remove('operationDone', resolve));
}

// CONTENT SCRIPT READINESS CHECK: Verify content.js is loaded before sending messages
async function checkContentScriptReady(tabId, maxRetries = 3, retryDelayMs = 500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.pong) {
            resolve(true);
          } else {
            reject(new Error('Content script did not respond to ping'));
          }
        });
      });
    } catch (error) {
      console.warn(`[Content Ready] Attempt ${attempt}/${maxRetries} failed:`, error.message);
      if (attempt < maxRetries) {
        await sleepMs(retryDelayMs);
      } else {
        throw error;
      }
    }
  }
}

// TAB RETRY LOGIC: Retry tab creation with exponential backoff
async function createTabWithRetry(url, maxRetries = 3, initialDelayMs = 2000, tabOptions = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (tabOptions.run && tabOptions.run.stopped) throw new Error('stopped');
    try {
      console.log(`[Tab Creation] Attempt ${attempt}/${maxRetries} for ${url}`);
      return await createTab(url, tabOptions);
    } catch (error) {
      lastError = error;
      console.warn(`[Tab Creation] Attempt ${attempt} failed:`, error.message);
      if (attempt < maxRetries) {
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        if (tabOptions.run) await runSleep(tabOptions.run, delay);
        else await sleepMs(delay);
      }
    }
  }
  throw new Error(`Failed to create tab after ${maxRetries} attempts: ${lastError.message}`);
}

// FB hiếm khi đạt status "complete" nhanh (long-polling, lazy load) -> nếu hết
// timeoutMs mà tab vẫn sống thì vẫn resolve (không đóng cửa sổ + retry vô ích);
// checkContentScriptReady sẽ đợi content script sau đó.
function createTab(url, { timeoutMs = 45000, focused = false, run = null } = {}) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;
    let listener = null;
    let createdWindowId = null;
    let settled = false;

    // Cửa sổ bị đóng (Stop hoặc người dùng tự đóng) -> thôi chờ ngay
    const onRemoved = (windowId) => {
      if (windowId === createdWindowId) settleReject(new Error('Window closed'));
    };

    const cleanup = () => {
      if (listener) chrome.tabs.onUpdated.removeListener(listener);
      if (timeoutId) clearTimeout(timeoutId);
      chrome.windows.onRemoved.removeListener(onRemoved);
      listener = null;
      timeoutId = null;
    };

    const settleResolve = (tabId) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ id: tabId, windowId: createdWindowId });
    };

    const settleReject = (error, { closeWindow = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (closeWindow && createdWindowId) {
        chrome.windows.remove(createdWindowId, () => reject(error));
        return;
      }
      reject(error);
    };

    chrome.windows.create(
      { url, type: 'popup', left: 100, top: 100, width: 700, height: 600, focused },
      (newWindow) => {
        if (chrome.runtime.lastError) {
          return settleReject(new Error(chrome.runtime.lastError.message));
        }
        const tabId = newWindow?.tabs?.[0]?.id;
        createdWindowId = newWindow?.id;
        if (run && createdWindowId) {
          run.windowIds.add(createdWindowId);
          if (run.stopped) return settleReject(new Error('stopped'), { closeWindow: true });
        }
        chrome.windows.onRemoved.addListener(onRemoved);
        if (!tabId) {
          return settleReject(new Error('Failed to get tab id from newly created window'), { closeWindow: true });
        }

        const finishIfAlive = () => {
          chrome.windows.get(createdWindowId, {}, (win) => {
            if (chrome.runtime.lastError || !win) {
              return settleReject(new Error('Window not found or already closed.'));
            }
            settleResolve(tabId);
          });
        };

        listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tabId && changeInfo && changeInfo.status === 'complete') finishIfAlive();
        };
        chrome.tabs.onUpdated.addListener(listener);

        // Tab có thể đã "complete" trước khi listener được gắn
        chrome.tabs.get(tabId, (t) => {
          if (!chrome.runtime.lastError && t && t.status === 'complete') finishIfAlive();
        });

        timeoutId = setTimeout(() => {
          chrome.tabs.get(tabId, (t) => {
            if (settled) return;
            if (chrome.runtime.lastError || !t) {
              return settleReject(new Error('Timed out waiting for tab to load'), { closeWindow: true });
            }
            console.warn(`[Tab Creation] Tab chưa "complete" sau ${timeoutMs}ms — vẫn tiếp tục`);
            settleResolve(tabId);
          });
        }, timeoutMs);
      }
    );
  });
}

// Đóng cửa sổ cào của 1 URL
async function cleanUpAfterPosting(tabId) {
  await new Promise((resolve) => chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; resolve(); }));
}

// ═══ LẦN CHẠY (RUN) ═══
// Mỗi lần Start tạo 1 object run riêng. Stop đánh dấu run.stopped + đóng cửa sổ cào
// ngay; mọi bước chờ đều kiểm tra run.stopped nên vòng cũ thoát trong ~1s. Start mới
// không phải đợi vòng cũ thoát hẳn, và vòng cũ không được ghi đè trạng thái run mới.
let currentRun = null;

function newRun() {
  return { id: Date.now(), stopped: false, windowIds: new Set() };
}

// Ngủ tối đa `ms`, thức dậy sớm nếu run bị dừng
async function runSleep(run, ms) {
  const end = Date.now() + ms;
  while (!run.stopped && Date.now() < end) {
    await sleepMs(Math.min(500, end - Date.now()));
  }
}

function stopRun(run, reason) {
  if (!run || run.stopped) return;
  run.stopped = true;
  // Đóng cửa sổ cào sau 3s: đủ để content script (đã nhận lệnh dừng) lưu phần đã cào
  const windowIds = Array.from(run.windowIds);
  setTimeout(() => {
    for (const wid of windowIds) chrome.windows.remove(wid, () => void chrome.runtime.lastError);
  }, 3000);
  // Báo content script đang chạy dừng lại
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { action: 'stopScrapePosts' }, () => void chrome.runtime.lastError));
  });
  if (run === currentRun) {
    updatePostingProgress('done');
    updatePostingStatus(reason || 'Đã dừng.');
  }
}

// Service worker vừa khởi động (lần đầu hoặc sau khi Chrome tắt nó giữa chừng):
// chắc chắn không có run nào đang chạy -> gỡ trạng thái 'started' bị kẹt.
chrome.storage.local.get(['isPostingInProgress'], (r) => {
  if (r && r.isPostingInProgress === 'started' && !currentRun) {
    updatePostingProgress('done');
    updatePostingStatus('Lần cào trước bị gián đoạn — kết quả đã cào vẫn được giữ. Có thể chạy lại.');
  }
});

// PAUSE giữa 2 URL: timeInSeconds, random 70-150% nếu bật; dừng ngay khi bấm Stop
async function waitBeforeNextPost(run, timeInSeconds, currentIndex, totalUrls, randomize, status) {
  let wait = Math.max(0, Math.round(timeInSeconds));
  if (randomize && wait > 0) {
    const min = Math.round(wait * 0.7);
    const max = Math.round(wait * 1.5);
    wait = Math.floor(Math.random() * (max - min + 1)) + min;
  }
  let remaining = wait;
  while (remaining > 0 && !run.stopped) {
    status(`URL ${currentIndex + 1} / ${totalUrls} xong. URL tiếp theo sau ${remaining} giây.`);
    const step = Math.min(5, remaining);
    await runSleep(run, step * 1000);
    remaining -= step;
  }
}

// Navigate tab tới url và đợi load xong (resolve cả khi timeout/stop để không treo flow)
function navigateTabAndWait(run, tabId, url, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      clearInterval(stopPoll);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo && changeInfo.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    const stopPoll = setInterval(() => { if (run.stopped) finish(); }, 500);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }, () => { if (chrome.runtime.lastError) finish(); });
  });
}

// Đợi content script sẵn sàng (tối đa ~maxSeconds), dừng ngay khi Stop
async function waitContentReady(run, tabId, maxSeconds = 30) {
  for (let i = 0; i < maxSeconds && !run.stopped; i++) {
    try {
      return await checkContentScriptReady(tabId, 1);
    } catch (e) {
      if (/No tab with id/i.test(e.message)) throw e; // cửa sổ đã bị đóng
      await runSleep(run, 1000);
    }
  }
  if (run.stopped) throw new Error('stopped');
  throw new Error('Content script không phản hồi');
}

// Cửa sổ cào bị che/thu nhỏ -> Chrome coi trang là "hidden", ngừng render,
// FB không lazy-load bài/comment. Đưa cửa sổ lên trên nếu người dùng cho phép.
async function ensureTabVisible(tabId, allowFocus) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.visibilityState,
    });
    if (res && res.result === 'visible') return true;
    if (!allowFocus) {
      console.warn('[Scrape] Tab cào đang bị che (hidden) — FB có thể không tải thêm nội dung');
      return false;
    }
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
    await sleepMs(800);
    return true;
  } catch (e) {
    console.warn('[Scrape] ensureTabVisible failed:', e?.message || e);
    return false;
  }
}

// Gửi lệnh cho content script rồi đợi operationDone (successful/failed) trong storage.
// Bị Stop: đợi thêm tối đa 3s để content script (đã nhận lệnh dừng) trả phần đã cào.
async function runContentStep(run, tabId, message, resultKeys, maxSeconds) {
  await clearOperationDone();
  await new Promise((resolve) => chrome.storage.local.remove(resultKeys, resolve));
  await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
  const read = () => new Promise((res) => chrome.storage.local.get(['operationDone', ...resultKeys], res));
  const end = Date.now() + maxSeconds * 1000;
  while (Date.now() < end) {
    const r = await read();
    if (r.operationDone === 'successful') return { ok: true, data: r };
    if (r.operationDone === 'failed') return { ok: false, data: r };
    if (run.stopped) {
      await sleepMs(3000);
      const last = await read();
      return { ok: last.operationDone === 'successful', data: last, stopped: true };
    }
    await sleepMs(1000);
  }
  return { ok: false, timeout: true };
}

async function initiateScrapePostsAction(run, request) {
  const urls = request.payload.urls || [];
  const options = request.payload.options || {};
  const timeInSeconds = typeof request.payload.timeInSeconds === 'number' ? request.payload.timeInSeconds : 30;
  const focusWindow = options.focusWindow !== false;
  const postBudgetSec = Math.max(30, options.postTimeBudgetSec || 240);
  // Chỉ run hiện hành mới được ghi trạng thái/kết quả (run cũ đang thoát thì im lặng)
  const isCurrent = () => run === currentRun;
  const status = (m) => { if (isCurrent() && !run.stopped) updatePostingStatus(m); };
  const save = (obj) => { if (isCurrent()) chrome.storage.local.set(obj); };

  updatePostingProgress('started');
  updatePostingStatus(`Start scraping ${urls.length} pages`);
  chrome.storage.local.set({
    isPostingInProgress: 'started',
    scrapeResults: [],
    scrapedPosts: [],
    scrapeLogs: [],
  });

  const allResults = [];

  for (let i = 0; i < urls.length && !run.stopped; i++) {
    const url = urls[i];
    const singlePost = ScraperCore.isPostUrl(url);
    status(`Scraping ${i + 1} / ${urls.length}: ${url}`);
    // Progress theo URL cho UI (key rieng de content script khong ghi de)
    save({ scrapeUrlProgress: { urlIndex: i + 1, totalUrls: urls.length, url }, scrapePostProgress: null });

    let tab;
    try {
      tab = await createTabWithRetry(url, 3, 2000, { focused: focusWindow, run });
    } catch (error) {
      if (run.stopped) break;
      console.error(`[Scrape] Failed to create tab for ${url}. Skipping.`, error);
      allResults.push({ url, error: 'Tab creation failed', posts: [] });
      continue;
    }

    let posts = [];
    try {
      await waitContentReady(run, tab.id);
      await ensureTabVisible(tab.id, focusWindow);

      // PHASE 1: thu danh sách bài + permalink (link bài đơn lẻ thì bỏ qua)
      if (singlePost) {
        posts = [{ postUrl: url, content: '', images: [], numComments: null, numReactions: null, comments: [] }];
      } else {
        const r1 = await runContentStep(
          run,
          tab.id,
          { action: 'contentScrapePosts', options: { ...options, withComments: false } },
          ['scrapedPosts'],
          300
        );
        posts = (r1.data && r1.data.scrapedPosts) || [];
        if (!r1.ok && !posts.length && !run.stopped) throw new Error(r1.timeout ? 'Phase 1 timeout' : 'Phase 1 failed');
      }
      save({ scrapedPosts: posts });
      const withUrl = posts.filter((p) => p.postUrl).length;
      status(`Tìm thấy ${posts.length} bài (${withUrl} có link) — mở từng bài để quét comment...`);

      // PHASE 2: MO TUNG BAI VIET (navigate tab tới postUrl) + quét full comment
      if (options.withComments !== false) {
        for (let j = 0; j < posts.length && !run.stopped; j++) {
          const p = posts[j];
          if (!p.postUrl) continue;
          status(`Bài ${j + 1}/${posts.length}: ${p.postUrl}`);
          save({ scrapePostProgress: { postIndex: j + 1, totalPosts: posts.length } });
          try {
            // Link bài đơn lẻ: tab đã mở sẵn đúng bài -> khỏi navigate lại
            if (!(singlePost && j === 0)) await navigateTabAndWait(run, tab.id, p.postUrl);
            await waitContentReady(run, tab.id);
            await ensureTabVisible(tab.id, focusWindow);
            const r2 = await runContentStep(
              run,
              tab.id,
              {
                action: 'contentScrapePostComments',
                options: { maxCommentClicks: options.maxCommentClicks, timeBudgetMs: postBudgetSec * 1000 },
              },
              ['scrapedComments', 'scrapedPostInfo'],
              postBudgetSec + 40
            );
            const got = (r2.data && r2.data.scrapedComments) || [];
            if (got.length >= (p.comments || []).length) p.comments = got;
            const info = r2.data && r2.data.scrapedPostInfo;
            if (info) {
              if (!p.content) p.content = info.content;
              if (!p.images || !p.images.length) p.images = info.images || [];
              if (p.numComments == null) p.numComments = info.numComments;
              if (p.numReactions == null) p.numReactions = info.numReactions;
              p.expectedComments = p.numComments;
            }
          } catch (postErr) {
            if (!run.stopped) console.error('[Scrape] Post flow failed cho', p.postUrl, postErr);
          }
          // Cập nhật UI live sau mỗi bài
          save({ scrapedPosts: posts });
          await runSleep(run, 2000); // nhịp nhẹ giữa các bài, tránh spam FB
        }
      }
      allResults.push({ url, posts });
      status(`Scraped ${posts.length} posts, ${posts.reduce((a, p) => a + (p.comments?.length || 0), 0)} comments from ${url}`);
    } catch (error) {
      if (run.stopped) {
        if (posts.length) allResults.push({ url, posts });
      } else {
        console.error('[Scrape] Flow failed for', url, error);
        allResults.push({ url, error: String(error?.message || error), posts });
      }
    }
    save({ scrapeResults: allResults });

    await cleanUpAfterPosting(tab.id);
    run.windowIds.delete(tab.windowId);

    // PAUSE giua cac URL
    if (i + 1 < urls.length && !run.stopped) {
      await waitBeforeNextPost(run, timeInSeconds, i, urls.length, options.randomizeWait !== false, status);
    }
  }

  // Luu ket qua (ca khi bi Stop: giu phan da cao)
  const totalPosts = allResults.reduce((a, r) => a + (r.posts?.length || 0), 0);
  const totalComments = allResults.reduce((a, r) => a + (r.posts || []).reduce((b, p) => b + (p.comments?.length || 0), 0), 0);
  if (isCurrent()) {
    chrome.storage.local.set({ scrapeResults: allResults, isPostingInProgress: 'done' });
    updatePostingStatus(run.stopped
      ? `Đã dừng. Giữ lại ${totalPosts} bài, ${totalComments} bình luận đã cào.`
      : `Scraping completed. ${totalPosts} posts, ${totalComments} comments total.`);
    currentRun = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startScrapePosts') {
    // Run cũ (nếu còn) bị dừng ngay, không chặn lần chạy mới
    if (currentRun) stopRun(currentRun);
    const run = newRun();
    currentRun = run;
    initiateScrapePostsAction(run, msg)
      .catch((err) => {
        console.error('[Scrape] error:', err);
        if (run === currentRun) {
          updatePostingProgress('done');
          updatePostingStatus('Lỗi: ' + (err?.message || err));
          currentRun = null;
        }
      });
    sendResponse({ success: true });
    return true;
  }
  if (msg.action === 'stopScrapePosts') {
    if (currentRun) {
      stopRun(currentRun, 'Đang dừng — lưu phần đã cào...');
    } else {
      // Không có run nào trong bộ nhớ (vd service worker đã khởi động lại) -> gỡ kẹt
      updatePostingProgress('done');
      updatePostingStatus('Đã dừng.');
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { action: 'stopScrapePosts' }, () => void chrome.runtime.lastError));
      });
    }
    sendResponse({ success: true });
    return true;
  }
  if (msg.action === 'getScrapeState') {
    sendResponse({ running: !!(currentRun && !currentRun.stopped) });
    return true;
  }
  if (msg.action === 'openScrapeUI') {
    chrome.tabs.create({ url: chrome.runtime.getURL('scraper.html') });
    sendResponse({ success: true });
    return true;
  }
});
