"use strict";

const path = require("path");
const express = require("express");
const mysql = require("mysql2/promise");
const PDFDocument = require("pdfkit");

// libs já presentes no package.json
const compression = require("compression");
const helmet = require("helmet");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ===============================
// CONFIG
// ===============================
const PORT = Number(process.env.PORT || 8080);

const DB_HOST = process.env.DB_HOST || "db";
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || "app";
const DB_PASSWORD = process.env.DB_PASSWORD || "app";
// compatibilidade: alguns ambientes usam DB_NAME, outros DB_DATABASE
const DB_NAME = process.env.DB_NAME || process.env.DB_DATABASE || "escala";

const SUPERVISOR_KEY = process.env.SUPERVISOR_KEY || "supervisor123";

// ===============================
// NOMES AUTORIZADOS PDF
// ===============================
const PDF_ALLOWED_NAMES = new Set([
  "Alberto Franzini Neto",
  "Eduardo Mosna Xavier"
]);

// ===============================
// DB POOL
// ===============================
const pool = mysql.createPool({
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
// AUTENTICAÇÃO
// ===============================
function authRequired(req, res, next) {
  const key = (req.headers["x-access-key"] || "").toString().trim();

  if (key !== SUPERVISOR_KEY) {
    return res.status(401).json({ error: "Acesso negado." });
  }

  req.user = { role: "supervisor" };
  next();
}

// ===============================
// SEMANA ATUAL
// ===============================
function getWeekRangeISO() {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : (1 - day);

  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() + diffToMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10)
  };
}

// ===============================
// ROTAS
// ===============================
app.get("/api/health", async (req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.post("/api/login", (req, res) => {
  const key = (req.body.access_key || "").trim();

  if (key !== SUPERVISOR_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }

  res.json({ ok: true, role: "supervisor" });
});

app.post("/api/relatorios", authRequired, async (req, res) => {
  try {
    const titulo = (req.body.titulo || "Escala Semanal").trim();
    const { start, end } = getWeekRangeISO();

    const [result] = await pool.execute(
      `INSERT INTO relatorios (titulo, semana_inicio, semana_fim, criado_em)
       VALUES (?, ?, ?, NOW())`,
      [titulo, start, end]
    );

    res.json({
      ok: true,
      relatorio: {
        id: result.insertId,
        titulo,
        semana_inicio: start,
        semana_fim: end
      }
    });
  } catch {
    res.status(500).json({ error: "Erro ao criar relatório." });
  }
});

app.post("/api/relatorios/:id/lancamentos", authRequired, async (req, res) => {
  try {
    const relatorioId = Number(req.params.id);
    const { data, codigo, observacao } = req.body;

    if (!data || !codigo) {
      return res.status(400).json({ error: "Campos obrigatórios." });
    }

    await pool.execute(
      `INSERT INTO lancamentos (relatorio_id, data_dia, codigo, observacao, criado_em)
       VALUES (?, ?, ?, ?, NOW())`,
      [relatorioId, data, codigo, observacao || ""]
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Erro ao salvar." });
  }
});

// ===============================
// PDF PROTEGIDO
// ===============================
app.get("/api/relatorios/:id/pdf", authRequired, async (req, res) => {
  try {
    const relatorioId = Number(req.params.id);
    const nome = (req.query.nome || "").trim();

    if (!PDF_ALLOWED_NAMES.has(nome)) {
      return res.status(403).json({ error: "PDF permitido apenas para Alberto e Major Mosna." });
    }

    const [rel] = await pool.execute(
      `SELECT * FROM relatorios WHERE id = ?`,
      [relatorioId]
    );

    if (!rel.length) {
      return res.status(404).json({ error: "Relatório não encontrado." });
    }

    const [rows] = await pool.execute(
      `SELECT * FROM lancamentos
       WHERE relatorio_id = ?
       ORDER BY data_dia ASC`,
      [relatorioId]
    );

    res.setHeader("Content-Type", "application/pdf");
    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    doc.fontSize(16).text("Escala Semanal de Oficiais", { align: "center" });
    doc.moveDown();

    doc.fontSize(11).text(`Semana: ${rel[0].semana_inicio} a ${rel[0].semana_fim}`);
    doc.text(`Gerado por: ${nome}`);
    doc.moveDown();

    rows.forEach(r => {
      doc.text(`${String(r.data_dia).slice(0,10)} - ${r.codigo}`);
      if (r.observacao) {
        doc.text(`Observação: ${r.observacao}`);
      }
      doc.moveDown(0.5);
    });

    doc.end();

  } catch {
    res.status(500).json({ error: "Erro ao gerar PDF." });
  }
});

// fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`OK - Backend rodando na porta ${PORT}`);
});