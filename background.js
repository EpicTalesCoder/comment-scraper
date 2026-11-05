// ═══════════════════════════════════════════════════════════════════════════
// Facebook Comment Scraper — BACKGROUND SERVICE WORKER (v1.26.0)
// Chỉ còn luồng cào comment. Đã gỡ toàn bộ code của extension gốc
// (đăng bài, Mixpanel/Sentry/telemetry, snapshot/dom-analyze upload, Firebase,
// cookies, credits). Không gửi dữ liệu tới bất kỳ server nào: kết quả chỉ nằm
// trong chrome.storage.local của máy bạn.
// ═══════════════════════════════════════════════════════════════════════════

// Pure helpers dung chung (isPostUrl...) — classic service worker nen dung importScripts
importScripts('lib/scraper-core.js');

const state = {
  isStopRequested: false,
};

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
    try {
      console.log(`[Tab Creation] Attempt ${attempt}/${maxRetries} for ${url}`);
      return await createTab(url, tabOptions);
    } catch (error) {
      lastError = error;
      console.warn(`[Tab Creation] Attempt ${attempt} failed:`, error.message);
      if (attempt < maxRetries) {
        await sleepMs(initialDelayMs * Math.pow(2, attempt - 1));
      }
    }
  }
  throw new Error(`Failed to create tab after ${maxRetries} attempts: ${lastError.message}`);
}

// FB hiếm khi đạt status "complete" nhanh (long-polling, lazy load) -> nếu hết
// timeoutMs mà tab vẫn sống thì vẫn resolve (không đóng cửa sổ + retry vô ích);
// checkContentScriptReady sẽ đợi content script sau đó.
function createTab(url, { timeoutMs = 45000, focused = false } = {}) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;
    let listener = null;
    let createdWindowId = null;
    let settled = false;

    const cleanup = () => {
      if (listener) chrome.tabs.onUpdated.removeListener(listener);
      if (timeoutId) clearTimeout(timeoutId);
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

// PAUSE giữa 2 URL: timeInSeconds, random 70-150% nếu bật; dừng ngay khi bấm Stop
async function waitBeforeNextPost(timeInSeconds, currentIndex, totalUrls, deliveryOptions = {}) {
  let wait = Math.max(0, Math.round(timeInSeconds));
  if (deliveryOptions.randomizeWait && wait > 0) {
    const min = Math.round(wait * 0.7);
    const max = Math.round(wait * 1.5);
    wait = Math.floor(Math.random() * (max - min + 1)) + min;
  }
  let remaining = wait;
  while (remaining > 0 && !state.isStopRequested) {
    updatePostingStatus(`URL ${currentIndex + 1} / ${totalUrls} xong. URL tiếp theo sau ${remaining} giây.`);
    const step = Math.min(10, remaining);
    await sleep(step);
    remaining -= step;
  }
}

let isScrapeRunning = false;

// Navigate tab tới url và đợi load xong (resolve cả khi timeout để không treo flow)
function navigateTabAndWait(tabId, url, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo && changeInfo.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }, () => void chrome.runtime.lastError);
  });
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

// Gửi lệnh cho content script rồi đợi operationDone (successful/failed) trong storage
async function runContentStep(tabId, message, resultKeys, maxSeconds) {
  await clearOperationDone();
  await new Promise((resolve) => chrome.storage.local.remove(resultKeys, resolve));
  await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
  for (let t = 0; t < maxSeconds; t++) {
    if (state.isStopRequested) return { ok: false, stopped: true };
    const r = await new Promise((res) => chrome.storage.local.get(['operationDone', ...resultKeys], res));
    if (r.operationDone === 'successful') return { ok: true, data: r };
    if (r.operationDone === 'failed') return { ok: false, data: r };
    await sleep(1);
  }
  return { ok: false, timeout: true };
}

