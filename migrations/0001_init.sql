-- Bảng phim
CREATE TABLE IF NOT EXISTS movies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  subtitle    TEXT,
  description TEXT,
  poster_key  TEXT,                          -- key file poster trong R2
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bảng tập phim
CREATE TABLE IF NOT EXISTS episodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id    INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  ep_number   INTEGER NOT NULL,
  title       TEXT NOT NULL,
  subtitle    TEXT,
  thumb_key   TEXT,                          -- key ảnh thumb trong R2
  video_key   TEXT NOT NULL,                 -- key file video trong R2
  duration    INTEGER,                       -- giây (tuỳ chọn)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (movie_id, ep_number)
);

-- Index để lấy danh sách tập theo phim chỉ đọc đúng số dòng cần
CREATE INDEX IF NOT EXISTS idx_episodes_movie ON episodes (movie_id, ep_number);
CREATE INDEX IF NOT EXISTS idx_movies_created ON movies (created_at);
