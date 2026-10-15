-- Lưu sẵn số tập trong bảng movies để API danh sách / search không phải đếm lại
-- (đếm mỗi lần gọi sẽ đọc toàn bộ dòng episodes của các phim, tốn rows read của D1)
ALTER TABLE movies ADD COLUMN episode_count INTEGER NOT NULL DEFAULT 0;

-- Điền giá trị cho dữ liệu đã có
UPDATE movies SET episode_count = (SELECT COUNT(*) FROM episodes e WHERE e.movie_id = movies.id);
