/**
 * short-drama — Cloudflare Worker
 *
 * Public (app gọi):
 *   GET  /api/movies?page=1&limit=20     danh sách phim (kèm số tập)
 *   GET  /api/movies/index               toàn bộ phim, chỉ trường gọn (để app tải 1 lần rồi search trên máy), cache 5 phút
 *   GET  /api/search?q=ten+phim          tìm phim theo tên / tiêu đề phụ (không phân biệt dấu, hoa thường), cache 60 giây
 *   GET  /api/movies/:id                 chi tiết phim + danh sách tập
 *   GET  /api/episodes/:id               chi tiết 1 tập
 *
 * Admin (header Authorization: Bearer <ADMIN_TOKEN>):
 *   GET    /api/admin/ping                         kiểm tra token
 *   POST   /api/admin/movies                       tạo phim (multipart: title, subtitle, description, poster)
 *   PATCH  /api/admin/movies/:id                   sửa phim (multipart, field nào gửi thì sửa field đó)
 *   DELETE /api/admin/movies/:id                   xoá phim + toàn bộ tập + file trên R2
 *   POST   /api/admin/movies/:id/episodes          thêm tập (multipart: ep_number, title, subtitle, duration, video, thumb)
 *   PUT    /api/admin/movies/:id/episodes/:ep      tạo hoặc cập nhật tập số :ep (video không bắt buộc) — dùng khi đồng bộ từ Google Sheet
 *   GET    /api/admin/sheet?url=<Apps Script URL>  đọc dữ liệu Google Sheet qua Apps Script (tránh lỗi CORS)
 *   PATCH  /api/admin/episodes/:id                 sửa tập
 *   DELETE /api/admin/episodes/:id                 xoá tập + file trên R2
 *
 * Media (dùng khi chưa gắn custom domain cho R2):
 *   GET/HEAD /media/<key>                          phát file từ R2, hỗ trợ Range (tua video)
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,range",
  "access-control-expose-headers": "content-length,content-range,accept-ranges,etag",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      const res = await route(request, env, ctx);
      return withCors(res);
    } catch (err) {
      if (err instanceof HttpError) {
        return withCors(json({ error: err.message }, err.status));
      }
      console.error(err);
      return withCors(json({ error: "Internal error" }, 500));
    }
  },
};

// ---------------------------------------------------------------- router

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  let m;

  // Media
  if (path.startsWith("/media/") && (method === "GET" || method === "HEAD")) {
    return serveMedia(request, env, decodeURIComponent(path.slice("/media/".length)));
  }

  // Public API
  if (method === "GET" && path === "/api/movies") return listMovies(url, env);
  // Admin (có ADMIN_TOKEN) luôn đọc dữ liệu mới, không qua cache — tránh tạo trùng phim khi đồng bộ
  const fresh = await hasAdminToken(request, env);
  if (method === "GET" && path === "/api/movies/index") return fresh ? movieIndex(url, env) : cached(url, ctx, 300, () => movieIndex(url, env));
  if (method === "GET" && path === "/api/search") return fresh ? searchMovies(url, env) : cached(url, ctx, 60, () => searchMovies(url, env));
  if (method === "GET" && (m = path.match(/^\/api\/movies\/(\d+)$/))) return getMovie(Number(m[1]), url, env);
  if (method === "GET" && (m = path.match(/^\/api\/episodes\/(\d+)$/))) return getEpisode(Number(m[1]), url, env);

  // Admin API
  if (path.startsWith("/api/admin/")) {
    await requireAdmin(request, env);
    if (method === "GET" && path === "/api/admin/ping") return json({ ok: true });
    if (method === "POST" && path === "/api/admin/movies") return createMovie(request, url, env);
    if ((m = path.match(/^\/api\/admin\/movies\/(\d+)$/))) {
      if (method === "PATCH") return updateMovie(Number(m[1]), request, url, env);
      if (method === "DELETE") return deleteMovie(Number(m[1]), env);
    }
    if (method === "POST" && (m = path.match(/^\/api\/admin\/movies\/(\d+)\/episodes$/))) {
      return createEpisode(Number(m[1]), request, url, env);
    }
    if (method === "PUT" && (m = path.match(/^\/api\/admin\/movies\/(\d+)\/episodes\/(\d+)$/))) {
      return upsertEpisode(Number(m[1]), Number(m[2]), request, url, env);
    }
    if (method === "GET" && path === "/api/admin/sheet") return proxySheet(url, env);
    if ((m = path.match(/^\/api\/admin\/episodes\/(\d+)$/))) {
      if (method === "PATCH") return updateEpisode(Number(m[1]), request, url, env);
      if (method === "DELETE") return deleteEpisode(Number(m[1]), env);
    }
  }

  if (path === "/" ) return json({ name: "short-drama", admin: "/admin/" });
  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------- public

async function listMovies(url, env) {
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 20);
  const page = clampInt(url.searchParams.get("page"), 1, 100000, 1);
  const offset = (page - 1) * limit;

  const [{ results }, totalRow] = await Promise.all([
    env.DB.prepare("SELECT * FROM movies ORDER BY id DESC LIMIT ?1 OFFSET ?2").bind(limit, offset).all(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM movies").first(),
  ]);

  const base = mediaBase(url, env);
  return json({
    page,
    limit,
    total: totalRow.total,
    movies: results.map((r) => movieDto(r, base)),
  });
}

async function getMovie(id, url, env) {
  const movie = await env.DB.prepare("SELECT * FROM movies WHERE id = ?1").bind(id).first();
  if (!movie) throw new HttpError(404, "Movie not found");
  const { results } = await env.DB.prepare(
    "SELECT * FROM episodes WHERE movie_id = ?1 ORDER BY ep_number ASC"
  ).bind(id).all();

  const base = mediaBase(url, env);
  return json({
    movie: { ...movieDto(movie, base), episode_count: results.length },
    episodes: results.map((e) => episodeDto(e, base)),
  });
}

/** Toàn bộ phim, chỉ trường cần cho danh sách + search trên máy. Đọc đúng số dòng = số phim. */
async function movieIndex(url, env) {
  const { results } = await env.DB.prepare(
    "SELECT id, title, subtitle, poster_key, episode_count FROM movies ORDER BY id DESC"
  ).all();
  const base = mediaBase(url, env);
  return json({
    total: results.length,
    movies: results.map((r) => ({
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      poster: keyToUrl(r.poster_key, base),
      episode_count: r.episode_count,
    })),
  });
}

