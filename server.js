"use strict";

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const mysql = require("mysql2/promise");

// ===============================
// CONFIG / ENV
// ===============================
const PORT = Number(process.env.PORT || 8080);
const TZ = (process.env.TZ || "America/Sao_Paulo").trim();

// Chave única (por enquanto): todos os oficiais usam a mesma chave para editar.
// Regras:
// - todos podem salvar (com a chave correta)
// - somente Alberto e Mosna podem gerar PDF
const SUPERVISOR_KEY = (process.env.SUPERVISOR_KEY || "sr123").trim();

// DB: Railway (URL) > Docker/local (DB_HOST...)
const DB_URL = (process.env.DB_URL || process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL || "").trim();

// Defaults para Docker/local (quando DB_URL não existir)
const DB_HOST = (process.env.DB_HOST || "db").trim();
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = (process.env.DB_USER || "app").trim();
const DB_PASSWORD = (process.env.DB_PASSWORD || "app").trim();
const DB_NAME = (process.env.DB_NAME || process.env.DB_DATABASE || "escala").trim();

// PDF: nomes autorizados (somente estes dois podem gerar PDF)
const PDF_ALLOWED_NAMES = new Set(["Alberto Franzini Neto", "Eduardo Mosna Xavier"]);

// ===============================
// APP
// ===============================
const app = express();
app.set("trust proxy", true);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "3mb" }));

// Servir frontend (serviço único)
app.use(express.static(path.join(__dirname, "public")));

// ===============================
// DB POOL
// ===============================
const pool = DB_URL
  ? mysql.createPool(DB_URL)
  : mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: "Z"
    });

// ===============================
// UTIL
// ===============================
function getWeekRangeISO() {
  // Semana vigente: segunda a domingo, em YYYY-MM-DD
  const now = new Date();
  const day = now.getDay(); // 0=dom
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() + diffToMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10)
  };
}

function mustBeSupervisor(req, res, next) {
  const key = (req.headers["x-access-key"] || "").toString().trim();
  if (!key || key !== SUPERVISOR_KEY) {
    return res.status(403).json({ error: "Acesso negado." });
  }
  return next();
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function safeString(s) {
  return (s === null || s === undefined) ? "" : String(s);
}

// códigos oficiais do frontend
const CODES_CORRETOS = ["", "EXP", "SR", "FO", "MA", "VE", "LP", "FÉRIAS", "CFP_DIA", "CFP_NOITE", "OUTROS"];

function buildDatesForWeek(startYYYYMMDD) {
  const dates = [];
  const [y, m, d] = startYYYYMMDD.split("-").map(Number);
  const base = new Date(y, m - 1, d);
  base.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const cur = new Date(base);
    cur.setDate(base.getDate() + i);
    dates.push(cur.toISOString().slice(0, 10));
  }
  return dates;
}

function normalizeBaseState(state) {
  // normaliza SEM apagar byUser (preserva todos os oficiais)
  const w = getWeekRangeISO();
  const dates = buildDatesForWeek(w.start);

  const out = state && typeof state === "object" ? state : {};

  out.meta = out.meta && typeof out.meta === "object" ? out.meta : {};
  if (!out.meta.title) out.meta.title = "Escala Semanal de Oficiais";
  if (!out.meta.author) out.meta.author = "Desenvolvido por Alberto Franzini Neto";
  if (!out.meta.created_at) out.meta.created_at = new Date().toISOString();

  out.period = { start: w.start, end: w.end };
  out.dates = dates;
  out.codes = CODES_CORRETOS.slice();
  if (!out.byUser || typeof out.byUser !== "object") out.byUser = {};
  out.updated_at = new Date().toISOString();

  return out;
}

function normalizeUserEntry(userEntry, dates) {
  // garante { [date]: { code, obs } } para as 7 datas
  const out = userEntry && typeof userEntry === "object" ? userEntry : {};
  for (const d of dates) {
    if (!out[d] || typeof out[d] !== "object") out[d] = { code: "", obs: "" };
    if (out[d].code === undefined) out[d].code = "";
    if (out[d].obs === undefined) out[d].obs = "";
    out[d].code = safeString(out[d].code);
    out[d].obs = safeString(out[d].obs);
  }
  return out;
}

