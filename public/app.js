/* public/app.js
 * Escala Semanal de Oficiais (Railway/local)
 * Compatível com o index.html:
 * - #loginArea, #appArea, #semanaContainer
 * - inputs: #nome, #chave
 * - funções globais: login(), logout()
 *
 * Regras implementadas:
 * 1) semana vigente: segunda a domingo
 * 2) códigos: EXP, SR, FO, MA, VE, LP, FÉRIAS, CFP_DIA, CFP_NOITE, OUTROS
 * 3) salvar automático (debounce) ao editar qualquer dia (situação/observações)
 * 4) PDF: botão só aparece para:
 *    - Alberto Franzini Neto
 *    - Eduardo Mosna Xavier
 *    Observação: o backend precisa ter GET /api/pdf (senão dará 404)
 */

(() => {
  "use strict";

  // =========================
  // Helpers
  // =========================
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

  function safeJsonParse(txt) {
    try { return JSON.parse(txt); } catch { return null; }
  }

  // Semana vigente: segunda -> domingo
  function getWeekRangeISO(baseDate = new Date()) {
    const d = new Date(baseDate);
    d.setHours(0, 0, 0, 0);

    // JS: 0=domingo..6=sábado
    const day = d.getDay();
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
  // API_BASE resolver
  // =========================
  function resolveApiBase() {
    const url = new URL(location.href);

    // ?api=https://xxxx.up.railway.app
    const apiFromQuery = url.searchParams.get("api");
    if (apiFromQuery) return apiFromQuery.replace(/\/$/, "");

    const apiFromStorage = localStorage.getItem("API_BASE");
    if (apiFromStorage) return apiFromStorage.replace(/\/$/, "");

    // mesma origem
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

  async function request(path, { method = "GET", body = null, headers = {}, isBlob = false } = {}) {
    const url = API_BASE ? `${API_BASE}${path}` : path;

    const h = { ...headers };
    if (AUTH.key) h["x-access-key"] = AUTH.key;

    // útil para o backend decidir permissão do PDF por nome
    if (AUTH.nome) h["x-user-name"] = AUTH.nome;

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
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = txt ? { raw: txt } : null;
    }

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
    meta: {
      title: "Escala Semanal de Oficiais",
      author: "Desenvolvido por Alberto Franzini Neto",
      created_at: new Date().toISOString(),
    },
    period: { start: "", end: "" },
    dates: [],
    codes: CODES_CORRETOS,
    byUser: {},
    updated_at: new Date().toISOString(),
  };

  let STATE = null;
  let IS_DIRTY = false;

  function markDirty(v) {
    IS_DIRTY = !!v;
    renderSaveStatus();
  }

  function ensureWeek(state) {
    if (!state.period) state.period = { start: "", end: "" };

    const needDates =
      !state.period.start ||
      !state.period.end ||
      !Array.isArray(state.dates) ||
      state.dates.length !== 7;

    if (!needDates) return state;

    const { monday, sunday } = getWeekRangeISO(new Date());
    state.period.start = toISODate(monday);
    state.period.end = toISODate(sunday);
    state.dates = listDatesISO(monday, sunday);
    return state;
  }

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

  function ensureCodes(state) {
    state.codes = CODES_CORRETOS.slice();
    return state;
  }

  // =========================
  // Local fallback (se backend falhar)
  // =========================
  function localKeyForState(periodStart, periodEnd, nome) {
    const p = `${periodStart}_${periodEnd}`;
    const u = nome || "sem_usuario";
    return `ESCFOF_STATE_${u}_${p}`;
  }

  function saveLocalFallback() {
    try {
      if (!STATE || !AUTH.nome) return;
      const k = localKeyForState(STATE.period.start, STATE.period.end, AUTH.nome);
      localStorage.setItem(k, JSON.stringify(STATE));
    } catch (e) {
      console.warn("Falha ao salvar fallback local:", e);
    }
  }

  function loadLocalFallback(periodStart, periodEnd, nome) {
    try {
      const k = localKeyForState(periodStart, periodEnd, nome);
      const raw = localStorage.getItem(k);
      if (!raw) return null;
      return safeJsonParse(raw);
    } catch {
      return null;
    }
  }

  // =========================
  // Render
  // =========================
  function renderSaveStatus(text = null) {
    const el = $("#saveStatus");
    if (!el) return;

    if (!AUTH.nome) {
      el.style.display = "none";
      el.textContent = "";
      return;
    }

    el.style.display = "inline-block";

    if (text !== null) {
      el.textContent = text;
      return;
    }

    el.textContent = IS_DIRTY ? "salvando..." : "salvo";
  }

  function render() {
    const container = $("#semanaContainer");
    if (!container || !STATE) return;

    const nome = AUTH.nome;
    if (!nome) {
      container.innerHTML = "";
      return;
    }

    const dates = STATE.dates || [];
    const codes = Array.isArray(STATE.codes) ? STATE.codes : CODES_CORRETOS;

    let html = "";
    html += `<div style="margin-bottom:12px;">
      <div><strong>usuário:</strong> ${escapeHtml(nome)}</div>
      <div><strong>período:</strong> ${escapeHtml(STATE.period.start)} a ${escapeHtml(STATE.period.end)}</div>
    </div>`;

    for (const d of dates) {
      const entry =
        STATE.byUser && STATE.byUser[nome] && STATE.byUser[nome][d]
          ? STATE.byUser[nome][d]
          : { code: "", obs: "" };

      const code = entry.code || "";
      const obs = entry.obs || "";

      html += `
        <div class="dia-bloco" data-date="${escapeHtml(d)}">
          <h3 style="margin:0 0 10px 0;">${escapeHtml(d)} (${escapeHtml(diaSemanaPt(d))})</h3>

          <label>situação:</label>
          <select data-field="code">
            ${codes.map((c) => {
              const label = c === "" ? "(vazio)" : c;
              return `<option value="${escapeHtml(c)}"${c === code ? " selected" : ""}>${escapeHtml(label)}</option>`;
            }).join("")}
          </select>

          <label>observações:</label>
          <textarea data-field="obs" placeholder="Digite observações do dia...">${escapeHtml(obs)}</textarea>
        </div>
      `;
    }

    container.innerHTML = html;

    container.querySelectorAll('select[data-field], textarea[data-field]').forEach((el) => {
      el.addEventListener("change", onEntryChange);
      el.addEventListener("input", onEntryChange);
    });
  }

  // =========================
  // Auto-save (debounce)
  // =========================
  let SAVE_TIMER = null;
  let SAVE_IN_FLIGHT = false;

  function scheduleAutoSave() {
    if (SAVE_TIMER) clearTimeout(SAVE_TIMER);
    SAVE_TIMER = setTimeout(() => {
      autoSave().catch(() => void 0);
    }, 800);
  }

  async function autoSave() {
    if (!STATE || !IS_DIRTY) return;
    if (SAVE_IN_FLIGHT) return;

    SAVE_IN_FLIGHT = true;
    renderSaveStatus("salvando...");

    try {
      await saveState(false);
      renderSaveStatus("salvo");
    } catch (err) {
      console.warn("Falha ao salvar no backend; usando fallback local:", err.message || err);
      saveLocalFallback();
      renderSaveStatus("salvo local");
      // mantém IS_DIRTY true? Aqui não: o usuário não pode ficar “preso”.
      // Se quiser garantir insistência no backend, deixe como true.
      // Para simplicidade operacional: marca como salvo (local) e segue.
      IS_DIRTY = false;
    } finally {
      SAVE_IN_FLIGHT = false;
    }
  }

  function onEntryChange(e) {
    if (!STATE || !AUTH.nome) return;

    const el = e.target;
    const bloco = el.closest(".dia-bloco");
    if (!bloco) return;

    const date = bloco.getAttribute("data-date");
    const field = el.getAttribute("data-field");
    if (!date || !field) return;

    ensureUser(STATE, AUTH.nome);

    STATE.byUser[AUTH.nome][date][field] = el.value;
    STATE.updated_at = new Date().toISOString();

    markDirty(true);
    scheduleAutoSave();
  }

  // =========================
  // Load / Save
  // =========================
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
    st = ensureUser(st, AUTH.nome);

    // Se backend falhou, tenta fallback local específico desse período/usuário
    if (!st || !st.byUser || !st.byUser[AUTH.nome]) {
      const local = loadLocalFallback(st.period.start, st.period.end, AUTH.nome);
      if (local) {
        st = local;
        st = ensureWeek(st);
        st = ensureCodes(st);
        st = ensureUser(st, AUTH.nome);
      }
    }

    STATE = st;
    markDirty(false);
    render();

    // tenta persistir estrutura correta
    try {
      await saveState(false);
    } catch {
      saveLocalFallback();
    }
  }

  async function saveState(showAlert = true) {
    if (!STATE) return;

    ensureCodes(STATE);
    await request("/api/state", { method: "PUT", body: STATE });

    markDirty(false);
    if (showAlert) alert("Salvo com sucesso.");
  }

  // =========================
  // PDF visibility (somente 2 nomes)
  // =========================
  const PDF_ALLOWED_NAMES = [
    "Alberto Franzini Neto",
    "Eduardo Mosna Xavier"
  ];

  function canGeneratePdf() {
    const nome = (AUTH.nome || "").trim();
    return PDF_ALLOWED_NAMES.includes(nome);
  }

  function applyPdfVisibility() {
    const btn = $("#btnPdf");
    if (!btn) return;
    btn.style.display = canGeneratePdf() ? "inline-block" : "none";
  }

  async function gerarPdfSomenteAutorizado() {
    if (!canGeneratePdf()) {
      alert("PDF final disponível somente para Alberto Franzini Neto e Eduardo Mosna Xavier.");
      return;
    }

    // tenta salvar antes
    try {
      if (IS_DIRTY) {
        await saveState(false);
      }
    } catch {
      // mantém
      saveLocalFallback();
    }

    // chama PDF
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

    // tenta login no backend (se existir)
    try {
      const r = await request("/api/login", { method: "POST", body: { access_key: key, nome } });
      setAuth({ key, nome, role: r?.role || "" });
    } catch {
      setAuth({ key, nome, role: "" });
    }

    showApp();
    applyPdfVisibility();

    const btnPdf = $("#btnPdf");
    if (btnPdf) {
      btnPdf.removeEventListener("click", gerarPdfSomenteAutorizado);
      btnPdf.addEventListener("click", gerarPdfSomenteAutorizado);
    }

    await loadState();
  }

  function doLogout() {
    clearAuth();
    STATE = null;
    markDirty(false);
    showLogin();

    const n = $("#nome");
    const c = $("#chave");
    if (n) n.value = "";
    if (c) c.value = "";
  }

  function showLogin() {
    const a = $("#loginArea");
    const b = $("#appArea");
    if (a) a.style.display = "block";
    if (b) b.style.display = "none";
    renderSaveStatus(null);
  }

  function showApp() {
    const a = $("#loginArea");
    const b = $("#appArea");
    if (a) a.style.display = "none";
    if (b) b.style.display = "block";
    renderSaveStatus(null);
  }

  // =========================
  // Globais (index.html usa onclick)
  // =========================
  window.login = async function login() {
    try {
      const nome = $("#nome")?.value ?? "";
      const chave = $("#chave")?.value ?? "";
      await doLogin(nome, chave);
    } catch (err) {
      alert(err.message || String(err));
    }
  };

  window.logout = function logout() {
    doLogout();
  };

  // =========================
  // Boot
  // =========================
  async function boot() {
    const chaveEl = $("#chave");
    if (chaveEl) {
      chaveEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          window.login();
        }
      });
    }

    if (AUTH.key && AUTH.nome) {
      showApp();
      applyPdfVisibility();

      const btnPdf = $("#btnPdf");
      if (btnPdf) {
        btnPdf.removeEventListener("click", gerarPdfSomenteAutorizado);
        btnPdf.addEventListener("click", gerarPdfSomenteAutorizado);
      }

      await loadState();
    } else {
      showLogin();
    }

    window.addEventListener("beforeunload", (e) => {
      if (IS_DIRTY) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  boot().catch((err) => {
    console.error(err);
    alert(`Falha ao iniciar.\n\nDetalhes: ${err.message || err}`);
  });
})();
