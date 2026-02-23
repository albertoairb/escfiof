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

const SUPERVISOR_KEY = (process.env.SUPERVISOR_KEY || "supervisor123").trim();

// DB: Railway (URL) > Docker/local (DB_HOST...)
const DB_URL = (process.env.DB_URL || process.env.MYSQL_URL || "").trim();

// Defaults para Docker/local (quando DB_URL não existir)
const DB_HOST = (process.env.DB_HOST || "db").trim();
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = (process.env.DB_USER || "app").trim();
const DB_PASSWORD = (process.env.DB_PASSWORD || "app").trim();
const DB_NAME = (process.env.DB_NAME || process.env.DB_DATABASE || "escala").trim();

// PDF: nomes autorizados
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
function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymdToString(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function getZonedYMDW(tz) {
  // pega ano/mes/dia + weekday no fuso desejado (sem depender do timezone do servidor)
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  });

  const parts = fmt.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;

  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const weekdayStr = String(get("weekday") || "Mon"); // Sun, Mon, Tue...

  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = map[weekdayStr] ?? 1;

  return { year, month, day, weekday };
}

function addDaysUTCNoon(y, m, d, deltaDays) {
  // usa UTC ao meio-dia para evitar “pulos” por fuso/DST, e retorna Y-M-D
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate()
  };
}

function getWeekRangeISO() {
  // Semana vigente: segunda a domingo, em YYYY-MM-DD, respeitando TZ
  // weekday: 0=domingo ... 6=sábado (map acima)
  const { year, month, day, weekday } = getZonedYMDW(TZ);

  // quantos dias desde a segunda-feira
  // se domingo(0) -> 6 dias desde segunda; se segunda(1) -> 0; ...; sábado(6) -> 5
  const daysSinceMonday = weekday === 0 ? 6 : (weekday - 1);

  const monday = addDaysUTCNoon(year, month, day, -daysSinceMonday);
  const sunday = addDaysUTCNoon(monday.year, monday.month, monday.day, 6);

  return {
    start: ymdToString(monday.year, monday.month, monday.day),
    end: ymdToString(sunday.year, sunday.month, sunday.day)
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
  // Cria tabelas se não existirem (1 statement por query)
  const sqlRelatorios = `
    CREATE TABLE IF NOT EXISTS relatorios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      titulo VARCHAR(255) NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  const sqlLancamentos = `
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
    await conn.query(sqlRelatorios);
    await conn.query(sqlLancamentos);
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
    console.error("[HEALTH][DB] Falha no ping do MySQL:", {
      message: err && err.message,
      code: err && err.code,
      errno: err && err.errno,
      sqlState: err && err.sqlState,
      using: DB_URL ? "DB_URL/MYSQL_URL" : "DB_HOST",
      DB_HOST: DB_HOST,
      DB_PORT: DB_PORT,
      DB_USER: DB_USER,
      DB_NAME: DB_NAME
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
  return res.json({ ok: true, role: "supervisor" });
});

// Criar relatório da semana vigente (sempre cria um novo, simples e estável)
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

    const dataISO = (req.body && req.body.data ? req.body.data : "").toString().trim();
    const codigo = (req.body && req.body.codigo ? req.body.codigo : "").toString().trim();
    const observacao = (req.body && req.body.observacao ? req.body.observacao : "").toString();

    if (!dataISO || !codigo) {
      return res.status(400).json({ error: "Campos obrigatórios: data, codigo." });
    }

    const dataDia = new Date(dataISO);
    if (Number.isNaN(dataDia.getTime())) {
      return res.status(400).json({ error: "Data inválida." });
    }
    const dataYYYYMMDD = dataDia.toISOString().slice(0, 10);

    const rel = await safeQuery("SELECT id FROM relatorios WHERE id = ?", [relatorioId]);
    if (!rel.length) {
      return res.status(404).json({ error: "Relatório não encontrado." });
    }

    const r = await safeQuery(
      "INSERT INTO lancamentos (relatorio_id, data, codigo, observacao) VALUES (?, ?, ?, ?)",
      [relatorioId, dataYYYYMMDD, codigo, observacao || null]
    );

    return res.json({ ok: true, id: r.insertId });
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

// PDF final (somente nomes autorizados)
app.get("/api/relatorios/:id/pdf", mustBeSupervisor, async (req, res) => {
  const nome = (req.query.nome || "").toString().trim();

  if (!PDF_ALLOWED_NAMES.has(nome)) {
    return res.status(403).json({ error: "PDF final permitido somente para Alberto e Major Mosna." });
  }

  let PDFDocument;
  try {
    PDFDocument = require("pdfkit");
  } catch (e) {
    return res.status(501).json({
      error: "Geração de PDF indisponível (dependência PDFKit não instalada)."
    });
  }

  try {
    const relatorioId = Number(req.params.id);
    const relRows = await safeQuery("SELECT * FROM relatorios WHERE id = ?", [relatorioId]);
    if (!relRows.length) return res.status(404).json({ error: "Relatório não encontrado." });

    const lancRows = await safeQuery(
      "SELECT * FROM lancamentos WHERE relatorio_id = ? ORDER BY data ASC, created_at ASC, id ASC",
      [relatorioId]
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="escala_${relatorioId}.pdf"`);

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    doc.fontSize(16).text(relRows[0].titulo, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(11).text(`Período: ${relRows[0].period_start} a ${relRows[0].period_end}`, { align: "center" });
    doc.moveDown(1);
    doc.fontSize(10).text(`Gerado por: ${nome}`);
    doc.moveDown(1);

    doc.fontSize(12).text("Lançamentos:", { underline: true });
    doc.moveDown(0.5);

    if (!lancRows.length) {
      doc.fontSize(10).text("Nenhum lançamento registrado.");
    } else {
      lancRows.forEach((l) => {
        doc.fontSize(10).text(`${l.data} — ${l.codigo}`);
        if (l.observacao) doc.fontSize(9).text(`Obs: ${l.observacao}`);
        doc.moveDown(0.5);
      });
    }

    doc.end();
  } catch (err) {
    console.error("[PDF] erro:", err);
    return res.status(500).json({ error: "Erro ao gerar PDF.", details: err.message });
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
      console.log("WEEK=", getWeekRangeISO());
    });
  } catch (err) {
    console.error("FALHA AO INICIALIZAR:", err);
    process.exit(1);
  }
})();