async function ensureSchema() {
  // Importante: executar UMA query por vez (compatibilidade total)
  const sqls = [
    `CREATE TABLE IF NOT EXISTS relatorios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      titulo VARCHAR(255) NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS lancamentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      relatorio_id INT NOT NULL,
      data DATE NOT NULL,
      codigo VARCHAR(64) NOT NULL,
      observacao TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_relatorio_data (relatorio_id, data),
      CONSTRAINT fk_lanc_rel
        FOREIGN KEY (relatorio_id) REFERENCES relatorios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    // tabela para o state do frontend (JSON inteiro)
    `CREATE TABLE IF NOT EXISTS state_store (
      id INT PRIMARY KEY,
      payload LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
  ];

  const conn = await pool.getConnection();
  try {
    for (const s of sqls) await conn.query(s);

    // seed do state id=1 (se não existir)
    const [rows] = await conn.query("SELECT id FROM state_store WHERE id=1 LIMIT 1");
    if (!rows.length) {
      const initial = normalizeBaseState({});
      await conn.query("INSERT INTO state_store (id, payload) VALUES (1, ?)", [JSON.stringify(initial)]);
    }
  } finally {
    conn.release();
  }
}

async function safeQuery(sql, params = []) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    conn.release();
  }
}

async function getState() {
  const rows = await safeQuery("SELECT payload FROM state_store WHERE id=1 LIMIT 1");
  if (!rows.length) return normalizeBaseState({});

  const st = safeJsonParse(rows[0].payload);
  return normalizeBaseState(st || {});
}

async function putStateMergedByUser(nome, incomingState) {
  const current = await getState(); // já normalizado e preserva byUser
  const dates = Array.isArray(current.dates) ? current.dates : [];

  const inc = incomingState && typeof incomingState === "object" ? incomingState : {};
  const incByUser = inc.byUser && typeof inc.byUser === "object" ? inc.byUser : {};
  const incUserEntry = incByUser[nome];

  // se o frontend enviar o estado inteiro mas sem byUser[nome], não apaga nada
  if (incUserEntry && typeof incUserEntry === "object") {
    current.byUser[nome] = normalizeUserEntry(incUserEntry, dates);
  } else {
    // fallback: tenta ler pelo layout "notesByDate" (se algum dia mudar)
    // mas por segurança não altera nada se não tiver dados
  }

  current.updated_at = new Date().toISOString();
  await safeQuery("UPDATE state_store SET payload=? WHERE id=1", [JSON.stringify(current)]);
  return current;
}

function requirePdfKitOr501(res) {
  try {
    // precisa estar em dependencies: npm i pdfkit
    return require("pdfkit");
  } catch {
    res.status(501).json({ error: "Geração de PDF indisponível (instale: npm i pdfkit)." });
    return null;
  }
}

// texto curto para célula do PDF
function cellText(it) {
  const code = safeString(it && it.code ? it.code : "").trim();
  const obs = safeString(it && it.obs ? it.obs : "").trim();
  if (!obs) return code;
  // corta observação para caber na tabela
  const short = obs.length > 36 ? (obs.slice(0, 35) + "…") : obs;
  return code ? `${code} - ${short}` : short;
}

// ===============================
// ROTAS
// ===============================
app.get("/api/health", async (req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();

    return res.json({
      ok: true,
      tz: TZ,
      db_mode: DB_URL ? "url" : "host",
      week: getWeekRangeISO()
    });
  } catch (err) {
    console.error("[HEALTH][DB] Falha no ping do MySQL:", {
      message: err && err.message,
      code: err && err.code,
      errno: err && err.errno,
      sqlState: err && err.sqlState
    });

    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Falha no health",
      code: err && err.code ? err.code : null
    });
  }
});

app.post("/api/login", (req, res) => {
  const key = (req.body && req.body.access_key ? req.body.access_key : "").toString().trim();
  if (key !== SUPERVISOR_KEY) {
    return res.status(403).json({ error: "Acesso negado." });
  }
  return res.json({ ok: true, role: "oficial" });
});

// ============ STATE (frontend) ============
// GET /api/state: carrega estado da semana vigente
app.get("/api/state", mustBeSupervisor, async (req, res) => {
  try {
    const st = await getState();
    return res.json(st);
  } catch (err) {
    console.error("[STATE][GET] erro:", err);
    return res.status(500).json({ error: "Erro ao carregar state.", details: err.message });
  }
});

