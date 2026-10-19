-- Phim: thêm danh sách tag (lưu dạng JSON mảng chuỗi, vd ["Ngôn tình","Tổng tài"]),
-- bỏ cột tiêu đề phụ. Dữ liệu khác của phim và các tập giữ nguyên.
ALTER TABLE movies ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE movies DROP COLUMN subtitle;
