"use strict";

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ===============================
// CONFIG / ENV
// ===============================
const PORT = Number(process.env.PORT || 8080);
process.env.TZ = (process.env.TZ || "America/Sao_Paulo").trim();

// Semana mÃ­nima (segunda-feira) para iniciar o sistema automaticamente, sem precisar forÃ§ar via variÃ¡vel.
// Ex.: quando a semana anterior jÃ¡ passou, iniciamos diretamente na prÃ³xima.
const CUTOVER_WEEK_START = "2026-03-09";
// Se quiser forÃ§ar manualmente a semana exibida (ex.: liberar semana futura), defina WEEK_START_OVERRIDE=YYYY-MM-DD (segunda-feira)
const WEEK_START_OVERRIDE = (process.env.WEEK_START_OVERRIDE || "").trim();

const JWT_SECRET = (process.env.JWT_SECRET || "troque-este-segredo").trim();
const DEFAULT_PASSWORD = (process.env.DEFAULT_PASSWORD || "sr123").trim();

const CLOSE_FRIDAY_HOUR = Number(process.env.CLOSE_FRIDAY_HOUR || 11);

const SYSTEM_NAME = (process.env.SYSTEM_NAME || "ESCALA DE OFICIAIS DO 4º BPM/M").trim();
const AUTHOR = (process.env.AUTHOR || "Desenvolvido por Alberto Franzini Neto").trim();
const COPYRIGHT_YEAR = (process.env.COPYRIGHT_YEAR || "2026").toString().trim();

function defaultSignatures() {
  return {
    left_name: "",
    left_role: "",
    center_name: "",
    center_role: "CH P1/P5",
    right_name: "",
    right_role: "SUBCMT",
  };
}


// DB: Railway (URL) > Docker/local (DB_HOST...)
const DB_URL = (process.env.DB_URL || process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL || "").trim();

// Defaults para Docker/local (quando DB_URL nÃ£o existir)
const DB_HOST = (process.env.DB_HOST || "db").trim();
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = (process.env.DB_USER || "app").trim();
const DB_PASSWORD = (process.env.DB_PASSWORD || "app").trim();
const DB_NAME = (process.env.DB_NAME || process.env.DB_DATABASE || "escala").trim();

// ===============================
// OFICIAIS (lista fixa)
// - canonical_name: chave Ãºnica do oficial (sem posto)
// - rank: posto/graduaÃ§Ã£o a exibir
// - name: nome completo a exibir
// ===============================
const OFFICERS = [
  { canonical_name: "Helder Antonio de Paula", rank: "Ten Cel PM", name: "Helder Antonio de Paula" },
  { canonical_name: "Ricardo Santos Medeiros", rank: "Maj PM", name: "Ricardo Santos Medeiros" },
  { canonical_name: "Carlos Bordim Neto", rank: "Maj PM", name: "Carlos Bordim Neto" },
  { canonical_name: "Marcio Saito Essaki", rank: "Cap PM", name: "Marcio Saito Essaki" },
  { canonical_name: "Jose Antonio Marciano Neto", rank: "Cap PM", name: "Jose Antonio Marciano Neto" },
  { canonical_name: "Alberto Franzini Neto", rank: "Cap PM", name: "Alberto Franzini Neto" },
  { canonical_name: "Vinicio Augusto Voltarelli Tavares", rank: "Cap PM", name: "Vinicio Augusto Voltarelli Tavares" },
  { canonical_name: "Andre Santarelli de Paula", rank: "Cap PM", name: "Andre Santarelli de Paula" },
  { canonical_name: "Iuri Filipe dos Santos", rank: "Cap PM", name: "Iuri Filipe dos Santos" },
  { canonical_name: "Daniel Alves de Siqueira", rank: "1º Ten PM", name: "Daniel Alves de Siqueira" },
  { canonical_name: "Fernanda Bruno Pomponio Martignago", rank: "1º Ten Dent PM", name: "Fernanda Bruno Pomponio Martignago" },
  { canonical_name: "Dayana de Oliveira Silva Almeida", rank: "1º Ten Dent PM", name: "Dayana de Oliveira Silva Almeida" },
  { canonical_name: "Antonio Ovidio Ferruccio Cardoso", rank: "1º Ten PM", name: "Antonio Ovidio Ferruccio Cardoso" },
  { canonical_name: "Bruno Antao de Oliveira", rank: "1º Ten PM", name: "Bruno Antao de Oliveira" },
  { canonical_name: "Larissa Amadeu Leite", rank: "1º Ten PM", name: "Larissa Amadeu Leite" },
  { canonical_name: "Renato Fernandes Freire", rank: "1º Ten PM", name: "Renato Fernandes Freire" },
  { canonical_name: "Raphael Mecca Sampaio", rank: "1º Ten PM", name: "Raphael Mecca Sampaio" },
  { canonical_name: "Jose Sebastiao dos Santos Neto", rank: "Asp Of PM", name: "Jose Sebastiao dos Santos Neto" },
  { canonical_name: "Lenise Helena Tragante de Souza Cristo", rank: "Asp Of PM", name: "Lenise Helena Tragante de Souza Cristo" },
];
            
// override visual para postos (Ten Dent) — garante exibiÃ§Ã£o correta no state e no PDF
function fixDentRanks(list) {
  return (Array.isArray(list) ? list : []).map(o => {
    if (!o || typeof o !== "object") return o;
    if (o.canonical_name === "Fernanda Bruno Pomponio Martignago") return { ...o, rank: "1º Ten Dent PM" };
    if (o.canonical_name === "Dayana de Oliveira Silva Almeida") return { ...o, rank: "1º Ten Dent PM" };
    return o;
  });
}


// ApÃ³s fechamento (sexta 11h+), somente estes podem alterar (qualquer oficial)
const ADMIN_NAMES = new Set([
  "Alberto Franzini Neto",
  "Helder Antonio de Paula",
  "Ricardo Santos Medeiros",
  "Marcio Saito Essaki",
  "Iuri Filipe dos Santos",
  "Daniel Alves de Siqueira",
]);

// CÃ³digos vÃ¡lidos (tudo em MAIÃšSCULO, conforme regra)
// - códigos terminados em * permitem descrição
// - FOJ: sem descrição
const CODES = ["EXP", "SR", "MA", "VE", "FOJ", "FO*", "SV*", "LP", "FERIAS", "FERIADO", "CONVALESCENCA", "CURSO", "CFP_DIA", "CFP_NOITE", "OUTROS", "SS", "EXP_SS", "FO", "PF", "CAO", "EAP", "CSP", "PPJM", "DS", "CFT", "TJM", "LUTO", "LICENCA PATERNIDADE", "NUPCIAS", "LICENCA ADOCAO"];

function normalizeCodeValue(value) {
  let code = stripAccents(String(value || "")).trim().replace(/\s+/g, " ").toUpperCase();
  if (!code) return "";
  const compact = code.replace(/[\s._-]+/g, "");
  if (compact === "FO") return "FO";
  if (compact === "FOJ") return "FOJ";
  if (compact === "FO*") return "FO*";
  if (compact === "SV*") return "SV*";
  if (compact === "CFPDIA") return "CFP_DIA";
  if (compact === "CFPNOITE") return "CFP_NOITE";
  if (compact === "EXPSS") return "EXP_SS";
  if (compact === "FERIAS") return "FERIAS";
  if (compact === "CONVALESCENCA") return "CONVALESCENCA";
  if (compact === "LICENCAPATERNIDADE") return "LICENCA PATERNIDADE";
  if (compact === "LICENCAADOCAO" || compact === "LICENAADDO" || compact === "LICENCAADDO") return "LICENCA ADOCAO";
  if (compact === "NUPCIAS") return "NUPCIAS";
  return code;
}