async function initiateScrapePostsAction(request) {
  const urls = request.payload.urls || [];
  const options = request.payload.options || {};
  const timeInSeconds = typeof request.payload.timeInSeconds === 'number' ? request.payload.timeInSeconds : 30;
  const focusWindow = options.focusWindow !== false;
  const postBudgetSec = Math.max(30, options.postTimeBudgetSec || 240);

  updatePostingProgress('started');
  updatePostingStatus(`Start scraping ${urls.length} pages`);

  chrome.storage.local.set({
    showModal: true,
    modalHiddenByUser: false,
    isPostingInProgress: 'started',
    scrapeResults: [],
    scrapeLogs: [],
  });

  const allResults = [];

  for (let i = 0; i < urls.length; i++) {
    if (state.isStopRequested) break;
    const url = urls[i];
    const singlePost = ScraperCore.isPostUrl(url);
    updatePostingStatus(`Scraping ${i + 1} / ${urls.length}: ${url}`);
    // Progress theo URL cho UI (key rieng de content script khong ghi de)
    chrome.storage.local.set({ scrapeUrlProgress: { urlIndex: i + 1, totalUrls: urls.length, url }, scrapePostProgress: null });

    let tab;
    try {
      tab = await createTabWithRetry(url, 3, 2000, { focused: focusWindow });
    } catch (error) {
      console.error(`[Scrape] Failed to create tab for ${url}. Skipping.`, error);
      allResults.push({ url, error: 'Tab creation failed', posts: [] });
      continue;
    }

    try {
      await checkContentScriptReady(tab.id, 30, 1000);
      await ensureTabVisible(tab.id, focusWindow);

      // PHASE 1: thu danh sách bài + permalink (link bài đơn lẻ thì bỏ qua)
      let posts;
      if (singlePost) {
        posts = [{ postUrl: url, content: '', images: [], numComments: null, numReactions: null, comments: [] }];
      } else {
        const r1 = await runContentStep(
          tab.id,
          { action: 'contentScrapePosts', options: { ...options, withComments: false } },
          ['scrapedPosts'],
          300
        );
        posts = (r1.data && r1.data.scrapedPosts) || [];
        if (!r1.ok && !posts.length) throw new Error(r1.timeout ? 'Phase 1 timeout' : 'Phase 1 failed');
      }
      chrome.storage.local.set({ scrapedPosts: posts });
      const withUrl = posts.filter((p) => p.postUrl).length;
      updatePostingStatus(`Tìm thấy ${posts.length} bài (${withUrl} có link) — mở từng bài để quét comment...`);
      if (withUrl < posts.length) {
        console.warn(`[Scrape] ${posts.length - withUrl}/${posts.length} bài không có permalink — dùng comment cào trong feed`);
      }

      // PHASE 2: MO TUNG BAI VIET (navigate tab tới postUrl) + quét full comment
      if (options.withComments !== false) {
        for (let j = 0; j < posts.length; j++) {
          if (state.isStopRequested) break;
          const p = posts[j];
          if (!p.postUrl) continue;
          updatePostingStatus(`Bài ${j + 1}/${posts.length}: ${p.postUrl}`);
          chrome.storage.local.set({ scrapePostProgress: { postIndex: j + 1, totalPosts: posts.length } });
          try {
            // Link bài đơn lẻ: tab đã mở sẵn đúng bài -> khỏi navigate lại
            if (!(singlePost && j === 0)) await navigateTabAndWait(tab.id, p.postUrl);
            await checkContentScriptReady(tab.id, 30, 1000);
            await ensureTabVisible(tab.id, focusWindow);
            const r2 = await runContentStep(
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
            console.error('[Scrape] Post flow failed cho', p.postUrl, postErr);
          }
          // Cập nhật UI live sau mỗi bài
          chrome.storage.local.set({ scrapedPosts: posts });
          await sleep(2); // nhịp nhẹ giữa các bài, tránh spam FB
        }
      }
      allResults.push({ url, posts });
      chrome.storage.local.set({ scrapeResults: allResults });
      updatePostingStatus(`Scraped ${posts.length} posts, ${posts.reduce((a, p) => a + (p.comments?.length || 0), 0)} comments from ${url}`);
    } catch (error) {
      console.error('[Scrape] Flow failed for', url, error);
      allResults.push({ url, error: String(error?.message || error), posts: [] });
    }

    // Cleanup tab (giong cleanUpAfterPosting)
    await cleanUpAfterPosting(tab.id);

    // PAUSE giua cac URL — dung dung co che waitBeforeNextPost cua posting flow
    if (i + 1 < urls.length && !state.isStopRequested) {
      console.log(`[Scrape] Waiting before next URL (${i + 2}/${urls.length})...`);
      // Custom delivery: dung dung timeInSeconds ma user nhap (batchSize=1 -> moi URL deu cho)
      const deliveryOpts = {
        isCustom: true,
        mode: 'throttled',
        batchSize: 1,
        waitMinutes: timeInSeconds / 60,
        randomizeWait: options.randomizeWait !== false,
      };
      await waitBeforeNextPost(timeInSeconds, i, urls.length, deliveryOpts);
    }
    await sleep(1);
  }

  // Luu ket qua
  const totalPosts = allResults.reduce((a, r) => a + (r.posts?.length || 0), 0);
  const totalComments = allResults.reduce((a, r) => a + (r.posts || []).reduce((b, p) => b + (p.comments?.length || 0), 0), 0);
  chrome.storage.local.set({
    scrapeResults: allResults,
    isPostingInProgress: 'done',
    showModal: true,
    modalHiddenByUser: false,
  }, () => {});
  updatePostingStatus(`Scraping completed. ${totalPosts} posts, ${totalComments} comments total.`);
  updatePostingProgress('done');
  isScrapeRunning = false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startScrapePosts') {
    if (isScrapeRunning) {
      sendResponse({ success: false, message: 'Scrape already running' });
      return true;
    }
    isScrapeRunning = true;
    state.isStopRequested = false;
    initiateScrapePostsAction(msg)
      .catch((err) => console.error('[Scrape] error:', err))
      .finally(() => { isScrapeRunning = false; });
    sendResponse({ success: true });
    return true;
  }
  if (msg.action === 'stopScrapePosts') {
    state.isStopRequested = true;
    // Thong bao cho content script dang chay
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((t) => {
        chrome.tabs.sendMessage(t.id, { action: 'stopScrapePosts' }, () => void chrome.runtime.lastError);
      });
    });
    sendResponse({ success: true });
    return true;
  }
  if (msg.action === 'openScrapeUI') {
    chrome.tabs.create({ url: chrome.runtime.getURL('scraper.html') });
    sendResponse({ success: true });
    return true;
  }
});
