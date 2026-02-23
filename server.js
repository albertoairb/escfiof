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
const TZ = process.env.TZ || "America/Sao_Paulo";

const SUPERVISOR_KEY = (process.env.SUPERVISOR_KEY || "supervisor123").trim();

// ===============================
// DB RESOLUTION (ROBUST FOR RAILWAY)
// ===============================
function resolveDbUrl() {
  const candidates = [
    process.env.DB_URL,
    process.env.DATABASE_URL,
    process.env.MYSQL_URL,
    process.env.MYSQL_PUBLIC_URL
  ]
    .map((v) => (v ? String(v).trim() : ""))
    .filter(Boolean);

  for (const v of candidates) {
    // caso 1: já é URL válida
    if (/^mysql:\/\//i.test(v)) return v;

    // caso 2: veio como nome literal da variável (ex: "MYSQL_PUBLIC_URL")
    if (process.env[v] && /^mysql:\/\//i.test(String(process.env[v]).trim())) {
      return String(process.env[v]).trim();
    }
  }

  return "";
}

const DB_URL = resolveDbUrl();

// Fallback para Docker/local
const DB_HOST = (process.env.DB_HOST || "db").trim();
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = (process.env.DB_USER || "app").trim();
const DB_PASSWORD = (process.env.DB_PASSWORD || "app").trim();
const DB_NAME = (process.env.DB_NAME || process.env.DB_DATABASE || "escala").trim();

// ===============================
// PDF: nomes autorizados
// ===============================
const PDF_ALLOWED_NAMES = new Set([
  "Alberto Franzini Neto",
  "Eduardo Mosna Xavier"
]);

// ===============================
// APP
// ===============================
const app = express();
app.set("trust proxy", true);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "1mb" }));

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
  const now = new Date();
  const day = now.getDay(); // 0=domingo
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

async function ensureSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS relatorios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      titulo VARCHAR(255) NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS lancamentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      relatorio_id INT NOT NULL,
      data DATE NOT NULL,
      codigo VARCHAR(64) NOT NULL,
      observacao TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (relatorio_id) REFERENCES relatorios(id) ON DELETE CASCADE,
      INDEX idx_relatorio_data (relatorio_id, data)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  const conn = await pool.getConnection();
  try {
    await conn.query(sql);
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
    console.error("[HEALTH][DB] Falha no ping do MySQL:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Falha no health"
    });
  }
});

app.post("/api/login", (req, res) => {
  const key = (req.body?.access_key || "").toString().trim();
  if (key !== SUPERVISOR_KEY) {
    return res.status(403).json({ error: "Acesso negado." });
  }
  return res.json({ ok: true, role: "supervisor" });
});

app.post("/api/relatorios", mustBeSupervisor, async (req, res) => {
  try {
    const titulo = (req.body?.titulo || "Escala Semanal").toString().trim();
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
    return res.status(500).json({ error: "Erro ao criar relatório." });
  }
});

app.post("/api/relatorios/:id/lancamentos", mustBeSupervisor, async (req, res) => {
  try {
    const relatorioId = Number(req.params.id);
    const dataISO = (req.body?.data || "").toString().trim();
    const codigo = (req.body?.codigo || "").toString().trim();
    const observacao = (req.body?.observacao || "").toString();

    if (!relatorioId || !dataISO || !codigo) {
      return res.status(400).json({ error: "Campos obrigatórios." });
    }

    const dataDia = new Date(dataISO);
    if (Number.isNaN(dataDia.getTime())) {
      return res.status(400).json({ error: "Data inválida." });
    }

    const dataYYYYMMDD = dataDia.toISOString().slice(0, 10);

    await safeQuery(
      "INSERT INTO lancamentos (relatorio_id, data, codigo, observacao) VALUES (?, ?, ?, ?)",
      [relatorioId, dataYYYYMMDD, codigo, observacao || null]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[LANCAMENTOS][POST] erro:", err);
    return res.status(500).json({ error: "Erro ao salvar." });
  }
});

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
    return res.status(500).json({ error: "Erro ao carregar." });
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