// ===============================
// APP
// ===============================
const app = express();
app.set("trust proxy", true);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "3mb" }));

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

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
      timezone: "Z",
      connectTimeout: 5000,
    });

// ===============================
// UTIL
// ===============================
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}


function fixText(s) {
  const str = String(s ?? "");
  if (!str) return "";
  // Corrige "mojibake" comum (UTF-8 interpretado como Latin-1 e regravado).
  if (/[ÃÂ�]/.test(str)) {
    try { return Buffer.from(str, "latin1").toString("utf8"); } catch (_e) {}
  }
  return str;
}

// Remove acentos (usar APENAS para nomes de oficiais, conforme regra).
function stripAccents(s) {
  return fixText(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function officerNameNoAccents(s) {
  return stripAccents(s).trim().replace(/\s+/g, " ");
}

function normKey(s) {
  return stripAccents(s).toLowerCase().trim().replace(/\s+/g, " ");
}

function fmtYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmtDDMMYYYY(iso) {
  const [y, m, d] = String(iso || "").split("-");
  if (!y || !m || !d) return String(iso || "");
  return `${d}/${m}/${y}`;
}

// Formata data/hora em pt-BR (SÃ£o Paulo) no padrÃ£o: dd/mm/aaaa às HHhMM
function fmtDDMMYYYYHHmm(value) {
  if (!value) return "";
  const dt = (value instanceof Date) ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return "";

  // Usa timeZone explicitamente para nÃ£o depender do TZ do processo.
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);

  const get = (type) => (parts.find(p => p.type === type) || {}).value || "";
  const dd = get("day");
  const mm = get("month");
  const yyyy = get("year");
  const hh = get("hour");
  const mi = get("minute");
  if (!dd || !mm || !yyyy) return "";

  const dateStr = `${dd}/${mm}/${yyyy}`;
  if (!hh || !mi) return dateStr;
  return `${dateStr} às ${hh}h${mi}`;
}

// Semana FUTURA: o sistema sempre exibe a próxima segunda-feira até o próximo domingo.
// Exemplo: durante 09/03 a 15/03, mostra 16/03 a 22/03.
// Na virada de domingo 00h para segunda, passa a mostrar a semana seguinte.
// Regra adicional: nunca retornar semana anterior a CUTOVER_WEEK_START (segunda-feira).
// Se WEEK_START_OVERRIDE estiver definido, ele prevalece integralmente.

function getWeekRangeISO() {
  if (WEEK_START_OVERRIDE && /^\d{4}-\d{2}-\d{2}$/.test(WEEK_START_OVERRIDE)) {
    const [oy, om, od] = WEEK_START_OVERRIDE.split("-").map(Number);
    const monday = new Date(oy, om - 1, od);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setHours(0, 0, 0, 0);
    sunday.setDate(monday.getDate() + 6);
    return { start: fmtYYYYMMDD(monday), end: fmtYYYYMMDD(sunday) };
  }

  const now = new Date(); // respeita TZ no processo
  now.setHours(0, 0, 0, 0);

  const day = now.getDay(); // 0=dom, 1=seg, ..., 6=sáb
  const daysUntilNextMonday = day === 0 ? 1 : 8 - day;

  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilNextMonday);
  nextMonday.setHours(0, 0, 0, 0);

  const [cy, cm, cd] = CUTOVER_WEEK_START.split("-").map(Number);
  const cutover = new Date(cy, cm - 1, cd);
  cutover.setHours(0, 0, 0, 0);

  const monday = new Date(Math.max(nextMonday.getTime(), cutover.getTime()));
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setHours(0, 0, 0, 0);
  sunday.setDate(monday.getDate() + 6);

  return { start: fmtYYYYMMDD(monday), end: fmtYYYYMMDD(sunday) };
}

function buildDatesForWeek(startYYYYMMDD) {
  const dates = [];
  const [y, m, d] = startYYYYMMDD.split("-").map(Number);
  const base = new Date(y, m - 1, d);
  base.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const cur = new Date(base);
    cur.setDate(base.getDate() + i);
    dates.push(fmtYYYYMMDD(cur));
  }
  return dates;
}

// Fechamento: sexta-feira às 11h (SÃ£o Paulo) atÃ© domingo
function isClosedNow() {
  const now = new Date();
  const day = now.getDay(); // 5=sexta
  const hour = now.getHours();

  if (day < 5) return false;
  if (day === 5) return hour >= CLOSE_FRIDAY_HOUR;
  return true; // sabado/domingo
}

function shouldRunAutoFillNow() {
  return isClosedNow();
}

function isAdminName(canonicalName) {
  return ADMIN_NAMES.has(String(canonicalName || "").trim());
}

function officerRankValue(off) {
  const r = stripAccents(String((off && off.rank) || "")).toLowerCase();
  if (r.includes("ten cel")) return 1;
  if (r.includes("maj")) return 2;
  if (r.includes("cap")) return 3;
  if (r.includes("ten")) return 4;
  if (r.includes("asp")) return 5;
  return 9;
}

function isCapOrAbove(off) {
  return officerRankValue(off) <= 3;
}

// ===============================
// FERIADOS (Brasil - nacionais + mÃ³veis)
// ===============================
function easterDate(year) {
  // Computus (Meeus/Jones/Butcher)
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=marÃ§o,4=abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function isoFromDate(d) {
  return fmtYYYYMMDD(d);
}

function getHolidaysForWeek(weekDates) {
  if (!Array.isArray(weekDates) || !weekDates.length) return [];
  const year = Number(weekDates[0].slice(0,4));
  const set = new Map();

  // Feriados nacionais fixos, sem acentos para evitar problema de codificacao.
  const fixed = [
    ["01-01", "Confraternizacao Universal"],
    ["21-04", "Tiradentes"],
    ["01-05", "Dia do Trabalhador"],
    ["07-09", "Independencia do Brasil"],
    ["12-10", "Nossa Senhora Aparecida"],
    ["02-11", "Finados"],
    ["15-11", "Proclamacao da Republica"],
    ["25-12", "Natal"],
  ];
  for (const [md, name] of fixed) set.set(`${year}-${md}`, { name, type: "FERIADO" });

  // Moveis nacionais.
  const easter = easterDate(year);
  const carnaval = addDays(easter, -47);
  const sextaSanta = addDays(easter, -2);
  const corpusChristi = addDays(easter, 60);

  set.set(isoFromDate(carnaval), { name: "Carnaval", type: "FERIADO" });
  set.set(isoFromDate(sextaSanta), { name: "Paixao de Cristo", type: "FERIADO" });
  set.set(isoFromDate(corpusChristi), { name: "Corpus Christi", type: "FERIADO" });

  // Ponto facultativo automatico:
  // feriado na terca => segunda anterior PF; feriado na quinta => sexta posterior PF.
  const pf = new Map();
  for (const [iso, info] of Array.from(set.entries())) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    const day = dt.getDay();
    if (day === 2) {
      pf.set(isoFromDate(addDays(dt, -1)), { name: `Ponto facultativo anterior a ${info.name}`, type: "PF" });
    }
    if (day === 4) {
      pf.set(isoFromDate(addDays(dt, 1)), { name: `Ponto facultativo posterior a ${info.name}`, type: "PF" });
    }
  }

  const out = [];
  for (const iso of weekDates) {
    if (set.has(iso)) out.push({ date: iso, ...set.get(iso) });
    if (pf.has(iso) && !set.has(iso)) out.push({ date: iso, ...pf.get(iso) });
  }
  return out;
}

