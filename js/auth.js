/* ============================================================
   Supabase Auth + Check-in Sync
   ============================================================ */

const VALID_PHOTO_DATA_URL_REGEX = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;

const AuthService = {
  CLOUD_DB_TABLE: 'attraction_databases',
  CLOUD_DB_COUNT: 10,
  CLOUD_DB_SLOT_KEY: 'beijing_cloud_db_slot_v1',
  client: null,
  user: null,
  enabled: false,
  initialized: false,
  listeners: [],

  async init() {
    if (this.initialized) return this.enabled;
    this.initialized = true;

    const config = window.SUPABASE_CONFIG || {};
    const { url, anonKey } = config;

    if (!window.supabase || !url || !anonKey) {
      this.enabled = false;
      return false;
    }

    try {
      this.client = window.supabase.createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });

      const { data: sessionData, error: sessionError } = await this.client.auth.getSession();
      if (sessionError) throw sessionError;

      this.user = sessionData?.session?.user || null;
      if (!this.user) {
        const { data, error } = await this.client.auth.signInAnonymously();
        if (error) throw error;
        this.user = data?.user || null;
      }

      this.client.auth.onAuthStateChange((_event, session) => {
        this.user = session?.user || null;
        this.listeners.forEach((cb) => cb(this.user));
      });

      this.enabled = true;
      return true;
    } catch (err) {
      console.error('Supabase initialization failed:', err);
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
      const raw = Number(localStorage.getItem(this.CLOUD_DB_SLOT_KEY));
      if (Number.isInteger(raw) && raw >= 1 && raw <= this.CLOUD_DB_COUNT) return raw;
      return 1;
    } catch (_) {
      return 1;
    }
  },

  setSelectedDatabaseSlot(slot) {
    const normalized = Number(slot);
    if (!Number.isInteger(normalized) || normalized < 1 || normalized > this.CLOUD_DB_COUNT) {
      return this.getSelectedDatabaseSlot();
    }
    try {
      localStorage.setItem(this.CLOUD_DB_SLOT_KEY, String(normalized));
    } catch (_) {
      // Ignore persistence failures and keep current slot in memory fallback.
    }
    return normalized;
  },

  getSafeRedirectUrl() {
    return `${window.location.origin}${window.location.pathname}`;
  },

  getUserLabel() {
    if (!this.user) return '未登录';
    if (this.user.is_anonymous) return '游客账号';
    return this.user.email || '已登录账号';
  },

  async useAnonymous() {
    if (!this.enabled) return { ok: false, message: '未配置 Supabase' };
    const current = await this.client.auth.getUser();
    if (current?.data?.user?.is_anonymous) {
      this.user = current.data.user;
      return { ok: true, message: '当前已是游客账号' };
    }
    const { data, error } = await this.client.auth.signInAnonymously();
    if (error) return { ok: false, message: error.message };
    this.user = data?.user || null;
    return { ok: true, message: '已切换到游客账号' };
  },

  async signInOrSignUp(email, password) {
    if (!this.enabled) return { ok: false, message: '未配置 Supabase' };
    const normalizedEmail = String(email || '').trim();
    const pass = String(password || '').trim();
    if (!normalizedEmail) return { ok: false, message: '请输入邮箱' };
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) return { ok: false, message: '邮箱格式不正确' };

    try {
      const current = this.getUser();
      if (current?.is_anonymous) {
        const updatePayload = pass
          ? { email: normalizedEmail, password: pass }
          : { email: normalizedEmail };
        const { error: updateError } = await this.client.auth.updateUser(updatePayload);
        if (updateError) return { ok: false, message: updateError.message };
        if (!pass) {
          const { error: otpError } = await this.client.auth.signInWithOtp({
            email: normalizedEmail,
            options: { emailRedirectTo: this.getSafeRedirectUrl() },
          });
          if (otpError) return { ok: false, message: otpError.message };
          return { ok: true, message: '已发送登录链接，请查收邮箱完成绑定。' };
        }
        return { ok: true, message: '账号已绑定邮箱。' };
      }

      if (pass) {
        const signInResp = await this.client.auth.signInWithPassword({
          email: normalizedEmail,
          password: pass,
        });
        if (!signInResp.error) return { ok: true, message: '登录成功' };

        const signInErrorText = String(signInResp.error.message || '');
        const canTrySignUp = /invalid login credentials|user not found|not registered/i.test(signInErrorText);
        if (!canTrySignUp) return { ok: false, message: signInErrorText || '登录失败' };

        const signUpResp = await this.client.auth.signUp({
          email: normalizedEmail,
          password: pass,
        });
        if (signUpResp.error) {
          const signUpErrorText = String(signUpResp.error.message || '');
          if (/already registered/i.test(signUpErrorText)) {
            return { ok: false, message: '账号已存在或密码错误，请重试。' };
          }
          return { ok: false, message: signUpErrorText || '注册失败' };
        }
        return { ok: true, message: '已注册，请按邮箱提示完成验证。' };
      }

      const { error: otpError } = await this.client.auth.signInWithOtp({
        email: normalizedEmail,
        options: { emailRedirectTo: this.getSafeRedirectUrl() },
      });
      if (otpError) return { ok: false, message: otpError.message };
      return { ok: true, message: '已发送登录链接，请查收邮箱。' };
    } catch (err) {
      return { ok: false, message: err.message || '登录失败' };
    }
  },

  async logout() {
    if (!this.enabled) return { ok: false, message: '未配置 Supabase' };
    const { error } = await this.client.auth.signOut();
    if (error) return { ok: false, message: error.message };
    const { data, error: anonErr } = await this.client.auth.signInAnonymously();
    if (anonErr) return { ok: false, message: anonErr.message };
    this.user = data?.user || null;
    return { ok: true, message: '已退出并切回游客账号' };
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
        ? item.photos.filter(
          (src) => typeof src === 'string' && VALID_PHOTO_DATA_URL_REGEX.test(src)
        )
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
      const { data, error } = await this.client
        .from(this.CLOUD_DB_TABLE)
        .select('payload')
        .eq('user_id', this.user.id)
        .eq('db_slot', dbSlot)
        .maybeSingle();
      if (error) throw error;
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
      const row = {
        user_id: this.user.id,
        db_slot: dbSlot,
        payload,
      };
      const { error } = await this.client
        .from(this.CLOUD_DB_TABLE)
        .upsert(row, { onConflict: 'user_id,db_slot' });
      if (error) throw error;
      return true;
    } catch (err) {
      console.error('Failed to save cloud database:', err);
      return false;
    }
  },
};

window.AuthService = AuthService;