// PUT /api/state: salva APENAS os dados do usuário logado (merge, sem apagar os demais)
app.put("/api/state", mustBeSupervisor, async (req, res) => {
  try {
    const nome = (req.headers["x-user-name"] || "").toString().trim();
    if (!nome) return res.status(400).json({ error: "Nome do usuário ausente (header x-user-name)." });

    const incoming = req.body && typeof req.body === "object" ? req.body : null;
    const st = await putStateMergedByUser(nome, incoming);

    return res.json({ ok: true, state: st });
  } catch (err) {
    console.error("[STATE][PUT] erro:", err);
    return res.status(500).json({ error: "Erro ao salvar state.", details: err.message });
  }
});

// ============ PDF (somente autorizados) ============
// Frontend chama GET /api/pdf (sem id), e envia nome no header x-user-name.
// PDF deve mostrar TODOS os oficiais em colunas (segunda->domingo).
app.get("/api/pdf", mustBeSupervisor, async (req, res) => {
  const nome = (req.headers["x-user-name"] || "").toString().trim();

  if (!PDF_ALLOWED_NAMES.has(nome)) {
    return res.status(403).json({ error: "PDF final permitido somente para Alberto Franzini Neto e Eduardo Mosna Xavier." });
  }

  const PDFDocument = requirePdfKitOr501(res);
  if (!PDFDocument) return;

  try {
    const st = await getState();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="escala_semanal.pdf"`);

    const doc = new PDFDocument({ margin: 36, size: "A4", layout: "landscape" });
    doc.pipe(res);

    const title = st?.meta?.title || "Escala Semanal de Oficiais";
    doc.fontSize(16).text(title, { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(10).text(`Período: ${st?.period?.start || ""} a ${st?.period?.end || ""}`, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(9).text(`Gerado por: ${nome}`, { align: "left" });
    doc.moveDown(0.6);

    const dates = Array.isArray(st.dates) ? st.dates : [];
    const byUser = (st.byUser && typeof st.byUser === "object") ? st.byUser : {};

    const officers = Object.keys(byUser).sort((a, b) => a.localeCompare(b, "pt-BR"));
    if (!officers.length) {
      doc.fontSize(11).text("Nenhum oficial registrado ainda.");
      doc.end();
      return;
    }

    // --- Tabela ---
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const x0 = doc.page.margins.left;
    let y = doc.y;

    const nameColW = 200; // coluna do nome do oficial
    const colW = (pageWidth - nameColW) / 7; // 7 dias
    const rowH = 26;
    const headerH = 24;

    function drawCell(x, y, w, h, text, isHeader = false) {
      doc.rect(x, y, w, h).stroke();
      doc.fontSize(isHeader ? 9 : 8);
      doc.text(text, x + 4, y + 7, { width: w - 8, height: h - 10, ellipsis: true });
    }

    // Cabeçalho
    drawCell(x0, y, nameColW, headerH, "oficial", true);
    for (let i = 0; i < 7; i++) {
      const d = dates[i] || "";
      drawCell(x0 + nameColW + (colW * i), y, colW, headerH, d, true);
    }
    y += headerH;

    // Linhas
    for (const offName of officers) {
      // quebra de página
      if (y + rowH > (doc.page.height - doc.page.margins.bottom)) {
        doc.addPage({ size: "A4", layout: "landscape", margin: 36 });
        y = doc.page.margins.top;

        // redesenha cabeçalho
        drawCell(x0, y, nameColW, headerH, "oficial", true);
        for (let i = 0; i < 7; i++) {
          const d = dates[i] || "";
          drawCell(x0 + nameColW + (colW * i), y, colW, headerH, d, true);
        }
        y += headerH;
      }

      drawCell(x0, y, nameColW, rowH, offName, false);

      const entry = byUser[offName] && typeof byUser[offName] === "object" ? byUser[offName] : {};
      for (let i = 0; i < 7; i++) {
        const d = dates[i];
        const it = d ? (entry[d] || { code: "", obs: "" }) : { code: "", obs: "" };
        drawCell(x0 + nameColW + (colW * i), y, colW, rowH, cellText(it), false);
      }

      y += rowH;
    }

    doc.end();
  } catch (err) {
    console.error("[PDF] erro:", err);
    return res.status(500).json({ error: "Erro ao gerar PDF.", details: err.message });
  }
});

// ===============================
// ROTAS (LEGADO) - mantém se você ainda usa
// ===============================

// Criar relatório da semana vigente
app.post("/api/relatorios", mustBeSupervisor, async (req, res) => {
  try {
    const titulo = (req.body && req.body.titulo ? req.body.titulo : "Escala Semanal").toString().trim();
    const { start, end } = getWeekRangeISO();

    const result = await safeQuery(
      "INSERT INTO relatorios (titulo, period_start, period_end) VALUES (?, ?, ?)",
      [titulo, start, end]
    );

    const id = result.insertId;
    const rows = await safeQuery("SELECT * FROM relatorios WHERE id = ?", [id]);

    return res.json({ ok: true, relatorio: rows[0] });
  } catch (err) {
    console.error("[RELATORIOS][POST] erro:", err);
    return res.status(500).json({ error: "Erro ao criar relatório.", details: err.message });
  }
});

// Inserir lançamento (append-only)
app.post("/api/relatorios/:id/lancamentos", mustBeSupervisor, async (req, res) => {
  try {
    const relatorioId = Number(req.params.id);
    if (!Number.isFinite(relatorioId) || relatorioId <= 0) {
      return res.status(400).json({ error: "ID inválido." });
    }

    // Aceita:
    // - "2026-02-23"
    // - "2026-02-23T00:00:00.000Z"
    // - "2026-02-23T12:34:56-03:00"
    // e sempre salva como "YYYY-MM-DD"
    const s = (req.body && req.body.data ? req.body.data : "").toString().trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    const dataYYYYMMDD = m ? m[1] : null;

    const codigo = (req.body && req.body.codigo ? req.body.codigo : "").toString().trim();
    const observacao = (req.body && req.body.observacao ? req.body.observacao : "").toString();

    if (!dataYYYYMMDD || !codigo) {
      return res.status(400).json({ error: "Campos obrigatórios: data (YYYY-MM-DD), codigo." });
    }

    const rel = await safeQuery("SELECT id FROM relatorios WHERE id = ?", [relatorioId]);
    if (!rel.length) {
      return res.status(404).json({ error: "Relatório não encontrado." });
    }

    const r = await safeQuery(
      "INSERT INTO lancamentos (relatorio_id, data, codigo, observacao) VALUES (?, ?, ?, ?)",
      [relatorioId, dataYYYYMMDD, codigo, observacao || null]
    );

    return res.json({ ok: true, id: r.insertId, data: dataYYYYMMDD });
  } catch (err) {
    console.error("[LANCAMENTOS][POST] erro:", err);
    return res.status(500).json({ error: "Erro ao salvar.", details: err.message });
  }
});

// Listar lançamentos do relatório
app.get("/api/relatorios/:id", mustBeSupervisor, async (req, res) => {
  try {
    const relatorioId = Number(req.params.id);
    const relRows = await safeQuery("SELECT * FROM relatorios WHERE id = ?", [relatorioId]);
    if (!relRows.length) return res.status(404).json({ error: "Relatório não encontrado." });

    const lancRows = await safeQuery(
      "SELECT * FROM lancamentos WHERE relatorio_id = ? ORDER BY data ASC, created_at ASC, id ASC",
      [relatorioId]
    );

    return res.json({ ok: true, relatorio: relRows[0], lancamentos: lancRows });
  } catch (err) {
    console.error("[RELATORIO][GET] erro:", err);
    return res.status(500).json({ error: "Erro ao carregar relatório.", details: err.message });
  }
});

// ===============================
// START
// ===============================
(async () => {
  try {
    process.env.TZ = TZ;

    await ensureSchema();

    app.listen(PORT, () => {
      console.log(`OK - Backend rodando na porta ${PORT}`);
      console.log(`DB_MODE=${DB_URL ? "url" : "host"} TZ=${TZ}`);
    });
  } catch (err) {
    console.error("FALHA AO INICIALIZAR:", err);
    process.exit(1);
  }
})();
