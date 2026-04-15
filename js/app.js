/* ============================================================
   北京打卡景点清单 · app.js
   ============================================================ */

/* ------------------------------------------------------------------
   pdf.js 4.x CDN URL  (4.x is patched against CVE that affected ≤4.1.392)
------------------------------------------------------------------ */
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.min.mjs';
const PDFJS_WORKER_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.mjs';
const TAG_KEY_SEPARATOR = '::';
const CLOUD_SAVE_DEBOUNCE_MS = 400;
const DEFAULT_STARTUP_DATABASE_SLOT = 1;
const MEDIA_UPLOAD_ACCEPT = 'image/*,video/*,.heic,.heif,.mov,.mp4,.webm,.m4v';
const MAX_MEDIA_ITEMS_PER_ATTRACTION = 20;
const MAX_MEDIA_FILE_SIZE_MB = 12;
const MAX_MEDIA_FILE_SIZE_BYTES = MAX_MEDIA_FILE_SIZE_MB * 1024 * 1024;

function normalizeTagList(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => {
      if (!tag || !tag.name) return null;
      const level = Math.max(1, Math.min(5, Number(tag.level) || 1));
      const name = String(tag.name).trim();
      return name ? { level, name } : null;
    })
    .filter(Boolean);
}

function inferMediaKindFromDataUrl(src) {
  const value = String(src || '').trim().toLowerCase();
  return value.startsWith('data:video/') ? 'video' : 'image';
}

function normalizeMediaEntry(entry) {
  if (typeof entry === 'string') {
    const src = entry.trim();
    if (!src) return null;
    return {
      kind: inferMediaKindFromDataUrl(src),
      src,
    };
  }

  if (!entry || typeof entry !== 'object') return null;

  const src = String(entry.src || entry.url || '').trim();
  if (!src) return null;

  const rawKind = String(entry.kind || entry.type || '').toLowerCase();
  const kind = rawKind.includes('video')
    ? 'video'
    : rawKind.includes('image')
    ? 'image'
    : inferMediaKindFromDataUrl(src);

  return { kind, src };
}

function normalizeMediaList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => normalizeMediaEntry(entry)).filter(Boolean);
}

function isSupportedMediaFile(file) {
  const mime = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  if (mime.startsWith('image/') || mime.startsWith('video/')) return true;
  return /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|mov|mp4|webm|m4v|avi)$/.test(name);
}

