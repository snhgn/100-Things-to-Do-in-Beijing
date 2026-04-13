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

/* ------------------------------------------------------------------
   1. LocalStorage Store
------------------------------------------------------------------ */
const Store = {
  KEY: 'beijing_attractions_v1',

  getAll() {
    try {
      const raw = localStorage.getItem(this.KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  },

  _persist(list) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(list));
    } catch (e) {
      // Storage quota may be exceeded when photos are large
      alert('存储空间不足，部分数据（尤其是照片）可能无法保存。请删除一些照片后重试。');
    }
    return list;
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
      if (confirm('确定要清空所有景点数据吗？此操作不可撤销。')) {
        this.attractions = Store.clear();
        this.expandedIds.clear();
        this.tagFilter = null;
        this._scheduleCloudSave();
        this.render();
      }
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
    document.getElementById('authEntryBtn').addEventListener('click', () => {
      this._openAuthModal();
    });
    document.getElementById('authModalClose').addEventListener('click', () => {
      this._closeAuthModal();
    });
    document.getElementById('authModalBackdrop').addEventListener('click', () => {
      this._closeAuthModal();
    });
    document.getElementById('authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('authEmail').value.trim();
      // Keep password as-is to avoid changing intentionally entered leading/trailing spaces.
      const password = document.getElementById('authPassword').value;
      const result = await window.AuthService.signInOrSignUp(email, password);
      alert(result.message);
      if (result.ok) this._closeAuthModal();
      this._refreshAuthUI();
      if (result.ok) await this._syncDatabaseFromCloud();
      this.render();
    });
    document.getElementById('authAnonymousBtn').addEventListener('click', async () => {
      const result = await window.AuthService.useAnonymous();
      alert(result.message);
      this._refreshAuthUI();
      if (result.ok) await this._syncDatabaseFromCloud();
      this.render();
    });
    document.getElementById('authLogoutBtn').addEventListener('click', async () => {
      const result = await window.AuthService.logout();
      alert(result.message);
      this._refreshAuthUI();
      if (result.ok) await this._syncDatabaseFromCloud();
      this.render();
    });

    const dbSelect = document.getElementById('databaseSelect');
    dbSelect.addEventListener('change', async () => {
      await this._switchCloudDatabase(Number(dbSelect.value));
    });

    /* Photo lightbox close */
    document.getElementById('modalBackdrop').addEventListener('click', () => {
      document.getElementById('photoModal').hidden = true;
    });
    document.getElementById('modalClose').addEventListener('click', () => {
      document.getElementById('photoModal').hidden = true;
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
      document.getElementById('photoModal').hidden = true;
    });
  },

  async _initAuth() {
    if (!window.AuthService) {
      this.cloudSyncEnabled = false;
      this._refreshAuthUI();
      return;
    }
    const enabled = await window.AuthService.init();
    this.cloudSyncEnabled = enabled;
    this.selectedDatabaseSlot = window.AuthService.getSelectedDatabaseSlot();
    this._renderDatabaseOptions();
    this._refreshAuthUI();

    if (!enabled) return;

    window.AuthService.onAuthStateChange(async () => {
      this._refreshAuthUI();
      await this._syncDatabaseFromCloud();
      this._renderStats();
      this._renderList();
    });

    await this._syncDatabaseFromCloud();
  },

  _renderDatabaseOptions() {
    const dbSelect = document.getElementById('databaseSelect');
    if (!dbSelect || !window.AuthService) return;
    const count = window.AuthService.getDatabaseCount();
    dbSelect.innerHTML = Array.from({ length: count }, (_, i) => {
      const slot = i + 1;
      return `<option value="${slot}">库 ${slot}</option>`;
    }).join('');
    dbSelect.value = String(this.selectedDatabaseSlot);
  },

  _refreshAuthUI() {
    const status = document.getElementById('authStatus');
    const hint = document.getElementById('authHint');
    const logoutBtn = document.getElementById('authLogoutBtn');
    const anonymousBtn = document.getElementById('authAnonymousBtn');
    const dbSelect = document.getElementById('databaseSelect');
    const dbLabel = document.getElementById('databaseLabel');

    if (!this.cloudSyncEnabled || !window.AuthService) {
      status.textContent = '本地模式';
      hint.textContent = '未配置 Supabase，当前为本地存储模式。';
      logoutBtn.disabled = true;
      anonymousBtn.disabled = true;
      dbSelect.disabled = true;
      dbLabel.textContent = '库: 本地';
      return;
    }

    const user = window.AuthService.getUser();
    this.selectedDatabaseSlot = window.AuthService.getSelectedDatabaseSlot();
    dbSelect.value = String(this.selectedDatabaseSlot);
    dbSelect.disabled = !user;
    dbLabel.textContent = `库: ${this.selectedDatabaseSlot}`;
    status.textContent = window.AuthService.getUserLabel();
    hint.textContent = user?.is_anonymous
      ? '当前为游客账号，可填写邮箱（密码可选）升级为个人账号。可切换 10 个云端库。'
      : '已登录云端账号，当前库中的景点/感悟/照片会同步到服务器。';
    logoutBtn.disabled = !user;
    anonymousBtn.disabled = !!user?.is_anonymous;
  },

  async _syncDatabaseFromCloud() {
    if (!this.cloudSyncEnabled || !window.AuthService) return;
    const slot = window.AuthService.getSelectedDatabaseSlot();
    const cloudAttractions = await window.AuthService.loadDatabase(slot);
    if (!Array.isArray(cloudAttractions)) return;
    this.selectedDatabaseSlot = slot;
    this.attractions = Store.replaceAll(cloudAttractions);
    this.expandedIds.clear();
  },

  async _switchCloudDatabase(slot) {
    if (!this.cloudSyncEnabled || !window.AuthService) return;
    const normalized = window.AuthService.setSelectedDatabaseSlot(slot);
    this.selectedDatabaseSlot = normalized;
    await this._syncDatabaseFromCloud();
    this._refreshAuthUI();
    this.render();
  },

  _scheduleCloudSave() {
    if (this.cloudSaveTimer) clearTimeout(this.cloudSaveTimer);
    this.cloudSaveTimer = setTimeout(() => {
      this._saveDatabaseToCloud();
    }, 400);
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
    const photos = a.photos || [];
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
             <h4>📷 打卡照片</h4>
             <div class="photo-grid" id="photos-${a.id}">
               ${photos
                 .map(
                   (src, idx) => `
                 <div class="photo-item">
                   <img src="${esc(src)}" alt="打卡照片 ${idx + 1}"
                        data-src="${esc(src)}" class="photo-thumb">
                   <button class="photo-delete" data-id="${a.id}" data-idx="${idx}"
                           aria-label="删除照片">✕</button>
                 </div>`
                 )
                 .join('')}
               <label class="photo-add" title="添加照片" aria-label="添加照片">
                 <input type="file" accept="image/*" multiple hidden
                        class="photo-upload-input" data-id="${a.id}">
                 <span class="photo-add-icon">＋</span>
                 <span class="photo-add-text">添加照片</span>
               </label>
             </div>
           </div>
         </div>`
      : `<div class="unvisited-hint">勾选左侧方框后，可在此记录游览感受和照片</div>`;

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

    /* Photo thumbnails — open lightbox */
    card.querySelectorAll('.photo-thumb').forEach((img) => {
      img.addEventListener('click', () => this._openLightbox(img.dataset.src));
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
    const photos = [...(attraction.photos || [])];

    const readers = Array.from(files).map(
      (f) =>
        new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = (e) => resolve(e.target.result);
          r.onerror = reject;
          r.readAsDataURL(f);
        })
    );

    try {
      const results = await Promise.all(readers);
      results.forEach((dataUrl) => photos.push(dataUrl));
      this.attractions = Store.update(id, { photos });
      this._scheduleCloudSave();
      this._renderList();
    } catch (e) {
      console.error(e);
      alert('照片上传失败，请重试。');
    }
  },

  /* ---- photo delete ---- */
  _deletePhoto(id, idx) {
    const attraction = this.attractions.find((a) => a.id === id);
    if (!attraction) return;
    const photos = [...(attraction.photos || [])];
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
  _openLightbox(src) {
    document.getElementById('modalImage').src = src;
    document.getElementById('photoModal').hidden = false;
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
