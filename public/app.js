// ===============================
// CONFIGURAÇÃO DA API
// - Local:   http://localhost:8080
// - Railway: usa o mesmo host (sem porta fixa)
// ===============================
const API = (() => {
  const { protocol, hostname, port } = location;

  // Se estiver em localhost/127.0.0.1, mantém a porta 8080 (backend local).
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${protocol}//${hostname}:8080`;
  }

  // Em produção (Railway), usa o mesmo host/porta atual do site.
  // Se front e back estiverem no mesmo serviço/domínio, funciona direto.
  // Se estiverem separados, ajuste aqui para o domínio do backend.
  return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
})();

// ===============================
// ESTADO GLOBAL
// ===============================
let usuarioLogado = null;
let relatorioAtual = null;

// ===============================
// FUNÇÃO PADRÃO DE REQUISIÇÃO
// ===============================
async function request(path, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };

  if (usuarioLogado && usuarioLogado.access_key) {
    headers["x-access-key"] = usuarioLogado.access_key;
  }

  const resp = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });

  // Tenta interpretar JSON, mas não quebra se vier vazio/HTML
  let data = null;
  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      data = await resp.json();
    } catch (e) {
      data = null;
    }
  } else {
    // fallback: tenta texto só para enriquecer mensagem de erro
    try {
      const txt = await resp.text();
      data = { error: txt };
    } catch (e) {
      data = null;
    }
  }

  if (!resp.ok) {
    const msg =
      (data && (data.error || data.details)) ||
      `Erro na requisição (HTTP ${resp.status})`;
    throw new Error(msg);
  }

  return data;
}

// ===============================
// LOGIN SIMPLES
// ===============================
async function login() {
  const nome = document.getElementById("nome").value.trim();
  const chave = document.getElementById("chave").value.trim();

  if (!nome || !chave) {
    alert("Preencha nome e chave.");
    return;
  }

  try {
    const resp = await request("/api/login", "POST", { access_key: chave });

    usuarioLogado = {
      nome,
      access_key: chave,
      role: resp && resp.role ? resp.role : null
    };

    document.getElementById("loginArea").style.display = "none";
    document.getElementById("appArea").style.display = "block";

    carregarOuCriarRelatorio();
  } catch (err) {
    alert("Acesso negado.");
  }
}

// ===============================
// LOGOUT
// ===============================
function logout() {
  usuarioLogado = null;
  relatorioAtual = null;

  document.getElementById("appArea").style.display = "none";
  document.getElementById("loginArea").style.display = "block";
}

// ===============================
// CRIAR OU CARREGAR RELATÓRIO
// ===============================
async function carregarOuCriarRelatorio() {
  try {
    const resp = await request("/api/relatorios", "POST", {
      titulo: "Escala Semanal"
    });

    relatorioAtual = resp.relatorio;
    renderSemana();
  } catch (err) {
    alert("Erro ao carregar relatório.");
  }
}

// ===============================
// GERAR SEMANA (SEGUNDA A DOMINGO)
// ===============================
function getSemanaAtual() {
  const hoje = new Date();
  const diaSemana = hoje.getDay(); // 0 = domingo
  const diff = hoje.getDate() - diaSemana + (diaSemana === 0 ? -6 : 1);

  const segunda = new Date(hoje.setDate(diff));
  const dias = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(segunda);
    d.setDate(segunda.getDate() + i);
    dias.push(new Date(d));
  }

  return dias;
}

// ===============================
// LISTA DE CÓDIGOS (SEM F e SEM 12H)
// + OUTROS (digitável)
// ===============================
const CODIGOS = [
  "EXP",
  "SR",
  "FO",
  "FO*",
  "FOJ",
  "MA",
  "VE",
  "LP",
  "CFP_DIA",
  "CFP_NOITE",
  "OUTROS"
];

// ===============================
// RENDERIZAR SEMANA
// ===============================
function renderSemana() {
  const container = document.getElementById("semanaContainer");
  container.innerHTML = "";

  const dias = getSemanaAtual();

  dias.forEach((data) => {
    const div = document.createElement("div");
    div.className = "dia-bloco";

    const titulo = document.createElement("h3");
    titulo.innerText = data.toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "2-digit",
      month: "2-digit"
    });

    const select = document.createElement("select");
    CODIGOS.forEach((codigo) => {
      const option = document.createElement("option");
      option.value = codigo;
      option.innerText = codigo;
      select.appendChild(option);
    });

    // Campo "OUTROS" (apenas quando selecionado)
    const outrosWrap = document.createElement("div");
    outrosWrap.style.display = "none";
    outrosWrap.style.marginTop = "6px";

    const outrosLabel = document.createElement("div");
    outrosLabel.innerText = "especifique (OUTROS):";
    outrosLabel.style.fontSize = "12px";
    outrosLabel.style.opacity = "0.85";

    const outrosInput = document.createElement("input");
    outrosInput.type = "text";
    outrosInput.placeholder = "Digite o código/descrição";
    outrosInput.style.width = "100%";

    outrosWrap.appendChild(outrosLabel);
    outrosWrap.appendChild(outrosInput);

    select.onchange = () => {
      const isOutros = select.value === "OUTROS";
      outrosWrap.style.display = isOutros ? "block" : "none";
      if (!isOutros) outrosInput.value = "";
    };

    const obs = document.createElement("textarea");
    obs.placeholder = "Observações do dia";

    const btn = document.createElement("button");
    btn.innerText = "Salvar";
    btn.onclick = () => {
      const codigo = select.value;

      // Se for OUTROS, exige preenchimento e salva como "OUTROS: <texto>"
      let codigoFinal = codigo;
      if (codigo === "OUTROS") {
        const txt = (outrosInput.value || "").trim();
        if (!txt) {
          alert("Preencha o campo 'OUTROS'.");
          return;
        }
        codigoFinal = `OUTROS: ${txt}`;
      }

      salvarDia(data, codigoFinal, obs.value);
    };

    div.appendChild(titulo);
    div.appendChild(select);
    div.appendChild(outrosWrap);
    div.appendChild(obs);
    div.appendChild(btn);

    container.appendChild(div);
  });
}

// ===============================
// SALVAR DIA
// ===============================
async function salvarDia(data, codigo, observacao) {
  try {
    await request(`/api/relatorios/${relatorioAtual.id}/lancamentos`, "POST", {
      data: data.toISOString(),
      codigo,
      observacao
    });

    alert("Salvo com sucesso.");
  } catch (err) {
    alert("Erro ao salvar.");
  }
}

// ===============================
// PDF FINAL (APENAS ALBERTO E MOSNA)
// ===============================
function gerarPDF() {
  if (
    usuarioLogado.nome !== "Alberto Franzini Neto" &&
    usuarioLogado.nome !== "Eduardo Mosna Xavier"
  ) {
    alert("PDF final permitido somente para Alberto e Major Mosna.");
    return;
  }

  window.open(
    `${API}/api/relatorios/${relatorioAtual.id}/pdf?nome=${encodeURIComponent(
      usuarioLogado.nome
    )}`,
    "_blank"
  );
}