-- Cho phép tạo tập trước khi có video (video_key được để trống).
-- Dùng khi đồng bộ từ Google Sheet: sheet có bao nhiêu tập thì tạo bấy nhiêu, video bổ sung sau.
-- SQLite không đổi được NOT NULL trực tiếp => tạo bảng mới, chép dữ liệu, đổi tên. Dữ liệu cũ giữ nguyên.
PRAGMA defer_foreign_keys = true;

CREATE TABLE episodes_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id    INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  ep_number   INTEGER NOT NULL,
  title       TEXT NOT NULL,
  subtitle    TEXT,
  thumb_key   TEXT,
  video_key   TEXT,                          -- NULL = tập đã có thông tin nhưng chưa có video
  duration    INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (movie_id, ep_number)
);

INSERT INTO episodes_new (id, movie_id, ep_number, title, subtitle, thumb_key, video_key, duration, created_at)
  SELECT id, movie_id, ep_number, title, subtitle, thumb_key, video_key, duration, created_at FROM episodes;

DROP TABLE episodes;
ALTER TABLE episodes_new RENAME TO episodes;
CREATE INDEX IF NOT EXISTS idx_episodes_movie ON episodes (movie_id, ep_number);

PRAGMA defer_foreign_keys = false;
