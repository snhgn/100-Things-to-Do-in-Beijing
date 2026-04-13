/* ============================================================
   Supabase Auth + Check-in Sync
   ============================================================ */

const AuthService = {
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

        const signUpResp = await this.client.auth.signUp({
          email: normalizedEmail,
          password: pass,
        });
        if (signUpResp.error) return { ok: false, message: signUpResp.error.message };
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

  async loadCheckins() {
    if (!this.enabled || !this.user) return null;
    try {
      const { data, error } = await this.client
        .from('checkins')
        .select('attraction_id, checked_at')
        .eq('user_id', this.user.id);
      if (error) throw error;
      const map = new Map();
      (data || []).forEach((row) => {
        map.set(Number(row.attraction_id), row.checked_at || null);
      });
      return map;
    } catch (err) {
      console.error('Failed to load cloud check-ins:', err);
      return null;
    }
  },

  async setCheckin(attractionId, checkedAt) {
    if (!this.enabled || !this.user) return false;
    try {
      const payload = {
        user_id: this.user.id,
        attraction_id: Number(attractionId),
        checked_at: checkedAt || null,
      };
      const { error } = await this.client
        .from('checkins')
        .upsert(payload, { onConflict: 'user_id,attraction_id' });
      if (error) throw error;
      return true;
    } catch (err) {
      console.error('Failed to write cloud check-in:', err);
      return false;
    }
  },

  async removeCheckin(attractionId) {
    if (!this.enabled || !this.user) return false;
    try {
      const { error } = await this.client
        .from('checkins')
        .delete()
        .eq('user_id', this.user.id)
        .eq('attraction_id', Number(attractionId));
      if (error) throw error;
      return true;
    } catch (err) {
      console.error('Failed to delete cloud check-in:', err);
      return false;
    }
  },
};

window.AuthService = AuthService;
