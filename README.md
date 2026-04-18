# 北京100个打卡景点清单

A **Beijing sightseeing check-in checklist** web application that lets you import attraction lists from Word, PDF, or Excel files and track which places you've visited.

## Features

- **📥 One-click Import** — Drag & drop or select files in `.docx` (Word), `.pdf`, `.xlsx/.xls` (Excel) format to populate the checklist automatically
- **🚀 Built-in Initial Checklist** — On first open, the app preloads the 100-item list from `离开北京前的 100 个必做清单.docx`
- **☑️ Check-in Tracking** — Every attraction has a checkbox; tick it to mark the place as visited and record the date automatically
- **📖 Collapsible Descriptions** — Click the ▼ button or the attraction title to expand/collapse the description, keeping the list compact
- **📝 Visit Notes** — After checking in, write your personal impressions in a notes field that auto-saves as you type
- **📷 Photo Upload** — Upload multiple photos per attraction; thumbnails are displayed in a gallery with a full-screen lightbox view
- **🖼️ HEIC / HEIF Support** — HEIC uploads are auto-converted to JPEG for cross-device viewing compatibility
- **✅ Upload Completion Notice** — After each upload action, the app shows a completion prompt with success/failure details
- **🏷️ Tag Browser** — Tags are displayed as category pills; click a tag to view only attractions under that tag
- **🔍 Filter View** — Switch between All / Visited / Unvisited to focus on what matters
- **🧩 Independent Content Management** — Add/delete attractions in a dedicated panel separated from check-in content to reduce accidental operations
- **⚙️ Hidden Management Drawer** — Content management is moved into a compact “Management” entry to avoid accidental clicks
- **📊 Progress Bar** — A real-time progress bar in the header shows how many attractions you've ticked off
- **💾 Persistent Storage** — All data (check-in status, notes, photos) is saved in browser `localStorage` and survives page refreshes
- **☁️ 10 Cloud Databases + Name Switch** — Supports 10 independent cloud databases; edit each database name and switch by directly typing the name

## File Format Guide

| Format | Parsing Strategy |
|--------|-----------------|
| **Excel** (.xlsx / .xls) | First column = attraction name; second column = description. A header row is detected automatically. |
| **Word** (.docx) | Numbered items (`1. Name`) are recognized as attractions; heading levels (H1–H5) are recognized as hierarchical attraction tags; following paragraphs become descriptions. |
| **PDF** | Numbered items (`1. Name`) are recognized as attractions; subsequent lines become the description. |

## Getting Started

1. Clone this repository and open `index.html` in any modern browser (Chrome, Edge, Firefox, Safari).
2. Click **选择文件** or drag a document onto the drop zone to import your attraction list.
3. Check off each attraction as you visit it, and add your notes and photos!

> **Requires an internet connection** for the first load to fetch the parsing libraries (SheetJS, mammoth.js, pdf.js) from CDN.

## HEIC Dependency Download (Desktop)

If your desktop browser cannot convert HEIC/HEIF files, you can open the dependency page directly from each attraction upload area via the link:

- 下载 HEIC 依赖

The link points to the heic2any package page:

- https://www.npmjs.com/package/heic2any

After network access is available, retry upload and the app will continue converting HEIC images to JPEG automatically.

## Security Notes

- Do not commit real server addresses, API keys, database passwords, or SSH profiles to public repositories.
- Keep actual backend credentials only in local `backend/.env`.
- Keep deployment credentials only in local `.vscode/sftp.json` (ignored by Git).
- Use `.vscode/sftp.example.json` as the template for your own SFTP profile.
- Use `js/config.example.js` as the template, then copy it to local `js/config.js` (ignored by Git).

## Technology

| Library | Purpose | CDN Version |
|---------|---------|-------------|
| [SheetJS](https://sheetjs.com/) | Excel parsing | 0.20.3 |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) | Word (.docx) parsing | 1.8.0 |
| [pdf.js](https://mozilla.github.io/pdf.js/) | PDF parsing | 4.9.155 (patched) |

No build tools are required — the app is plain HTML, CSS, and JavaScript.

## Azure PostgreSQL Configuration (Optional, for cloud sync)

This project is a pure frontend app, so it **cannot connect to PostgreSQL directly from browser** safely.
You need a small backend API (Azure Functions / App Service / Container App) between browser and Azure Database for PostgreSQL.

A ready-to-run Node.js backend is included in this repository:

- Backend code: `backend/server.js`
- Backend setup guide: `backend/README.md`
- SQL schema file: `backend/sql/init.sql`

Quick start:

1. `cd backend`
2. `npm install`
3. Copy `.env.example` to `.env` and fill your Azure PostgreSQL settings.
4. `npm start`

Frontend cloud config (optional):

1. Copy `js/config.example.js` to `js/config.js`
2. Fill `apiBaseUrl`, `apiKey`, `userId` in `js/config.js`

### 1) Create table in Azure Database for PostgreSQL

```sql
create table if not exists attraction_databases (
  user_id text not null,
  db_slot smallint not null check (db_slot = 1),
  payload jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, db_slot)
);

create index if not exists idx_attraction_databases_user_id
  on attraction_databases (user_id);
```

### 2) Implement backend API contract

The frontend now calls these endpoints:

- `GET /attraction-databases?user_id=<string>&db_slot=1`
  - Response: `{ "payload": [...] }`
- `PUT /attraction-databases`
  - Body: `{ "user_id": "...", "db_slot": 1, "payload": [...] }`
  - Response: `200/204`
- Optional health check: `GET /health` (any 2xx is fine)

The frontend sends `Authorization: Bearer <apiKey>` when `apiKey` is configured.

### 3) Configure frontend in `js/config.js` (recommended)

```js
window.APP_CONFIG = {
  apiBaseUrl: 'https://YOUR_API_HOST', // your backend API base URL
  apiKey: 'YOUR_API_KEY',              // optional
  userId: '',                          // optional; empty = shared default user id
};
```

If `apiBaseUrl` is empty, the app automatically runs in local-only mode.