/**
 * Tìm phim theo tên/tiêu đề phụ. Không phân biệt dấu và hoa thường:
 * "tinh yeu" khớp "Tình Yêu". Mọi từ trong q đều phải xuất hiện.
 * Số phim nhỏ (vài trăm) nên lọc trong Worker; D1 chỉ đọc 1 dòng / phim.
 */
async function searchMovies(url, env) {
  const q = normalizeText(url.searchParams.get("q"));
  const limit = clampInt(url.searchParams.get("limit"), 1, 50, 20);
  if (q.length < 1) return json({ q: "", total: 0, movies: [] });
  const words = q.split(" ");

  const { results } = await env.DB.prepare(
    "SELECT id, title, subtitle, description, poster_key, episode_count, created_at FROM movies"
  ).all();

  const scored = [];
  for (const r of results) {
    const t = normalizeText(r.title);
    const hay = `${t} ${normalizeText(r.subtitle)}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const score = t === q ? 0 : t.startsWith(q) ? 1 : t.includes(q) ? 2 : 3;
    scored.push({ r, score });
  }
  scored.sort((a, b) => a.score - b.score || b.r.id - a.r.id);

  const base = mediaBase(url, env);
  return json({
    q: url.searchParams.get("q"),
    total: scored.length,
    movies: scored.slice(0, limit).map(({ r }) => movieDto(r, base)),
  });
}

/** Bỏ dấu tiếng Việt, về chữ thường, gộp khoảng trắng. */
function normalizeText(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Cache response ở edge (Cache API). Chỉ có tác dụng khi Worker chạy trên custom domain
 * (vd api.tenmien.com); trên *.workers.dev cache bị bỏ qua nhưng API vẫn chạy bình thường.
 * Header cache-control giúp HTTP client của app (OkHttp, Dio...) cũng cache được.
 */
async function cached(url, ctx, ttl, build) {
  const key = new Request(url.toString(), { method: "GET" });
  let cache = null;
  try { cache = caches.default; } catch {}
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) return hit;
  }
  const res = await build();
  res.headers.set("cache-control", `public, max-age=${ttl}`);
  if (cache && res.status === 200) ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

/** Cập nhật lại số tập của phim sau khi thêm/xoá tập. */
async function refreshEpisodeCount(env, movieId) {
  await env.DB.prepare(
    "UPDATE movies SET episode_count = (SELECT COUNT(*) FROM episodes WHERE movie_id = ?1) WHERE id = ?1"
  ).bind(movieId).run();
}

async function getEpisode(id, url, env) {
  const ep = await env.DB.prepare("SELECT * FROM episodes WHERE id = ?1").bind(id).first();
  if (!ep) throw new HttpError(404, "Episode not found");
  return json({ episode: episodeDto(ep, mediaBase(url, env)) });
}

// ---------------------------------------------------------------- admin: movies

async function createMovie(request, url, env) {
  const form = await request.formData();
  const title = str(form.get("title"));
  if (!title) throw new HttpError(400, "title is required");

  const row = await env.DB.prepare(
    "INSERT INTO movies (title, subtitle, description) VALUES (?1, ?2, ?3) RETURNING *"
  ).bind(title, str(form.get("subtitle")), str(form.get("description"))).first();

  const poster = fileOrNull(form.get("poster"));
  if (poster) {
    const key = await putFile(env, `movies/${row.id}/poster`, poster);
    await env.DB.prepare("UPDATE movies SET poster_key = ?1 WHERE id = ?2").bind(key, row.id).run();
    row.poster_key = key;
  }
  return json({ movie: movieDto(row, mediaBase(url, env)) }, 201);
}

async function updateMovie(id, request, url, env) {
  const movie = await env.DB.prepare("SELECT * FROM movies WHERE id = ?1").bind(id).first();
  if (!movie) throw new HttpError(404, "Movie not found");
  const form = await request.formData();

  const next = {
    title: form.has("title") ? str(form.get("title")) : movie.title,
    subtitle: form.has("subtitle") ? str(form.get("subtitle")) : movie.subtitle,
    description: form.has("description") ? str(form.get("description")) : movie.description,
    poster_key: movie.poster_key,
  };
  if (!next.title) throw new HttpError(400, "title cannot be empty");

  const poster = fileOrNull(form.get("poster"));
  if (poster) next.poster_key = await putFile(env, `movies/${id}/poster`, poster);

  const row = await env.DB.prepare(
    "UPDATE movies SET title=?1, subtitle=?2, description=?3, poster_key=?4 WHERE id=?5 RETURNING *"
  ).bind(next.title, next.subtitle, next.description, next.poster_key, id).first();

  if (poster && movie.poster_key) await env.BUCKET.delete(movie.poster_key);
  return json({ movie: movieDto(row, mediaBase(url, env)) });
}

async function deleteMovie(id, env) {
  const movie = await env.DB.prepare("SELECT * FROM movies WHERE id = ?1").bind(id).first();
  if (!movie) throw new HttpError(404, "Movie not found");
  const { results } = await env.DB.prepare(
    "SELECT video_key, thumb_key FROM episodes WHERE movie_id = ?1"
  ).bind(id).all();

  const keys = [movie.poster_key];
  for (const e of results) keys.push(e.video_key, e.thumb_key);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM episodes WHERE movie_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM movies WHERE id = ?1").bind(id),
  ]);
  await deleteKeys(env, keys);
  return json({ deleted: true, episodes_deleted: results.length });
}

// ---------------------------------------------------------------- admin: episodes

async function createEpisode(movieId, request, url, env) {
  const movie = await env.DB.prepare("SELECT id FROM movies WHERE id = ?1").bind(movieId).first();
  if (!movie) throw new HttpError(404, "Movie not found");

  const form = await request.formData();
  const epNumber = intOrNull(form.get("ep_number"));
  if (!epNumber || epNumber < 1) throw new HttpError(400, "ep_number is required (>= 1)");
  const video = fileOrNull(form.get("video"));
  if (!video) throw new HttpError(400, "video file is required");

  const exists = await env.DB.prepare(
    "SELECT id, video_key FROM episodes WHERE movie_id = ?1 AND ep_number = ?2"
  ).bind(movieId, epNumber).first();
  if (exists && exists.video_key) throw new HttpError(409, `Episode ${epNumber} already exists (id ${exists.id}), use PATCH to replace`);
  if (exists) return saveEpisode(movieId, epNumber, form, url, env);   // tập đã tạo từ Sheet nhưng chưa có video => điền video

  const ep2 = String(epNumber).padStart(2, "0");
  const videoKey = await putFile(env, `movies/${movieId}/ep_${ep2}`, video);
  const thumb = fileOrNull(form.get("thumb"));
  const thumbKey = thumb ? await putFile(env, `movies/${movieId}/ep_${ep2}_thumb`, thumb) : null;

  const title = str(form.get("title")) || `Tập ${epNumber}`;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO episodes (movie_id, ep_number, title, subtitle, thumb_key, video_key, duration)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING *`
    ).bind(movieId, epNumber, title, str(form.get("subtitle")), thumbKey, videoKey, intOrNull(form.get("duration"))).first();
    await refreshEpisodeCount(env, movieId);
    return json({ episode: episodeDto(row, mediaBase(url, env)) }, 201);
  } catch (err) {
    // Ghi DB lỗi thì dọn file vừa upload để không rác R2
    await deleteKeys(env, [videoKey, thumbKey]);
    throw err;
  }
}

