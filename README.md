# 北京100个打卡景点清单

A **Beijing sightseeing check-in checklist** web application that lets you import attraction lists from Word, PDF, or Excel files and track which places you've visited.

## Features

- **📥 One-click Import** — Drag & drop or select files in `.docx` (Word), `.pdf`, `.xlsx/.xls` (Excel) format to populate the checklist automatically
- **🚀 Built-in Initial Checklist** — On first open, the app preloads the 100-item list from `离开北京前的 100 个必做清单.docx`
- **☑️ Check-in Tracking** — Every attraction has a checkbox; tick it to mark the place as visited and record the date automatically
- **📖 Collapsible Descriptions** — Click the ▼ button or the attraction title to expand/collapse the description, keeping the list compact
- **📝 Visit Notes** — After checking in, write your personal impressions in a notes field that auto-saves as you type
- **📷 Photo Upload** — Upload multiple photos per attraction; thumbnails are displayed in a gallery with a full-screen lightbox view
- **🏷️ Tag Browser** — Tags are displayed as category pills; click a tag to view only attractions under that tag
- **🔍 Filter View** — Switch between All / Visited / Unvisited to focus on what matters
- **🧩 Independent Content Management** — Add/delete attractions in a dedicated panel separated from check-in content to reduce accidental operations
- **📊 Progress Bar** — A real-time progress bar in the header shows how many attractions you've ticked off
- **💾 Persistent Storage** — All data (check-in status, notes, photos) is saved in browser `localStorage` and survives page refreshes

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

## Technology

| Library | Purpose | CDN Version |
|---------|---------|-------------|
| [SheetJS](https://sheetjs.com/) | Excel parsing | 0.20.3 |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) | Word (.docx) parsing | 1.8.0 |
| [pdf.js](https://mozilla.github.io/pdf.js/) | PDF parsing | 4.9.155 (patched) |

No build tools are required — the app is plain HTML, CSS, and JavaScript.
