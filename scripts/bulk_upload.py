#!/usr/bin/env python3
"""
Upload hàng loạt phim lên short-drama từ dòng lệnh (cùng quy tắc với trang admin).

Cấu trúc thư mục:

    phim/
      Ten Phim A/          ← tên thư mục = tên phim
        poster.jpg         (tuỳ chọn) poster.jpg / poster.png / poster.webp
        movie.json         (tuỳ chọn) {"description": "...", "tags": ["Ngôn tình", "Tổng tài"]} cho phim mới
        Tap 01.mp4         ← số tập = số cuối cùng trong tên file (ep_01.mp4, 01.mp4, tap1.mp4...)
        Tap 01.jpg         (tuỳ chọn) thumbnail; không có thì tự cắt từ video nếu máy có ffmpeg
        ...
      Ten Phim B/
        ...

- File video không có số trong tên: bỏ qua.
- 2 file cùng số tập: giữ file tên ngắn hơn.
- Phim đã có trên server (trùng tên): chỉ upload tập còn thiếu video.

Chạy:
    pip install requests
    python scripts/bulk_upload.py --api https://short-drama.<subdomain>.workers.dev --token <ADMIN_TOKEN> --root ./phim

Thêm --dry-run để chỉ xem danh sách sẽ upload, không gửi gì lên server.
Chạy lại bao nhiêu lần cũng được.
"""
import argparse
import json
import mimetypes
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from pathlib import Path

VIDEO_EXT = {".mp4", ".m4v", ".webm", ".mov"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}
POSTER_NAMES = ("poster", "cover", "bia")
HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def last_number(name: str):
    m = re.findall(r"\d+", Path(name).stem)
    return int(m[-1]) if m else None


def natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def plain(s) -> str:
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.replace("đ", "d").replace("Đ", "d").lower().strip()


def file_tuple(path: Path):
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return (path.name, open(path, "rb"), mime)


def probe_duration(path: Path):
    if not HAS_FFMPEG:
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=60,
        ).stdout.strip()
        return round(float(out)) if out else None
    except Exception:  # noqa: BLE001
        return None


def make_thumb(path: Path, out_dir: Path):
    if not HAS_FFMPEG:
        return None
    out = out_dir / f"{path.stem}_thumb.jpg"
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-ss", "1", "-i", str(path), "-frames:v", "1",
             "-vf", "scale=640:-2", "-q:v", "3", str(out)],
            capture_output=True, timeout=60,
        )
        return out if out.exists() and out.stat().st_size > 0 else None
    except Exception:  # noqa: BLE001
        return None


def scan_folder(mdir: Path):
    """Trả về (danh sách tập, file không có số, file trùng số, poster)."""
    files = [p for p in mdir.iterdir() if p.is_file() and not p.name.startswith(".")]
    videos = [p for p in files if p.suffix.lower() in VIDEO_EXT]
    images = [p for p in files if p.suffix.lower() in IMAGE_EXT and p.stem.lower() not in POSTER_NAMES]
    by_stem = {p.stem.lower(): p for p in images}
    by_num = {}
    for p in images:
        n = last_number(p.name)
        if n is not None:
            by_num.setdefault(n, p)

    eps, no_number, dups = {}, [], []
    # trùng số tập: giữ file tên ngắn nhất (thường là bản gốc, không phải "... (copy)")
    for v in sorted(videos, key=lambda p: (len(p.name), natural_key(p.name))):
        n = last_number(v.name)
        if n is None or n < 1:
            no_number.append(v)
        elif n in eps:
            dups.append(v)
        else:
            eps[n] = {"ep": n, "video": v, "thumb": by_stem.get(v.stem.lower()) or by_num.get(n)}
    poster = next((mdir / f"{n}{e}" for n in POSTER_NAMES for e in IMAGE_EXT if (mdir / f"{n}{e}").exists()), None)
    return [eps[k] for k in sorted(eps)], no_number, dups, poster