/** PUT: tạo hoặc cập nhật tập theo (phim, số tập). Field nào gửi lên thì cập nhật field đó. */
async function upsertEpisode(movieId, epNumber, request, url, env) {
  if (epNumber < 1) throw new HttpError(400, "ep_number must be >= 1");
  const movie = await env.DB.prepare("SELECT id FROM movies WHERE id = ?1").bind(movieId).first();
  if (!movie) throw new HttpError(404, "Movie not found");
  return saveEpisode(movieId, epNumber, await request.formData(), url, env);
}

async function saveEpisode(movieId, epNumber, form, url, env) {
  const old = await env.DB.prepare(
    "SELECT * FROM episodes WHERE movie_id = ?1 AND ep_number = ?2"
  ).bind(movieId, epNumber).first();

  const ep2 = String(epNumber).padStart(2, "0");
  const video = fileOrNull(form.get("video"));
  const thumb = fileOrNull(form.get("thumb"));
  const newVideoKey = video ? await putFile(env, `movies/${movieId}/ep_${ep2}`, video) : null;
  const newThumbKey = thumb ? await putFile(env, `movies/${movieId}/ep_${ep2}_thumb`, thumb) : null;

  const pick = (field, parse, fallback) => (form.has(field) ? parse(form.get(field)) : fallback);
  const title = pick("title", str, old?.title) || `Tập ${epNumber}`;
  const subtitle = pick("subtitle", str, old?.subtitle ?? null);
  const duration = pick("duration", intOrNull, old?.duration ?? null);
  const videoKey = newVideoKey || old?.video_key || null;
  const thumbKey = newThumbKey || old?.thumb_key || null;

  let row;
  try {
    if (old) {
      row = await env.DB.prepare(
        "UPDATE episodes SET title=?1, subtitle=?2, duration=?3, video_key=?4, thumb_key=?5 WHERE id=?6 RETURNING *"
      ).bind(title, subtitle, duration, videoKey, thumbKey, old.id).first();
    } else {
      row = await env.DB.prepare(
        `INSERT INTO episodes (movie_id, ep_number, title, subtitle, thumb_key, video_key, duration)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING *`
      ).bind(movieId, epNumber, title, subtitle, thumbKey, videoKey, duration).first();
      await refreshEpisodeCount(env, movieId);
    }
  } catch (err) {
    await deleteKeys(env, [newVideoKey, newThumbKey]);
    throw err;
  }
  // xoá file cũ đã bị thay
  await deleteKeys(env, [newVideoKey && old?.video_key, newThumbKey && old?.thumb_key]);
  return json({ episode: episodeDto(row, mediaBase(url, env)), created: !old }, old ? 200 : 201);
}

