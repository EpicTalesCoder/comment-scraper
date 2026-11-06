const $ = (id) => document.getElementById(id);
let lastResults = [];

// Restore urls
chrome.storage.local.get(['scraperUrls'], (r) => {
  if (r?.scraperUrls) $('urls').value = r.scraperUrls;
});

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderResults(results) {
  lastResults = ScraperCore.cleanResults(results);
  const totalPosts = lastResults.reduce((a, r) => a + (r.posts?.length || 0), 0);
  const totalComments = lastResults.reduce((a, r) => a + (r.posts || []).reduce((b, p) => b + (p.comments?.length || 0), 0), 0);
  const totalExpected = lastResults.reduce((a, r) => a + (r.posts || []).reduce((b, p) => b + (p.expectedComments ?? p.numComments ?? 0), 0), 0);
  let html = `<div class="summary"><b>${lastResults.length}</b> URL(s) • <b>${totalPosts}</b> bài viết • <b>${totalComments}</b> bình luận` +
    (totalExpected > 0 ? ` <span style="color:#65676b">(FB hiển thị ~${totalExpected})</span>` : '') + `</div>`;
  for (const r of lastResults) {
    html += `<div style="font-weight:600;margin-top:8px;color:#050505">${esc(r.url)} ${r.error ? '<span style="color:#fa383e">— lỗi: ' + esc(r.error) + '</span>' : ''}</div>`;
    for (const p of (r.posts || [])) {
      html += `<div class="post-item">`;
      if (p.postUrl) html += `<div class="post-url"><a href="${esc(p.postUrl)}" target="_blank">${esc(p.postUrl)}</a></div>`;
      html += `<div class="post-content">${esc((p.content || '').slice(0, 500))}</div>`;
      const got = p.comments?.length ?? 0;
      const exp = p.expectedComments ?? p.numComments;
      const flag = (exp != null && got < exp) ? ` <span style="color:#e68a00" title="FB hiển thị ${exp} comment nhưng chỉ cào được ${got} — có thể cần tăng maxCommentClicks">⚠️</span>` : '';
      html += `<div class="post-meta">💬 ${got}${exp != null ? '/' + exp : ''} comment${flag} • 👍 ${p.numReactions ?? '?'} • 🖼 ${p.images?.length || 0} ảnh</div>`;
      for (const c of (p.comments || [])) {
        html += `<div class="comment"${c.isReply ? ' style="margin-left:24px"' : ''}>${c.isReply ? '↳ ' : ''}<b>${esc(c.author)}</b> <span>${esc((c.text || '').slice(0, 300))}</span></div>`;
      }
      html += `</div>`;
    }
  }
  $('results').innerHTML = html || '<div style="color:#65676b">Chưa có kết quả.</div>';
  $('btnJson').disabled = totalPosts === 0;
  $('btnCsv').disabled = totalPosts === 0;
}

function pollStatus() {
  chrome.storage.local.get(['postingStatus', 'scrapeResults', 'scraperProgress', 'scrapeUrlProgress', 'scrapePostProgress', 'isPostingInProgress', 'scrapedPosts', 'scrapeLogs'], (r) => {
    if (r?.postingStatus) $('status').textContent = r.postingStatus;
    const prog = r?.scraperProgress;
    if (prog && prog.maxScrolls > 0) {
      $('progressBar').style.width = Math.min(100, (prog.scroll / prog.maxScrolls) * 100) + '%';
    }
    // Log tail (15 dong cuoi)
    if (r?.scrapeLogs?.length) {
      $('logTail').textContent = r.scrapeLogs.slice(-15).join('\n');
    }
    // Đếm live trong lúc chạy: tổng posts + comments của URL đang cào
    if (r?.isPostingInProgress === 'started') {
      const livePosts = r?.scrapedPosts || [];
      const lc = livePosts.reduce((a, p) => a + (p.comments?.length || 0), 0);
      const up = r?.scrapeUrlProgress;
      const pp = r?.scrapePostProgress;
      const urlInfo = up?.totalUrls ? `URL ${up.urlIndex}/${up.totalUrls} • ` : '';
      const postInfo = pp?.totalPosts ? `bài ${pp.postIndex}/${pp.totalPosts} • ` : '';
      $('liveCounters').textContent = `${urlInfo}${postInfo}${livePosts.length} bài • ${lc} bình luận (đang cào…)`;
    } else {
      $('liveCounters').textContent = '';
    }
    if (r?.scrapeResults?.length) renderResults(r.scrapeResults);
    const running = r?.isPostingInProgress === 'started';
    $('btnStart').disabled = running;
    // Poll nhanh hơn khi đang chạy
    setTimeout(pollStatus, running ? 1000 : 3000);
  });
}
pollStatus();

$('btnStart').onclick = () => {
  const urls = $('urls').value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!urls.length) { $('status').textContent = '⚠️ Hãy nhập ít nhất 1 URL Facebook.'; return; }
  chrome.storage.local.set({ scraperUrls: $('urls').value });
  const options = {
    maxScrolls: parseInt($('maxScrolls').value, 10) || 10,
    scrollDelayMs: 2500,
    withComments: $('withComments').value === 'yes',
    maxCommentClicks: parseInt($('maxCommentClicks').value, 10) || 150,
    postTimeBudgetSec: parseInt($('postTimeBudgetSec').value, 10) || 240,
    focusWindow: $('focusWindow').value === 'yes',
  };
  const timeInSeconds = parseInt($('timeInSeconds').value, 10) || 30;
  chrome.runtime.sendMessage(
    { action: 'startScrapePosts', payload: { urls, options, timeInSeconds } },
    (resp) => {
      if (chrome.runtime.lastError) {
        $('status').textContent = '❌ ' + chrome.runtime.lastError.message;
        return;
      }
      if (resp?.success) {
        $('status').textContent = 'Đã bắt đầu... cửa sổ Facebook sẽ tự mở từng URL.';
        $('btnStart').disabled = true;
      } else {
        $('status').textContent = '⚠️ ' + (resp?.message || 'Không gửi được lệnh');
      }
    }
  );
};

$('btnStop').onclick = () => {
  chrome.runtime.sendMessage({ action: 'stopScrapePosts' }, () => {
    void chrome.runtime.lastError;
    $('status').textContent = 'Đang dừng — lưu phần đã cào...';
    $('btnStart').disabled = false;
  });
};

// Trạng thái 'started' trong storage nhưng background không còn run nào
// (service worker bị Chrome tắt giữa chừng) -> gỡ kẹt để chạy lại được
function syncRunState() {
  chrome.runtime.sendMessage({ action: 'getScrapeState' }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    chrome.storage.local.get(['isPostingInProgress'], (r) => {
      if (!resp.running && r?.isPostingInProgress === 'started') {
        chrome.storage.local.set({ isPostingInProgress: 'done', postingStatus: 'Lần cào trước bị gián đoạn — có thể chạy lại.' });
      }
    });
  });
}
syncRunState();
setInterval(syncRunState, 15000);

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('btnJson').onclick = () => {
  download('fb-scrape-' + Date.now() + '.json', JSON.stringify(ScraperCore.cleanResults(lastResults), null, 2), 'application/json');
};

$('btnCsv').onclick = () => {
  const rows = ScraperCore.resultsToCsvRows(lastResults);
  const csv = '\ufeff' + rows.map(r => r.join(',')).join('\n');
  download('fb-scrape-' + Date.now() + '.csv', csv, 'text/csv;charset=utf-8');
};
