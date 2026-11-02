# Facebook Comment Scraper (v1.20.0)

Fork tu "Facebook Groups Bulk Poster & Scheduler" v1.19.7 — giu nguyen toan bo co che
posting (pause/smart delays giua cac URL, tab retry, stop button), them che do CAO DU LIEU.

## Chuc nong moi
- Cao bai viet (noi dung, anh, so reaction, so comment) + TOAN BO binh luan (tac gia + noi dung)
  tu cac group/page Facebook hoac tu 1 bai viet cu the.
- Tu scroll feed de tai them bai (maxScrolls), tu click "Xem thêm bình luận" de load du comment.
- Giu nguyen co che PAUSE giua cac URL: dung dung ham waitBeforeNextPost cua ban goc
  (mac dinh 30 giay, random 70-150%, co the tinh chinh trong UI).
- Stop button hoat dong (dung lai ngay ca scroll va vong lap URL).
- Xuat ket qua JSON / CSV (co BOM de Excel doc tieng Viet dung).

## Cach dung
1. chrome://extensions -> Load unpacked -> chon thu muc nay.
2. Mo extension -> chuot phai icon -> Options (hoac mo truc tiep scraper.html).
   Link nhanh: chrome-extension://<EXTENSION_ID>/scraper.html
3. Dan danh sach URL (moi dong 1 link group/page/bai viet).
4. Chinh: maxScrolls (so lan scroll tai them bai), thoi gian cho giua 2 URL (giay),
   maxCommentClicks (gioi han click "xem them binh luan"), chon co cao comments khong.
5. Start Scraping. Extension se tu mo tab moi cho tung URL, cao, dong tab, cho `timeInSeconds`,
   roi sang URL tiep theo. Trang scraper hien progress + xem truc tiep ket qua.
6. Xuat JSON hoac CSV khi chay xong.

## Code them moi
- content.js: __scraper* (scrape feed, expand See more, mo comments, extract) + handler
  contentScrapePosts / stopScrapePosts.
- background.js: initiateScrapePostsAction (vong lap URL giong posting loop) + routes
  startScrapePosts / stopScrapePosts / openScrapeUI.
- scraper.html + scraper.js: trang UI cai dat & xem ket qua.
- manifest.json: them options_page/options_ui, version 1.20.0, xoa _metadata (CRX-only).

## Luu y
- Cao du lieu ca nhan dung voi muc dich nghien cuu; khong lam dung (spam, tu dong thao tac
  qua muc cho phep cua Facebook) vi co the bi checkpoint/khoa tai khoan.
- Extension goc goi telemetry (Mixpanel/Sentry/server fbgroupbulkposter.com) — flow scraper
  KHONG goi them bat ky server nao: du lieu chi luu trong chrome.storage cua may ban.
- Login cua extension goc da duoc mo khoa "unlimited_access_mode" san trong ban nay
  (checkCredits/checkPremium luon tra isPremium=true), khong can tai khoan.