function autoCodeForOfficerDate(off, iso, holidays) {
  if (!isCapOrAbove(off)) return "";
  const h = (holidays || []).find(x => x.date === iso);
  if (h && h.type === "PF") return "PF";
  if (h && h.type === "FERIADO") return "FERIADO";
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(y, m - 1, d).getDay();
  if (day === 0 || day === 6) return "FO";
  return "EXP";
}

function applyAutoFill(st) {
  if (!st || !shouldRunAutoFillNow()) return false;
  st.assignments = st.assignments && typeof st.assignments === "object" ? st.assignments : {};
  const holidays = getHolidaysForWeek(st.dates || []);
  let changed = false;
  for (const off of OFFICERS) {
    if (!isCapOrAbove(off)) continue;
    for (const iso of st.dates || []) {
      const key = `${off.canonical_name}|${iso}`;
      if (String(st.assignments[key] || "").trim()) continue;
      const code = autoCodeForOfficerDate(off, iso, holidays);
      if (code) {
        st.assignments[key] = code;
        changed = true;
      }
    }
  }
  return changed;
}

// ===============================
// SCHEMA / STATE
// ===============================
async function ensureSchema() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS state_store (
      id INT PRIMARY KEY,
      payload LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

    await conn.query(`CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      canonical_name VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      must_change TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

    await conn.query(`CREATE TABLE IF NOT EXISTS action_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor_name VARCHAR(255) NOT NULL,
      target_name VARCHAR(255) NOT NULL,
      action VARCHAR(64) NOT NULL,
      details TEXT NULL,
      INDEX idx_at (at),
      INDEX idx_actor (actor_name),
      INDEX idx_target (target_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

    // lanÃ§amentos por dia (persistÃªncia da semana)
    await conn.query(`CREATE TABLE IF NOT EXISTS escala_lancamentos (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      data DATE NOT NULL,
      oficial VARCHAR(255) NOT NULL,
      codigo VARCHAR(32) NOT NULL,
      observacao TEXT NULL,
      created_by VARCHAR(255) NULL,
      updated_by VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_data_oficial (data, oficial),
      INDEX idx_data (data),
      INDEX idx_oficial (oficial)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

    // migraÃ§Ã£o defensiva: colunas faltantes em 'escala_lancamentos' (ambientes antigos)
    // (usa information_schema para evitar erro de coluna duplicada)
    try {
      const [cols] = await conn.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'escala_lancamentos'"
      );
      const names = new Set((cols || []).map(c => String(c.column_name || c.COLUMN_NAME || "").toLowerCase()));
      if (!names.has("observacao")) await conn.query("ALTER TABLE escala_lancamentos ADD COLUMN observacao TEXT NULL");
      if (!names.has("created_by")) await conn.query("ALTER TABLE escala_lancamentos ADD COLUMN created_by VARCHAR(255) NULL");
      if (!names.has("updated_by")) await conn.query("ALTER TABLE escala_lancamentos ADD COLUMN updated_by VARCHAR(255) NULL");
    } catch (e) {
      // tolera corrida/duplicidade em inicializaÃ§Ã£o concorrente
      const code = String((e && e.code) || "");
      const msg = String((e && e.message) || "");
      if (!code.includes("ER_DUP_FIELDNAME") && !msg.toLowerCase().includes("duplicate column")) throw e;
    }
// logs detalhados de alteraÃ§Ãµes (histÃ³rico)
await conn.query(`CREATE TABLE IF NOT EXISTS escala_change_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_name VARCHAR(255) NOT NULL,
  target_name VARCHAR(255) NOT NULL,
  data DATE NOT NULL,
  field_name VARCHAR(32) NOT NULL,   -- 'codigo' | 'observacao'
  before_value TEXT NULL,
  after_value TEXT NULL,
  INDEX idx_at (at),
  INDEX idx_target (target_name),
  INDEX idx_data (data)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);


    const [rows] = await conn.query("SELECT id FROM state_store WHERE id=1 LIMIT 1");
    if (!rows.length) {
      const initial = buildFreshState();
      await conn.query("INSERT INTO state_store (id, payload) VALUES (1, ?)", [JSON.stringify(initial)]);
    }
  } finally {
    conn.release();
  }
}

function buildFreshState() {
  const w = getWeekRangeISO();
  const dates = buildDatesForWeek(w.start);

  const fresh = {
    meta: {
      system_name: fixText(SYSTEM_NAME),
      footer_mark: `© ${COPYRIGHT_YEAR} - ${fixText(AUTHOR)}`,
      signatures: defaultSignatures(),
    },
    period: { start: w.start, end: w.end },
    dates,
    codes: CODES.slice(),
    officers: OFFICERS.slice(),
    assignments: {},
    notes: {},
    updated_at: new Date().toISOString(),
  };
  applyAutoFill(fresh);
  return fresh;
}

async function safeQuery(sql, params = []) {
  const ACQUIRE_MS = Number(process.env.DB_ACQUIRE_TIMEOUT_MS || 8000);
  const QUERY_MS = Number(process.env.DB_QUERY_TIMEOUT_MS || 8000);

  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);

  const conn = await withTimeout(pool.getConnection(), ACQUIRE_MS, "db_acquire_timeout");
  try {
    // mysql2 aceita timeout por query quando enviado como objeto { sql, timeout }
    const queryObj = (typeof sql === "string") ? { sql, timeout: QUERY_MS } : { ...sql, timeout: QUERY_MS };
    const [rows] = await withTimeout(conn.query(queryObj, params), QUERY_MS + 500, "db_query_timeout");
    return rows;
  } finally {
    try { conn.release(); } catch (_e) {}
  }
}
function isoFromDbDate(v) {
  if (!v) return "";
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // strings: aceita 'YYYY-MM-DD', 'YYYY/MM/DD', e valores com hora/offset
  let s = String(v).trim();
  if (!s) return "";

  // pega sÃ³ a parte de data se vier com hora
  if (s.length >= 10) s = s.slice(0, 10);

  // normaliza separador
  if (s.includes("/")) s = s.replaceAll("/", "-");

  // se vier no formato DD-MM-YYYY por algum motivo, converte
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (m) {
    const dd = m[1];
    const mm = m[2];
    const yy = m[3];
    return `${yy}-${mm}-${dd}`;
  }

  return s;
}

function resolveCanonicalFromDbOfficer(oficialStr) {
  const nk = normKey(oficialStr);
  if (!nk) return null;
  for (const off of OFFICERS) {
    const ok = normKey(off.canonical_name);
    if (ok && (nk.includes(ok) || ok.includes(nk))) return off.canonical_name;
  }
  return null;
}

