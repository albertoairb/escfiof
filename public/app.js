(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const state = {
    token: null,
    me: null,
    meta: null,
    locked: false,
    officers: [],
    dates: [],
    codes: [],
    assignments: {},
    notes: {},
    notes_meta: {},
    pending: new Map() // key -> { code, observacao }
  };

  // modal de descrição (OUTROS / FO*)
  const descModal = {
    open: false,
    key: null,
    code: null,
    curCode: null,
    selectEl: null,
    cellEl: null,
  };

  function ddmmyyyy(iso) {
    const [y,m,d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }


function ddmmyyyy_hhmm(isoOrDate) {
  try {
    const dt = new Date(isoOrDate);
    const dd = String(dt.getDate()).padStart(2, "0");
    const mm2 = String(dt.getMonth() + 1).padStart(2, "0");
    const yy = dt.getFullYear();
    const hh = String(dt.getHours()).padStart(2, "0");
    const mi = String(dt.getMinutes()).padStart(2, "0");
    return `${dd}/${mm2}/${yy} ${hh}:${mi}`;
  } catch (_e) {
    return "";
  }
}

  function dayNameBR(idx) {
    const names = ["DOMINGO","SEGUNDA","TERÇA","QUARTA","QUINTA","SEXTA","SÁBADO"];
    return names[idx] || "";
  }

  async function api(path, opts = {}) {
    const headers = opts.headers || {};
    if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
    headers["Content-Type"] = "application/json";
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function show(el, yes) {
    $(el).style.display = yes ? "" : "none";
  }

  function setHolidayBar(holidays) {
    const bar = $("holidayBar");
    if (!holidays || !holidays.length) {
      bar.style.display = "none";
      bar.textContent = "";
      return;
    }
    bar.style.display = "";
    bar.textContent = `ALERTA DE FERIADO NA SEMANA: ${holidays.map(h => `${ddmmyyyy(h.date)} - ${h.name}`).join(" | ")}`;
  }

  function setHeader() {
    $("systemName").textContent = (state.meta && state.meta.system_name) ? state.meta.system_name : "Escala";
    $("period").textContent = (state.meta && state.meta.period_label) ? state.meta.period_label : "";
    $("footerMark").textContent = (state.meta && state.meta.footer_mark) ? state.meta.footer_mark : "";
  }

  function setLegend() {
    const el = $("legend");
    if (!el) return;
    el.innerHTML = "";

    const help = {
      "EXP": "expediente",
      "SR": "supervisor regional",
      "MA": "manhã",
      "VE": "vespertino",
      "FOJ": "folga obrigatória (sem descrição)",
      "FO*": "folga obrigatória (com descrição)",
      "LP": "licença-prêmio",
      "FÉRIAS": "férias",
      "CFP_DIA": "CFP (dia)",
      "CFP_NOITE": "CFP (noite)",
      "OUTROS": "com descrição"
    };

    for (const c of (state.codes || [])) {
      if (!c) continue;
      const div = document.createElement("div");
      div.className = "pill";
      div.textContent = help[c] ? `${c} – ${help[c]}` : c;
      el.appendChild(div);
    }
  }

  function setLockMsg() {
    if (state.locked) {
      $("lockMsg").textContent = "edição fechada (sexta 11h até domingo). após isso, somente responsáveis autorizados.";
    } else {
      $("lockMsg").textContent = "edição liberada.";
    }
  }

  function setUserMsg() {
    if (!state.me) return;
    $("userMsg").textContent = `usuário: ${state.me.canonical_name}`;
  }

  function buildOpsNotes() {
    const box = $("opsNotes");
    box.innerHTML = "";
    for (let i = 0; i < state.dates.length; i++) {
      const iso = state.dates[i];
      const d = new Date(iso + "T00:00:00");
      const day = dayNameBR(d.getDay());
      const div = document.createElement("div");
      div.className = "opsDay";
      div.innerHTML = `<b>${day} - ${ddmmyyyy(iso)}</b>
        <div class="line"></div>
        <div class="line"></div>
        <div class="line"></div>
        <div class="line"></div>`;
      box.appendChild(div);
    }
  }
function buildDescNotes() {
  const box = $("descNotes");
  const wrap = $("descBox");
  if (!box || !wrap) return;

  box.innerHTML = "";

  const byCanonical = new Map();
  for (const o of (state.officers || [])) byCanonical.set(o.canonical_name, o);

  const entries = [];
  for (const k of Object.keys(state.notes || {})) {
    const [canonical, iso] = k.split("|");
    const o = byCanonical.get(canonical);
    if (!o) continue;
    const code = state.assignments && state.assignments[k] ? String(state.assignments[k]) : "";
    if (code !== "OUTROS" && code !== "FO*") continue;
    const text = String(state.notes[k] || "").trim();
    if (!text) continue;
    entries.push({ key: k, iso, o, code, text });
  }

  entries.sort((a,b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : a.o.name.localeCompare(b.o.name)));

  if (!entries.length) {
    wrap.style.display = "none";
    return;
  }

  wrap.style.display = "block";

  for (const it of entries) {
    const div = document.createElement("div");
    div.className = "descitem";

    const title = document.createElement("div");
    title.className = "descitem__title";
    title.textContent = `${ddmmyyyy(it.iso)} - ${it.o.rank} ${it.o.name} (${it.code})`;
    div.appendChild(title);

    const body = document.createElement("div");
    body.textContent = it.text;
    div.appendChild(body);


const meta = state.notes_meta && state.notes_meta[it.key] ? state.notes_meta[it.key] : null;
if (meta && (meta.updated_at || meta.updated_by || meta.created_by)) {
  const metaLine = document.createElement("div");
  metaLine.className = "muted";
  const dt = meta.updated_at ? ddmmyyyy_hhmm(meta.updated_at) : "";
  const by = meta.updated_by || meta.created_by || "";
  metaLine.textContent = `${dt ? "atualizado em " + dt : ""}${(dt && by) ? " por " : ""}${by ? by : ""}`.trim();
  if (metaLine.textContent) div.appendChild(metaLine);
}


function hideChangeLogs() {
  const box = $("historyBox");
  if (box) box.style.display = "none";
  const table = $("historyTable");
  if (table) table.innerHTML = "";
}

async function loadChangeLogs() {
  const box = $("historyBox");
  const table = $("historyTable");
  if (!box || !table) return;

  box.style.display = "block";
  table.innerHTML = "<div class='muted'>carregando…</div>";

  const r = await api("/api/change_logs?limit=200");
  if (!r.ok) {
    table.innerHTML = `<div class='muted'>${(r.data && (r.data.error || r.data.details)) ? (r.data.error || r.data.details) : "erro ao carregar histórico"}</div>`;
    return;
  }

  const rows = Array.isArray(r.data && r.data.rows) ? r.data.rows : [];
  if (!rows.length) {
    table.innerHTML = "<div class='muted'>sem registros.</div>";
    return;
  }

  const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  let html = "<table class='hist'><thead><tr><th>data/hora</th><th>ator</th><th>alvo</th><th>dia</th><th>campo</th><th>antes</th><th>depois</th></tr></thead><tbody>";
  for (const r of rows) {
    const at = r.at ? ddmmyyyy_hhmm(r.at) : "";
    const day = r.data ? ddmmyyyy(String(r.data).slice(0,10).replaceAll('/','-')) : "";
    html += "<tr>";
    html += `<td>${esc(at)}</td>`;
    html += `<td>${esc(r.actor_name || "")}</td>`;
    html += `<td>${esc(r.target_name || "")}</td>`;
    html += `<td>${esc(day)}</td>`;
    html += `<td>${esc(r.field_name || "")}</td>`;
    html += `<td>${esc(r.before_value || "")}</td>`;
    html += `<td>${esc(r.after_value || "")}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table>";
  table.innerHTML = html;
}

    box.appendChild(div);
  }
}


  function canEditOfficer(officerCanonical) {
    if (!state.me) return false;
    if (state.me.is_admin) return true;
    return officerCanonical === state.me.canonical_name && !state.locked;
  }

  function buildTable() {
    const table = $("table");
    table.innerHTML = "";

    const thead = document.createElement("thead");
    const trh = document.createElement("tr");

    const thP = document.createElement("th");
    thP.textContent = "posto";
    trh.appendChild(thP);

    const thN = document.createElement("th");
    thN.textContent = "nome";
    trh.appendChild(thN);

    for (const iso of state.dates) {
      const th = document.createElement("th");
      th.textContent = ddmmyyyy(iso);
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    for (const off of state.officers) {
      const tr = document.createElement("tr");

      const tdRank = document.createElement("td");
      tdRank.textContent = off.rank;
      tr.appendChild(tdRank);

      const tdName = document.createElement("td");
      tdName.innerHTML = `<b>${off.name}</b>`;
      tr.appendChild(tdName);

      const editable = canEditOfficer(off.canonical_name);

      for (const iso of state.dates) {
        const td = document.createElement("td");
        const sel = document.createElement("select");
        sel.disabled = !editable;

        const optEmpty = document.createElement("option");
        optEmpty.value = "";
        optEmpty.textContent = "-";
        sel.appendChild(optEmpty);

        for (const code of state.codes) {
          if (!code) continue;
          const opt = document.createElement("option");
          opt.value = code;
          opt.textContent = code;
          sel.appendChild(opt);
        }

        const key = `${off.canonical_name}|${iso}`;
        const cur = state.assignments[key] || "";
        const pending = state.pending.has(key) ? state.pending.get(key) : null;
        const pendingCode = (pending && typeof pending === "object") ? (pending.code || "") : pending;
        sel.value = (pendingCode !== null && pendingCode !== undefined) ? pendingCode : cur;

        // tooltip com descrição (quando houver)
        const noteText = (state.notes && state.notes[key]) ? String(state.notes[key]) : "";
        sel.title = noteText || "";

        sel.addEventListener("change", () => {
          const v = sel.value;

          if (v === cur) {
            state.pending.delete(key);
            td.classList.remove("changed");
            $("saveMsg").textContent = `${state.pending.size} alteração(ões) pendente(s).`;
            return;
          }

          // códigos com descrição (texto livre exibido no PDF)
          if (v === "OUTROS" || v === "FO*") {
            const prev = (state.pending.get(key) && typeof state.pending.get(key) === "object")
              ? (state.pending.get(key).observacao || "")
              : (state.notes[key] || "");

            // abre modal
            descModal.open = true;
            descModal.key = key;
            descModal.code = v;
            descModal.curCode = cur;
            descModal.selectEl = sel;
            descModal.cellEl = td;

            $("descModalTitle").textContent = (v === "OUTROS") ? "OUTROS" : "FO*";
            $("descModalHint").textContent = "digite a descrição (aparecerá integralmente no PDF).";
            $("outrosText").value = prev || "";
            $("outrosMsg").textContent = "";
            $("outrosModal").style.display = "flex";
            setTimeout(() => $("outrosText").focus(), 0);
            return;
          }

          state.pending.set(key, { code: v, observacao: null });
          td.classList.add("changed");
          $("saveMsg").textContent = `${state.pending.size} alteração(ões) pendente(s).`;
        });

        td.appendChild(sel);
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
  }

  async function loadState() {
    const r = await api("/api/state", { method: "GET" });
    if (!r.ok) {
      $("saveMsg").textContent = (r.data && (r.data.error || r.data.details)) ? (r.data.error || r.data.details) : "erro ao carregar";
      return;
    }

    state.me = r.data.me;
    state.meta = r.data.meta;
    state.locked = !!r.data.locked;
    state.officers = r.data.officers || [];
    state.dates = r.data.dates || [];
    state.codes = r.data.codes || [];
    state.assignments = r.data.assignments || {};
    state.notes = r.data.notes || {};
    state.pending.clear();

    setHeader();
    setHolidayBar(r.data.holidays || []);
    setLockMsg();
    setUserMsg();
    setLegend();
    buildTable();
    buildOpsNotes();
    buildDescNotes();

    // histórico (somente admin)
    if (state.me && state.me.is_admin) {
      await loadChangeLogs();
    } else {
      hideChangeLogs();
    }

    // assinaturas
    const sig = (state.meta && state.meta.signatures) ? state.meta.signatures : null;
    if (state.me && state.me.is_admin && sig) {
      $("sigLeftName").value = sig.left_name || "";
      $("sigLeftRole").value = sig.left_role || "";
      $("sigRightName").value = sig.right_name || "";
      $("sigRightRole").value = sig.right_role || "";
      $("sigMsg").textContent = "";
      show("sigBox", true);
    } else {
      show("sigBox", false);
    }

    $("saveMsg").textContent = "";
  }

  function closeDescModal(cancel = false) {
    $("outrosModal").style.display = "none";
    $("outrosMsg").textContent = "";

    if (!descModal.open) return;

    const key = descModal.key;
    const sel = descModal.selectEl;
    const td = descModal.cellEl;
    const cur = descModal.curCode || "";

    if (cancel) {
      // volta para o que estava no banco
      if (sel) sel.value = cur;
      state.pending.delete(key);
      if (td) td.classList.remove("changed");
      $("saveMsg").textContent = `${state.pending.size} alteração(ões) pendente(s).`;
    }

    descModal.open = false;
    descModal.key = null;
    descModal.code = null;
    descModal.curCode = null;
    descModal.selectEl = null;
    descModal.cellEl = null;
  }

  function saveDescModal() {
    if (!descModal.open) return;
    const key = descModal.key;
    const v = descModal.code;
    const td = descModal.cellEl;

    const txt = String($("outrosText").value || "").trim();
    if (!txt) {
      $("outrosMsg").textContent = "a descrição não pode ficar em branco.";
      return;
    }

    state.pending.set(key, { code: v, observacao: txt });
    if (td) td.classList.add("changed");
    $("saveMsg").textContent = `${state.pending.size} alteração(ões) pendente(s).`;

    // tooltip imediato
    if (descModal.selectEl) descModal.selectEl.title = txt;

    closeDescModal(false);
  }

  async function doLogin() {
    $("loginMsg").textContent = "";
    const name = $("loginName").value.trim();
    const password = $("loginPass").value;

    const r = await api("/api/login", { method: "POST", body: JSON.stringify({ name, password }) });
    if (!r.ok) {
      $("loginMsg").textContent = (r.data && (r.data.error || r.data.details)) ? (r.data.error || r.data.details) : "falha no login";
      return;
    }

    state.token = r.data.token;
    state.me = r.data.me;

    // força troca de senha
    if (r.data.must_change) {
      show("loginBox", false);
      show("changeBox", true);
      show("appBox", false);
      $("changeMsg").textContent = "";
      return;
    }

    show("loginBox", false);
    show("changeBox", false);
    show("appBox", true);
    await loadState();
  }

  async function changePassword() {
    $("changeMsg").textContent = "";
    const p1 = $("newPass1").value;
    const p2 = $("newPass2").value;

    if (!p1 || p1.length < 6) { $("changeMsg").textContent = "a nova senha deve ter pelo menos 6 caracteres."; return; }
    if (p1 !== p2) { $("changeMsg").textContent = "as senhas não conferem."; return; }

    const r = await api("/api/change_password", { method: "POST", body: JSON.stringify({ new_password: p1 }) });
    if (!r.ok) {
      $("changeMsg").textContent = (r.data && (r.data.error || r.data.details)) ? (r.data.error || r.data.details) : "erro ao trocar senha";
      return;
    }

    show("loginBox", false);
    show("changeBox", false);
    show("appBox", true);
    await loadState();
  }

  async function save() {
    if (!state.pending.size) { $("saveMsg").textContent = "nenhuma alteração pendente."; return; }

    const updates = [];
    for (const [key, item] of state.pending.entries()) {
      const [canonical_name, date] = key.split("|");
      const code = (item && typeof item === "object") ? (item.code || "") : String(item || "");
      const observacao = (item && typeof item === "object") ? item.observacao : null;
      updates.push({ canonical_name, date, code, observacao });
    }

    const r = await api("/api/assignments", { method: "PUT", body: JSON.stringify({ updates }) });
    if (!r.ok) {
      $("saveMsg").textContent = (r.data && (r.data.error || r.data.details)) ? (r.data.error || r.data.details) : "erro ao salvar";
      return;
    }

    await loadState();
    $("saveMsg").textContent = "salvo.";
  }

  function logout() {
    state.token = null;
    state.me = null;
    state.meta = null;
    state.pending.clear();
    show("loginBox", true);
    show("changeBox", false);
    show("appBox", false);
    $("loginPass").value = "";
    $("loginMsg").textContent = "";
  }

  async function openPdf() {
    // abre em nova aba com link autenticado (window.open não envia headers)
    if (!state.token) {
      alert("Você precisa estar logado para abrir o PDF.");
      return;
    }

    const r = await api("/api/pdf_link", { method: "POST" });
    if (!r.ok) {
      const msg = (r.data && (r.data.error || r.data.details)) ? (r.data.error || r.data.details) : "Erro ao gerar link do PDF";
      alert(msg);
      return;
    }

    const url = r.data.url || "/api/pdf";
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function saveSignatures() {
    $("sigMsg").textContent = "";
    if (!state.me || !state.me.is_admin) {
      $("sigMsg").textContent = "sem permissão.";
      return;
    }

    const payload = {
      left_name: $("sigLeftName").value,
      left_role: $("sigLeftRole").value,
      right_name: $("sigRightName").value,
      right_role: $("sigRightRole").value,
    };

    const r = await api("/api/signatures", { method: "PUT", body: JSON.stringify(payload) });
    if (!r.ok) {
      $("sigMsg").textContent = (r.data && (r.data.error || r.data.details)) ? (r.data.error || r.data.details) : "erro ao salvar assinaturas";
      return;
    }

    $("sigMsg").textContent = "assinaturas salvas.";
    await loadState();
  }

  $("btnLogin").addEventListener("click", doLogin);
  $("btnChange").addEventListener("click", changePassword);
  $("btnSave").addEventListener("click", save);
  $("btnLogout").addEventListener("click", logout);
  $("btnPdf").addEventListener("click", openPdf);

  // modal descrição
  $("outrosCancel").addEventListener("click", () => closeDescModal(true));
  $("outrosSave").addEventListener("click", saveDescModal);
  $("outrosModal").addEventListener("click", (e) => {
    if (e.target && e.target.id === "outrosModal") closeDescModal(true);
  });

  // assinaturas
  const btnSig = $("btnSigSave");
  if (btnSig) btnSig.addEventListener("click", saveSignatures);

  // start: mostra login
  show("loginBox", true);
  show("changeBox", false);
  show("appBox", false);
})();