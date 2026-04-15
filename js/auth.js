/* ============================================================
   Cloud Sync Service (Custom REST API)
   ============================================================ */

const VALID_MEDIA_DATA_URL_REGEX =
  /^data:(image|video)\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;

function inferMediaKindFromDataUrl(src) {
  return String(src || '').trim().toLowerCase().startsWith('data:video/')
    ? 'video'
    : 'image';
}

function normalizeMediaEntry(entry) {
  if (typeof entry === 'string') {
    const src = entry.trim();
    if (!src || !VALID_MEDIA_DATA_URL_REGEX.test(src)) return null;
    return {
      kind: inferMediaKindFromDataUrl(src),
      src,
    };
  }

  if (!entry || typeof entry !== 'object') return null;

  const src = String(entry.src || entry.url || '').trim();
  if (!src || !VALID_MEDIA_DATA_URL_REGEX.test(src)) return null;

  const rawKind = String(entry.kind || entry.type || '').toLowerCase();
  const kind = rawKind.includes('video')
    ? 'video'
    : rawKind.includes('image')
    ? 'image'
    : inferMediaKindFromDataUrl(src);

  return { kind, src };
}

const AuthService = {
  CLOUD_DB_COUNT: 1,
  DEFAULT_SHARED_USER_ID: 'beijing-shared-user',
  CLOUD_DB_SLOT_KEY: 'beijing_cloud_db_slot_v1',
  CLOUD_DB_NAMES_KEY: 'beijing_cloud_db_names_v1',
  CLOUD_USER_ID_KEY: 'beijing_cloud_user_id_v1',
  apiBaseUrl: '',
  apiKey: '',
  user: null,
  enabled: false,
  initialized: false,
  listeners: [],

  async init() {
    if (this.initialized) return this.enabled;
    this.initialized = true;

    const config = window.CLOUD_SYNC_CONFIG || {};
    const apiBaseUrl = String(config.apiBaseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(config.apiKey || '').trim();

    if (!apiBaseUrl) {
      this.enabled = false;
      return false;
    }

    this.apiBaseUrl = apiBaseUrl;
    this.apiKey = apiKey;

    const userId = this._resolveUserId(config.userId);
    this.user = { id: userId, is_anonymous: true };

    try {
      // Optional connectivity probe. Backend can skip implementation and this will be ignored.
      await this._request('GET', '/health', { allowFailure: true });
      this.enabled = true;
      this.listeners.forEach((cb) => cb(this.user));
      return true;
    } catch (err) {
      console.error('Cloud sync initialization failed:', err);
      this.enabled = false;
      this.user = null;
      return false;
    }
  },

  onAuthStateChange(callback) {
    if (typeof callback === 'function') this.listeners.push(callback);
  },

  getUser() {
    return this.user;
  },

  getDatabaseCount() {
    return this.CLOUD_DB_COUNT;
  },

  getSelectedDatabaseSlot() {
    try {
      localStorage.setItem(this.CLOUD_DB_SLOT_KEY, '1');
    } catch (_) {
      // Ignore persistence failures and fallback to slot 1 in memory.
    }
    return 1;
  },

  setSelectedDatabaseSlot(slot) {
    try {
      localStorage.setItem(this.CLOUD_DB_SLOT_KEY, '1');
    } catch (_) {
      // Ignore persistence failures and fallback to slot 1 in memory.
    }
    return 1;
  },

  _defaultDatabaseNames() {
    return Array.from({ length: this.CLOUD_DB_COUNT }, (_, i) => `库 ${i + 1}`);
  },

  _normalizeDatabaseName(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '');
  },

  getDatabaseNames() {
    try {
      const raw = localStorage.getItem(this.CLOUD_DB_NAMES_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(parsed)) return this._defaultDatabaseNames();
      const defaults = this._defaultDatabaseNames();
      return defaults.map((fallback, idx) => {
        const name = String(parsed[idx] || '').trim();
        return name || fallback;
      });
    } catch (parseError) {
      console.warn('Failed to read database names from local cache:', parseError);
      return this._defaultDatabaseNames();
    }
  },

  getDatabaseName(slot) {
    const normalized = Number(slot);
    if (!Number.isInteger(normalized) || normalized < 1 || normalized > this.CLOUD_DB_COUNT) {
      return '';
    }
    return this.getDatabaseNames()[normalized - 1];
  },

  setDatabaseName(slot, name) {
    const normalizedSlot = Number(slot);
    if (
      !Number.isInteger(normalizedSlot) ||
      normalizedSlot < 1 ||
      normalizedSlot > this.CLOUD_DB_COUNT
    ) {
      return { ok: false, message: '数据库编号无效' };
    }
    const nextName = String(name || '').trim();
    if (!nextName) return { ok: false, message: '数据库名字不能为空' };
    if (nextName.length > 30) return { ok: false, message: '数据库名字不能超过 30 个字符' };

    const names = this.getDatabaseNames();
    const normalizedName = this._normalizeDatabaseName(nextName);
    const duplicate = names.findIndex(
      (item, idx) =>
        idx !== normalizedSlot - 1 && this._normalizeDatabaseName(item) === normalizedName
    );
    if (duplicate !== -1) return { ok: false, message: '数据库名字已存在，请使用其他名字' };

    names[normalizedSlot - 1] = nextName;
    try {
      localStorage.setItem(this.CLOUD_DB_NAMES_KEY, JSON.stringify(names));
      return { ok: true, message: '数据库名字已更新', names };
    } catch (persistError) {
      console.warn('Failed to save database names to local cache:', persistError);
      return { ok: false, message: '保存失败，请稍后重试' };
    }
  },

  findDatabaseSlotByName(name) {
    const normalized = this._normalizeDatabaseName(name);
    if (!normalized) return null;
    const names = this.getDatabaseNames();
    const idx = names.findIndex((item) => this._normalizeDatabaseName(item) === normalized);
    return idx === -1 ? null : idx + 1;
  },

  _resolveUserId(configUserId) {
    const input = String(configUserId || '').trim();
    if (input) return input;

    // Use a deterministic shared ID by default so different devices can see the same data.
    try {
      localStorage.setItem(this.CLOUD_USER_ID_KEY, this.DEFAULT_SHARED_USER_ID);
    } catch (_) {
      // Ignore persistence failures and keep using the in-memory fallback.
    }
    return this.DEFAULT_SHARED_USER_ID;
  },

  getUserLabel() {
    if (!this.user) return '未连接';
    const id = String(this.user.id || '');
    if (!id) return '设备账号';
    return `设备账号(${id.slice(0, Math.min(8, id.length))})`;
  },

  _buildUrl(path, query) {
    const normalizedPath = String(path || '').replace(/^\/+/, '');
    const url = new URL(normalizedPath, `${this.apiBaseUrl}/`);
    if (query && typeof query === 'object') {
      Object.entries(query).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        url.searchParams.set(key, String(value));
      });
    }
    return url.toString();
  },

  async _request(method, path, options = {}) {
    const { query, body, allowFailure = false } = options;
    const headers = {
      Accept: 'application/json',
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const requestOptions = {
      method,
      headers,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestOptions.body = JSON.stringify(body);
    }

    const response = await fetch(this._buildUrl(path, query), requestOptions);

    if (allowFailure) return response.ok;

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `HTTP ${method} ${path} failed with ${response.status}${text ? `: ${text}` : ''}`
      );
    }

    if (response.status === 204) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;
    return response.json();
  },

  _sanitizeAttraction(item) {
    if (!item || typeof item !== 'object') return null;
    const normalizedId = Number(item.id);
    return {
      id: Number.isFinite(normalizedId) && normalizedId > 0 ? normalizedId : null,
      name: String(item.name || '未命名景点'),
      description: String(item.description || ''),
      tags: Array.isArray(item.tags) ? item.tags : [],
      visited: Boolean(item.visited),
      visitDate: item.visitDate || null,
      notes: String(item.notes || ''),
      photos: Array.isArray(item.photos)
        ? item.photos.map((entry) => normalizeMediaEntry(entry)).filter(Boolean)
        : [],
    };
  },

  _normalizeDatabasePayload(payload) {
    if (!Array.isArray(payload)) return [];
    const usedIds = new Set();
    let nextId = 1;
    const pickId = (preferredId) => {
      if (Number.isFinite(preferredId) && preferredId > 0 && !usedIds.has(preferredId)) {
        usedIds.add(preferredId);
        return preferredId;
      }
      while (usedIds.has(nextId)) nextId += 1;
      const allocated = nextId;
      usedIds.add(allocated);
      nextId += 1;
      return allocated;
    };
    return payload
      .map((item) => {
        const sanitized = this._sanitizeAttraction(item);
        if (!sanitized) return null;
        return { ...sanitized, id: pickId(sanitized.id) };
      })
      .filter(Boolean);
  },

  async loadDatabase(slot) {
    if (!this.enabled || !this.user) return null;
    const dbSlot = this.setSelectedDatabaseSlot(slot);
    try {
      const data = await this._request('GET', '/attraction-databases', {
        query: {
          user_id: this.user.id,
          db_slot: dbSlot,
        },
      });
      const payload = data?.payload;
      return this._normalizeDatabasePayload(payload);
    } catch (err) {
      console.error('Failed to load cloud database:', err);
      return null;
    }
  },

  async saveDatabase(slot, attractions) {
    if (!this.enabled || !this.user) return false;
    const dbSlot = this.setSelectedDatabaseSlot(slot);
    const payload = this._normalizeDatabasePayload(attractions);
    try {
      await this._request('PUT', '/attraction-databases', {
        body: {
          user_id: this.user.id,
          db_slot: dbSlot,
          payload,
        },
      });
      return true;
    } catch (err) {
      console.error('Failed to save cloud database:', err);
      return false;
    }
  },
};

window.AuthService = AuthService;
