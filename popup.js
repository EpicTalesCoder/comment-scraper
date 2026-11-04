// Popup chỉ có 1 nhiệm vụ: mở trang Comment Scraper (scraper.html) trong tab mới.
// Bản v1.21.0 đã GỠ đăng bài — không còn UI đăng bài nữa.
chrome.runtime.sendMessage({ action: 'openScrapeUI' }, () => {
  void chrome.runtime.lastError;
  setTimeout(() => window.close(), 250);
});
