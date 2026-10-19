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
