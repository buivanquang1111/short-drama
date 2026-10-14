# short-drama

Backend lưu phim/tập trên Cloudflare: **Workers** (API) + **D1** (thông tin) + **R2** (file video/ảnh).

```
src/index.js              Worker: API cho app, API admin, phát file /media (hỗ trợ Range)
migrations/0001_init.sql  Bảng movies, episodes
public/admin/index.html   Trang admin (mở tại /admin/)
scripts/bulk_upload.py    Upload hàng loạt từ thư mục trên máy
```

## Chạy local
```bash
npm install
cp .dev.vars.example .dev.vars          # sửa ADMIN_TOKEN
npm run db:migrate:local
npm run dev                              # http://localhost:8787/admin/
```

## Deploy
```bash
npx wrangler login
npx wrangler d1 create short-drama-db          # dán database_id vào wrangler.toml
npx wrangler r2 bucket create short-drama-files
npm run db:migrate:remote
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

## API cho app
| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/movies?page=1&limit=20` | Danh sách phim |
| GET | `/api/movies/:id` | Phim + danh sách tập (có `video_url`) |
| GET | `/api/episodes/:id` | Một tập |

API admin (header `Authorization: Bearer <ADMIN_TOKEN>`, body multipart form):
`POST /api/admin/movies`, `PATCH|DELETE /api/admin/movies/:id`,
`POST /api/admin/movies/:id/episodes`, `PATCH|DELETE /api/admin/episodes/:id`.