/** Đọc JSON từ Apps Script web app (script.google.com) phía server, tránh lỗi CORS trên trình duyệt. */
async function proxySheet(url, env) {
  const target = url.searchParams.get("url") || env.SHEET_URL || "";
  let u;
  try { u = new URL(target); } catch { throw new HttpError(400, "Thiếu hoặc sai link Apps Script"); }
  if (u.protocol !== "https:" || !/^script\.google(usercontent)?\.com$/.test(u.hostname)) {
    throw new HttpError(400, "Chỉ chấp nhận link Apps Script dạng https://script.google.com/macros/s/.../exec");
  }
  const res = await fetch(u.toString(), { redirect: "follow" });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new HttpError(502, "Apps Script không trả JSON. Kiểm tra lại quyền truy cập (Anyone) và link /exec");
  }
  if (!res.ok || data.error) throw new HttpError(502, data.error || `Apps Script HTTP ${res.status}`);
  return json(data);
}

async function updateEpisode(id, request, url, env) {
  const ep = await env.DB.prepare("SELECT * FROM episodes WHERE id = ?1").bind(id).first();
  if (!ep) throw new HttpError(404, "Episode not found");
  const form = await request.formData();
  const ep2 = String(ep.ep_number).padStart(2, "0");

  const next = {
    ep_number: ep.ep_number,
    title: form.has("title") ? str(form.get("title")) : ep.title,
    subtitle: form.has("subtitle") ? str(form.get("subtitle")) : ep.subtitle,
    duration: form.has("duration") ? intOrNull(form.get("duration")) : ep.duration,
    video_key: ep.video_key,
    thumb_key: ep.thumb_key,
  };

  // Đổi số tập (nếu gửi lên)
  if (form.has("ep_number")) {
    const n = intOrNull(form.get("ep_number"));
    if (!n || n < 1) throw new HttpError(400, "ep_number must be >= 1");
    if (n !== ep.ep_number) {
      const clash = await env.DB.prepare(
        "SELECT id FROM episodes WHERE movie_id = ?1 AND ep_number = ?2"
      ).bind(ep.movie_id, n).first();
      if (clash) throw new HttpError(409, `Episode ${n} already exists (id ${clash.id})`);
      next.ep_number = n;
    }
  }
  if (!next.title) next.title = `Tập ${next.ep_number}`;

  const oldKeys = [];
  const video = fileOrNull(form.get("video"));
  if (video) {
    next.video_key = await putFile(env, `movies/${ep.movie_id}/ep_${ep2}`, video);
    oldKeys.push(ep.video_key);
  }
  const thumb = fileOrNull(form.get("thumb"));
  if (thumb) {
    next.thumb_key = await putFile(env, `movies/${ep.movie_id}/ep_${ep2}_thumb`, thumb);
    oldKeys.push(ep.thumb_key);
  }

  const row = await env.DB.prepare(
    "UPDATE episodes SET ep_number=?1, title=?2, subtitle=?3, duration=?4, video_key=?5, thumb_key=?6 WHERE id=?7 RETURNING *"
  ).bind(next.ep_number, next.title, next.subtitle, next.duration, next.video_key, next.thumb_key, id).first();

  await deleteKeys(env, oldKeys);
  return json({ episode: episodeDto(row, mediaBase(url, env)) });
}

