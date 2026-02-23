/* public/app.js
 * Regras:
 * - semana vigente: segunda a domingo (datas corretas)
 * - salvar automático
 * - Alberto/Mosna: podem editar qualquer oficial (dropdown)
 * - fechamento: sexta-feira 11h (São Paulo) bloqueia edição para oficiais
 *   e libera para Alberto/Mosna se marcar "alterar após fechamento"
 * - PDF: somente Alberto/Mosna, sempre com assinatura, e com todos os oficiais em tabela
 */

(() => {
  "use strict";
  const $ = (sel) => document.querySelector(sel);

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeName(nome) {
    return String(nome || "").trim().replace(/\s+/g, " ");
  }

  function getWeekRangeISO(baseDate = new Date()) {
    const d = new Date(baseDate);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // 0=dom..6=sab
    const diffToMonday = (day === 0 ? -6 : 1) - day;

    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    return { monday, sunday };
  }

  function toISODate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function listDatesISO(fromDate, toDate) {
    const out = [];
    const cur = new Date(fromDate);
    cur.setHours(0, 0, 0, 0);

    const end = new Date(toDate);
    end.setHours(0, 0, 0, 0);

    while (cur <= end) {
      out.push(toISODate(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  function diaSemanaPt(isoDate) {
    const [y, m, d] = isoDate.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    const dias = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
    return dias[dt.getDay()];
  }

  // =========================
  // API_BASE
  // =========================
  function resolveApiBase() {
    const url = new URL(location.href);
    const apiFromQuery = url.searchParams.get("api");
    if (apiFromQuery) return apiFromQuery.replace(/\/$/, "");
    const apiFromStorage = localStorage.getItem("API_BASE");
    if (apiFromStorage) return apiFromStorage.replace(/\/$/, "");
    return "";
  }
  const API_BASE = resolveApiBase();

  // =========================
  // Auth / Request
  // =========================
  const AUTH = {
    key: localStorage.getItem("ACCESS_KEY") || "",
    nome: localStorage.getItem("USER_NAME") || "",
    role: localStorage.getItem("ROLE") || "",
  };

  function setAuth({ key, nome, role = "" }) {
    AUTH.key = key || "";
    AUTH.nome = nome || "";
    AUTH.role = role || "";
    localStorage.setItem("ACCESS_KEY", AUTH.key);
    localStorage.setItem("USER_NAME", AUTH.nome);
    localStorage.setItem("ROLE", AUTH.role);
  }

  function clearAuth() {
    AUTH.key = "";
    AUTH.nome = "";
    AUTH.role = "";
    localStorage.removeItem("ACCESS_KEY");
    localStorage.removeItem("USER_NAME");
    localStorage.removeItem("ROLE");
  }

  const ADMIN_NAMES = ["Alberto Franzini Neto", "Eduardo Mosna Xavier"];
  function isAdmin() { return ADMIN_NAMES.includes((AUTH.nome || "").trim()); }

  function getTargetUser() {
    if (!isAdmin()) return AUTH.nome;
    const sel = $("#adminTarget");
    return (sel && sel.value) ? sel.value : AUTH.nome;
  }

  function getAdminOverride() {
    if (!isAdmin()) return false;
    const cb = $("#adminOverride");
    return !!(cb && cb.checked);
  }

  async function request(path, { method = "GET", body = null, headers = {}, isBlob = false } = {}) {
    const url = API_BASE ? `${API_BASE}${path}` : path;

    const h = { ...headers };
    if (AUTH.key) h["x-access-key"] = AUTH.key;
    if (AUTH.nome) h["x-user-name"] = AUTH.nome;

    // admin pode editar outro oficial
    const target = getTargetUser();
    if (target && target !== AUTH.nome) h["x-target-user"] = target;

    // admin override após fechamento
    if (getAdminOverride()) h["x-admin-override"] = "1";

    let payload;
    if (body !== null && body !== undefined) {
      h["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const resp = await fetch(url, { method, headers: h, body: payload });

    if (isBlob) {
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(txt || `HTTP ${resp.status}`);
      }
      return await resp.blob();
    }

    const txt = await resp.text().catch(() => "");
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = txt ? { raw: txt } : null; }

    if (!resp.ok) {
      const msg =
        (data && (data.error || data.message || data.details)) ||
        (data && data.raw) ||
        `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // =========================
  // State
  // =========================
  const CODES_CORRETOS = ["", "EXP", "SR", "FO", "MA", "VE", "LP", "FÉRIAS", "CFP_DIA", "CFP_NOITE", "OUTROS"];

  const DEFAULT_STATE = {
    meta: { title: "Escala Semanal de Oficiais", author: "Desenvolvido por Alberto Franzini Neto", created_at: new Date().toISOString() },
    period: { start: "", end: "" },
    dates: [],
    codes: CODES_CORRETOS,
    byUser: {},
    updated_at: new Date().toISOString(),
  };

  let STATE = null;
  let IS_DIRTY = false;
  let SAVE_TIMER = null;
  let SAVE_IN_FLIGHT = false;

  function renderSaveStatus(text = null) {
    const el = $("#saveStatus");
    if (!el) return;
    if (!AUTH.nome) { el.style.display = "none"; el.textContent = ""; return; }
    el.style.display = "inline-block";
    el.textContent = (text !== null) ? text : (IS_DIRTY ? "salvando..." : "salvo");
  }

  function renderLockStatus(isClosed) {
    const el = $("#lockStatus");
    if (!el) return;
    if (!AUTH.nome) { el.style.display = "none"; el.textContent = ""; return; }
    el.style.display = "inline-block";
    el.textContent = isClosed ? "fechado (sexta 11h)" : "aberto";
  }

  function markDirty(v) { IS_DIRTY = !!v; renderSaveStatus(); }

  function ensureWeek(state) {
    if (!state.period) state.period = { start: "", end: "" };
    const needDates = !state.period.start || !state.period.end || !Array.isArray(state.dates) || state.dates.length !== 7;
    if (!needDates) return state;

    const { monday, sunday } = getWeekRangeISO(new Date());
    state.period.start = toISODate(monday);
    state.period.end = toISODate(sunday);
    state.dates = listDatesISO(monday, sunday);
    return state;
  }

  function ensureCodes(state) { state.codes = CODES_CORRETOS.slice(); return state; }

  function ensureUser(state, nome) {
    if (!state.byUser) state.byUser = {};
    if (!state.byUser[nome]) state.byUser[nome] = {};
    for (const d of state.dates || []) {
      if (!state.byUser[nome][d]) state.byUser[nome][d] = { code: "", obs: "" };
      if (state.byUser[nome][d].code === undefined) state.byUser[nome][d].code = "";
      if (state.byUser[nome][d].obs === undefined) state.byUser[nome][d].obs = "";
    }
    return state;
  }

  function renderAdminBox() {
    const box = $("#adminBox");
    const sel = $("#adminTarget");
    const cb = $("#adminOverride");
    if (!box || !sel || !cb) return;

    if (!isAdmin()) {
      box.style.display = "none";
      sel.innerHTML = "";
      cb.checked = false;
      return;
    }

    box.style.display = "block";

    const byUser = (STATE && STATE.byUser) ? STATE.byUser : {};
    const names = Array.from(new Set([AUTH.nome, ...Object.keys(byUser)])).sort((a,b)=>a.localeCompare(b,"pt-BR"));

    const current = sel.value || AUTH.nome;
    sel.innerHTML = names.map(n => `<option value="${escapeHtml(n)}"${n===current?" selected":""}>${escapeHtml(n)}</option>`).join("");

    sel.onchange = () => render();
    cb.onchange = () => {
      // ao marcar override, tenta salvar novamente se estiver sujo
      if (IS_DIRTY) scheduleAutoSave();
    };
  }

  function render() {
    const container = $("#semanaContainer");
    if (!container || !STATE) return;

    ensureCodes(STATE);
    ensureWeek(STATE);

    const target = getTargetUser();
    ensureUser(STATE, target);

    renderAdminBox();

    const dates = STATE.dates || [];
    const codes = STATE.codes || CODES_CORRETOS;

    let html = "";
    html += `<div style="margin-bottom:12px;">
      <div><strong>usuário:</strong> ${escapeHtml(AUTH.nome)}</div>
      <div><strong>editando:</strong> ${escapeHtml(target)}</div>
      <div><strong>período:</strong> ${escapeHtml(STATE.period.start)} a ${escapeHtml(STATE.period.end)}</div>
    </div>`;

    for (const d of dates) {
      const entry = (STATE.byUser && STATE.byUser[target] && STATE.byUser[target][d]) ? STATE.byUser[target][d] : { code:"", obs:"" };
      html += `
        <div class="dia-bloco" data-date="${escapeHtml(d)}">
          <h3 style="margin:0 0 10px 0;">${escapeHtml(d)} (${escapeHtml(diaSemanaPt(d))})</h3>

          <label>situação:</label>
          <select data-field="code">
            ${codes.map((c) => {
              const label = c === "" ? "(vazio)" : c;
              return `<option value="${escapeHtml(c)}"${c===entry.code ? " selected":""}>${escapeHtml(label)}</option>`;
            }).join("")}
          </select>

          <label>observações:</label>
          <textarea data-field="obs" placeholder="Digite observações do dia...">${escapeHtml(entry.obs || "")}</textarea>
        </div>
      `;
    }

    container.innerHTML = html;
    container.querySelectorAll('select[data-field], textarea[data-field]').forEach((el) => {
      el.addEventListener("change", onEntryChange);
      el.addEventListener("input", onEntryChange);
    });
  }

  function onEntryChange(e) {
    if (!STATE || !AUTH.nome) return;

    const el = e.target;
    const bloco = el.closest(".dia-bloco");
    if (!bloco) return;
    const date = bloco.getAttribute("data-date");
    const field = el.getAttribute("data-field");
    if (!date || !field) return;

    const target = getTargetUser();
    ensureUser(STATE, target);
    STATE.byUser[target][date][field] = el.value;
    STATE.updated_at = new Date().toISOString();

    markDirty(true);
    scheduleAutoSave();
  }

  function scheduleAutoSave() {
    if (SAVE_TIMER) clearTimeout(SAVE_TIMER);
    SAVE_TIMER = setTimeout(() => autoSave().catch(()=>{}), 800);
  }

  async function autoSave() {
    if (!STATE || !IS_DIRTY) return;
    if (SAVE_IN_FLIGHT) return;

    SAVE_IN_FLIGHT = true;
    renderSaveStatus("salvando...");

    try {
      await request("/api/state", { method: "PUT", body: STATE });
      markDirty(false);
      renderSaveStatus("salvo");
    } catch (err) {
      // se estiver fechado, backend devolve erro; mostra na tela
      renderSaveStatus("não salvo");
      alert(`Não foi possível salvar.\n\nDetalhes: ${err.message || err}`);
    } finally {
      SAVE_IN_FLIGHT = false;
    }
  }

  async function loadState() {
    let st = null;
    try {
      st = await request("/api/state", { method: "GET" });
    } catch (err) {
      console.warn("Falha ao carregar /api/state:", err.message || err);
    }
    if (!st) st = structuredClone(DEFAULT_STATE);
    st = ensureWeek(st);
    st = ensureCodes(st);
    // garante que o usuário e (se admin) o alvo existam
    if (AUTH.nome) ensureUser(st, AUTH.nome);
    STATE = st;
    markDirty(false);
    render();
    await refreshLockStatus();
  }

  async function refreshLockStatus() {
    try {
      const r = await request("/api/lock", { method: "GET" });
      renderLockStatus(!!r.closed);
    } catch {
      // se não existir /api/lock, não quebra
      renderLockStatus(false);
    }
  }

  // =========================
  // PDF (somente 2 nomes)
  // =========================
  function canGeneratePdf() { return isAdmin(); }

  function applyPdfVisibility() {
    const btn = $("#btnPdf");
    if (!btn) return;
    btn.style.display = canGeneratePdf() ? "inline-block" : "none";
  }

  async function gerarPdf() {
    try {
      const blob = await request("/api/pdf", { method: "GET", isBlob: true });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      alert(`Não foi possível gerar/abrir o PDF.\n\nDetalhes: ${err.message || err}`);
    }
  }

  // =========================
  // Login / Logout
  // =========================
  async function doLogin(nome, key) {
    nome = normalizeName(nome);
    key = String(key || "").trim();

    if (!nome) throw new Error("Informe seu nome completo.");
    if (!key) throw new Error("Informe a chave de acesso.");

    try {
      const r = await request("/api/login", { method: "POST", body: { access_key: key, nome } });
      setAuth({ key, nome, role: (r && r.role) ? r.role : "" });
    } catch {
      setAuth({ key, nome, role: "" });
    }

    showApp();
    applyPdfVisibility();

    const btnPdf = $("#btnPdf");
    if (btnPdf) {
      btnPdf.removeEventListener("click", gerarPdf);
      btnPdf.addEventListener("click", gerarPdf);
    }

    await loadState();
  }

  function doLogout() {
    clearAuth();
    STATE = null;
    markDirty(false);
    showLogin();
    const n = $("#nome"); const c = $("#chave");
    if (n) n.value = ""; if (c) c.value = "";
  }

  function showLogin() {
    const a = $("#loginArea"); const b = $("#appArea");
    if (a) a.style.display = "block";
    if (b) b.style.display = "none";
    renderSaveStatus(null);
    renderLockStatus(false);
  }

  function showApp() {
    const a = $("#loginArea"); const b = $("#appArea");
    if (a) a.style.display = "none";
    if (b) b.style.display = "block";
    renderSaveStatus(null);
  }

  window.login = async function login() {
    try {
      await doLogin($("#nome")?.value ?? "", $("#chave")?.value ?? "");
    } catch (err) {
      alert(err.message || String(err));
    }
  };

  window.logout = function logout() { doLogout(); };

  async function boot() {
    const chaveEl = $("#chave");
    if (chaveEl) {
      chaveEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); window.login(); }
      });
    }

    if (AUTH.key && AUTH.nome) {
      showApp();
      applyPdfVisibility();

      const btnPdf = $("#btnPdf");
      if (btnPdf) {
        btnPdf.removeEventListener("click", gerarPdf);
        btnPdf.addEventListener("click", gerarPdf);
      }

      await loadState();
    } else {
      showLogin();
    }

    window.addEventListener("beforeunload", (e) => {
      if (IS_DIRTY) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  boot().catch((err) => {
    console.error(err);
    alert(`Falha ao iniciar.\n\nDetalhes: ${err.message || err}`);
  });
})();