async function fetchLancamentosForPeriod(periodStartISO, periodEndISO) {
  // periodStartISO / periodEndISO sÃ£o YYYY-MM-DD
  // CompatÃ­vel com coluna 'data' como DATE ou como string (ex.: 'YYYY/MM/DD')
  const sql = `
    SELECT data, oficial, codigo, observacao, created_at, updated_at, created_by, updated_by
      FROM escala_lancamentos
     WHERE (
       CASE
         WHEN CAST(data AS CHAR) LIKE '%/%'
           THEN STR_TO_DATE(CAST(data AS CHAR), '%Y/%m/%d')
         ELSE STR_TO_DATE(SUBSTRING(CAST(data AS CHAR), 1, 10), '%Y-%m-%d')
       END
     ) BETWEEN ? AND ?
  `;
  return safeQuery(sql, [periodStartISO, periodEndISO]);
}

function fetchChangeLogsForPeriod(periodStartISO, periodEndISO, limit = 500) {
  const sql = `
    SELECT at, actor_name, target_name, data, field_name, before_value, after_value
      FROM escala_change_log
     WHERE data BETWEEN ? AND ?
     ORDER BY at ASC
     LIMIT ?
  `;
  return safeQuery(sql, [periodStartISO, periodEndISO, limit]);
}

async function fetchLastActionForPeriod(periodStartISO, periodEndISO) {
  // action_logs.at Ã© TIMESTAMP; filtra pela janela da semana (SÃ£o Paulo)
  const start = `${periodStartISO} 00:00:00`;
  const end = `${periodEndISO} 23:59:59`;
  const sql = `
    SELECT at, actor_name, action
      FROM action_logs
     WHERE at BETWEEN ? AND ?
       AND action IN ('update_day','update_signatures','reset_week')
     ORDER BY at DESC
     LIMIT 1
  `;
  const rows = await safeQuery(sql, [start, end]);
  return (rows && rows.length) ? rows[0] : null;
}


function buildAssignmentsAndNotesFromLancamentos(rows, validDates) {
  const assignments = {};
  const notes = {};
  const notes_meta = {};

  const valid = new Set(validDates || []);
  const validCodes = new Set(CODES);

  for (const r of rows || []) {
    const iso = isoFromDbDate(r.data);
    if (!valid.has(iso)) continue;

    const canonical = resolveCanonicalFromDbOfficer(r.oficial);
    if (!canonical) continue;

    // normaliza codigo vindo do DB (legado), sempre sem acento.
    let code = normalizeCodeValue(r.codigo);

    if (!validCodes.has(code)) {
      // ignora cÃ³digos desconhecidos/antigos
      continue;
    }

    const key = `${canonical}|${iso}`;
    assignments[key] = code;

    // observação só faz sentido em OUTROS e códigos terminados em *
    const obs = (r.observacao == null) ? "" : String(r.observacao).trim();
    if (obs && (code === "OUTROS" || /\*$/.test(code))) {
      notes[key] = obs;

      // metadados para exibir no sistema/PDF
      const updatedAt = r.updated_at ? new Date(r.updated_at).toISOString() : null;
      notes_meta[key] = {
        updated_at: updatedAt,
        updated_by: r.updated_by ? String(r.updated_by) : null,
        created_by: r.created_by ? String(r.created_by) : null,
      };
    }
  }

  return { assignments, notes, notes_meta };
}

async function getStateAutoReset() {
  const rows = await safeQuery("SELECT payload FROM state_store WHERE id=1 LIMIT 1");
  let st = rows.length ? safeJsonParse(rows[0].payload) : null;

  const currentWeek = getWeekRangeISO();
  const needReset = !st || !st.period || st.period.start !== currentWeek.start || st.period.end !== currentWeek.end;

  if (needReset) {
    // se existia uma semana anterior registrada, significa virada de semana â†’ limpar lanÃ§amentos (segunda-feira inicia nova semana e limpa somente a escala semanal)
    // nÃ£o remove usuÃ¡rios nem logs, apenas a tabela de registros da escala.
    try {
      if (st && st.period && (st.period.start || st.period.end)) {
        await safeQuery("DELETE FROM escala_lancamentos");
      }
    } catch (_e) {
      // ignora se a tabela nÃ£o existir em algum ambiente
    }

    st = buildFreshState();
    await safeQuery(
      "INSERT INTO state_store (id, payload) VALUES (1, ?) ON DUPLICATE KEY UPDATE payload=VALUES(payload), updated_at=CURRENT_TIMESTAMP",
      [JSON.stringify(st)]
    );
    return { st, didReset: true };
  }

  // garante campos
  st.meta = st.meta || {};
  st.meta.system_name = SYSTEM_NAME;
  st.meta.footer_mark = `© ${COPYRIGHT_YEAR} - ${AUTHOR}`;
  st.meta.signatures = st.meta.signatures && typeof st.meta.signatures === "object" ? st.meta.signatures : defaultSignatures();
  st.codes = CODES.slice();
  st.officers = OFFICERS.slice();
  st.period = { start: currentWeek.start, end: currentWeek.end };
  st.dates = buildDatesForWeek(currentWeek.start);
  st.assignments = st.assignments && typeof st.assignments === "object" ? st.assignments : {};
  st.notes = st.notes && typeof st.notes === "object" ? st.notes : {};

  if (applyAutoFill(st)) {
    st.updated_at = new Date().toISOString();
    await safeQuery(
      "INSERT INTO state_store (id, payload) VALUES (1, ?) ON DUPLICATE KEY UPDATE payload=VALUES(payload), updated_at=CURRENT_TIMESTAMP",
      [JSON.stringify(st)]
    );
  }
  return { st, didReset: false };

}

// ===============================
// AUTH
// ===============================
function signToken(me) {
  return jwt.sign(
    { canonical_name: me.canonical_name, is_admin: !!me.is_admin, must_change: !!me.must_change },
    JWT_SECRET,
    { expiresIn: "14d" }
  );
}

// token curto e especÃ­fico para abrir PDF via URL (window.open nÃ£o envia headers)
function signPdfToken(me) {
  return jwt.sign(
    { canonical_name: me.canonical_name, is_admin: !!me.is_admin, scope: "pdf" },
    JWT_SECRET,
    { expiresIn: "2m" }
  );
}

function pdfAuth(req, res, next) {
  // 1) Bearer token normal
  const auth = (req.headers["authorization"] || "").toString();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    try {
      const payload = jwt.verify(m[1], JWT_SECRET);
      req.user = {
        canonical_name: String(payload.canonical_name || "").trim(),
        is_admin: !!payload.is_admin,
        must_change: !!payload.must_change,
      };
      return next();
    } catch (_e) {
      // continua para tentar token via query
    }
  }

  // 2) token via query (curto, sÃ³ para PDF)
  const q = (req.query && req.query.token ? String(req.query.token) : "").trim();
  if (!q) return res.status(401).json({ error: "nÃ£o autenticado" });

  try {
    const payload = jwt.verify(q, JWT_SECRET);
    if (payload.scope !== "pdf") return res.status(401).json({ error: "token invÃ¡lido" });
    req.user = {
      canonical_name: String(payload.canonical_name || "").trim(),
      is_admin: !!payload.is_admin,
      must_change: false,
    };
    return next();
  } catch (e) {
    return res.status(401).json({ error: "token invÃ¡lido" });
  }
}

function authRequired(allowMustChange = false) {
  return (req, res, next) => {
    const auth = (req.headers["authorization"] || "").toString();
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "nÃ£o autenticado" });

    try {
      const payload = jwt.verify(m[1], JWT_SECRET);
      req.user = {
        canonical_name: String(payload.canonical_name || "").trim(),
        is_admin: !!payload.is_admin,
        must_change: !!payload.must_change,
      };
      if (!allowMustChange && req.user.must_change) {
        return res.status(403).json({ error: "troca de senha obrigatÃ³ria" });
      }
      return next();
    } catch (e) {
      return res.status(401).json({ error: "token invÃ¡lido" });
    }
  };
}