async function deleteEpisode(id, env) {
  const ep = await env.DB.prepare("SELECT * FROM episodes WHERE id = ?1").bind(id).first();
  if (!ep) throw new HttpError(404, "Episode not found");
  await env.DB.prepare("DELETE FROM episodes WHERE id = ?1").bind(id).run();
  await refreshEpisodeCount(env, ep.movie_id);
  await deleteKeys(env, [ep.video_key, ep.thumb_key]);
  return json({ deleted: true });
}

// ---------------------------------------------------------------- media (Range support)

async function serveMedia(request, env, key) {
  if (!key || key.includes("..")) throw new HttpError(400, "Bad key");

  const obj = await env.BUCKET.get(key, {
    range: request.headers,
    onlyIf: request.headers,
  });
  if (obj === null) throw new HttpError(404, "File not found");

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=31536000, immutable");

  // onlyIf không thoả (vd If-None-Match khớp) => object không có body
  if (!("body" in obj)) return new Response(null, { status: 304, headers });

  const isHead = request.method === "HEAD";
  const range = obj.range;
  if (range && request.headers.has("range")) {
    let start, end;
    if (typeof range.suffix === "number") {
      start = Math.max(obj.size - range.suffix, 0);
      end = obj.size - 1;
    } else {
      start = range.offset ?? 0;
      end = range.length !== undefined ? start + range.length - 1 : obj.size - 1;
    }
    headers.set("content-range", `bytes ${start}-${end}/${obj.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(isHead ? null : obj.body, { status: 206, headers });
  }

  headers.set("content-length", String(obj.size));
  return new Response(isHead ? null : obj.body, { status: 200, headers });
}

// ---------------------------------------------------------------- helpers

function movieDto(r, base) {
  return {
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    description: r.description,
    poster: keyToUrl(r.poster_key, base),
    episode_count: r.episode_count ?? undefined,
    created_at: r.created_at,
  };
}

function episodeDto(e, base) {
  return {
    id: e.id,
    movie_id: e.movie_id,
    ep_number: e.ep_number,
    title: e.title,
    subtitle: e.subtitle,
    thumb: keyToUrl(e.thumb_key, base),
    video_url: keyToUrl(e.video_key, base),
    duration: e.duration,
    created_at: e.created_at,
  };
}

function mediaBase(url, env) {
  let configured = (env.MEDIA_BASE_URL || "").trim().replace(/\/+$/, "");
  // "cdn.tenmien.com" (thiếu scheme) => "https://cdn.tenmien.com"
  if (configured && !/^https?:\/\//i.test(configured)) configured = `https://${configured.replace(/^\/+/, "")}`;
  return configured ? `${configured}/` : `${url.origin}/media/`;
}

function keyToUrl(key, base) {
  if (!key) return null;
  return base + key.split("/").map(encodeURIComponent).join("/");
}

/** Upload file lên R2 với key có hậu tố thời gian (để CDN không trả bản cũ khi thay file). */
async function putFile(env, keyPrefix, file) {
  const ext = extOf(file.name, file.type);
  const key = `${keyPrefix}_${Date.now().toString(36)}${ext}`;
  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: {
      // Trình duyệt/curl đôi khi gửi application/octet-stream => đoán theo đuôi file
      // để player nhận đúng video/mp4
      contentType:
        file.type && file.type !== "application/octet-stream" ? file.type : guessType(ext),
      cacheControl: "public, max-age=31536000, immutable",
    },
  });
  return key;
}

async function deleteKeys(env, keys) {
  const list = keys.filter(Boolean);
  if (list.length) await env.BUCKET.delete(list);
}

function extOf(name, type) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || "");
  if (m) return "." + m[1].toLowerCase();
  const map = { "video/mp4": ".mp4", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
  return map[type] || "";
}

function guessType(ext) {
  return (
    { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[ext] ||
    "application/octet-stream"
  );
}

async function hasAdminToken(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!env.ADMIN_TOKEN || !auth.startsWith("Bearer ")) return false;
  const enc = new TextEncoder();
  const a = enc.encode(auth.slice(7)), b = enc.encode(env.ADMIN_TOKEN);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

async function requireAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) throw new HttpError(500, "ADMIN_TOKEN is not configured");
  const auth = request.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(expected);
  const ok = a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
  if (!ok) throw new HttpError(401, "Unauthorized");
}

function fileOrNull(v) {
  return v && typeof v === "object" && typeof v.stream === "function" && v.size > 0 ? v : null;
}

function str(v) {
  if (v === null || v === undefined || typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

function intOrNull(v) {
  const s = str(v);
  if (s === null) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function withCors(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