function inferMediaKindFromFile(file, dataUrl = '') {
  const mime = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (/\.(mov|mp4|webm|m4v|avi)$/.test(name)) return 'video';
  if (/\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/.test(name)) return 'image';
  return inferMediaKindFromDataUrl(dataUrl);
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(String(e.target?.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------
   1. LocalStorage Store
------------------------------------------------------------------ */
const Store = {
  KEY: 'beijing_attractions_v1',
  cache: null,
  cloudMode: false,
  quotaWarned: false,

  setCloudMode(enabled) {
    this.cloudMode = Boolean(enabled);
  },

  _readFromLocal() {
    try {
      const raw = localStorage.getItem(this.KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  },

  _ensureCache() {
    if (Array.isArray(this.cache)) return;
    this.cache = this._readFromLocal();
  },

  getAll() {
    this._ensureCache();
    return this.cache;
  },

  _persist(list) {
    const nextList = Array.isArray(list) ? list : [];
    this.cache = nextList;
    try {
      localStorage.setItem(this.KEY, JSON.stringify(nextList));
      this.quotaWarned = false;
    } catch (e) {
      // Browser localStorage quota is usually around a few MB, much smaller than DB server storage.
      if (this.cloudMode) {
        if (!this.quotaWarned) {
          console.warn('Local storage quota exceeded; fallback to cloud-only persistence for large media.');
          this.quotaWarned = true;
        }
      } else if (!this.quotaWarned) {
        alert('浏览器本地存储空间不足，部分媒体可能无法离线保存。请减少照片数量或连接云端同步。');
        this.quotaWarned = true;
      }
    }
    return nextList;
  },

  replaceAll(list) {
    return this._persist(Array.isArray(list) ? list : []);
  },

  addBatch(newItems) {
    const existing = this.getAll();
    const maxId = existing.reduce((m, a) => Math.max(m, a.id || 0), 0);
    const mapped = newItems.map((item, i) => ({
      id: maxId + i + 1,
      name: item.name || '未命名景点',
      description: item.description || '',
      tags: normalizeTagList(item.tags),
      visited: false,
      visitDate: null,
      notes: '',
      photos: [],
    }));
    return this._persist([...existing, ...mapped]);
  },

  update(id, patch) {
    const list = this.getAll();
    const idx = list.findIndex((a) => a.id === id);
    if (idx !== -1) {
      list[idx] = { ...list[idx], ...patch };
    }
    return this._persist(list);
  },

  clear() {
    this.cache = [];
    localStorage.removeItem(this.KEY);
    return [];
  },

  addOne(item) {
    return this.addBatch([item]);
  },

  remove(id) {
    const list = this.getAll().filter((a) => a.id !== id);
    return this._persist(list);
  },
};

/* ------------------------------------------------------------------
   2. File Parser  (Excel · Word · PDF)
------------------------------------------------------------------ */
const Parser = {
  /* -------- helpers -------- */
  _numberedLine(text) {
    // matches "1. 景点", "1、景点", "1 景点" etc.
    const m = text.match(/^\s*(\d+)\s*[\.、。\s]\s*(.+)/);
    return m ? m[2].trim() : null;
  },

  _buildAttractions(nameDescPairs) {
    return nameDescPairs
      .filter((p) => p.name && p.name.trim())
      .map((p) => ({
        name: p.name.trim(),
        description: (p.description || '').trim(),
        tags: normalizeTagList(p.tags),
      }));
  },

  /* -------- Excel -------- */
  async parseExcel(file) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!rows.length) return [];

    // Auto-detect header row (if first row contains keyword like 名称/景点/名字/name)
    const firstCells = rows[0].map((c) => String(c).toLowerCase());
    const looksLikeHeader = firstCells.some(
      (c) => /名称|景点|地点|名字|title|name|标题/.test(c)
    );
    const dataRows = looksLikeHeader ? rows.slice(1) : rows;

    const pairs = dataRows
      .filter((row) => row.some((cell) => String(cell).trim()))
      .map((row) => {
        const cells = row.map((c) => String(c).trim());
        if (cells.length === 1) return { name: cells[0], description: '' };
        const [name, ...rest] = cells;
        return { name, description: rest.filter(Boolean).join(' | ') };
      });

    return this._buildAttractions(pairs);
  },

  /* -------- Word (.docx) -------- */
  async parseWord(file) {
    const buffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
    const div = document.createElement('div');
    div.innerHTML = result.value;

    const pairs = [];
    let current = null;
    const headingStack = [];
    const currentTags = () => headingStack.filter(Boolean).map((h) => ({ ...h }));

    for (const el of div.querySelectorAll('h1,h2,h3,h4,h5,p,li')) {
      const tag = el.tagName.toLowerCase();
      const text = el.textContent.trim();
      if (!text) continue;

      if (['h1', 'h2', 'h3', 'h4', 'h5'].includes(tag)) {
        if (current) pairs.push(current);
        const level = Number(tag.slice(1));
        headingStack[level - 1] = { level, name: text };
        headingStack.length = level; // truncate to current level (removing any deeper headings)
      } else {
        const numbered = this._numberedLine(text);
        if (numbered) {
          if (current) pairs.push(current);
          current = { name: numbered, description: '', tags: currentTags() };
        } else if (current) {
          current.description += (current.description ? '\n' : '') + text;
        } else {
          // First plain paragraph — treat it as an attraction name
          current = { name: text, description: '', tags: currentTags() };
        }
      }
    }
    if (current) pairs.push(current);
    return this._buildAttractions(pairs);
  },

  /* -------- PDF -------- */
  async parsePDF(file) {
    // Load pdf.js 4.x lazily via dynamic import (patched version — no known CVEs)
    let pdfjsLib;
    try {
      pdfjsLib = await import(/* webpackIgnore: true */ PDFJS_URL);
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    } catch (e) {
      throw new Error(
        'PDF 解析器加载失败，请检查网络连接后重试。\n详情：' + e.message
      );
    }

    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

    let fullText = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // Reconstruct lines using y-position grouping
      const items = content.items;
      // Sort by page order (top-to-bottom, left-to-right)
      const lines = [];
      let lastY = null;
      let currentLine = '';
      for (const item of items) {
        const y = item.transform ? Math.round(item.transform[5]) : 0;
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          if (currentLine.trim()) lines.push(currentLine.trim());
          currentLine = item.str;
        } else {
          currentLine += item.str;
        }
        lastY = y;
      }
      if (currentLine.trim()) lines.push(currentLine.trim());
      fullText += lines.join('\n') + '\n';
    }

    const pairs = [];
    let current = null;

    for (const raw of fullText.split('\n')) {
      const line = raw.trim();
      if (!line) continue;

      const numbered = this._numberedLine(line);
      if (numbered) {
        if (current) pairs.push(current);
        current = { name: numbered, description: '' };
      } else if (current) {
        current.description += (current.description ? ' ' : '') + line;
      } else {
        current = { name: line, description: '' };
      }
    }
    if (current) pairs.push(current);
    return this._buildAttractions(pairs);
  },

  /* -------- dispatch -------- */
  async parse(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) return this.parseExcel(file);
    if (name.endsWith('.docx')) return this.parseWord(file);
    if (name.endsWith('.pdf')) return this.parsePDF(file);
    throw new Error(`不支持的文件格式："${file.name}"。请使用 .docx、.pdf、.xlsx 或 .xls 文件。`);
  },
};

/* ------------------------------------------------------------------
   3. HTML escape utility
------------------------------------------------------------------ */
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------
   4. Main Application