async function findOrCreateUser(canonical_name) {
  const rows = await safeQuery("SELECT id, canonical_name, password_hash, must_change FROM users WHERE canonical_name=? LIMIT 1", [canonical_name]);
  if (rows.length) return rows[0];

  // cria com senha padrÃ£o e must_change=1
  const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  await safeQuery("INSERT INTO users (canonical_name, password_hash, must_change) VALUES (?, ?, 1)", [canonical_name, hash]);
  const created = await safeQuery("SELECT id, canonical_name, password_hash, must_change FROM users WHERE canonical_name=? LIMIT 1", [canonical_name]);
  return created[0];
}

function resolveOfficerFromInput(nameInput) {
  const nk = normKey(nameInput);
  if (!nk) return null;

  // aceita "posto + nome" ou sÃ³ "nome"
  // remove posto do inÃ­cio se bater com algum rank
  const stripped = nk
    .replace(/^tenente\-coronel pm\s+/, "")
    .replace(/^tenente coronel pm\s+/, "")
    .replace(/^major pm\s+/, "")
    .replace(/^capit(ao|Ã£o) pm\s+/, "")
    .replace(/^1º tenente pm\s+/, "")
    .replace(/^2º tenente pm\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

  const targetNk = stripped || nk;

  let best = null;
  let bestScore = 0;

  for (const off of OFFICERS) {
    const ok = normKey(off.canonical_name);
    // score: tokens em comum
    const a = new Set(targetNk.split(" ").filter(Boolean));
    const b = new Set(ok.split(" ").filter(Boolean));
    const inter = [...a].filter(t => b.has(t)).length;
    const union = new Set([...a, ...b]).size || 1;
    let score = inter / union;

    const aParts = targetNk.split(" ").filter(Boolean);
    const bParts = ok.split(" ").filter(Boolean);
    if (aParts.length && bParts.length) {
      if (aParts[0] === bParts[0]) score += 0.10;
      if (aParts[aParts.length-1] === bParts[bParts.length-1]) score += 0.15;
    }

    if (score > bestScore) {
      bestScore = score;
      best = off;
    }
  }

  // exige mÃ­nimo razoÃ¡vel para evitar erro de pessoa
  if (!best || bestScore < 0.65) return null;
  return best;
}

// ===============================
// LOG
// ===============================
async function logAction(actor, target, action, details = "") {
  await safeQuery(
    "INSERT INTO action_logs (actor_name, target_name, action, details) VALUES (?, ?, ?, ?)",
    [actor, target, action, details || ""]
  );
}

// ===============================
// PDF
// ===============================
function requirePdfKitOr501(res) {
  try {
    return require("pdfkit");
  } catch {
    res.status(501).json({ error: "geraÃ§Ã£o de PDF indisponÃ­vel" });
    return null;
  }
}

// ===============================
// ROTAS
// ===============================
app.get("/api/health", async (_req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    return res.json({ ok: true, tz: process.env.TZ, db_mode: DB_URL ? "url" : "host", week: getWeekRangeISO() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : "falha no health" });
  }
});

// STATUS PÃšBLICO (sem token) â€“ para teste externo e monitoramento no Railway
app.get("/api/status", async (_req, res) => {
  try {
    // nÃ£o falha se o DB estiver indisponÃ­vel: retorna o bÃ¡sico
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
    } catch (_e) {
      // ignora
    }

    const week = getWeekRangeISO();
    return res.json({
      ok: true,
      tz: process.env.TZ,
      week,
      locked: isClosedNow(),
      close_friday_hour: CLOSE_FRIDAY_HOUR,
      system_name: fixText(SYSTEM_NAME),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : "falha no status" });
  }
});

// WEEK PÃšBLICO (sem token) â€“ ajuda o frontend e facilita debug
app.get("/api/week", (_req, res) => {
  const week = getWeekRangeISO();
  return res.json({ ok: true, week, dates: buildDatesForWeek(week.start) });
});

// login: nome + senha
app.post("/api/login", async (req, res) => {
  try {
    const name = (req.body && req.body.name ? req.body.name : "").toString().trim();
    const password = (req.body && req.body.password ? req.body.password : "").toString();

    const off = resolveOfficerFromInput(name);
    if (!off) return res.status(403).json({ error: "nome nÃ£o reconhecido. use posto + nome completo." });

    const userRow = await findOrCreateUser(off.canonical_name);

    const ok = await bcrypt.compare(password, userRow.password_hash);
    if (!ok) return res.status(403).json({ error: "senha invÃ¡lida" });

    const me = {
      canonical_name: off.canonical_name,
      is_admin: isAdminName(off.canonical_name),
      must_change: !!userRow.must_change,
    };

    const token = signToken(me);

    // log
    await logAction(me.canonical_name, me.canonical_name, "login", "");

    return res.json({ ok: true, token, me, must_change: me.must_change });
  } catch (err) {
    return res.status(500).json({ error: "erro no login", details: err.message });
  }
});

// troca obrigatÃ³ria de senha
app.post("/api/change_password", authRequired(true), async (req, res) => {
  try {
    const newPass = (req.body && req.body.new_password ? req.body.new_password : "").toString();
    if (!newPass || newPass.length < 6) return res.status(400).json({ error: "senha muito curta (mÃ­nimo 6)" });

    const hash = await bcrypt.hash(newPass, 10);
    await safeQuery("UPDATE users SET password_hash=?, must_change=0 WHERE canonical_name=?", [hash, req.user.canonical_name]);

    await logAction(req.user.canonical_name, req.user.canonical_name, "change_password", "");

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "erro ao trocar senha", details: err.message });
  }
});

