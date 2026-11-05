# Facebook Comment Scraper (v1.26.0)

## Moi o v1.26.0 — tach han khoi extension goc
- Trinh duyet bao "Tien ich nay co chua phan mem doc hai" vi manifest giu `key` cua
  extension goc "Facebook Groups Bulk Poster" -> cung ID `lnjjcckgbpppdjcijhakcbnkggbdhccj`,
  ID nay nam trong blocklist malware cua Google.
- Cac ban truoc ghi "da go telemetry" nhung background.js THUC TE van con: Mixpanel,
  `server.fbgroupbulkposter.com/telemetry`, upload snapshot (`/api/snapshots`), gui HTML
  trang len `/dom-analyze`, doc/xoa cookie, Firebase/Firestore, credits.
- Da sua: viet lai background.js chi con luong cao (~425 dong, khong fetch ra ngoai).
  Manifest moi: bo `key`, `update_url`, `oauth2`, `externally_connectable`, quyen
  `cookies`/`system.display`; host permission chi con facebook.com. Doi ten + icon moi,
  xoa `_locales` va popup cua ban goc.
- Sau khi cai lai, extension co ID MOI -> phai "Remove" ban cu roi "Load unpacked" lai.


## Moi o v1.25.0
- Sua "khong cao duoc comment": nhan dien nhan moi cua FB ("Bình luận dưới tên X",
  "Phản hồi dưới tên X", "Comment by X 2 hours ago") + fallback theo cau truc
  ([role=article] co link comment_id). Text comment lay tu div[dir=auto] cua chinh
  comment (khong dinh reply / "Thích · Phản hồi · 2 giờ").
- Tai het comment + reply: bam moi nut "Xem thêm bình luận", "Xem tất cả N phản hồi",
  "N phản hồi", "View all N replies"... + cuon xuong day de FB lazy-load; thu thap dan.
- Sua "chi cao duoc 1 bai":
  * Cua so cao bi che -> Chrome ngung render -> FB khong tai them bai. Mac dinh cua so
    cao duoc dua len tren (tuy chon "Cửa sổ cào"). Dung che/thu nho cua so do.
  * Link bai trong feed la href="#" cho den khi hover -> gia lap hover de lay permalink.
  * Nhan dien bai: [role=feed] > div, fallback div[aria-posinset], FeedUnit.
- Dan link bai viet don le -> bo qua phase 1, cao thang comment cua bai.
- Moi comment co them: commentId, isReply; link comment da bo tham so tracking.
- Tuy chon moi: thoi gian toi da / bai (mac dinh 240s); click mo comment toi da 150.
- Test: `node --test tests/scraper-core.test.js` (22 test).


Fork tu "Facebook Groups Bulk Poster & Scheduler" v1.19.7. Tu v1.21.0 da GO BO
DANG BAI hoan toan; khong con telemetry (Sentry/Mixpanel), khong remote config,
khong Firebase.

## Moi o v1.24.0
- MO TUNG BAI VIET THAT (2 phase):
  Phase 1 — scroll feed chi de thu DANH SACH bai + permalink.
  Phase 2 — background tu navigate tab vao tung bai viet (link /posts/,
  /permalink/, /photo/...), cho trang load, quét comment, roi sang bai ke.
- MOI BAI deu chon filter "All comments"/"Tat ca binh luan" truoc khi quet
  (ho tro UI tieng Anh uu tien: Most relevant/Newest -> All comments).
- Bấm hết "View more comments"/"more replies" trong bài (maxCommentClicks).
- UI hien tien do tung bai: "URL i/N • bài j/M • x bài • y bình luận".
- Xuat CSV 2 cot: `cmt_col` (noi dung comment) + `link_cmt` (permalink comment
  neu co, fallback ve link bai viet). Co BOM de Excel doc tieng Viet dung.
- Link /photo/ giu nguyen query (fbid=) de mo dung bai.

## Moi o v1.23.0
- MO TUNG BAI VIET RA khi quet: voi moi bai trong feed, scraper tu bam nut
  "N binh luan" mo khung comment cua bai (chinh la view cua bai viet), khong con
  chi doc tap hop comment inline tren feed nua.
- TU CHON FILTER "All comments" / "Tat ca binh luan": FB mac dinh hien
  "Most relevant"/"Phu hop nhat" -> thieu comment. Scraper mo dropdown filter va
  chon "All comments" TRUOC khi quet (ho tro ca tieng Anh + tieng Viet).
- Xuat CSV 2 cot dung nhu yeu cau: `cmt_col` (noi dung comment) va `link_cmt`
  (link permalink cua comment neu FB co, fallback ve link bai viet). Co BOM
  de Excel doc tieng Viet dung.

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
- Tu v1.26.0 extension khong goi bat ky server nao: du lieu chi luu trong
  chrome.storage cua may ban (kiem tra: grep "fetch(" chi con doc file config noi bo).
- Selector DOM (aria-label "Comment by"/"Bình luận của", nut "N bình luận", dialog close)
  chua duoc test tren Facebook that — can chay thu 1 URL truoc khi cao hang loat.
