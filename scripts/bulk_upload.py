#!/usr/bin/env python3
"""
Upload hàng loạt phim + tập lên short-drama.

Cấu trúc thư mục:

    phim/
      Ten Phim A/
        movie.json        (tuỳ chọn) {"title": "...", "subtitle": "...", "description": "..."}
        poster.jpg        (tuỳ chọn) poster.jpg / poster.png / poster.webp
        episodes.csv      (tuỳ chọn) tiêu đề, tiêu đề phụ, thời lượng cho từng tập (xem bên dưới)
        ep_01.mp4
        ep_01.jpg         (tuỳ chọn) thumbnail
        ...
      Ten Phim B/
        ...

Số tập:
  - Tên file có số (ep_05.mp4, tap5.mp4, 05.mp4) => lấy số cuối cùng.
  - Tên file không có số => đánh tiếp theo thứ tự tên file, sau số lớn nhất ở trên.
  - Có cột "ep" trong episodes.csv => dùng số đó (ưu tiên cao nhất).

Thumbnail: ảnh cùng tên với video (abc.mp4 + abc.jpg) hoặc cùng số tập (ep_05.jpg).
  Không có ảnh và máy có ffmpeg => tự cắt khung hình ở giây thứ 1.

Thời lượng: lấy từ episodes.csv, nếu không có thì tự đọc bằng ffprobe (nếu máy có ffmpeg).

episodes.csv (UTF-8, dòng đầu là tiêu đề cột; chỉ cột "file" là bắt buộc):

    file,ep,title,subtitle,duration
    ep_01.mp4,1,Cuộc gặp gỡ,Tập mở đầu,
    ep_02.mp4,2,Hiểu lầm,,95

Chạy:
    pip install requests
    python scripts/bulk_upload.py --api https://short-drama.<subdomain>.workers.dev --token <ADMIN_TOKEN> --root ./phim

Thêm --dry-run để chỉ xem danh sách sẽ upload (số tập, tiêu đề, thumb), không gửi gì lên server.

Chạy lại bao nhiêu lần cũng được: script nhớ phim đã tạo (file .upload_state.json trong --root)
và bỏ qua tập đã có trên server.
"""
import argparse
import csv
import json
import mimetypes
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

VIDEO_EXT = {".mp4", ".m4v", ".webm", ".mov"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}
STATE_FILE = ".upload_state.json"
HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def last_number(name: str):
    m = re.findall(r"\d+", Path(name).stem)
    return int(m[-1]) if m else None


def natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


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


def read_csv(path: Path):
    """Trả về {tên file (thường): {ep,title,subtitle,duration}}"""
    if not path.exists():
        return {}
    rows = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            name = (row.get("file") or "").strip()
            if name:
                rows[name.lower()] = {k: (v or "").strip() for k, v in row.items() if k}
    return rows