// estado: todos autenticados podem ver (mesmo com must_change)
app.get("/api/state", authRequired(true), async (req, res) => {
  try {
    let st;
    try {
      ({ st } = await getStateAutoReset());
    } catch (e) {
      console.error('[WARN] Falha ao carregar estado persistido; usando estado inicial seguro:', e && e.message ? e.message : e);
      st = buildFreshState();
    }
    const holidays = getHolidaysForWeek(st.dates);

    // se houver lanÃ§amentos no MySQL (escala_lancamentos), eles prevalecem
    let assignments = st.assignments || {};
    const baseNotes = (st.notes && typeof st.notes === "object") ? st.notes : {};
    const baseMeta = (st.notes_meta && typeof st.notes_meta === "object") ? st.notes_meta : {};
    let notes = baseNotes;
    let notes_meta = baseMeta;
    try {
      const rows = await fetchLancamentosForPeriod(st.period.start, st.period.end);
      const built = buildAssignmentsAndNotesFromLancamentos(rows, st.dates);
      if (Object.keys(built.assignments).length) {
        assignments = { ...(st.assignments || {}), ...built.assignments };
        notes = built.notes;
        notes_meta = built.notes_meta || {};
      }
    } catch (_e) {
      // se a tabela ainda nÃ£o existir em algum ambiente, mantÃ©m state_store
    }

    // merge de descriÃ§Ãµes: mantÃ©m state_store.notes quando o MySQL vier sem observaÃ§Ã£o
    try {
      const baseNotes = (st.notes && typeof st.notes === "object") ? st.notes : {};
      const baseMeta = (st.notes_meta && typeof st.notes_meta === "object") ? st.notes_meta : {};
      // se nÃ£o veio nada do DB, usa o state_store
      if (!notes || Object.keys(notes).length === 0) {
        notes = { ...baseNotes };
      } else {
        for (const k of Object.keys(baseNotes)) {
          const v = String(baseNotes[k] || "").trim();
          if (!v) continue;
          const cur = (notes[k] == null) ? "" : String(notes[k]).trim();
          if (!cur) notes[k] = v;
        }
      }
      if (!notes_meta || Object.keys(notes_meta).length === 0) {
        notes_meta = { ...baseMeta };
      } else {
        for (const k of Object.keys(baseMeta)) {
          if (!notes_meta[k]) notes_meta[k] = baseMeta[k];
        }
      }
    } catch (_e) {}

    const periodLabel = `periodo: ${fmtDDMMYYYY(st.period.start)} a ${fmtDDMMYYYY(st.period.end)}`;

    return res.json({
      ok: true,
      me: {
        canonical_name: req.user.canonical_name,
        is_admin: req.user.is_admin,
      },
      meta: {
        system_name: fixText(SYSTEM_NAME),
        footer_mark: `© ${COPYRIGHT_YEAR} - ${fixText(AUTHOR)}`,
        period_label: periodLabel,
        signatures: (st.meta && st.meta.signatures) ? st.meta.signatures : defaultSignatures(),
      },
      locked: isClosedNow(),
      holidays,
      officers: fixDentRanks(OFFICERS).map(o => ({ ...o, rank: fixText(o.rank), name: officerNameNoAccents(o.name) })),
      dates: st.dates,
      codes: CODES,
      assignments,
      notes,
      notes_meta,
    });
  } catch (err) {
    console.error('[ERRO] /api/state:', err && err.stack ? err.stack : err);
    try {
      const st = buildFreshState();
      const holidays = getHolidaysForWeek(st.dates);
      return res.json({
        ok: true,
        me: { canonical_name: req.user.canonical_name, is_admin: req.user.is_admin },
        meta: {
          system_name: fixText(SYSTEM_NAME),
          footer_mark: `© ${COPYRIGHT_YEAR} - ${fixText(AUTHOR)}`,
          period_label: `periodo: ${fmtDDMMYYYY(st.period.start)} a ${fmtDDMMYYYY(st.period.end)}`,
          signatures: defaultSignatures(),
        },
        locked: isClosedNow(),
        holidays,
        officers: fixDentRanks(OFFICERS).map(o => ({ ...o, rank: fixText(o.rank), name: officerNameNoAccents(o.name) })),
        dates: st.dates,
        codes: CODES,
        assignments: st.assignments || {},
        notes: st.notes || {},
        notes_meta: {},
      });
    } catch (_fallbackErr) {
      return res.status(500).json({ error: "erro ao carregar", details: err && err.message ? err.message : String(err) });
    }
  }
});

// assinaturas do PDF (somente admin)
app.put("/api/signatures", authRequired(true), async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({ error: "nÃ£o autorizado" });

    const { st } = await getStateAutoReset();
    const cur = (st.meta && st.meta.signatures) ? st.meta.signatures : defaultSignatures();

    const left_name = String(req.body && req.body.left_name ? req.body.left_name : cur.left_name).trim();
    const left_role = String(req.body && req.body.left_role ? req.body.left_role : cur.left_role).trim();
    const center_name = String(req.body && req.body.center_name ? req.body.center_name : cur.center_name).trim();
    const center_role = String(req.body && req.body.center_role ? req.body.center_role : cur.center_role).trim();
    const right_name = String(req.body && req.body.right_name ? req.body.right_name : cur.right_name).trim();
    const right_role = String(req.body && req.body.right_role ? req.body.right_role : cur.right_role).trim();

    if (left_name.length > 120 || center_name.length > 120 || right_name.length > 120) return res.status(400).json({ error: "nome muito longo" });
    if (left_role.length > 120 || center_role.length > 120 || right_role.length > 120) return res.status(400).json({ error: "cargo/funcao muito longa" });

    st.meta = st.meta || {};
    st.meta.signatures = {
      left_name: left_name.toUpperCase(),
      left_role: left_role.toUpperCase(),
      center_name: center_name.toUpperCase(),
      center_role: center_role.toUpperCase(),
      right_name: right_name.toUpperCase(),
      right_role: right_role.toUpperCase(),
    };

    // metadados do Ãºltimo registro (para PDF)
    st.last_edit_actor = req.user.canonical_name;
    st.last_edit_at = new Date().toISOString();

    await safeQuery(
      "INSERT INTO state_store (id, payload) VALUES (1, ?) ON DUPLICATE KEY UPDATE payload=VALUES(payload), updated_at=CURRENT_TIMESTAMP",
      [JSON.stringify(st)]
    );

    await logAction(req.user.canonical_name, req.user.canonical_name, "update_signatures", "assinaturas do PDF atualizadas");

    return res.json({ ok: true, signatures: st.meta.signatures });
  } catch (err) {
    return res.status(500).json({ error: "erro ao salvar assinaturas", details: err.message });
  }
});


// histÃ³rico de alteraÃ§Ãµes (somente admin)
app.get("/api/change_logs", authRequired(true), async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({ error: "nÃ£o autorizado" });

    const limit = Math.max(10, Math.min(500, Number(req.query && req.query.limit ? req.query.limit : 200)));
    const sql = `
      SELECT id, at, actor_name, target_name, data, field_name, before_value, after_value
        FROM escala_change_log
       ORDER BY at DESC
       LIMIT ?
    `;
    const rows = await safeQuery(sql, [limit]);
    return res.json({ ok: true, rows: rows || [] });
  } catch (err) {
    return res.status(500).json({ error: "erro ao carregar histÃ³rico", details: err.message });
  }
});


