PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_init.sql','2026-10-14 09:15:42');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2,'0002_episode_count.sql','2026-10-15 03:03:19');
CREATE TABLE movies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  subtitle    TEXT,
  description TEXT,
  poster_key  TEXT,                          
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
, episode_count INTEGER NOT NULL DEFAULT 0);
INSERT INTO "movies" ("id","title","subtitle","description","poster_key","created_at","episode_count") VALUES(1,'Drama1','123','abc','movies/1/poster_mv7x4epk.jpeg','2026-10-14 09:39:03',1);
CREATE TABLE episodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id    INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  ep_number   INTEGER NOT NULL,
  title       TEXT NOT NULL,
  subtitle    TEXT,
  thumb_key   TEXT,                          
  video_key   TEXT NOT NULL,                 
  duration    INTEGER,                       
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (movie_id, ep_number)
);
INSERT INTO "episodes" ("id","movie_id","ep_number","title","subtitle","thumb_key","video_key","duration","created_at") VALUES(1,1,1,'Tập 1',NULL,'movies/1/ep_01_thumb_mv7x4t0c.jpg','movies/1/ep_01_mv7x4sb6.mp4',124,'2026-10-14 09:39:37');
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',2);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('movies',1);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('episodes',1);
CREATE INDEX idx_episodes_movie ON episodes (movie_id, ep_number);
CREATE INDEX idx_movies_created ON movies (created_at);