def request_with_retry(session, method, url, retries=3, files_factory=None, **kwargs):
    """Gửi request, tự thử lại khi lỗi mạng hoặc HTTP 5xx.
    files_factory: hàm trả về dict files (mở lại file ở mỗi lần thử)."""
    for attempt in range(1, retries + 1):
        files = files_factory() if files_factory else None
        try:
            r = session.request(method, url, timeout=600, files=files, **kwargs)
            if r.status_code >= 500 and attempt < retries:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
            return r
        except Exception as e:  # noqa: BLE001
            if attempt == retries:
                raise
            print(f"    lỗi ({e}), thử lại {attempt}/{retries - 1} ...")
            time.sleep(2 * attempt)
        finally:
            for f in (files or {}).values():
                f[1].close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", help="URL Worker, vd https://short-drama.xxx.workers.dev")
    ap.add_argument("--token", help="ADMIN_TOKEN")
    ap.add_argument("--root", required=True, help="Thư mục chứa các thư mục phim")
    ap.add_argument("--dry-run", action="store_true", help="Chỉ in danh sách sẽ upload, không gửi lên server")
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        sys.exit(f"Không tìm thấy thư mục {root}")
    movie_dirs = sorted((p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")),
                        key=lambda p: natural_key(p.name))
    if not HAS_FFMPEG:
        print("(Không thấy ffmpeg: sẽ không tự lấy thời lượng / tự cắt thumbnail. Cài: brew install ffmpeg)")

    def print_notes(no_number, dups):
        if no_number:
            print(f"  ! Bỏ qua (không có số tập trong tên): {', '.join(p.name for p in no_number)}")
        if dups:
            print(f"  ! Bỏ qua (trùng số tập với file khác): {', '.join(p.name for p in dups)}")

    # ---- dry run: chỉ xem kế hoạch
    if args.dry_run:
        for mdir in movie_dirs:
            eps, no_number, dups, poster = scan_folder(mdir)
            print(f"\n== {mdir.name}  ({len(eps)} tập)" + (f"  poster: {poster.name}" if poster else ""))
            for e in eps:
                thumb = e["thumb"].name if e["thumb"] else ("tự cắt từ video" if HAS_FFMPEG else "-")
                print(f"  Tập {e['ep']:>3}  {e['video'].name:<30} | thumb: {thumb}")
            print_notes(no_number, dups)
        return

    if not args.api or not args.token:
        sys.exit("Cần --api và --token (hoặc dùng --dry-run để xem trước)")
    try:
        import requests
    except ImportError:
        sys.exit("Thiếu thư viện requests. Chạy: pip install requests")

    api = args.api.rstrip("/")
    s = requests.Session()
    s.headers["authorization"] = f"Bearer {args.token}"
    r = s.get(f"{api}/api/admin/ping", timeout=30)
    if r.status_code != 200:
        sys.exit(f"Token không hợp lệ hoặc API sai: HTTP {r.status_code} {r.text[:200]}")

    # danh sách phim trên server (đọc mới, không qua cache vì có token admin)
    server_movies = s.get(f"{api}/api/movies/index", timeout=30).json().get("movies", [])
    by_title = {plain(m["title"]): m["id"] for m in server_movies}

    total_ok = total_skip = total_fail = 0
    tmp = Path(tempfile.mkdtemp(prefix="short-drama-thumbs-"))

    for mdir in movie_dirs:
        title = mdir.name
        print(f"\n== {title}")
        eps, no_number, dups, poster = scan_folder(mdir)
        print_notes(no_number, dups)

        # 1) phim: tìm theo tên thư mục, chưa có thì tạo
        movie_id = by_title.get(plain(title))
        if movie_id:
            detail = s.get(f"{api}/api/movies/{movie_id}", timeout=30).json()
            has_video = {e["ep_number"] for e in detail["episodes"] if e.get("video_url")}
            print(f"  = Phim đã có id={movie_id}, {len(has_video)} tập có video trên server")
        else:
            info = json.loads((mdir / "movie.json").read_text("utf-8")) if (mdir / "movie.json").exists() else {}
            tags = info.get("tags") or []
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.split(",")]
            data = {"title": title, "description": info.get("description") or "",
                    "tags": json.dumps([t for t in tags if t], ensure_ascii=False)}
            r = request_with_retry(
                s, "POST", f"{api}/api/admin/movies", data=data,
                files_factory=(lambda p=poster: {"poster": file_tuple(p)} if p else None),
            )
            if r.status_code != 201:
                print(f"  ✗ Không tạo được phim: {r.status_code} {r.text[:200]}")
                total_fail += 1
                continue
            movie_id = r.json()["movie"]["id"]
            by_title[plain(title)] = movie_id
            has_video = set()
            print(f"  + Tạo phim id={movie_id}")

        # 2) upload tập còn thiếu video
        for e in eps:
            n, v = e["ep"], e["video"]
            if n in has_video:
                total_skip += 1
                continue
            thumb = e["thumb"] or make_thumb(v, tmp)
            duration = probe_duration(v)
            data = {"duration": str(duration)} if duration is not None else {}

            def factory(v=v, thumb=thumb):
                f = {"video": file_tuple(v)}
                if thumb:
                    f["thumb"] = file_tuple(thumb)
                return f

            size_mb = v.stat().st_size / 1024 / 1024
            t0 = time.time()
            try:
                r = request_with_retry(
                    s, "PUT", f"{api}/api/admin/movies/{movie_id}/episodes/{n}",
                    data=data, files_factory=factory,
                )
            except Exception as ex:  # noqa: BLE001
                print(f"  ✗ Tập {n}: {ex}")
                total_fail += 1
                continue
            if r.status_code in (200, 201):
                total_ok += 1
                print(f"  ✓ Tập {n:>3}  {size_mb:6.1f} MB  {time.time() - t0:5.1f}s  {v.name}")
            else:
                total_fail += 1
                print(f"  ✗ Tập {n}: HTTP {r.status_code} {r.text[:200]}")

    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nXong. Thành công: {total_ok}, bỏ qua (đã có): {total_skip}, lỗi: {total_fail}")
    if total_fail:
        print("Chạy lại lệnh để upload tiếp các tập lỗi.")


if __name__ == "__main__":
    main()