// salvar alteraÃ§Ãµes (somente apÃ³s troca de senha)
app.put("/api/assignments", authRequired(false), async (req, res) => {
  try {
    const { st } = await getStateAutoReset();

    const updates = Array.isArray(req.body && req.body.updates) ? req.body.updates : [];
    if (!updates.length) return res.status(400).json({ error: "nenhuma alteraÃ§Ã£o enviada" });

    const locked = isClosedNow();
    const actor = req.user.canonical_name;

    if (locked && !req.user.is_admin) {
      return res.status(423).json({ error: "edicao fechada (sexta 11h ate domingo)" });
    }

    const validDates = new Set(st.dates || []);
    const validCodes = new Set(CODES);
    const officersByCanonical = new Set(OFFICERS.map(o => o.canonical_name));

    let applied = 0;

    for (const u of updates) {
      const date = String(u.date || "").trim();
      if (!validDates.has(date)) continue;

      let target = String(u.canonical_name || "").trim();
      if (!officersByCanonical.has(target)) continue;

      // regra: durante a semana, nÃ£o-admin sÃ³ pode mexer na prÃ³pria linha
      if (!req.user.is_admin) {
        target = actor;
      }

      let code = normalizeCodeValue(u.code);
      if (!code) code = ""; // limpar
      if (code && !validCodes.has(code)) continue;

      const key = `${target}|${date}`;

      const beforeCode = (st.assignments && st.assignments[key]) ? String(st.assignments[key]) : "";
      const beforeObs = (st.notes && st.notes[key]) ? String(st.notes[key]) : "";

      const needObs = (code === "OUTROS" || /\*$/.test(code));
      const newObs = needObs ? String(u.observacao == null ? "" : u.observacao).trim() : "";

      // atualiza state_store (permite limpar)
      st.assignments = st.assignments || {};
      st.notes = st.notes || {};

      if (!code) {
        delete st.assignments[key];
        delete st.notes[key];
      } else {
        st.assignments[key] = code;
        if (needObs) {
          // grava/atualiza observaÃ§Ã£o mesmo se o cÃ³digo nÃ£o mudar
          st.notes[key] = newObs;
        } else {
          delete st.notes[key];
        }
      }

      // persistÃªncia no MySQL
      try {
        if (!code) {
          await safeQuery("DELETE FROM escala_lancamentos WHERE data=? AND oficial=?", [date, target]);
        } else {
          const obsToSave = needObs ? newObs : null;
          await safeQuery(
            "INSERT INTO escala_lancamentos (data, oficial, codigo, observacao, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?) " +
              "ON DUPLICATE KEY UPDATE codigo=VALUES(codigo), observacao=VALUES(observacao), updated_by=VALUES(updated_by), updated_at=CURRENT_TIMESTAMP",
            [date, target, code, obsToSave, actor, actor]
          );
        }
      } catch (_e) {
        // ignora se a tabela nÃ£o existir em algum ambiente
      }

      // log
      const changedCode = (beforeCode || "") !== (code || "");
      const changedObs = needObs && (beforeObs || "") !== (newObs || "");
      if (changedCode || changedObs) {
        const logBefore = beforeCode || "-";
        const logAfter = code || "-";
        const logExtra = needObs ? ` | obs: ${(beforeObs || "-")} -> ${(newObs || "-")}` : "";
        await logAction(actor, target, "update_day", `${date}: ${logBefore} -> ${logAfter}${logExtra}`);
      
// histÃ³rico detalhado
try {
  if (changedCode) {
    await safeQuery(
      "INSERT INTO escala_change_log (actor_name, target_name, data, field_name, before_value, after_value) VALUES (?, ?, ?, 'codigo', ?, ?)",
      [actor, target, date, beforeCode || null, code || null]
    );
  }
  if (changedObs) {
    await safeQuery(
      "INSERT INTO escala_change_log (actor_name, target_name, data, field_name, before_value, after_value) VALUES (?, ?, ?, 'observacao', ?, ?)",
      [actor, target, date, beforeObs || null, newObs || null]
    );
  }
} catch (_e) {
  // ignora
}
}

      applied++;
    }

    // metadados do Ãºltimo registro (para PDF)
    st.last_edit_actor = actor;
    st.last_edit_at = new Date().toISOString();
    st.updated_at = st.last_edit_at;
    await safeQuery(
      "INSERT INTO state_store (id, payload) VALUES (1, ?) ON DUPLICATE KEY UPDATE payload=VALUES(payload), updated_at=CURRENT_TIMESTAMP",
      [JSON.stringify(st)]
    );

    return res.json({ ok: true, applied });
  } catch (err) {
    return res.status(500).json({ error: "erro ao salvar", details: err.message });
  }
});


// PDF: todos autenticados podem ler

// gera link autenticado para abrir PDF em nova aba (sem depender de headers)
app.post("/api/pdf_link", authRequired(true), async (req, res) => {
  try {
    const me = {
      canonical_name: req.user.canonical_name,
      is_admin: !!req.user.is_admin,
    };
    const t = signPdfToken(me);
    return res.json({ ok: true, url: `/api/pdf?token=${encodeURIComponent(t)}` });
  } catch (err) {
    return res.status(500).json({ error: "erro ao gerar link do PDF", details: err.message });
  }
});

