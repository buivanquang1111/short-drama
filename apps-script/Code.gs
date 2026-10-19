/**
 * Apps Script cho Google Sheet danh sách phim — trả dữ liệu tất cả các tab dạng JSON
 * để trang admin short-drama đọc và đồng bộ.
 *
 * Cài đặt (làm 1 lần):
 *   1. Mở Google Sheet → Tiện ích mở rộng (Extensions) → Apps Script
 *   2. Xoá code mẫu, dán toàn bộ file này vào, bấm Lưu
 *   3. (Tuỳ chọn) Đặt mã bảo vệ: Cài đặt dự án (⚙) → Thuộc tính tập lệnh → thêm SHEET_KEY = <chuỗi bí mật>
 *   4. Triển khai (Deploy) → Tùy chọn triển khai mới (New deployment) → loại: Ứng dụng web (Web app)
 *        - Thực thi với tư cách (Execute as): Tôi (Me)
 *        - Người có quyền truy cập (Who has access): Bất kỳ ai (Anyone)
 *   5. Copy URL dạng https://script.google.com/macros/s/.../exec
 *      Nếu có SHEET_KEY thì thêm ?key=<chuỗi bí mật> vào cuối URL
 *   6. Dán URL vào ô "Link Apps Script" trên trang admin
 *
 * Sửa code này sau khi đã triển khai: Deploy → Manage deployments → Edit → Version: New version.
 *
 * Mỗi tab = 1 bộ phim. Tab có tên bắt đầu bằng "_" hoặc bị ẩn sẽ bị bỏ qua (dùng làm ghi chú, mẫu...).
 * Bố cục 1 tab (xem trang admin để biết chi tiết):
 *
 *   Tên phim     | Tình Yêu Bất Tận
 *   Tiêu đề phụ  | Ngôn tình
 *   Mô tả        | ...
 *                |
 *   ep | title        | subtitle      | video (tuỳ chọn)
 *   1  | Cuộc gặp gỡ  | Tập mở đầu    | ep_01.mp4
 *   2  | Hiểu lầm     | Anh ấy là ai? |
 */
/** Menu "Short Drama" trên thanh công cụ của Sheet (hiện sau khi tải lại Sheet). */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Short Drama')
    .addItem('Thêm phim mới (tạo tab mẫu)', 'addMovieTab')
    .addItem('Thêm tập vào phim đang mở', 'addEpisodeRows')
    .addToUi();
}

/** Tạo 1 tab mới đúng mẫu: thông tin phim + bảng tập đã đánh số sẵn. */
function addMovieTab() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('Thêm phim mới', 'Tên phim:', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const title = r1.getResponseText().trim();
  if (!title) return;

  const r2 = ui.prompt('Số tập', 'Phim có bao nhiêu tập? (vd 50 — để trống nếu chưa biết)', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  const count = Math.max(0, Math.min(500, parseInt(r2.getResponseText(), 10) || 0));

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = title.slice(0, 95);
  if (ss.getSheetByName(name)) { ui.alert('Đã có tab tên "' + name + '"'); return; }

  const sh = ss.insertSheet(name, ss.getNumSheets());
  sh.getRange(1, 1, 3, 2).setValues([['Tên phim', title], ['Tiêu đề phụ', ''], ['Mô tả', '']]);
  sh.getRange('A1:A3').setFontWeight('bold');
  sh.getRange(5, 1, 1, 4).setValues([['Tập', 'Tiêu đề', 'Tiêu đề phụ', 'Video']])
    .setFontWeight('bold').setBackground('#f1f3f4');
  if (count > 0) {
    sh.getRange(6, 1, count, 1).setValues(Array.from({ length: count }, function (_, i) { return [i + 1]; }));
  }
  sh.setFrozenRows(5);
  sh.setColumnWidth(1, 70);
  sh.setColumnWidth(2, 280);
  sh.setColumnWidth(3, 280);
  sh.setColumnWidth(4, 160);
  sh.getRange('B2').activate();
}

/** Thêm N dòng tập tiếp theo vào cuối tab đang mở (đánh số nối tiếp). */
function addEpisodeRows() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const r = ui.prompt('Thêm tập', 'Thêm bao nhiêu tập vào "' + sh.getName() + '"?', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const n = Math.max(0, Math.min(500, parseInt(r.getResponseText(), 10) || 0));
  if (!n) return;
  const values = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getDisplayValues();
  let last = 0;
  values.forEach(function (row) { const v = parseInt(row[0], 10); if (!isNaN(v)) last = Math.max(last, v); });
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, n, 1).setValues(Array.from({ length: n }, function (_, i) { return [last + i + 1]; }));
  sh.getRange(start, 2).activate();
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  const secret = PropertiesService.getScriptProperties().getProperty('SHEET_KEY');
  if (secret && params.key !== secret) {
    return jsonOut({ error: 'Sai key' });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets()
    .filter(function (s) { return !s.isSheetHidden() && s.getName().charAt(0) !== '_'; })
    .filter(function (s) { return !params.sheet || s.getName() === params.sheet; })
    .map(function (s) {
      return {
        sheet: s.getName(),
        gid: s.getSheetId(),
        values: s.getDataRange().getDisplayValues(),   // giữ đúng chữ hiển thị (số tập, tiếng Việt...)
      };
    });

  return jsonOut({ spreadsheet: ss.getName(), updatedAt: new Date().toISOString(), sheets: sheets });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