def plan_episodes(mdir: Path):
    """Ghép video + thumbnail + thông tin csv, đánh số tập. Trả về list dict, đã sắp theo số tập."""
    files = [p for p in mdir.iterdir() if p.is_file() and not p.name.startswith(".")]
    videos = sorted((p for p in files if p.suffix.lower() in VIDEO_EXT), key=lambda p: natural_key(p.name))
    images = [p for p in files if p.suffix.lower() in IMAGE_EXT and not p.stem.lower().startswith("poster")]
    by_stem = {p.stem.lower(): p for p in images}
    by_num = {}
    for p in images:
        n = last_number(p.name)
        if n is not None:
            by_num.setdefault(n, p)
    meta = read_csv(mdir / "episodes.csv")

    eps = []
    for v in videos:
        m = meta.get(v.name.lower(), {})
        csv_ep = int(m["ep"]) if m.get("ep", "").isdigit() else None
        name_ep = last_number(v.name)
        eps.append({"video": v, "meta": m, "ep": csv_ep or name_ep, "numbered": (csv_ep or name_ep) is not None})

    # file không có số => đánh tiếp sau số lớn nhất, theo thứ tự tên file (ổn định giữa các lần chạy)
    nxt = max([e["ep"] for e in eps if e["numbered"]] or [0]) + 1
    for e in eps:
        if e["ep"] is None:
            e["ep"] = nxt
            nxt += 1

    for e in eps:
        v, m = e["video"], e["meta"]
        e["thumb"] = by_stem.get(v.stem.lower()) or (by_num.get(e["ep"]) if e["numbered"] else None)
        e["title"] = m.get("title") or f"Tập {e['ep']}"
        e["subtitle"] = m.get("subtitle") or ""
        e["duration"] = int(m["duration"]) if m.get("duration", "").isdigit() else None
    eps.sort(key=lambda e: e["ep"])

    seen = {}
    for e in eps:
        seen.setdefault(e["ep"], []).append(e["video"].name)
    dups = {n: names for n, names in seen.items() if len(names) > 1}
    return eps, dups


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

    # ---- dry run: chỉ xem kế hoạch
    if args.dry_run:
        for mdir in movie_dirs:
            eps, dups = plan_episodes(mdir)
            print(f"\n== {mdir.name}  ({len(eps)} tập)")
            for e in eps:
                thumb = e["thumb"].name if e["thumb"] else ("tự cắt từ video" if HAS_FFMPEG else "-")
                print(f"  Tập {e['ep']:>3}  {e['video'].name:<30} | {e['title']} | {e['subtitle']} | thumb: {thumb}")
            for n, names in dups.items():
                print(f"  ! Trùng số tập {n}: {', '.join(names)}")
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

    state_path = root / STATE_FILE
    state = json.loads(state_path.read_text("utf-8")) if state_path.exists() else {}

    def save_state():
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), "utf-8")

    total_ok = total_skip = total_fail = 0
    tmp = Path(tempfile.mkdtemp(prefix="short-drama-thumbs-"))

    for mdir in movie_dirs:
        info = {}
        if (mdir / "movie.json").exists():
            info = json.loads((mdir / "movie.json").read_text("utf-8"))
        title = info.get("title") or mdir.name
        print(f"\n== {title}")

        eps, dups = plan_episodes(mdir)
        if dups:
            for n, names in dups.items():
                print(f"  ✗ Trùng số tập {n}: {', '.join(names)} — sửa tên file hoặc cột ep trong episodes.csv")
            total_fail += 1
            continue

        # 1) Tạo phim (hoặc lấy lại id đã tạo lần trước)
        movie_id = state.get(mdir.name)
        if movie_id:
            r = s.get(f"{api}/api/movies/{movie_id}", timeout=30)
            if r.status_code == 404:
                movie_id = None
        if not movie_id:
            poster = next((mdir / f"poster{e}" for e in IMAGE_EXT if (mdir / f"poster{e}").exists()), None)
            data = {k: info.get(k) or "" for k in ("subtitle", "description")}
            data["title"] = title
            r = request_with_retry(
                s, "POST", f"{api}/api/admin/movies", data=data,
                files_factory=(lambda p=poster: {"poster": file_tuple(p)} if p else None),
            )
            if r.status_code != 201:
                print(f"  ✗ Không tạo được phim: {r.status_code} {r.text[:200]}")
                total_fail += 1
                continue
            movie_id = r.json()["movie"]["id"]
            state[mdir.name] = movie_id
            save_state()
            print(f"  + Tạo phim id={movie_id}")
            existing = set()
        else:
            existing = {e["ep_number"] for e in r.json()["episodes"]}
            print(f"  = Phim đã có id={movie_id}, {len(existing)} tập trên server")

        # 2) Upload các tập
        for e in eps:
            n, v = e["ep"], e["video"]
            if n in existing:
                total_skip += 1
                continue
            thumb = e["thumb"] or make_thumb(v, tmp)
            duration = e["duration"] if e["duration"] is not None else probe_duration(v)
            data = {"ep_number": str(n), "title": e["title"], "subtitle": e["subtitle"]}
            if duration is not None:
                data["duration"] = str(duration)

            def factory(v=v, thumb=thumb):
                f = {"video": file_tuple(v)}
                if thumb:
                    f["thumb"] = file_tuple(thumb)
                return f

            size_mb = v.stat().st_size / 1024 / 1024
            t0 = time.time()
            try:
                r = request_with_retry(
                    s, "POST", f"{api}/api/admin/movies/{movie_id}/episodes",
                    data=data, files_factory=factory,
                )
            except Exception as ex:  # noqa: BLE001
                print(f"  ✗ Tập {n}: {ex}")
                total_fail += 1
                continue
            if r.status_code == 201:
                total_ok += 1
                print(f"  ✓ Tập {n:>3}  {size_mb:6.1f} MB  {time.time() - t0:5.1f}s  {e['title']}")
            elif r.status_code == 409:
                total_skip += 1
            else:
                total_fail += 1
                print(f"  ✗ Tập {n}: HTTP {r.status_code} {r.text[:200]}")

    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nXong. Thành công: {total_ok}, bỏ qua (đã có): {total_skip}, lỗi: {total_fail}")
    if total_fail:
        print("Chạy lại lệnh để upload tiếp các tập lỗi.")


if __name__ == "__main__":
    main()