app.get("/api/pdf", pdfAuth, async (req, res) => {
  const PDFDocument = requirePdfKitOr501(res);
  if (!PDFDocument) return;

  try {
    const { st } = await getStateAutoReset();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="escala_semanal.pdf"`);

    const doc = new PDFDocument({ margin: 28, size: "A4", layout: "landscape" });
    doc.pipe(res);

    // cabeÃ§alho
    doc.fontSize(16).text(fixText(SYSTEM_NAME), { align: "center" });
    doc.moveDown(0.2);
    doc.fontSize(10).text(`Periodo: ${fmtDDMMYYYY(st.period.start)} a ${fmtDDMMYYYY(st.period.end)}`, { align: "center" });
    doc.moveDown(0.6);

    const dates = st.dates || [];

    // prefere dados do MySQL (escala_lancamentos); fallback para state_store
    let assignments = st.assignments || {};
    // descrições (OUTROS/códigos com asterisco) salvas no state_store (fallback)
    const baseNotes = (st.notes && typeof st.notes === "object") ? st.notes : {};
    const baseMeta = (st.notes_meta && typeof st.notes_meta === "object") ? st.notes_meta : {};

    // inicia com state_store para garantir que o PDF sempre mostre o que aparece no front
    let notes = { ...baseNotes };
    let notes_meta = { ...baseMeta };
    let usedDb = false;
    try {
      const rows = await fetchLancamentosForPeriod(st.period.start, st.period.end);
      const built = buildAssignmentsAndNotesFromLancamentos(rows, dates);
      if (Object.keys(built.assignments).length) {
        assignments = { ...(st.assignments || {}), ...built.assignments };
        // DB passa a ser a fonte primÃ¡ria, mas fazemos merge defensivo com o state_store
        notes = (built.notes && typeof built.notes === "object") ? built.notes : {};
        notes_meta = (built.notes_meta && typeof built.notes_meta === "object") ? built.notes_meta : {};
        usedDb = true;
        // merge defensivo: se o DB nÃ£o tiver observaÃ§Ã£o (ou vier NULL/vazio), mantÃ©m o state_store
        for (const k of Object.keys(baseNotes)) {
          const codeNow = assignments && assignments[k] ? String(assignments[k]) : "";
          if (codeNow !== "OUTROS" && !/\*$/.test(codeNow)) continue;
          const dbVal = (notes && notes[k] != null) ? String(notes[k]).trim() : "";
          if (!dbVal) {
            const v = String(baseNotes[k] || "").trim();
            if (v) notes[k] = v;
          }
        }
        // mantÃ©m metadados do state_store quando o DB nÃ£o tiver
        for (const k of Object.keys(baseMeta)) {
          if (!notes_meta[k]) notes_meta[k] = baseMeta[k];
        }
      }
    } catch (_e) {
      // mantÃ©m fallback
    }


// histÃ³rico para PDF (quando houver DB)
let changeLogs = [];
if (usedDb) {
  try {
    const rows = await fetchChangeLogsForPeriod(st.period.start, st.period.end, 500);
    changeLogs = Array.isArray(rows) ? rows : [];
  } catch (_e) {
    changeLogs = [];
  }
}

// último registro (nome + data/hora) para rodapé do PDF
let lastActor = (st && st.last_edit_actor) ? officerNameNoAccents(st.last_edit_actor) : "";
let lastAt = (st && st.last_edit_at) ? st.last_edit_at : (st && st.updated_at ? st.updated_at : null);

// fallback: action_logs (para ambientes antigos)
if (!lastAt || !lastActor) {
  let lastAction = null;
  try {
    lastAction = await fetchLastActionForPeriod(st.period.start, st.period.end);
  } catch (_e) {
    lastAction = null;
  }
  if (!lastActor && lastAction && lastAction.actor_name) lastActor = officerNameNoAccents(lastAction.actor_name);
  if (!lastAt && lastAction && lastAction.at) lastAt = lastAction.at;
}

const lastStamp = fmtDDMMYYYYHHmm(lastAt);
    // tabela
    const left = doc.page.margins.left;
    const top = doc.y;
    const colWName = 220;
    const colWDay = 80;

    // header row
    doc.fontSize(9).text("OFICIAIS", left, top, { width: colWName, align: "left" });
    for (let i = 0; i < dates.length; i++) {
      doc.text(fmtDDMMYYYY(dates[i]), left + colWName + i * colWDay, top, { width: colWDay, align: "center" });
    }
    doc.moveTo(left, top + 14).lineTo(left + colWName + colWDay * dates.length, top + 14).stroke();

    let y = top + 18;

    doc.fontSize(8);
    for (let offIndex = 0; offIndex < OFFICERS.length; offIndex++) {
      const off = OFFICERS[offIndex];
      const label = `${offIndex + 1}. ${fixText(off.rank)} ${officerNameNoAccents(off.name)}`;
      doc.text(label, left, y, { width: colWName, align: "left" });
      doc.moveTo(left, y+12).lineTo(left+colWName, y+12).stroke();

      for (let i = 0; i < dates.length; i++) {
        const k = `${off.canonical_name}|${dates[i]}`;
        const code = assignments[k] ? String(assignments[k]) : "";
        doc.text(code || "-", left + colWName + i * colWDay, y, { width: colWDay, align: "center" });
      }

      const rowLineY = y + 12;
      doc.moveTo(left, rowLineY).lineTo(left + colWName + colWDay * dates.length, rowLineY).stroke();

      y += 14;
      if (y > doc.page.height - 140) {
        doc.addPage({ margin: 28, size: "A4", layout: "landscape" });
        y = doc.y;
      }
    }
    // assinaturas sempre na primeira página
    {
      const leftMargin = doc.page.margins.left;
      const usableW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const gap = 40;
      const lineW = (usableW - gap) / 2;
      const xCenter = leftMargin;
      const xRight = xCenter + lineW + gap;
      const yLine = doc.page.height - 100;

      const rawSig = (st.meta && st.meta.signatures) ? st.meta.signatures : defaultSignatures();
      const sig = {
        center_role: String(rawSig.center_role || "").trim() || defaultSignatures().center_role,
        right_role: String(rawSig.right_role || "").trim() || defaultSignatures().right_role,
      };

      doc.moveTo(xCenter, yLine).lineTo(xCenter + lineW, yLine).stroke();
      doc.moveTo(xRight, yLine).lineTo(xRight + lineW, yLine).stroke();

      doc.fontSize(10).text(String(sig.center_role || "").toUpperCase(), xCenter, yLine + 14, { width: lineW, align: "center" });
      doc.fontSize(10).text(String(sig.right_role || "").toUpperCase(), xRight, yLine + 14, { width: lineW, align: "center" });
    }

    // detalhamento de descrições (OUTROS e códigos com asterisco)
    const noteEntries = [];
    for (const k of Object.keys(notes || {})) {
      const [canonical, iso] = k.split("|");
      const off = OFFICERS.find(o => o.canonical_name === canonical);
      if (!off) continue;
      const code = assignments[k] ? String(assignments[k]) : "";
      // só imprime descrições para OUTROS e códigos com asterisco
      if (code !== "OUTROS" && !/\*$/.test(code)) continue;
      const meta = (notes_meta && notes_meta[k]) ? notes_meta[k] : null;
      noteEntries.push({ iso, off, code, text: notes[k], meta });
    }
    noteEntries.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));

    if (noteEntries.length) {
      doc.addPage({ margin: 36, size: "A4", layout: "portrait" });
      doc.fontSize(14).text("DESCRIÇÕES (OUTROS / CÓDIGOS COM ASTERISCO)", { align: "center" });
      doc.moveDown(0.6);
      // registro institucional (somente aqui, conforme regra)
      if (lastStamp) {
        const line = lastActor ? `Último registro: ${lastActor} — ${lastStamp}` : `Último registro: ${lastStamp}`;
        doc.fontSize(9).text(line, { align: "center" });
        doc.moveDown(0.6);
      }

      doc.fontSize(10);

      for (const it of noteEntries) {
        const title = `${fmtDDMMYYYY(it.iso)} - ${fixText(it.off.rank)} ${officerNameNoAccents(it.off.name)} (${it.code})`;
        doc.font("Helvetica-Bold").text(title);
        doc.font("Helvetica").text(it.text, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        
if (it.meta && (it.meta.updated_at || it.meta.updated_by || it.meta.created_by)) {
  const dt = it.meta.updated_at ? fmtDDMMYYYYHHmm(it.meta.updated_at) : "";
  const by = it.meta.updated_by ? String(it.meta.updated_by) : (it.meta.created_by ? String(it.meta.created_by) : "");
  const suffix = [dt ? `atualizado em ${dt}` : "", by ? `por ${by}` : ""].filter(Boolean).join(" ");
  if (suffix) {
    doc.fontSize(8).fillColor("#555555").text(suffix);
    doc.fontSize(10).fillColor("black");
  }
}
doc.moveDown(0.6);
        if (doc.y > doc.page.height - 180) {
          doc.addPage({ margin: 36, size: "A4", layout: "portrait" });
          doc.fontSize(14).text("DESCRIÇÕES (OUTROS / CÓDIGOS COM ASTERISCO)", { align: "center" });
          doc.moveDown(0.6);
          doc.fontSize(10);
        }
      }
    }


    // folha apartada: alterações operacionais
    const addOperationalChangesPage = () => {
      doc.addPage({ margin: 36, size: "A4", layout: "portrait" });
      doc.fontSize(14).text("ALTERAÇÕES OPERACIONAIS", { align: "center" });
      doc.moveDown(0.8);

      const weekdayLabels = [
        "SEGUNDA",
        "TERÇA",
        "QUARTA",
        "QUINTA",
        "SEXTA",
        "SÁBADO",
        "DOMINGO",
      ];

      const lineStartX = doc.page.margins.left;
      const lineEndX = doc.page.width - doc.page.margins.right;
      const lineGap = 14;

      doc.fontSize(10);
      for (let i = 0; i < dates.length && i < weekdayLabels.length; i++) {
        const heading = `${weekdayLabels[i]} - ${fmtDDMMYYYY(dates[i])}`;
        doc.font("Helvetica-Bold").text(heading);
        doc.moveDown(0.25);
        for (let j = 0; j < 4; j++) {
          const yLine = doc.y + 8;
          doc.moveTo(lineStartX, yLine).lineTo(lineEndX, yLine).stroke();
          doc.y = yLine + lineGap;
        }
        doc.moveDown(0.35);
      }
      doc.font("Helvetica");
    };

    addOperationalChangesPage();

    // sem página de histórico no PDF; somente DESCRIÇÕES (OUTROS / FO*) quando houver conteúdo

    doc.end();
  } catch (err) {
    return res.status(500).json({ error: "erro ao gerar pdf", details: err.message });
  }
});

// fallback SPA
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===============================
// START
// ===============================
(async () => {
  try {
    await ensureSchema();
    app.listen(PORT, () => {
      console.log(`[OK] Escala online em :${PORT} (TZ=${process.env.TZ})`);
    });
  } catch (e) {
    console.error("[FATAL] Falha ao iniciar:", e);
    process.exit(1);
  }
})();