------------------------------------------------------------------ */
const App = {
  attractions: [],   // in-memory mirror of Store
  filter: 'all',
  tagFilter: null,
  searchQuery: '',
  expandedIds: new Set(), // IDs of expanded cards
  cloudSyncEnabled: false,
  cloudSyncWarned: false,
  selectedDatabaseSlot: 1,
  cloudSaveTimer: null,

  /* ---- init ---- */
  async init() {
    this.attractions = Store.getAll();
    this._bindGlobalEvents();
    // First-time bootstrap only: preload bundled checklist when local storage is empty.
    if (
      !this.attractions.length &&
      window.DEFAULT_ATTRACTIONS &&
      Array.isArray(window.DEFAULT_ATTRACTIONS)
    ) {
      this.attractions = Store.addBatch(window.DEFAULT_ATTRACTIONS);
    }
    await this._initAuth();
    this.render();
  },

  /* ---- global event bindings ---- */
  _bindGlobalEvents() {
    /* File picker button */
    document.getElementById('importBtn').addEventListener('click', () =>
      document.getElementById('fileInput').click()
    );

    /* File input change */
    document.getElementById('fileInput').addEventListener('change', (e) => {
      if (e.target.files.length) this._handleFile(e.target.files[0]);
      e.target.value = ''; // allow re-import same filename
    });

    /* Drag & drop */
    const dropZone = document.getElementById('dropZone');
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) this._handleFile(e.dataTransfer.files[0]);
    });

    /* Search input */
    const searchInput = document.getElementById('searchInput');
    const searchClearBtn = document.getElementById('searchClearBtn');
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      searchClearBtn.hidden = !this.searchQuery;
      this._renderList();
    });
    searchClearBtn.addEventListener('click', () => {
      searchInput.value = '';
      this.searchQuery = '';
      searchClearBtn.hidden = true;
      searchInput.focus();
      this._renderList();
    });

    /* Toolbar buttons */
    document.getElementById('manageBtn').addEventListener('click', () => {
      this._openManagerDrawer();
    });
    document.getElementById('managerDrawerClose').addEventListener('click', () => {
      this._closeManagerDrawer();
    });
    document.getElementById('managerDrawerBackdrop').addEventListener('click', () => {
      this._closeManagerDrawer();
    });
    document.getElementById('importMoreBtn').addEventListener('click', () => {
      this._closeManagerDrawer();
      document.getElementById('attractionsSection').hidden = true;
      document.getElementById('importSection').hidden = false;
    });

    document.getElementById('clearBtn').addEventListener('click', () => {
      const cloudNotice = this.cloudSyncEnabled
        ? `（将同步清空云端数据库 ${this.selectedDatabaseSlot}）`
        : '';
      if (!confirm(`确定要清空所有景点数据吗？此操作不可撤销。${cloudNotice}`)) return;
      this.attractions = Store.clear();
      this.expandedIds.clear();
      this.tagFilter = null;
      this._scheduleCloudSave();
      this.render();
    });

    /* Filter buttons */
    document.querySelectorAll('.filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.filter = btn.dataset.filter;
        this._renderList();
      });
    });

    document.getElementById('clearTagFilterBtn').addEventListener('click', () => {
      this.tagFilter = null;
      this._renderTagBrowser();
      this._renderList();
    });

    document.getElementById('addAttractionForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this._addAttraction();
    });

    document.getElementById('deleteAttractionBtn').addEventListener('click', () => {
      this._deleteAttraction();
    });

    /* Account / auth modal */
    document.getElementById('databaseNameEntryBtn').addEventListener('click', () => {
      this._openAuthModal();
    });
    document.getElementById('authModalClose').addEventListener('click', () => {
      this._closeAuthModal();
    });
    document.getElementById('authModalBackdrop').addEventListener('click', () => {
      this._closeAuthModal();
    });
    document.getElementById('authModalDoneBtn').addEventListener('click', () => {
      this._closeAuthModal();
    });

    document.getElementById('databaseSwitchForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!window.AuthService || window.AuthService.getDatabaseCount() <= 1) {
        await this._switchCloudDatabase(DEFAULT_STARTUP_DATABASE_SLOT);
        return;
      }
      const nameInput = document.getElementById('databaseNameInput');
      await this._switchCloudDatabaseByName(nameInput.value);
    });

    document.getElementById('databaseRenameForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!window.AuthService || window.AuthService.getDatabaseCount() <= 1) {
        alert('当前仅保留数据库1，无需管理多数据库名称。');
        return;
      }
      const slot = Number(document.getElementById('databaseRenameSlot').value);
      const name = document.getElementById('databaseRenameInput').value;
      const result = window.AuthService.setDatabaseName(slot, name);
      alert(result.message);
      if (!result.ok) return;
      this._renderDatabaseOptions();
      this._refreshAuthUI();
    });
    this._bindDatabaseEditorEvents();

    /* Photo lightbox close */
    document.getElementById('modalBackdrop').addEventListener('click', () => {
      this._closeLightbox();
    });
    document.getElementById('modalClose').addEventListener('click', () => {
      this._closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!document.getElementById('authModal').hidden) {
        this._closeAuthModal();
        return;
      }
      if (!document.getElementById('managerDrawer').hidden) {
        this._closeManagerDrawer();
        return;
      }
      this._closeLightbox();
    });
  },

  async _initAuth() {
    if (!window.AuthService) {
      this.cloudSyncEnabled = false;
      Store.setCloudMode(false);
      this._refreshAuthUI();
      return;
    }
    const enabled = await window.AuthService.init();
    this.cloudSyncEnabled = enabled;
    Store.setCloudMode(enabled);

    // Always open with database slot 1 as the default entry point.
    this.selectedDatabaseSlot = window.AuthService.setSelectedDatabaseSlot(
      DEFAULT_STARTUP_DATABASE_SLOT
    );
    this._refreshDatabaseEditor();
    this._refreshAuthUI();

    if (!enabled) return;

    window.AuthService.onAuthStateChange(async () => {
      this._refreshAuthUI();
      await this._syncDatabaseFromCloud({ seedDefaultWhenEmpty: true });
      this._renderStats();
      this._renderList();
    });

    await this._syncDatabaseFromCloud({ seedDefaultWhenEmpty: true });
  },

  _renderDatabaseOptions() {
    if (!window.AuthService) return;
    const renameSlot = document.getElementById('databaseRenameSlot');
    const nameList = document.getElementById('databaseNameList');
    const names = window.AuthService.getDatabaseNames();
    if (renameSlot) {
      renameSlot.innerHTML = names
        .map((name, i) => `<option value="${i + 1}">库 ${i + 1}（${esc(name)}）</option>`)
        .join('');
      renameSlot.value = String(this.selectedDatabaseSlot);
    }
    if (nameList) {
      nameList.innerHTML = names.map((name) => `<option value="${esc(name)}"></option>`).join('');
    }
  },

  _setCurrentDatabaseNameInput() {
    if (!window.AuthService) return;
    const input = document.getElementById('databaseNameInput');
    if (!input) return;
    input.value = window.AuthService.getDatabaseName(this.selectedDatabaseSlot);
  },

  _fillRenameInputFromSelectedSlot() {
    if (!window.AuthService) return;
    const renameSlot = document.getElementById('databaseRenameSlot');
    const renameInput = document.getElementById('databaseRenameInput');
    if (!renameSlot || !renameInput) return;
    const selected = Number(renameSlot.value) || this.selectedDatabaseSlot;
    renameInput.value = window.AuthService.getDatabaseName(selected);
  },

  _resolveDatabaseSlotInput(name) {
    if (!window.AuthService) return null;
    const count = window.AuthService.getDatabaseCount();
    if (count <= 1) return DEFAULT_STARTUP_DATABASE_SLOT;

    const input = String(name || '').trim();
    if (!input) return null;

    const compact = input.replace(/\s+/g, '');
    const numericMatch =
      compact.match(/^(\d{1,2})$/) ||
      compact.match(/^库(\d{1,2})$/) ||
      compact.match(/^数据库(\d{1,2})$/);
    if (numericMatch) {
      const slot = Number(numericMatch[1]);
      if (Number.isInteger(slot) && slot >= 1 && slot <= window.AuthService.getDatabaseCount()) {
        return slot;
      }
    }

    const cnDigitMap = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };
    const cnMatch = compact.match(/^库([一二三四五六七八九十])$/) || compact.match(/^数据库([一二三四五六七八九十])$/);
    if (cnMatch) {
      return cnDigitMap[cnMatch[1]] || null;
    }

    return window.AuthService.findDatabaseSlotByName(input);
  },

  async _switchCloudDatabaseByName(name) {
    if (!this.cloudSyncEnabled || !window.AuthService) return;
    if (window.AuthService.getDatabaseCount() <= 1) {
      await this._switchCloudDatabase(DEFAULT_STARTUP_DATABASE_SLOT);
      return;
    }
    const slot = this._resolveDatabaseSlotInput(name);
    if (!slot) {
      alert('未找到该数据库，请输入正确的数据库名字或编号。');
      return;
    }
    await this._switchCloudDatabase(slot);
  },

  async _switchCloudDatabase(slot) {
    if (!this.cloudSyncEnabled || !window.AuthService) return;
    const normalized = window.AuthService.setSelectedDatabaseSlot(slot);
    this.selectedDatabaseSlot = normalized;
    await this._syncDatabaseFromCloud();
    this._refreshAuthUI();
    this.render();
  },

  _bindDatabaseEditorEvents() {
    const renameSlot = document.getElementById('databaseRenameSlot');
    if (!renameSlot) return;
    renameSlot.addEventListener('change', () => {
      this._fillRenameInputFromSelectedSlot();
    });
  },

  _refreshDatabaseEditor() {
    const switchForm = document.getElementById('databaseSwitchForm');
    const nameEntryBtn = document.getElementById('databaseNameEntryBtn');
    const switchInput = document.getElementById('databaseNameInput');
    const count = window.AuthService.getDatabaseCount();
    if (!count) return;

    const singleDatabaseMode = count <= 1;
    if (switchForm) switchForm.hidden = singleDatabaseMode;
    if (nameEntryBtn) nameEntryBtn.hidden = singleDatabaseMode;
    if (switchInput) {
      switchInput.disabled = singleDatabaseMode;
      switchInput.placeholder = singleDatabaseMode
        ? '仅保留数据库1'
        : '输入数据库名字或编号(1-10)';
      switchInput.setAttribute(
        'aria-label',
        singleDatabaseMode ? '仅保留数据库1' : '输入数据库名字或编号(1-10)'
      );
    }

    this._renderDatabaseOptions();
    this._setCurrentDatabaseNameInput();
    this._fillRenameInputFromSelectedSlot();
  },

  _refreshAuthUI() {
    const status = document.getElementById('authStatus');
    const hint = document.getElementById('authHint');
    const switchInput = document.getElementById('databaseNameInput');
    const switchForm = document.getElementById('databaseSwitchForm');
    const nameEntryBtn = document.getElementById('databaseNameEntryBtn');
    const dbLabel = document.getElementById('databaseLabel');

    if (!this.cloudSyncEnabled || !window.AuthService) {
      status.textContent = '本地模式';
      hint.textContent = '未配置云端同步服务，当前为本地存储模式。';
      switchInput.disabled = true;
      dbLabel.textContent = '数据库: 本地';
      return;
    }

    const user = window.AuthService.getUser();
    const singleDatabaseMode = window.AuthService.getDatabaseCount() <= 1;
    this.selectedDatabaseSlot = window.AuthService.getSelectedDatabaseSlot();
    const dbName = window.AuthService.getDatabaseName(this.selectedDatabaseSlot);
    switchInput.disabled = !user || singleDatabaseMode;
    if (switchForm) switchForm.hidden = singleDatabaseMode;
    if (nameEntryBtn) nameEntryBtn.hidden = singleDatabaseMode;
    dbLabel.textContent = `数据库: ${dbName}`;
    status.textContent = user ? '云端已连接' : '未连接';
    hint.textContent = singleDatabaseMode
      ? '当前仅保留数据库1。'
      : '可编辑数据库名字；在页头输入数据库名字或编号（1-10）即可切换。';
    this._refreshDatabaseEditor();
  },

  async _syncDatabaseFromCloud(options = {}) {
    const { seedDefaultWhenEmpty = false } = options;
    if (!this.cloudSyncEnabled || !window.AuthService) return;
    const slot = window.AuthService.getSelectedDatabaseSlot();
    const cloudAttractions = await window.AuthService.loadDatabase(slot);
    if (!Array.isArray(cloudAttractions)) return;

    if (
      seedDefaultWhenEmpty &&
      slot === DEFAULT_STARTUP_DATABASE_SLOT &&
      cloudAttractions.length === 0 &&
      Array.isArray(window.DEFAULT_ATTRACTIONS) &&
      window.DEFAULT_ATTRACTIONS.length
    ) {
      // If this device already has local data, push it first to avoid overriding user edits.
      if (Array.isArray(this.attractions) && this.attractions.length) {
        const pushed = await window.AuthService.saveDatabase(slot, this.attractions);
        if (pushed) return;
        console.warn('Failed to bootstrap empty cloud db-1 from local data.');
      }

      // Seed db-1 once so first open always lands on the built-in 100-item checklist.
      Store.replaceAll([]);
      this.attractions = Store.addBatch(window.DEFAULT_ATTRACTIONS);
      this.expandedIds.clear();
      const seeded = await window.AuthService.saveDatabase(slot, this.attractions);
      if (!seeded) {
        console.warn('Failed to seed default db-1 payload to cloud; local fallback is active.');
      }
      return;
    }

    this.selectedDatabaseSlot = slot;
    this.attractions = Store.replaceAll(cloudAttractions);
    this.expandedIds.clear();
  },

  _scheduleCloudSave() {
    if (this.cloudSaveTimer) clearTimeout(this.cloudSaveTimer);
    this.cloudSaveTimer = setTimeout(() => {
      this._saveDatabaseToCloud().catch((err) => {
        console.error('Unexpected cloud save error:', err);
      });
    }, CLOUD_SAVE_DEBOUNCE_MS);
  },

  async _saveDatabaseToCloud() {
    if (!this.cloudSyncEnabled || !window.AuthService) return;
    const slot = window.AuthService.getSelectedDatabaseSlot();
    const ok = await window.AuthService.saveDatabase(slot, this.attractions);
    if (!ok) {
      console.warn('Cloud database sync failed; local result was kept.');
      if (!this.cloudSyncWarned) {
        this.cloudSyncWarned = true;
        alert('云端保存失败，当前仅保存在本地浏览器。');
      }
    } else {
      this.cloudSyncWarned = false;
    }
  },

  _openManagerDrawer() {
    document.getElementById('managerDrawer').hidden = false;
  },

  _closeManagerDrawer() {
    document.getElementById('managerDrawer').hidden = true;
  },

  _openAuthModal() {
    this._refreshDatabaseEditor();
    document.getElementById('authModal').hidden = false;
  },

  _closeAuthModal() {
    document.getElementById('authModal').hidden = true;
  },

  /* ---- file handling ---- */
  async _handleFile(file) {
    const loading = document.getElementById('loadingOverlay');
    loading.hidden = false;
    try {
      const parsed = await Parser.parse(file);
      if (!parsed.length) {
        alert('未能从文件中解析出景点数据，请检查文件内容和格式。');
        return;
      }
      this.attractions = Store.addBatch(parsed);
      this._scheduleCloudSave();
      this.render();
    } catch (err) {
      console.error(err);
      alert('文件解析失败：' + err.message);
    } finally {
      loading.hidden = true;
    }
  },

  /* ---- full render ---- */
  render() {
    const hasAttractions = this.attractions.length > 0;
    document.getElementById('importSection').hidden = hasAttractions;
    document.getElementById('attractionsSection').hidden = !hasAttractions;
    this._renderStats();
    this._renderTagBrowser();
    this._renderDeleteOptions();
    this._renderList();
  },

  /* ---- stats + progress bar ---- */
  _renderStats() {
    const total = this.attractions.length;
    const visited = this.attractions.filter((a) => a.visited).length;
    document.getElementById('stats').textContent = `已打卡: ${visited} / ${total}`;
    const pct = total > 0 ? (visited / total) * 100 : 0;
    document.getElementById('progressBar').style.width = `${pct}%`;
  },

  /* ---- list render ---- */
  _renderList() {
    const list = document.getElementById('attractionsList');
    const keywords = this.searchQuery
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((k) => k.toLowerCase());

    const filtered = this.attractions.filter((a) => {
      const statusMatched =
        this.filter === 'visited' ? a.visited : this.filter === 'unvisited' ? !a.visited : true;
      if (!statusMatched) return false;
      if (this.tagFilter) {
        const tags = normalizeTagList(a.tags);
        const keySet = new Set(tags.map((t) => this._tagKey(t.level, t.name)));
        if (!keySet.has(this.tagFilter)) return false;
      }
      if (keywords.length) {
        const haystack = [
          a.name,
          a.description,
          ...normalizeTagList(a.tags).map((t) => t.name),
        ]
          .join(' ')
          .toLowerCase();
        return keywords.every((kw) => haystack.includes(kw));
      }
      return true;
    });

    if (!filtered.length) {
      const msg = keywords.length
        ? `未找到与"${esc(this.searchQuery.trim())}"相关的景点`
        : this.tagFilter
        ? '该标签下暂无景点'
        : '暂无景点数据';
      list.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">🗺️</span>
          ${msg}
        </div>`;
      return;
    }

    list.innerHTML = filtered.map((a) => this._cardHTML(a)).join('');

    // Bind per-card events after render
    filtered.forEach((a) => this._bindCardEvents(a.id));
  },

  /* ---- card HTML template ---- */
  _cardHTML(a) {
    const expanded = this.expandedIds.has(a.id);
    const mediaItems = normalizeMediaList(a.photos);
    const tags = normalizeTagList(a.tags);
    const tagsHTML = tags.length
      ? `<div class="tag-list">
           ${tags
              .map((tag) => {
                const level = Math.max(1, Math.min(5, Number(tag.level) || 1));
                return `<span class="tag-badge level-${level}">L${level} · ${esc(tag.name)}</span>`;
              })
              .join('')}
         </div>`
      : '';

    const descHTML = a.description
      ? `<div class="description-section">
           <div class="description-label">景点介绍</div>
           <p class="description">${esc(a.description)}</p>
         </div>`
      : '';

    const visitDetailsHTML = a.visited
      ? `<div class="visit-details">
           <h4>📝 我的打卡记录</h4>
           <textarea
             class="notes-input"
             data-id="${a.id}"
             placeholder="写下你的游览感受、评分或注意事项…"
             aria-label="游览感受"
           >${esc(a.notes)}</textarea>

           <div class="photo-section">
             <h4>📷 打卡照片 / 实况</h4>
             <div class="photo-grid" id="photos-${a.id}">
               ${mediaItems
                 .map((media, idx) => {
                   const src = esc(media.src);
                   const mediaThumb =
                     media.kind === 'video'
                       ? `<video src="${src}" class="media-thumb video-thumb" data-src="${src}" data-kind="video" muted playsinline preload="metadata" aria-label="实况视频 ${idx + 1}"></video>
                          <span class="photo-live-badge">LIVE</span>`
                       : `<img src="${src}" alt="打卡照片 ${idx + 1}" data-src="${src}" data-kind="image" class="media-thumb photo-thumb">`;
                   return `
                 <div class="photo-item">
                   ${mediaThumb}
                   <button class="photo-delete" data-id="${a.id}" data-idx="${idx}"
                           aria-label="删除照片">✕</button>
                 </div>`;
                 })
                 .join('')}
               <label class="photo-add" title="添加照片或实况" aria-label="添加照片或实况">
                 <input type="file" accept="${MEDIA_UPLOAD_ACCEPT}" multiple hidden
                        class="photo-upload-input" data-id="${a.id}">
                 <span class="photo-add-icon">＋</span>
                 <span class="photo-add-text">上传实况</span>
               </label>
             </div>
           </div>
         </div>`
      : `<div class="unvisited-hint">勾选左侧方框后，可在此记录游览感受和照片/实况</div>`;

    return `
      <div class="attraction-card ${a.visited ? 'visited' : ''}" id="card-${a.id}">
        <div class="card-header">
          <label class="checkbox-container" aria-label="标记已打卡">
            <input type="checkbox" class="visit-checkbox" data-id="${a.id}"
                   ${a.visited ? 'checked' : ''}>
            <span class="checkmark"></span>
          </label>
          <div class="card-title-area">
            <h3 class="attraction-name ${a.visited ? 'visited-name' : ''}">
              ${esc(a.name)}
            </h3>
            ${tagsHTML}
            ${a.visitDate ? `<span class="visit-date">📅 打卡时间：${esc(a.visitDate)}</span>` : ''}
          </div>
          <button class="expand-btn" data-id="${a.id}"
                  aria-expanded="${expanded}"
                  aria-label="${expanded ? '收起详情' : '展开详情'}">
            ${expanded ? '▲' : '▼'}
          </button>
        </div>
        <div class="card-body ${expanded ? 'expanded' : 'collapsed'}">
          ${descHTML}
          ${visitDetailsHTML}
        </div>
      </div>`;
  },

  /* ---- bind per-card events ---- */
  _bindCardEvents(id) {
    const card = document.getElementById(`card-${id}`);
    if (!card) return;

    /* Expand / collapse button */
    const expandBtn = card.querySelector('.expand-btn');
    if (expandBtn) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleExpand(id);
      });
    }

    /* Clicking on title also toggles */
    const titleArea = card.querySelector('.card-title-area');
    if (titleArea) {
      titleArea.addEventListener('click', () => this._toggleExpand(id));
    }

    /* Checkbox */
    const checkbox = card.querySelector('.visit-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', async () => {
        await this._toggleVisit(id, checkbox.checked);
      });
    }

    /* Notes textarea — debounced save */
    const textarea = card.querySelector('.notes-input');
    if (textarea) {
      let timer;
      textarea.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.attractions = Store.update(id, { notes: textarea.value });
          this._scheduleCloudSave();
        }, 500);
      });
    }

    /* Media thumbnails — open lightbox */
    card.querySelectorAll('.media-thumb').forEach((thumb) => {
      thumb.addEventListener('click', () => {
        this._openLightbox({
          src: thumb.dataset.src,
          kind: thumb.dataset.kind,
        });
      });
    });

    /* Photo delete buttons */
    card.querySelectorAll('.photo-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._deletePhoto(Number(btn.dataset.id), Number(btn.dataset.idx));
      });
    });

    /* Photo upload input */
    const uploadInput = card.querySelector('.photo-upload-input');
    if (uploadInput) {
      uploadInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
          this._uploadPhotos(id, e.target.files);
          e.target.value = '';
        }
      });
    }
  },

  /* ---- expand / collapse ---- */
  _toggleExpand(id) {
    if (this.expandedIds.has(id)) {
      this.expandedIds.delete(id);
    } else {
      this.expandedIds.add(id);
    }
    // In-place DOM update — no full re-render needed
    const card = document.getElementById(`card-${id}`);
    if (!card) return;
    const body = card.querySelector('.card-body');
    const btn = card.querySelector('.expand-btn');
    const isNowExpanded = this.expandedIds.has(id);
    if (body) {
      body.classList.toggle('expanded', isNowExpanded);
      body.classList.toggle('collapsed', !isNowExpanded);
    }
    if (btn) {
      btn.textContent = isNowExpanded ? '▲' : '▼';
      btn.setAttribute('aria-expanded', String(isNowExpanded));
      btn.setAttribute('aria-label', isNowExpanded ? '收起详情' : '展开详情');
    }
  },

  /* ---- mark visited / unvisited ---- */
  async _toggleVisit(id, visited) {
    // Flush any pending notes before re-render
    const textarea = document.querySelector(`.notes-input[data-id="${id}"]`);
    if (textarea) {
      this.attractions = Store.update(id, { notes: textarea.value });
      this._scheduleCloudSave();
    }

    const visitDate = visited ? new Date().toLocaleDateString('zh-CN') : null;
    this.attractions = Store.update(id, { visited, visitDate });
    this._scheduleCloudSave();

    // Auto-expand when marking visited so user can add notes/photos immediately
    if (visited) this.expandedIds.add(id);

    this._renderStats();
    this._renderList();
  },

  /* ---- photo upload ---- */
  async _uploadPhotos(id, files) {
    const attraction = this.attractions.find((a) => a.id === id);
    if (!attraction) return;
    const existingMedia = normalizeMediaList(attraction.photos);
    const nextMedia = [...existingMedia];
    const rejected = [];

    for (const file of Array.from(files || [])) {
      if (nextMedia.length >= MAX_MEDIA_ITEMS_PER_ATTRACTION) {
        rejected.push(`${file.name}（超过每个景点最多 ${MAX_MEDIA_ITEMS_PER_ATTRACTION} 个媒体的限制）`);
        continue;
      }

      if (!isSupportedMediaFile(file)) {
        rejected.push(`${file.name}（仅支持图片或视频文件）`);
        continue;
      }

      if (Number(file.size || 0) > MAX_MEDIA_FILE_SIZE_BYTES) {
        rejected.push(`${file.name}（文件超过 ${MAX_MEDIA_FILE_SIZE_MB}MB）`);
        continue;
      }

      try {
        const dataUrl = await readFileAsDataURL(file);
        if (!dataUrl) {
          rejected.push(`${file.name}（读取失败）`);
          continue;
        }
        nextMedia.push({
          kind: inferMediaKindFromFile(file, dataUrl),
          src: dataUrl,
        });
      } catch (e) {
        console.error(e);
        rejected.push(`${file.name}（读取失败）`);
      }
    }

    if (nextMedia.length === existingMedia.length) {
      if (rejected.length) {
        alert(`没有可上传的媒体文件：\n${rejected.slice(0, 5).join('\n')}`);
      }
      return;
    }

    try {
      this.attractions = Store.update(id, { photos: nextMedia });
      this._scheduleCloudSave();
      this._renderList();

      if (rejected.length) {
        const brief = rejected.slice(0, 5).join('\n');
        const suffix =
          rejected.length > 5 ? `\n...另外还有 ${rejected.length - 5} 个文件未上传。` : '';
        alert(`部分文件未上传：\n${brief}${suffix}`);
      }
    } catch (e) {
      console.error(e);
      alert('媒体上传失败，请重试。');
    }
  },

  /* ---- photo delete ---- */
  _deletePhoto(id, idx) {
    const attraction = this.attractions.find((a) => a.id === id);
    if (!attraction) return;
    const photos = normalizeMediaList(attraction.photos);
    if (idx < 0 || idx >= photos.length) return;
    photos.splice(idx, 1);
    this.attractions = Store.update(id, { photos });
    this._scheduleCloudSave();
    this._renderList();
  },

  _tagKey(level, name) {
    return `${Math.max(1, Math.min(5, Number(level) || 1))}${TAG_KEY_SEPARATOR}${String(name || '').trim()}`;
  },

  _collectTagStats() {
    const map = new Map();
    this.attractions.forEach((a) => {
      normalizeTagList(a.tags).forEach((tag) => {
        const key = this._tagKey(tag.level, tag.name);
        if (!map.has(key)) map.set(key, { ...tag, count: 0 });
        map.get(key).count += 1;
      });
    });
    return Array.from(map.entries())
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => a.level - b.level || b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
  },

  _renderTagBrowser() {
    const wrapper = document.getElementById('tagBrowser');
    const list = document.getElementById('tagBrowserList');
    const clearBtn = document.getElementById('clearTagFilterBtn');
    const tags = this._collectTagStats();
    clearBtn.hidden = !this.tagFilter;
    wrapper.hidden = false;

    if (!tags.length) {
      list.innerHTML = '<div class="tag-pill-empty">暂无可用标签</div>';
      return;
    }

    list.innerHTML = tags
      .map(
        (tag) => `
          <button class="tag-pill ${this.tagFilter === tag.key ? 'active' : ''}" data-tag-key="${esc(tag.key)}">
            L${tag.level} · ${esc(tag.name)} (${tag.count})
          </button>`
      )
      .join('');

    list.querySelectorAll('.tag-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.tagFilter = btn.dataset.tagKey;
        this._renderTagBrowser();
        this._renderList();
      });
    });
  },

  _renderDeleteOptions() {
    const select = document.getElementById('deleteAttractionSelect');
    if (!this.attractions.length) {
      select.innerHTML = '<option value="">暂无可删除内容</option>';
      select.disabled = true;
      return;
    }

    select.disabled = false;
    select.innerHTML = this.attractions
      .map((a) => `<option value="${a.id}">${esc(a.name)}</option>`)
      .join('');
  },

  _addAttraction() {
    const nameInput = document.getElementById('newAttractionName');
    const descInput = document.getElementById('newAttractionDescription');
    const tagInput = document.getElementById('newAttractionTag');
    const name = nameInput.value.trim();
    if (!name) {
      alert('请先填写景点名称。');
      return;
    }
    const tagName = tagInput.value.trim();
    const tags = tagName ? [{ level: 1, name: tagName }] : [];
    this.attractions = Store.addOne({
      name,
      description: descInput.value.trim(),
      tags,
    });
    this._scheduleCloudSave();
    nameInput.value = '';
    descInput.value = '';
    tagInput.value = '';
    this.render();
  },

  _deleteAttraction() {
    const select = document.getElementById('deleteAttractionSelect');
    const id = Number(select.value);
    if (!id) return;
    const target = this.attractions.find((a) => a.id === id);
    if (!target) return;
    if (!confirm(`确定删除「${target.name}」吗？此操作不可撤销。`)) return;
    this.expandedIds.delete(id);
    this.attractions = Store.remove(id);
    this._scheduleCloudSave();
    if (this.tagFilter) {
      const stillExists = this.attractions.some((a) =>
        normalizeTagList(a.tags).some((t) => this._tagKey(t.level, t.name) === this.tagFilter)
      );
      if (!stillExists) this.tagFilter = null;
    }
    this.render();
  },

  /* ---- lightbox ---- */
  _closeLightbox() {
    const modal = document.getElementById('photoModal');
    const image = document.getElementById('modalImage');
    const video = document.getElementById('modalVideo');
    modal.hidden = true;
    image.hidden = true;
    image.src = '';
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.hidden = true;
      video.load();
    }
  },

  _openLightbox(media) {
    const normalized = normalizeMediaEntry(media) || normalizeMediaEntry(String(media || ''));
    if (!normalized) return;

    const modal = document.getElementById('photoModal');
    const image = document.getElementById('modalImage');
    const video = document.getElementById('modalVideo');

    if (normalized.kind === 'video' && video) {
      image.hidden = true;
      image.src = '';
      video.hidden = false;
      video.src = normalized.src;
      video.currentTime = 0;
      video.play().catch(() => {});
    } else {
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.hidden = true;
        video.load();
      }
      image.hidden = false;
      image.src = normalized.src;
    }

    modal.hidden = false;
  },
};

/* ------------------------------------------------------------------
   5. Bootstrap
------------------------------------------------------------------ */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
