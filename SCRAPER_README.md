# Facebook Comment Scraper (v1.22.0 — SCRAPER-ONLY)

Fork tu "Facebook Groups Bulk Poster & Scheduler" v1.19.7. Tu v1.21.0 da GO BO
DANG BAI hoan toan; v1.22.0 quet sach: content script chi con ~390 dong,
KHONG con telemetry (Sentry/Mixpanel), khong remote config, khong Firebase.

## Da sua o v1.22.0
- Go 100% driver dang bai + telemetry khoi content script (truoc day chay tren
  moi trang Facebook): khong gui gi ra server thu ba, config doc tu file dong goi.
- Go Firebase SDK khoi service worker (importScripts file da xoá — neu khong
  service worker se chet).
- Do beng vong cao: time budget 4 phut/URL (khong bao gio vuot timeout 5p cua
  background), tu dung scroll som sau 3 lan lien tiep khong co bai moi.
- Quan sat: log buffer 15 dong cuoi hien trong UI, progress URL i/N + dem
  posts/comments live, moi bai hien comments da cao / FB hien thi (canh bao
  neu thieu, de tang maxCommentClicks kip thoi).
- Unit test: node --test tests/ (13 test cho parse author, dedupe key, CSV).

## Bug da sua (v1.21.0)
- "Dung yen o bai dau tien, khong cao duoc binh luan": FB mo khung comment o lop
  dialog ben NGOAI feed — scraper cu tim chi trong post nen ra 0 comment, dialog
  khong duoc dong lam feed khong scroll. Gio: lay comment tu ca post va dialog,
  dong dialog sau moi post, scroll tung buoc co fallback scroll container.

## Chuc nang
- Cao bai viet (noi dung, anh, so reaction, so comment) + TOAN BO binh luan (tac gia + noi dung)
  tu cac group/page Facebook hoac tu 1 bai viet cu the.
- Tu scroll feed de tai them bai (maxScrolls), tu click "Xem thêm bình luận" de load du comment.
- Chay SONG SONG voi trinh duyet: moi URL mo trong mot cua so nho rieng (700x600, khong
  cuop focus), tab goc cua ban van dung binh thuong.
- Giu nguyen co che PAUSE giua cac URL: dung dung ham waitBeforeNextPost cua ban goc
  (mac dinh 30 giay, random 70-150%, co the tinh chinh trong UI).
- Stop button hoat dong (dung lai ngay ca scroll va vong lap URL).
- Xuat ket qua JSON / CSV (co BOM de Excel doc tieng Viet dung).

## Da sua o v1.21.0
- Bug "dung yen o bai dau tien, khong cao duoc binh luan": FB mo khung comment o lop
  dialog ben NGOAI feed — ban cu tim chi trong post nen ra 0 comment, va dialog khong
  duoc dong lam feed khong scroll duoc. Gio: lay comment tu ca post va dialog, dong dialog
  sau moi post; scroll tung buoc co fallback scroll container; tim comment qua aria-label
  chua (khong con startsWith) de bat ca cac variant ngon ngu.
- Click icon extension -> mo thang trang scraper.html (popup.html moi).
- Cam dang bai: POST_PAYLOAD / schedulePost / runPostLogic (lich) deu bi chan trong background.

## Cach dung
1. chrome://extensions -> Load unpacked -> chon thu muc nay.
2. Click icon extension (hoac chuot phai icon -> Options) -> mo trang scraper.
3. Dan danh sach URL (moi dong 1 link group/page/bai viet).
4. Chinh: maxScrolls (so lan scroll tai them bai), thoi gian cho giua 2 URL (giay),
   maxCommentClicks (gioi han click "xem them binh luan"), chon co cao comments khong.
5. Start Scraping. Moi URL mo trong cua so nho rieng, cao xong tu dong, cho timeInSeconds,
   roi sang URL tiep theo. Trang scraper hien progress + xem truc tiep ket qua.
6. Xuat JSON hoac CSV khi chay xong.

## Luu y
- Cao du lieu ca nhan dung voi muc dich nghien cuu; khong lam dung (spam, tu dong thao tac
  qua muc cho phep cua Facebook) vi co the bi checkpoint/khoa tai khoan.
- Extension goc goi telemetry (Mixpanel/Sentry/server fbgroupbulkposter.com) — flow scraper
  KHONG goi them bat ky server nao: du lieu chi luu trong chrome.storage cua may ban.
- Selector DOM (aria-label "Comment by"/"Bình luận của", nut "N bình luận", dialog close)
  chua duoc test tren Facebook that — can chay thu 1 URL truoc khi cao hang loat.
