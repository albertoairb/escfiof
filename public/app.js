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
    pending: new Map() // key -> code
  };

  function ddmmyyyy(iso) {
    const [y,m,d] = iso.split("-");
    return `${d}/${m}/${y}`;
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
        sel.value = pending !== null ? pending : cur;

        sel.addEventListener("change", () => {
          const v = sel.value;
          if (v === cur) {
            state.pending.delete(key);
            td.classList.remove("changed");
          } else {
            state.pending.set(key, v);
            td.classList.add("changed");
          }
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
    state.pending.clear();

    setHeader();
    setHolidayBar(r.data.holidays || []);
    setLockMsg();
    setUserMsg();
    buildTable();
    buildOpsNotes();
    $("saveMsg").textContent = "";
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
    for (const [key, code] of state.pending.entries()) {
      const [canonical_name, date] = key.split("|");
      updates.push({ canonical_name, date, code });
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
    try {
      if (!state.token) {
        $("loginMsg").textContent = "sessão expirada. faça login novamente.";
        logout();
        return;
      }

      const res = await fetch("/api/pdf", {
        method: "GET",
        headers: { "Authorization": `Bearer ${state.token}` }
      });

      if (!res.ok) {
        const txt = await res.text();
        alert(`erro ao gerar PDF: ${txt}`);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    } catch (e) {
      alert("falha ao abrir PDF: " + (e?.message || e));
    }
  }

  $("btnLogin").addEventListener("click", doLogin);
  $("btnChange").addEventListener("click", changePassword);
  $("btnSave").addEventListener("click", save);
  $("btnLogout").addEventListener("click", logout);
  $("btnPdf").addEventListener("click", openPdf);

  // start: mostra login
  show("loginBox", true);
  show("changeBox", false);
  show("appBox", false);
})();