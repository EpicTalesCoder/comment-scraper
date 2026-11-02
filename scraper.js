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
  lastResults = results || [];
  const totalPosts = lastResults.reduce((a, r) => a + (r.posts?.length || 0), 0);
  const totalComments = lastResults.reduce((a, r) => a + (r.posts || []).reduce((b, p) => b + (p.comments?.length || 0), 0), 0);
  let html = `<div class="summary"><b>${lastResults.length}</b> URL(s) • <b>${totalPosts}</b> bài viết • <b>${totalComments}</b> bình luận</div>`;
  for (const r of lastResults) {
    html += `<div style="font-weight:600;margin-top:8px;color:#050505">${esc(r.url)} ${r.error ? '<span style="color:#fa383e">— lỗi: ' + esc(r.error) + '</span>' : ''}</div>`;
    for (const p of (r.posts || [])) {
      html += `<div class="post-item">`;
      if (p.postUrl) html += `<div class="post-url"><a href="${esc(p.postUrl)}" target="_blank">${esc(p.postUrl)}</a></div>`;
      html += `<div class="post-content">${esc((p.content || '').slice(0, 500))}</div>`;
      html += `<div class="post-meta">💬 ${p.numComments ?? (p.comments?.length || 0)} comments • 👍 ${p.numReactions ?? '?'} • 🖼 ${p.images?.length || 0} ảnh</div>`;
      for (const c of (p.comments || [])) {
        html += `<div class="comment"><b>${esc(c.author)}</b> <span>${esc((c.text || '').slice(0, 300))}</span></div>`;
      }
      html += `</div>`;
    }
  }
  $('results').innerHTML = html || '<div style="color:#65676b">Chưa có kết quả.</div>';
  $('btnJson').disabled = totalPosts === 0;
  $('btnCsv').disabled = totalPosts === 0;
}

function pollStatus() {
  chrome.storage.local.get(['postingStatus', 'scrapeResults', 'scraperProgress', 'isPostingInProgress'], (r) => {
    if (r?.postingStatus) $('status').textContent = r.postingStatus;
    const prog = r?.scraperProgress;
    if (prog && prog.maxScrolls > 0) {
      $('progressBar').style.width = Math.min(100, (prog.scroll / prog.maxScrolls) * 100) + '%';
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
    maxCommentClicks: parseInt($('maxCommentClicks').value, 10) || 30,
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
    $('status').textContent = 'Đã yêu cầu dừng...';
  });
};

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('btnJson').onclick = () => {
  download('fb-scrape-' + Date.now() + '.json', JSON.stringify(lastResults, null, 2), 'application/json');
};

$('btnCsv').onclick = () => {
  const rows = [['post_url', 'post_content', 'num_comments', 'num_reactions', 'comment_author', 'comment_text']];
  for (const r of lastResults) {
    for (const p of (r.posts || [])) {
      const pc = (p.content || '').replace(/"/g, '""').replace(/\n/g, ' ');
      if (p.comments?.length) {
        for (const c of p.comments) {
          rows.push([p.postUrl || '', `"${pc}"`, p.numComments ?? p.comments.length, p.numReactions ?? '', c.author || '', `"${(c.text || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`]);
        }
      } else {
        rows.push([p.postUrl || '', `"${pc}"`, 0, p.numReactions ?? '', '', '']);
      }
    }
  }
  const csv = '\ufeff' + rows.map(r => r.join(',')).join('\n');
  download('fb-scrape-' + Date.now() + '.csv', csv, 'text/csv;charset=utf-8');
};
