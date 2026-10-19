-- Tập phim chỉ còn số tập + video: bỏ cột tiêu đề và tiêu đề phụ của tập.
-- Bảng movies (tên phim, tiêu đề phụ, mô tả, poster) giữ nguyên.
ALTER TABLE episodes DROP COLUMN title;
ALTER TABLE episodes DROP COLUMN subtitle;
