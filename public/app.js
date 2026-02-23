/* public/app.js
 * Frontend: Escala Semanal de Oficiais
 * Compatível com o index.html enviado:
 * - #loginArea, #appArea, #semanaContainer
 * - inputs: #nome, #chave
 * - funções globais: login(), logout(), gerarPDF()
 *
 * Backend esperado (padrão):
 * - POST /api/login  { access_key, nome }  -> opcional (se não existir, segue apenas com header)
 * - GET  /api/state  -> retorna estado do sistema
 * - PUT  /api/state  -> salva estado do sistema (inteiro)
 * - GET  /api/pdf    -> retorna PDF (blob) (opcional)
 */

(() => {
  "use strict";

  // =========================
  // 0) Helpers
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
    return String(nome || "")
      .trim()
      .replace(/\s+/g, " ");
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
  // 1) API_BASE resolver
  // =========================
  function resolveApiBase() {
    const url = new URL(location.href);
    const apiFromQuery = url.searchParams.get("api");
    if (apiFromQuery) return apiFromQuery.replace(/\/$/, "");

    const apiFromStorage = localStorage.getItem("API_BASE");
    if (apiFromStorage) return apiFromStorage.replace(/\/$/, "");

    return "";
  }

  const API_BASE = resolveApiBase(); // "" => mesma origem

  // =========================
  // 2) Auth / Request
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
  // 3) Estado do sistema (multiusuário por nome)
  // =========================
  const DEFAULT_STATE = {
    meta: {
      title: "Escala Semanal de Oficiais",
      author: "Desenvolvido por Alberto Franzini Neto",
      created_at: new Date().toISOString(),
    },
    period: { start: "", end: "" }, // segunda -> domingo
    dates: [],
    // CÓDIGOS CORRETOS (conforme sua regra)
    // - remover: F, 12H
    // - adicionar: FÉRIAS, OUTROS
    // - manter: EXP, SR, FO, MA, VE, LP, CFP_DIA, CFP_NOITE
    codes: ["", "EXP", "SR", "FO", "MA", "VE", "LP", "FÉRIAS", "CFP_DIA", "CFP_NOITE", "OUTROS"],
    byUser: {},
    updated_at: new Date().toISOString(),
  };

  let STATE = null;
  let IS_DIRTY = false;

  function markDirty(v) {
    IS_DIRTY = !!v;
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
    // força sempre a lista correta, mesmo que o backend tenha salvo lista antiga
    state.codes = ["", "EXP", "SR", "FO", "MA", "VE", "LP", "FÉRIAS", "CFP_DIA", "CFP_NOITE", "OUTROS"];
    return state;
  }

  // =========================
  // 4) Render (blocos por dia)
  // =========================
  function render() {
    const container = $("#semanaContainer");
    if (!container || !STATE) return;

    const nome = AUTH.nome;
    if (!nome) {
      container.innerHTML = "";
      return;
    }

    const dates = STATE.dates || [];
    const codes = Array.isArray(STATE.codes) ? STATE.codes : DEFAULT_STATE.codes;

    let html = "";
    html += `<div style="margin-bottom:12px;">
      <div><strong>usuário:</strong> ${escapeHtml(nome)}</div>
      <div><strong>período:</strong> ${escapeHtml(STATE.period.start)} a ${escapeHtml(STATE.period.end)}</div>
      ${API_BASE ? `<div><strong>api:</strong> ${escapeHtml(API_BASE)}</div>` : ""}
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
            ${codes
              .map((c) => {
                const label = c === "" ? "(vazio)" : c;
                return `<option value="${escapeHtml(c)}"${
                  c === code ? " selected" : ""
                }>${escapeHtml(label)}</option>`;
              })
              .join("")}
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
  }

  // =========================
  // 5) Load / Save (backend)
  // =========================
  async function loadState() {
    let st = null;

    try {
      st = await request("/api/state", { method: "GET" });
    } catch (err) {
      console.warn("Falha ao carregar /api/state:", err.message);
    }

    if (!st) st = structuredClone(DEFAULT_STATE);

    st = ensureWeek(st);
    st = ensureUser(st, AUTH.nome);
    st = ensureCodes(st); // força códigos corretos sempre

    STATE = st;
    markDirty(false);
    render();

    try {
      await saveState(false);
    } catch {
      // ignora
    }
  }

  async function saveState(showAlert = true) {
    if (!STATE) return;

    // garante que nunca vai salvar lista errada
    ensureCodes(STATE);

    await request("/api/state", { method: "PUT", body: STATE });

    markDirty(false);
    if (showAlert) alert("Salvo com sucesso.");
  }

  // =========================
  // 6) Login / Logout / PDF
  // =========================
  async function doLogin(nome, key) {
    nome = normalizeName(nome);
    key = String(key || "").trim();

    if (!nome) throw new Error("Informe seu nome completo.");
    if (!key) throw new Error("Informe a chave de acesso.");

    try {
      const r = await request("/api/login", { method: "POST", body: { access_key: key, nome } });
      setAuth({ key, nome, role: r?.role || "" });
    } catch {
      setAuth({ key, nome, role: "" });
    }

    showApp();
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

  async function openPdf() {
    try {
      const blob = await request("/api/pdf", { method: "GET", isBlob: true });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      alert(`Não foi possível gerar/abrir o PDF.\n\nDetalhes: ${err.message}`);
    }
  }

  // =========================
  // 7) UI
  // =========================
  function showLogin() {
    const a = $("#loginArea");
    const b = $("#appArea");
    if (a) a.style.display = "block";
    if (b) b.style.display = "none";
  }

  function showApp() {
    const a = $("#loginArea");
    const b = $("#appArea");
    if (a) a.style.display = "none";
    if (b) b.style.display = "block";
  }

  // =========================
  // 8) Funções globais (index.html usa onclick)
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

  window.gerarPDF = async function gerarPDF() {
    try {
      if (IS_DIRTY) {
        await saveState(false);
      }
    } catch {
      // ignora
    }
    await openPdf();
  };

  // =========================
  // 9) Boot
  // =========================
  async function boot() {
    if (AUTH.key && AUTH.nome) {
      showApp();
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

    const chaveEl = $("#chave");
    if (chaveEl) {
      chaveEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          window.login();
        }
      });
    }
  }

  boot().catch((err) => {
    console.error(err);
    alert(`Falha ao iniciar.\n\nDetalhes: ${err.message || err}`);
  });
})();