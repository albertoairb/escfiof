"use strict";

const path = require("path");
const fs = require("fs");
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

// Semana mínima (segunda-feira) para iniciar o sistema automaticamente, sem precisar forçar via variável.
// Ex.: quando a semana anterior já passou, iniciamos diretamente na próxima.
const CUTOVER_WEEK_START = "2026-03-09";
// Se quiser forçar manualmente a semana exibida (ex.: liberar semana futura), defina WEEK_START_OVERRIDE=YYYY-MM-DD (segunda-feira)
const WEEK_START_OVERRIDE = (process.env.WEEK_START_OVERRIDE || "").trim();

const JWT_SECRET = (process.env.JWT_SECRET || "troque-este-segredo").trim();
const DEFAULT_PASSWORD = (process.env.DEFAULT_PASSWORD || "sr123").trim();
const ONE_TIME_PASSWORD_RESET_MARKER = "reset_senhas_20260826_franzini_voltarelli";

const AUTOFILL_FRIDAY_HOUR = Number(process.env.AUTOFILL_FRIDAY_HOUR || 17);
const SPECIAL_READONLY_USER = "p1";
const SPECIAL_READONLY_PASSWORD = "aux123";
const INITIAL_PREVIOUS_PDF = path.join(__dirname, "history", "escala_anterior_original_2026-09-14_a_2026-09-20.pdf");

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

// Defaults para Docker/local (quando DB_URL não existir)
const DB_HOST = (process.env.DB_HOST || "db").trim();
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = (process.env.DB_USER || "app").trim();
const DB_PASSWORD = (process.env.DB_PASSWORD || "app").trim();
const DB_NAME = (process.env.DB_NAME || process.env.DB_DATABASE || "escala").trim();

// ===============================
// OFICIAIS (lista fixa)
// - canonical_name: chave única do oficial (sem posto)
// - rank: posto/graduação a exibir
// - name: nome completo a exibir
// ===============================
const OFFICERS = [
  { canonical_name: "Helder Antonio de Paula", rank: "Ten Cel PM", name: "Helder Antonio de Paula", aliases: ["Helder"] },
  { canonical_name: "Ricardo Santos Medeiros", rank: "Maj PM", name: "Ricardo Santos Medeiros", aliases: ["Medeiros"] },
  { canonical_name: "Carlos Bordim Neto", rank: "Maj PM", name: "Carlos Bordim Neto", aliases: ["Bordim"] },
  { canonical_name: "Marcio Saito Essaki", rank: "Cap PM", name: "Marcio Saito Essaki", aliases: ["Essaki"] },
  { canonical_name: "Jose Antonio Marciano Neto", rank: "Cap PM", name: "Jose Antonio Marciano Neto", aliases: ["Jose Antonio"] },
  { canonical_name: "Alberto Franzini Neto", rank: "Cap PM", name: "Alberto Franzini Neto", aliases: ["Franzini"] },
  { canonical_name: "Vinicio Augusto Voltarelli Tavares", rank: "Cap PM", name: "Vinicio Augusto Voltarelli Tavares", aliases: ["Voltarelli"] },
  { canonical_name: "Andre Santarelli de Paula", rank: "Cap PM", name: "Andre Santarelli de Paula", aliases: ["Santarelli"] },
  { canonical_name: "Iuri Filipe dos Santos", rank: "Cap PM", name: "Iuri Filipe dos Santos", aliases: ["Iuri"] },
  { canonical_name: "Mateus Pedro Teodoro", rank: "Cap PM", name: "Mateus Pedro Teodoro", aliases: ["Teodoro"] },
  { canonical_name: "Daniel Alves de Siqueira", rank: "1º Ten PM", name: "Daniel Alves de Siqueira", aliases: ["Siqueira"] },
  { canonical_name: "Fernanda Bruno Pomponio Martignago", rank: "1º Ten Dent PM", name: "Fernanda Bruno Pomponio Martignago", aliases: ["Pomponio"] },
  { canonical_name: "Dayana de Oliveira Silva Almeida", rank: "1º Ten Dent PM", name: "Dayana de Oliveira Silva Almeida", aliases: ["Dayana"] },
  { canonical_name: "Antonio Ovidio Ferruccio Cardoso", rank: "1º Ten PM", name: "Antonio Ovidio Ferrucio Cardoso", aliases: ["Ferrucio", "Antonio Ovidio Ferrucio Cardoso"] },
  { canonical_name: "Bruno Antao de Oliveira", rank: "1º Ten PM", name: "Bruno Antao de Oliveira", aliases: ["Antao"] },
  { canonical_name: "Larissa Amadeu Leite", rank: "1º Ten PM", name: "Larissa Amadeu Leite", aliases: ["Amadeu"] },
  { canonical_name: "Renato Fernandes Freire", rank: "1º Ten PM", name: "Renato Fernandes Freire", aliases: ["Freire"] },
  { canonical_name: "Raphael Mecca Sampaio", rank: "1º Ten PM", name: "Raphael Mecca Sampaio", aliases: ["Mecca"] },
  { canonical_name: "Jose Sebastiao dos Santos Neto", rank: "Asp Of PM", name: "Jose Sebastiao dos Santos Neto", aliases: ["Neto"] },
  { canonical_name: "Lenise Helena Tragante de Souza Cristo", rank: "Asp Of PM", name: "Lenise Helena Tragante de Souza Cristo", aliases: ["Tragante"] },
];
            
// override visual para postos (Ten Dent) — garante exibição correta no state e no PDF
function fixDentRanks(list) {
  return (Array.isArray(list) ? list : []).map(o => {
    if (!o || typeof o !== "object") return o;
    if (o.canonical_name === "Fernanda Bruno Pomponio Martignago") return { ...o, rank: "1º Ten Dent PM" };
    if (o.canonical_name === "Dayana de Oliveira Silva Almeida") return { ...o, rank: "1º Ten Dent PM" };
    return o;
  });
}


// Administradores mantêm as permissões atuais para alterar qualquer oficial
const ADMIN_NAMES = new Set([
  "Alberto Franzini Neto",
  "Helder Antonio de Paula",
  "Ricardo Santos Medeiros",
  "Marcio Saito Essaki",
  "Iuri Filipe dos Santos",
  "Daniel Alves de Siqueira",
]);

// Códigos válidos (tudo em MAIÚSCULO, conforme regra)
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
  let str = String(s ?? "");
  if (!str) return "";

  // Corrige somente quando há sinais reais de mojibake.
  // IMPORTANTE: não usar espaço como gatilho, pois isso corrompe texto UTF-8 válido
  // (ex.: "às", "Permanência", "referência", "reunião").
  const suspicious = /(?:\u00C3.|\u00C2.|\u00E2..|\u00F0\u0178|\uFFFD)/;
  if (suspicious.test(str)) {
    for (let i = 0; i < 3; i++) {
      try {
        const fixed = Buffer.from(str, "latin1").toString("utf8");
        if (!fixed || fixed === str) break;
        str = fixed;
        if (!suspicious.test(str)) break;
      } catch (_e) {
        break;
      }
    }
  }

  // Compatibilidade com alguns registros antigos que já foram persistidos corrompidos.
  const legacyMap = {
    "ÿys": "às",
    "Permanÿncia": "Permanência",
    "permanÿncia": "permanência",
    "Referÿncia": "Referência",
    "referÿncia": "referência",
    "Reuniÿo": "Reunião",
    "reuniÿo": "reunião",
  };
  for (const [wrong, right] of Object.entries(legacyMap)) {
    if (str.includes(wrong)) str = str.split(wrong).join(right);
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

// Formata data/hora em pt-BR (São Paulo) no padrão: dd/mm/aaaa às HHhMM
function fmtDDMMYYYYHHmm(value) {
  if (!value) return "";
  const dt = (value instanceof Date) ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return "";

  // Usa timeZone explicitamente para não depender do TZ do processo.
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

// A escala atual permanece editável em todos os dias/horários.
function isClosedNow() {
  return false;
}

// O horário de sexta-feira às 17h é apenas o gatilho do autopreenchimento.
// Depois do gatilho, a rotina continua válida no sábado e domingo para preencher
// somente campos que ainda estejam vazios.
function shouldRunAutoFillNow() {
  const now = new Date();
  const day = now.getDay(); // 5=sexta, 6=sábado, 0=domingo
  const hour = now.getHours();
  if (day === 5) return hour >= AUTOFILL_FRIDAY_HOUR;
  return day === 6 || day === 0;
}

function isAdminName(canonicalName) {
  return ADMIN_NAMES.has(String(canonicalName || "").trim());
}

function canViewAuditName(canonicalName) {
  const key = normKey(canonicalName);
  return key === normKey("Alberto Franzini Neto") || key === normKey("Franzini") || key.includes("franzini");
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
// FERIADOS (Brasil - nacionais + móveis)
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
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=março,4=abril
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
  const year = Number(weekDates[0].slice(0, 4));
  const set = new Map();

  // Feriados nacionais.
  const fixedNational = [
    ["01-01", "Confraternização Universal", "NACIONAL"],
    ["21-04", "Tiradentes", "NACIONAL"],
    ["01-05", "Dia Mundial do Trabalho", "NACIONAL"],
    ["07-09", "Independência do Brasil", "NACIONAL"],
    ["12-10", "Nossa Senhora Aparecida", "NACIONAL"],
    ["02-11", "Finados", "NACIONAL"],
    ["15-11", "Proclamação da República", "NACIONAL"],
    ["20-11", "Dia Nacional de Zumbi e da Consciência Negra", "NACIONAL"],
    ["25-12", "Natal", "NACIONAL"],
  ];
  for (const [md, name, scope] of fixedNational) {
    set.set(`${year}-${md}`, { name, type: "FERIADO", scope });
  }

  // Estado de São Paulo.
  set.set(`${year}-07-09`, { name: "REVOLUÇÃO CONSTITUCIONALISTA", type: "FERIADO", scope: "ESTADUAL" });

  // Município de São Paulo.
  set.set(`${year}-01-25`, { name: "Aniversário da Cidade de São Paulo", type: "FERIADO", scope: "MUNICIPAL" });
  const easter = easterDate(year);
  set.set(isoFromDate(addDays(easter, -2)), { name: "Paixão de Cristo", type: "FERIADO", scope: "MUNICIPAL" });
  set.set(isoFromDate(addDays(easter, 60)), { name: "Corpus Christi", type: "FERIADO", scope: "MUNICIPAL" });

  const out = [];
  for (const iso of weekDates) {
    if (set.has(iso)) out.push({ date: iso, ...set.get(iso) });
  }
  return out;
}

function autoCodeForOfficerDate(off, iso) {
  if (!isCapOrAbove(off)) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(y, m - 1, d).getDay();
  if (day === 0 || day === 6) return "FO";
  return "EXP";
}

function applyAutoFill(st) {
  if (!st || !shouldRunAutoFillNow()) return false;
  st.assignments = st.assignments && typeof st.assignments === "object" ? st.assignments : {};
  st.auto_assignments = st.auto_assignments && typeof st.auto_assignments === "object" ? st.auto_assignments : {};
  let changed = false;
  for (const off of OFFICERS) {
    if (!isCapOrAbove(off)) continue;
    for (const iso of st.dates || []) {
      const key = `${off.canonical_name}|${iso}`;
      if (String(st.assignments[key] || "").trim()) continue;
      const code = autoCodeForOfficerDate(off, iso);
      if (code) {
        st.assignments[key] = code;
        st.auto_assignments[key] = true;
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

    await conn.query(`CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      event_type VARCHAR(80) NOT NULL,
      input_name VARCHAR(255) NULL,
      actor_name VARCHAR(255) NULL,
      target_name VARCHAR(255) NULL,
      recognized TINYINT(1) NULL,
      scale_date DATE NULL,
      field_name VARCHAR(64) NULL,
      before_value TEXT NULL,
      after_value TEXT NULL,
      details TEXT NULL,
      success TINYINT(1) NULL,
      http_status INT NULL,
      ip VARCHAR(80) NULL,
      user_agent TEXT NULL,
      INDEX idx_at (at),
      INDEX idx_event_type (event_type),
      INDEX idx_actor (actor_name),
      INDEX idx_target (target_name),
      INDEX idx_scale_date (scale_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

    // lançamentos por dia (persistência da semana)
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

    // migração defensiva: colunas faltantes em 'escala_lancamentos' (ambientes antigos)
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
      // tolera corrida/duplicidade em inicialização concorrente
      const code = String((e && e.code) || "");
      const msg = String((e && e.message) || "");
      if (!code.includes("ER_DUP_FIELDNAME") && !msg.toLowerCase().includes("duplicate column")) throw e;
    }
// logs detalhados de alterações (histórico)
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

    // Usuário técnico P1: somente leitura, senha fixa inicial e sem troca obrigatória.
    const [p1Rows] = await conn.query("SELECT id FROM users WHERE LOWER(canonical_name)=LOWER(?) LIMIT 1", [SPECIAL_READONLY_USER]);
    if (!p1Rows.length) {
      const p1Hash = await bcrypt.hash(SPECIAL_READONLY_PASSWORD, 10);
      await conn.query("INSERT INTO users (canonical_name, password_hash, must_change) VALUES (?, ?, 0)", [SPECIAL_READONLY_USER, p1Hash]);
    }
  } finally {
    conn.release();
  }
}


async function runOneTimePasswordReset() {
  const targets = [
    "Alberto Franzini Neto",
    "Vinicio Augusto Voltarelli Tavares",
  ];

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [alreadyDone] = await conn.query(
      "SELECT id FROM action_logs WHERE action=? LIMIT 1 FOR UPDATE",
      [ONE_TIME_PASSWORD_RESET_MARKER]
    );

    if (alreadyDone.length) {
      await conn.commit();
      return false;
    }

    const hash = await bcrypt.hash("sr123", 10);
    const [result] = await conn.query(
      "UPDATE users SET password_hash=?, must_change=1 WHERE canonical_name IN (?, ?)",
      [hash, targets[0], targets[1]]
    );

    if (Number(result.affectedRows || 0) !== 2) {
      throw new Error(`reset_senhas_abortado: esperado 2 usuarios, alterados ${Number(result.affectedRows || 0)}`);
    }

    await conn.query(
      "INSERT INTO action_logs (actor_name, target_name, action, details) VALUES (?, ?, ?, ?)",
      [
        "SYSTEM",
        targets.join("; "),
        ONE_TIME_PASSWORD_RESET_MARKER,
        "Reset unico para sr123 com troca obrigatoria no proximo login",
      ]
    );

    await conn.commit();
    console.log("[OK] Reset unico de senha aplicado a Franzini e Voltarelli.");
    return true;
  } catch (e) {
    try { await conn.rollback(); } catch (_e) {}
    throw e;
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
    auto_assignments: {},
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

  // pega só a parte de data se vier com hora
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
  // periodStartISO / periodEndISO são YYYY-MM-DD
  // Compatível com coluna 'data' como DATE ou como string (ex.: 'YYYY/MM/DD')
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
  // action_logs.at é TIMESTAMP; filtra pela janela da semana (São Paulo)
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
      // ignora códigos desconhecidos/antigos
      continue;
    }

    const key = `${canonical}|${iso}`;
    assignments[key] = code;

    // observação só faz sentido em OUTROS e códigos terminados em *
    const obs = (r.observacao == null) ? "" : fixText(r.observacao).trim();
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

async function hydrateStateFromCurrentLaunches(st) {
  if (!st || !st.period || !st.period.start || !st.period.end) return st;
  try {
    const rows = await fetchLancamentosForPeriod(st.period.start, st.period.end);
    const built = buildAssignmentsAndNotesFromLancamentos(rows, st.dates || []);
    st.assignments = { ...(st.assignments || {}), ...(built.assignments || {}) };
    st.notes = { ...(st.notes || {}), ...(built.notes || {}) };
    st.notes_meta = { ...(st.notes_meta || {}), ...(built.notes_meta || {}) };
    // Tudo que veio da tabela de lançamentos foi gravado/alterado por usuário e
    // deixa de ser marcado como autopreenchimento.
    st.auto_assignments = st.auto_assignments && typeof st.auto_assignments === "object" ? st.auto_assignments : {};
    for (const key of Object.keys(built.assignments || {})) delete st.auto_assignments[key];
  } catch (_e) {
    // Fallback seguro: conserva a fotografia existente em state_store.
  }
  return st;
}

async function savePreviousSnapshot(st) {
  if (!st || !st.period || !st.period.start || !st.period.end) return false;
  const frozen = JSON.parse(JSON.stringify(await hydrateStateFromCurrentLaunches(st)));
  frozen.read_only = true;
  frozen.original = true;
  frozen.frozen_at = new Date().toISOString();
  await safeQuery(
    "INSERT INTO state_store (id, payload) VALUES (2, ?) ON DUPLICATE KEY UPDATE payload=VALUES(payload), updated_at=CURRENT_TIMESTAMP",
    [JSON.stringify(frozen)]
  );
  return true;
}

async function getPreviousSnapshot() {
  const rows = await safeQuery("SELECT payload FROM state_store WHERE id=2 LIMIT 1");
  if (!rows.length) return null;
  return safeJsonParse(rows[0].payload);
}

// Ponte estruturada da primeira ESCALA ANTERIOR ORIGINAL (14 a 20/09/2026).
// O arquivo histórico inicial existe apenas em PDF; estes dados permitem gerar
// a SITUAÇÃO DO DIA VIGENTE em 20/09/2026 sem ler a escala futura em edição.
function getInitialDailySituationSnapshot(iso) {
  if (iso !== "2026-09-20") return null;
  const values = {
    "Marcio Saito Essaki": "FO",
    "Jose Antonio Marciano Neto": "FO",
    "Alberto Franzini Neto": "FO",
    "Vinicio Augusto Voltarelli Tavares": "FERIAS",
    "Andre Santarelli de Paula": "CAO",
    "Iuri Filipe dos Santos": "FO",
    "Mateus Pedro Teodoro": "LP",
    "Daniel Alves de Siqueira": "FO",
    "Fernanda Bruno Pomponio Martignago": "FO",
    "Dayana de Oliveira Silva Almeida": "FERIAS",
    "Antonio Ovidio Ferruccio Cardoso": "CFP_DIA",
    "Bruno Antao de Oliveira": "FO",
    "Larissa Amadeu Leite": "FO",
    "Renato Fernandes Freire": "FERIAS",
    "Raphael Mecca Sampaio": "CFP_NOITE",
    "Jose Sebastiao dos Santos Neto": "FO*",
    "Lenise Helena Tragante de Souza Cristo": "OUTROS",
  };
  const assignments = {};
  for (const [name, code] of Object.entries(values)) assignments[`${name}|${iso}`] = code;
  const notes = {
    [`Jose Sebastiao dos Santos Neto|${iso}`]: "Folga mensal",
    [`Lenise Helena Tragante de Souza Cristo|${iso}`]: "Estágio Permanência Corregedoria",
  };
  return {
    period: { start: "2026-09-14", end: "2026-09-20" },
    dates: [iso],
    assignments,
    notes,
    read_only: true,
    original: true,
  };
}

async function getDailySituationSnapshot(iso) {
  const previous = await getPreviousSnapshot();
  if (previous && previous.period && Array.isArray(previous.dates) && previous.dates.includes(iso)) return previous;
  return getInitialDailySituationSnapshot(iso);
}

async function getStateAutoReset() {
  const rows = await safeQuery("SELECT payload FROM state_store WHERE id=1 LIMIT 1");
  let st = rows.length ? safeJsonParse(rows[0].payload) : null;

  const currentWeek = getWeekRangeISO();
  const needReset = !st || !st.period || st.period.start !== currentWeek.start || st.period.end !== currentWeek.end;

  if (needReset) {
    // Virada de semana: primeiro congela a fotografia integral da semana atual.
    // Só depois de confirmar a gravação da ESCALA ANTERIOR ORIGINAL é que os
    // lançamentos da semana corrente são limpos para iniciar a nova semana.
    if (st && st.period && (st.period.start || st.period.end)) {
      await savePreviousSnapshot(st);
      await safeQuery("DELETE FROM escala_lancamentos WHERE data BETWEEN ? AND ?", [st.period.start, st.period.end]);
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
  st.auto_assignments = st.auto_assignments && typeof st.auto_assignments === "object" ? st.auto_assignments : {};

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
    { canonical_name: me.canonical_name, is_admin: !!me.is_admin, is_readonly: !!me.is_readonly, must_change: !!me.must_change, can_view_audit: !!me.can_view_audit },
    JWT_SECRET,
    { expiresIn: "14d" }
  );
}

// token curto e específico para abrir PDF via URL (window.open não envia headers)
function signPdfToken(me) {
  return jwt.sign(
    { canonical_name: me.canonical_name, is_admin: !!me.is_admin, is_readonly: !!me.is_readonly, scope: "pdf" },
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
        is_readonly: !!payload.is_readonly,
        must_change: !!payload.must_change,
        can_view_audit: !!payload.can_view_audit || canViewAuditName(payload.canonical_name),
      };
      return next();
    } catch (_e) {
      // continua para tentar token via query
    }
  }

  // 2) token via query (curto, só para PDF)
  const q = (req.query && req.query.token ? String(req.query.token) : "").trim();
  if (!q) return res.status(401).json({ error: "não autenticado" });

  try {
    const payload = jwt.verify(q, JWT_SECRET);
    if (payload.scope !== "pdf") return res.status(401).json({ error: "token inválido" });
    req.user = {
      canonical_name: String(payload.canonical_name || "").trim(),
      is_admin: !!payload.is_admin,
      is_readonly: !!payload.is_readonly,
      must_change: false,
    };
    return next();
  } catch (e) {
    return res.status(401).json({ error: "token inválido" });
  }
}

function authRequired(allowMustChange = false) {
  return (req, res, next) => {
    const auth = (req.headers["authorization"] || "").toString();
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "não autenticado" });

    try {
      const payload = jwt.verify(m[1], JWT_SECRET);
      req.user = {
        canonical_name: String(payload.canonical_name || "").trim(),
        is_admin: !!payload.is_admin,
        is_readonly: !!payload.is_readonly,
        must_change: !!payload.must_change,
        can_view_audit: !!payload.can_view_audit || canViewAuditName(payload.canonical_name),
      };
      if (!allowMustChange && req.user.must_change) {
        return res.status(403).json({ error: "troca de senha obrigatória" });
      }
      return next();
    } catch (e) {
      return res.status(401).json({ error: "token inválido" });
    }
  };
}

async function findOrCreateUser(canonical_name) {
  const rows = await safeQuery("SELECT id, canonical_name, password_hash, must_change FROM users WHERE canonical_name=? LIMIT 1", [canonical_name]);
  if (rows.length) return rows[0];

  // cria com senha padrão e must_change=1
  const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  await safeQuery("INSERT INTO users (canonical_name, password_hash, must_change) VALUES (?, ?, 1)", [canonical_name, hash]);
  const created = await safeQuery("SELECT id, canonical_name, password_hash, must_change FROM users WHERE canonical_name=? LIMIT 1", [canonical_name]);
  return created[0];
}

function stripRankFromLogin(input) {
  return normKey(input)
    .replace(/^tenente\-coronel pm\s+/, "")
    .replace(/^tenente coronel pm\s+/, "")
    .replace(/^ten cel pm\s+/, "")
    .replace(/^major pm\s+/, "")
    .replace(/^maj pm\s+/, "")
    .replace(/^capit(ao|ão) pm\s+/, "")
    .replace(/^cap pm\s+/, "")
    .replace(/^1º tenente dent pm\s+/, "")
    .replace(/^1º ten dent pm\s+/, "")
    .replace(/^1º tenente pm\s+/, "")
    .replace(/^1º ten pm\s+/, "")
    .replace(/^2º tenente pm\s+/, "")
    .replace(/^2º ten pm\s+/, "")
    .replace(/^aspirante oficial pm\s+/, "")
    .replace(/^asp of pm\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveOfficerFromInput(nameInput) {
  const targetNk = stripRankFromLogin(nameInput);
  if (!targetNk) return null;

  for (const off of OFFICERS) {
    if (targetNk === normKey(off.canonical_name)) return off;

    const aliases = Array.isArray(off.aliases) ? off.aliases : [];
    for (const alias of aliases) {
      if (targetNk === normKey(alias)) return off;
    }
  }

  return null;
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

function clientIp(req) {
  const forwarded = String((req && req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
  return forwarded || String((req && req.ip) || (req && req.socket && req.socket.remoteAddress) || "").trim();
}

function userAgent(req) {
  return String((req && req.headers && req.headers["user-agent"]) || "").slice(0, 1000);
}

async function auditEvent(req, data = {}) {
  try {
    await safeQuery(
      "INSERT INTO audit_logs (event_type, input_name, actor_name, target_name, recognized, scale_date, field_name, before_value, after_value, details, success, http_status, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        String(data.event_type || "evento").slice(0, 80),
        data.input_name == null ? null : String(data.input_name).slice(0, 255),
        data.actor_name == null ? null : String(data.actor_name).slice(0, 255),
        data.target_name == null ? null : String(data.target_name).slice(0, 255),
        data.recognized == null ? null : (data.recognized ? 1 : 0),
        data.scale_date || null,
        data.field_name == null ? null : String(data.field_name).slice(0, 64),
        data.before_value == null ? null : String(data.before_value),
        data.after_value == null ? null : String(data.after_value),
        data.details == null ? null : String(data.details),
        data.success == null ? null : (data.success ? 1 : 0),
        data.http_status == null ? null : Number(data.http_status),
        clientIp(req),
        userAgent(req),
      ]
    );
  } catch (e) {
    // Auditoria nunca pode derrubar o sistema principal.
    console.warn("audit_log_failed", e && e.message ? e.message : e);
  }
}

// ===============================
// PDF
// ===============================
function requirePdfKitOr501(res) {
  try {
    return require("pdfkit");
  } catch {
    res.status(501).json({ error: "geração de PDF indisponível" });
    return null;
  }
}


function drawReferenceHours(doc, startY) {
  const x = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let y = Number(startY || doc.y);
  doc.font("Helvetica-Bold").fontSize(7.2).text("HORÁRIOS DE REFERÊNCIA", x, y, { width, align: "left" });
  y += 11;
  doc.font("Helvetica").fontSize(6.7);
  const lines = [
    "EXP - DAS 08H00 ÀS 18H00 / DAS 09H00 ÀS 18H00, NO MESMO DIA.",
    "CFP_DIA - DAS 05H00 ÀS 17H15, NO MESMO DIA - REGIME 12X36.",
    "CFP_NOITE - DAS 17H00 DO DIA DE INÍCIO ÀS 05H15 DO DIA SEGUINTE.",
    "SR - DIAS ÚTEIS: DAS 17H30 DO DIA DE INÍCIO ÀS 08H00 DO DIA SEGUINTE.",
    "SR - FINAIS DE SEMANA E FERIADOS (24H): DAS 08H00 DO DIA DE INÍCIO ÀS 08H00 DO DIA SEGUINTE.",
  ];
  for (const line of lines) {
    doc.text(line, x, y, { width, align: "left", lineGap: 0 });
    y += 9;
  }
  doc.font("Helvetica-Bold").fontSize(6.7).text("PORTARIA DO CMT G Nº PM1-007/02/23", x, y, { width, align: "left" });
  doc.font("Helvetica");
  return y + 10;
}

function renderFrozenScalePdf(res, st, filename = "escala_anterior_original.pdf") {
  const PDFDocument = requirePdfKitOr501(res);
  if (!PDFDocument) return;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

  const doc = new PDFDocument({ margin: 28, size: "A4", layout: "landscape" });
  doc.pipe(res);

  const dates = Array.isArray(st.dates) ? st.dates : [];
  const assignments = (st.assignments && typeof st.assignments === "object") ? st.assignments : {};
  const notes = (st.notes && typeof st.notes === "object") ? st.notes : {};
  const notesMeta = (st.notes_meta && typeof st.notes_meta === "object") ? st.notes_meta : {};

  doc.fontSize(16).text(fixText(SYSTEM_NAME), { align: "center" });
  doc.moveDown(0.2);
  doc.fontSize(10).text(`Periodo: ${fmtDDMMYYYY(st.period && st.period.start)} a ${fmtDDMMYYYY(st.period && st.period.end)}`, { align: "center" });
  doc.moveDown(0.6);

  const left = doc.page.margins.left;
  const top = doc.y;
  const colWName = 220;
  const colWDay = 80;

  const renderCell = (text, x, y, width) => {
    const raw = String(text || "-").trim() || "-";
    if ((raw.length > 10 && raw.includes(" ")) || raw.length > 14) {
      const parts = raw.split(/\s+/).filter(Boolean);
      const lines = parts.length >= 2 ? [parts[0], parts.slice(1).join(" ")] : [raw];
      doc.fontSize(5.2).text(lines.join("\n"), x, y + 1, { width, align: "center", lineGap: 0 });
      doc.fontSize(8);
      return;
    }
    doc.fontSize(8).text(raw, x, y, { width, align: "center" });
  };

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
    for (let i = 0; i < dates.length; i++) {
      const key = `${off.canonical_name}|${dates[i]}`;
      renderCell(assignments[key] || "-", left + colWName + i * colWDay, y, colWDay);
    }
    doc.moveTo(left, y + 12).lineTo(left + colWName + colWDay * dates.length, y + 12).stroke();
    y += 14;
  }

  drawReferenceHours(doc, y + 7);

  const usableW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 40;
  const lineW = (usableW - gap) / 2;
  const xCenter = doc.page.margins.left;
  const xRight = xCenter + lineW + gap;
  const yLine = doc.page.height - 72;
  const rawSig = (st.meta && st.meta.signatures) ? st.meta.signatures : defaultSignatures();
  const centerRole = String(rawSig.center_role || "").trim() || defaultSignatures().center_role;
  const rightRole = String(rawSig.right_role || "").trim() || defaultSignatures().right_role;
  doc.moveTo(xCenter, yLine).lineTo(xCenter + lineW, yLine).stroke();
  doc.moveTo(xRight, yLine).lineTo(xRight + lineW, yLine).stroke();
  doc.fontSize(9).text(centerRole.toUpperCase(), xCenter, yLine + 10, { width: lineW, align: "center" });
  doc.fontSize(9).text(rightRole.toUpperCase(), xRight, yLine + 10, { width: lineW, align: "center" });

  // Página 2 - descrições/registro, preservando a lógica institucional já existente.
  const noteEntries = [];
  for (const key of Object.keys(notes)) {
    const [canonical, iso] = key.split("|");
    const off = OFFICERS.find(o => o.canonical_name === canonical);
    if (!off) continue;
    const code = assignments[key] ? String(assignments[key]) : "";
    if (code !== "OUTROS" && !/\*$/.test(code)) continue;
    noteEntries.push({ iso, off, code, text: notes[key], meta: notesMeta[key] || null });
  }
  noteEntries.sort((a, b) => a.iso.localeCompare(b.iso));

  doc.addPage({ margin: 36, size: "A4", layout: "portrait" });
  doc.fontSize(14).text("DESCRIÇÕES (OUTROS / CÓDIGOS COM ASTERISCO)", { align: "center" });
  doc.moveDown(0.6);
  const lastStamp = fmtDDMMYYYYHHmm(st.last_edit_at || st.updated_at || st.frozen_at);
  const lastActor = st.last_edit_actor ? officerNameNoAccents(st.last_edit_actor) : "";
  if (lastStamp) {
    doc.fontSize(9).text(lastActor ? `Último registro: ${lastActor} — ${lastStamp}` : `Último registro: ${lastStamp}`, { align: "center" });
    doc.moveDown(0.6);
  }
  if (!noteEntries.length) {
    doc.fontSize(10).text("SEM DESCRIÇÕES REGISTRADAS.", { align: "center" });
  } else {
    doc.fontSize(10);
    for (const it of noteEntries) {
      doc.font("Helvetica-Bold").text(`${fmtDDMMYYYY(it.iso)} - ${fixText(it.off.rank)} ${officerNameNoAccents(it.off.name)} (${it.code})`);
      doc.font("Helvetica").text(fixText(it.text || ""));
      if (it.meta && (it.meta.updated_at || it.meta.updated_by || it.meta.created_by)) {
        const dt = it.meta.updated_at ? fmtDDMMYYYYHHmm(it.meta.updated_at) : "";
        const by = it.meta.updated_by || it.meta.created_by || "";
        const suffix = [dt ? `atualizado em ${dt}` : "", by ? `por ${by}` : ""].filter(Boolean).join(" ");
        if (suffix) doc.fontSize(8).fillColor("#555555").text(suffix).fontSize(10).fillColor("black");
      }
      doc.moveDown(0.6);
    }
  }

  // Página 3 - alterações operacionais, sem alterar a regra atual.
  doc.addPage({ margin: 36, size: "A4", layout: "portrait" });
  doc.fontSize(14).text("ALTERAÇÕES OPERACIONAIS", { align: "center" });
  doc.moveDown(0.8);
  const weekdayLabels = ["SEGUNDA", "TERÇA", "QUARTA", "QUINTA", "SEXTA", "SÁBADO", "DOMINGO"];
  const lineStartX = doc.page.margins.left;
  const lineEndX = doc.page.width - doc.page.margins.right;
  doc.fontSize(10);
  for (let i = 0; i < dates.length && i < weekdayLabels.length; i++) {
    doc.font("Helvetica-Bold").text(`${weekdayLabels[i]} - ${fmtDDMMYYYY(dates[i])}`);
    doc.moveDown(0.25);
    for (let j = 0; j < 4; j++) {
      const lineY = doc.y + 8;
      doc.moveTo(lineStartX, lineY).lineTo(lineEndX, lineY).stroke();
      doc.y = lineY + 14;
    }
    doc.moveDown(0.35);
  }
  doc.font("Helvetica");
  doc.end();
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

// STATUS PÚBLICO (sem token) – para teste externo e monitoramento no Railway
app.get("/api/status", async (_req, res) => {
  try {
    // não falha se o DB estiver indisponível: retorna o básico
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
      locked: false,
      autofill_friday_hour: AUTOFILL_FRIDAY_HOUR,
      system_name: fixText(SYSTEM_NAME),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : "falha no status" });
  }
});

// WEEK PÚBLICO (sem token) – ajuda o frontend e facilita debug
app.get("/api/week", (_req, res) => {
  const week = getWeekRangeISO();
  return res.json({ ok: true, week, dates: buildDatesForWeek(week.start) });
});

// login: nome + senha
app.post("/api/login", async (req, res) => {
  try {
    const name = (req.body && req.body.name ? req.body.name : "").toString().trim();
    const password = (req.body && req.body.password ? req.body.password : "").toString();

    const isP1 = normKey(name) === normKey(SPECIAL_READONLY_USER);
    const off = isP1 ? null : resolveOfficerFromInput(name);
    if (!off && !isP1) {
      await auditEvent(req, {
        event_type: "login_errado",
        input_name: name,
        recognized: false,
        success: false,
        http_status: 403,
        details: "nome nao reconhecido",
      });
      return res.status(403).json({ error: "nome não reconhecido. use nome completo ou nome de guerra." });
    }

    const loginCanonical = isP1 ? SPECIAL_READONLY_USER : off.canonical_name;
    const userRow = await findOrCreateUser(loginCanonical);

    const ok = await bcrypt.compare(password, userRow.password_hash);
    if (!ok) {
      await auditEvent(req, {
        event_type: "login_errado",
        input_name: name,
        actor_name: loginCanonical,
        recognized: true,
        success: false,
        http_status: 403,
        details: "senha invalida",
      });
      return res.status(403).json({ error: "senha inválida" });
    }

    const me = {
      canonical_name: loginCanonical,
      is_admin: isP1 ? false : isAdminName(loginCanonical),
      is_readonly: isP1,
      can_view_audit: isP1 ? false : canViewAuditName(loginCanonical),
      must_change: isP1 ? false : !!userRow.must_change,
    };

    const token = signToken(me);

    await logAction(me.canonical_name, me.canonical_name, "login", "");
    await auditEvent(req, {
      event_type: "login_correto",
      input_name: name,
      actor_name: me.canonical_name,
      recognized: true,
      success: true,
      http_status: 200,
    });

    return res.json({ ok: true, token, me, must_change: me.must_change });
  } catch (err) {
    await auditEvent(req, {
      event_type: "erro_login",
      input_name: req.body && req.body.name ? req.body.name : "",
      success: false,
      http_status: 500,
      details: err.message,
    });
    return res.status(500).json({ error: "erro no login", details: err.message });
  }
});

// troca obrigatória de senha
app.post("/api/change_password", authRequired(true), async (req, res) => {
  try {
    if (req.user.is_readonly) return res.status(403).json({ error: "senha deste usuário é administrada pelo sistema" });
    const newPass = (req.body && req.body.new_password ? req.body.new_password : "").toString();
    if (!newPass || newPass.length < 6) return res.status(400).json({ error: "senha muito curta (mínimo 6)" });

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

    // se houver lançamentos no MySQL (escala_lancamentos), eles prevalecem
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
      // se a tabela ainda não existir em algum ambiente, mantém state_store
    }

    // merge de descrições: mantém state_store.notes quando o MySQL vier sem observação
    try {
      const baseNotes = (st.notes && typeof st.notes === "object") ? st.notes : {};
      const baseMeta = (st.notes_meta && typeof st.notes_meta === "object") ? st.notes_meta : {};
      // se não veio nada do DB, usa o state_store
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
        is_readonly: !!req.user.is_readonly,
        can_view_audit: canViewAuditName(req.user.canonical_name),
      },
      meta: {
        system_name: fixText(SYSTEM_NAME),
        footer_mark: `© ${COPYRIGHT_YEAR} - ${fixText(AUTHOR)}`,
        period_label: periodLabel,
        signatures: (st.meta && st.meta.signatures) ? st.meta.signatures : defaultSignatures(),
      },
      locked: false,
      holidays,
      officers: fixDentRanks(OFFICERS).map(o => ({ ...o, rank: fixText(o.rank), name: officerNameNoAccents(o.name) })),
      dates: st.dates,
      codes: CODES,
      assignments,
      notes,
      notes_meta,
      auto_assignments: st.auto_assignments || {},
    });
  } catch (err) {
    console.error('[ERRO] /api/state:', err && err.stack ? err.stack : err);
    try {
      const st = buildFreshState();
      const holidays = getHolidaysForWeek(st.dates);
      return res.json({
        ok: true,
        me: { canonical_name: req.user.canonical_name, is_admin: req.user.is_admin, is_readonly: !!req.user.is_readonly, can_view_audit: canViewAuditName(req.user.canonical_name) },
        meta: {
          system_name: fixText(SYSTEM_NAME),
          footer_mark: `© ${COPYRIGHT_YEAR} - ${fixText(AUTHOR)}`,
          period_label: `periodo: ${fmtDDMMYYYY(st.period.start)} a ${fmtDDMMYYYY(st.period.end)}`,
          signatures: defaultSignatures(),
        },
        locked: false,
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
    if (!req.user.is_admin) return res.status(403).json({ error: "não autorizado" });

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

    // metadados do último registro (para PDF)
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


// histórico de alterações (somente admin)
app.get("/api/change_logs", authRequired(true), async (req, res) => {
  try {
    if (!canViewAuditName(req.user.canonical_name)) return res.status(403).json({ error: "não autorizado" });

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
    return res.status(500).json({ error: "erro ao carregar histórico", details: err.message });
  }
});


// auditoria operacional e de segurança (somente Franzini)
app.get("/api/audit_logs", authRequired(true), async (req, res) => {
  try {
    if (!canViewAuditName(req.user.canonical_name)) {
      await auditEvent(req, {
        event_type: "tentativa_sem_permissao",
        actor_name: req.user.canonical_name,
        success: false,
        http_status: 403,
        details: "tentativa de acessar auditoria",
      });
      return res.status(403).json({ error: "não autorizado" });
    }

    const limit = Math.max(10, Math.min(1000, Number(req.query && req.query.limit ? req.query.limit : 300)));
    const name = String(req.query && req.query.name ? req.query.name : "").trim();
    const dateFrom = String(req.query && req.query.date_from ? req.query.date_from : "").trim();
    const dateTo = String(req.query && req.query.date_to ? req.query.date_to : "").trim();
    const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (dateFrom && !isoDateRe.test(dateFrom)) return res.status(400).json({ error: "data inicial inválida" });
    if (dateTo && !isoDateRe.test(dateTo)) return res.status(400).json({ error: "data final inválida" });
    if (dateFrom && dateTo && dateFrom > dateTo) return res.status(400).json({ error: "período inválido" });
    const params = [];
    let where = "1=1";

    if (name) {
      const off = resolveOfficerFromInput(name);
      if (off) {
        where += " AND (actor_name = ? OR target_name = ? OR input_name LIKE ?)";
        params.push(off.canonical_name, off.canonical_name, `%${name}%`);
      } else {
        where += " AND (actor_name LIKE ? OR target_name LIKE ? OR input_name LIKE ? OR details LIKE ?)";
        params.push(`%${name}%`, `%${name}%`, `%${name}%`, `%${name}%`);
      }
    }

    if (dateFrom) {
      where += " AND DATE(CONVERT_TZ(at, '+00:00', '-03:00')) >= ?";
      params.push(dateFrom);
    }
    if (dateTo) {
      where += " AND DATE(CONVERT_TZ(at, '+00:00', '-03:00')) <= ?";
      params.push(dateTo);
    }

    params.push(limit);
    const rows = await safeQuery(
      `SELECT id,
              DATE_FORMAT(CONVERT_TZ(at, '+00:00', '-03:00'), '%Y-%m-%dT%H:%i:%s-03:00') AS at,
              event_type, input_name, actor_name, target_name, recognized, scale_date, field_name, before_value, after_value, details, success, http_status, ip, user_agent
         FROM audit_logs
        WHERE ${where}
        ORDER BY at DESC
        LIMIT ?`,
      params
    );

    return res.json({ ok: true, rows: rows || [] });
  } catch (err) {
    return res.status(500).json({ error: "erro ao carregar auditoria", details: err.message });
  }
});


// salvar alterações (somente após troca de senha)
app.put("/api/assignments", authRequired(false), async (req, res) => {
  try {
    const { st } = await getStateAutoReset();

    const updates = Array.isArray(req.body && req.body.updates) ? req.body.updates : [];
    const actor = req.user.canonical_name;

    if (req.user.is_readonly) {
      await auditEvent(req, {
        event_type: "tentativa_sem_permissao",
        actor_name: actor,
        details: "usuario somente leitura tentou alterar a escala",
        success: false,
        http_status: 403,
      });
      return res.status(403).json({ error: "usuario somente leitura" });
    }

    await auditEvent(req, {
      event_type: "clique_salvar",
      actor_name: actor,
      details: `${updates.length} alteracao(oes) enviada(s)`,
      success: null,
      http_status: null,
    });

    if (!updates.length) {
      await auditEvent(req, {
        event_type: "erro_ao_salvar",
        actor_name: actor,
        details: "nenhuma alteracao enviada",
        success: false,
        http_status: 400,
      });
      return res.status(400).json({ error: "nenhuma alteração enviada" });
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

      // Usuário comum só pode alterar a própria linha. A tentativa é recusada;
      // nunca redirecionamos silenciosamente uma alteração para outra célula.
      if (!req.user.is_admin && target !== actor) {
        await auditEvent(req, {
          event_type: "tentativa_sem_permissao",
          actor_name: actor,
          target_name: target,
          scale_date: date,
          details: "usuario tentou alterar linha de outro oficial",
          success: false,
          http_status: 403,
        });
        continue;
      }

      let code = normalizeCodeValue(u.code);
      if (!code) code = ""; // limpar
      if (code && !validCodes.has(code)) continue;

      const key = `${target}|${date}`;

      const beforeCode = (st.assignments && st.assignments[key]) ? String(st.assignments[key]) : "";
      const beforeObs = (st.notes && st.notes[key]) ? fixText(st.notes[key]) : "";

      const needObs = (code === "OUTROS" || /\*$/.test(code));
      const newObs = needObs ? fixText(u.observacao == null ? "" : u.observacao).trim() : "";
      if (needObs && !newObs) {
        await auditEvent(req, {
          event_type: "erro_ao_salvar",
          actor_name: actor,
          target_name: target,
          scale_date: date,
          field_name: "observacao",
          details: `${code} exige descricao`,
          success: false,
          http_status: 400,
        });
        return res.status(400).json({ error: `${code} exige descrição` });
      }

      // atualiza state_store (permite limpar)
      st.assignments = st.assignments || {};
      st.notes = st.notes || {};
      st.auto_assignments = st.auto_assignments && typeof st.auto_assignments === "object" ? st.auto_assignments : {};
      delete st.auto_assignments[key];

      if (!code) {
        delete st.assignments[key];
        delete st.notes[key];
      } else {
        st.assignments[key] = code;
        if (needObs) {
          // grava/atualiza observação mesmo se o código não mudar
          st.notes[key] = newObs;
        } else {
          delete st.notes[key];
        }
      }

      // persistência no MySQL
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
        // ignora se a tabela não existir em algum ambiente
      }

      // log
      const changedCode = (beforeCode || "") !== (code || "");
      const changedObs = needObs && (beforeObs || "") !== (newObs || "");
      if (changedCode || changedObs) {
        const logBefore = beforeCode || "-";
        const logAfter = code || "-";
        const logExtra = needObs ? ` | obs: ${(beforeObs || "-")} -> ${(newObs || "-")}` : "";
        await logAction(actor, target, "update_day", `${date}: ${logBefore} -> ${logAfter}${logExtra}`);
        if (changedCode) {
          await auditEvent(req, {
            event_type: "alteracao_feita",
            actor_name: actor,
            target_name: target,
            scale_date: date,
            field_name: "codigo",
            before_value: beforeCode || "",
            after_value: code || "",
            details: "alteracao de escala",
            success: true,
            http_status: 200,
          });
        }
        if (changedObs) {
          await auditEvent(req, {
            event_type: "alteracao_feita",
            actor_name: actor,
            target_name: target,
            scale_date: date,
            field_name: "observacao",
            before_value: beforeObs || "",
            after_value: newObs || "",
            details: "alteracao de observacao",
            success: true,
            http_status: 200,
          });
        }
      
// histórico detalhado
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

    // metadados do último registro (para PDF)
    st.last_edit_actor = actor;
    st.last_edit_at = new Date().toISOString();
    st.updated_at = st.last_edit_at;
    await safeQuery(
      "INSERT INTO state_store (id, payload) VALUES (1, ?) ON DUPLICATE KEY UPDATE payload=VALUES(payload), updated_at=CURRENT_TIMESTAMP",
      [JSON.stringify(st)]
    );

    await auditEvent(req, {
      event_type: "salvamento_com_sucesso",
      actor_name: actor,
      details: `${applied} alteracao(oes) aplicada(s)`,
      success: true,
      http_status: 200,
    });

    return res.json({ ok: true, applied });
  } catch (err) {
    await auditEvent(req, {
      event_type: "erro_ao_salvar",
      actor_name: req.user && req.user.canonical_name ? req.user.canonical_name : null,
      details: err.message,
      success: false,
      http_status: 500,
    });
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
      is_readonly: !!req.user.is_readonly,
    };
    const t = signPdfToken(me);
    await auditEvent(req, {
      event_type: "visualizacao_pdf",
      actor_name: req.user.canonical_name,
      details: "link do PDF gerado",
      success: true,
      http_status: 200,
    });
    return res.json({ ok: true, url: `/api/pdf?token=${encodeURIComponent(t)}` });
  } catch (err) {
    return res.status(500).json({ error: "erro ao gerar link do PDF", details: err.message });
  }
});

function dailySituationDisplayCode(code) {
  const c = String(code || "").trim();
  if (c === "CFP_DIA") return "CFP DIURNO";
  if (c === "CFP_NOITE") return "CFP NOTURNO";
  if (c === "FERIAS") return "FÉRIAS";
  if (c === "CONVALESCENCA") return "CONVALESCENÇA";
  if (c === "NUPCIAS") return "NÚPCIAS";
  if (c === "LICENCA PATERNIDADE") return "LICENÇA PATERNIDADE";
  if (c === "LICENCA ADOCAO") return "LICENÇA ADOÇÃO";
  return c || "-";
}

function dailySituationOfficerLabel(off) {
  const alias = Array.isArray(off.aliases) && off.aliases.length ? off.aliases[0] : off.name;
  let rank = fixText(off.rank || "").replace(/\s+PM$/i, "").trim();
  if (/^Asp Of$/i.test(rank)) rank = "Asp";
  return `${rank} ${officerNameNoAccents(alias)}`.trim();
}

function weekdayPtUpper(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return new Intl.DateTimeFormat("pt-BR", { weekday: "long", timeZone: "America/Sao_Paulo" })
    .format(dt).toUpperCase();
}

function renderDailySituationPdf(res, st, iso) {
  const PDFDocument = requirePdfKitOr501(res);
  if (!PDFDocument) return;
  const dates = Array.isArray(st.dates) ? st.dates : [];
  if (!dates.includes(iso)) return res.status(404).json({ error: "o dia vigente não pertence à escala anterior original" });

  const assignments = st.assignments && typeof st.assignments === "object" ? st.assignments : {};
  const notes = st.notes && typeof st.notes === "object" ? st.notes : {};
  const startIndex = OFFICERS.findIndex(o => o.canonical_name === "Marcio Saito Essaki");
  const officers = OFFICERS.slice(startIndex >= 0 ? startIndex : 0);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="situacao_do_dia_${iso}.pdf"`);
  const doc = new PDFDocument({ margin: 42, size: "A4", layout: "portrait" });
  doc.pipe(res);

  const [yyyy, mm, dd] = iso.split("-");
  const compact = `${dd}${["JAN","FEV","MAR","ABR","MAI","JUN","JUL","AGO","SET","OUT","NOV","DEZ"][Number(mm)-1]}${String(yyyy).slice(2)}`;
  doc.font("Helvetica-Bold").fontSize(14).text(`SITUAÇÃO DOS OFICIAIS – ${compact} (${weekdayPtUpper(iso)})`, { align: "center" });
  doc.moveDown(0.9);

  for (const off of officers) {
    const key = `${off.canonical_name}|${iso}`;
    const code = String(assignments[key] || "").trim();
    const displayCode = dailySituationDisplayCode(code);
    doc.font("Helvetica").fontSize(11).text(`${dailySituationOfficerLabel(off)} – `, { continued: true });
    doc.font("Helvetica-Bold").text(displayCode);
    const note = fixText(notes[key] || "").trim();
    if (note && (code === "OUTROS" || /\*$/.test(code))) {
      doc.font("Helvetica-Oblique").fontSize(9).text(`Descrição: ${fixText(note)}`, { indent: 18 });
    }
    doc.moveDown(0.25);
  }

  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(10).text("Fonte: Escala Online de Oficiais (ESCFIOF)", { align: "center" });
  doc.moveDown(0.5);
  doc.text("Alberto Franzini Neto", { align: "center" });
  doc.text("Ch P1/P5", { align: "center" });
  doc.end();
}

app.post("/api/daily_situation_pdf_link", authRequired(true), async (req, res) => {
  try {
    if (req.user.is_readonly || normKey(req.user.canonical_name) === normKey(SPECIAL_READONLY_USER)) {
      return res.status(403).json({ error: "não autorizado" });
    }
    const today = fmtYYYYMMDD(new Date());
    const previous = await getDailySituationSnapshot(today);
    if (!previous || !previous.period || !Array.isArray(previous.dates) || !previous.dates.includes(today)) {
      return res.status(404).json({ error: "escala anterior original ainda indisponível para a situação do dia" });
    }
    const t = signPdfToken(req.user);
    return res.json({ ok: true, url: `/api/daily_situation_pdf?token=${encodeURIComponent(t)}` });
  } catch (err) {
    return res.status(500).json({ error: "erro ao gerar situação do dia", details: err.message });
  }
});

app.get("/api/daily_situation_pdf", pdfAuth, async (req, res) => {
  try {
    if (req.user.is_readonly || normKey(req.user.canonical_name) === normKey(SPECIAL_READONLY_USER)) {
      return res.status(403).json({ error: "não autorizado" });
    }
    const today = fmtYYYYMMDD(new Date());
    const previous = await getDailySituationSnapshot(today);
    if (!previous || !previous.period || !Array.isArray(previous.dates) || !previous.dates.includes(today)) {
      return res.status(404).json({ error: "escala anterior original ainda indisponível" });
    }
    return renderDailySituationPdf(res, previous, today);
  } catch (err) {
    return res.status(500).json({ error: "erro ao abrir situação do dia", details: err.message });
  }
});

app.post("/api/previous_pdf_link", authRequired(true), async (req, res) => {
  try {
    const me = {
      canonical_name: req.user.canonical_name,
      is_admin: !!req.user.is_admin,
      is_readonly: !!req.user.is_readonly,
    };
    const t = signPdfToken(me);
    await auditEvent(req, {
      event_type: "visualizacao_pdf_anterior",
      actor_name: req.user.canonical_name,
      details: "link da ESCALA ANTERIOR ORIGINAL gerado",
      success: true,
      http_status: 200,
    });
    return res.json({ ok: true, url: `/api/previous_pdf?token=${encodeURIComponent(t)}` });
  } catch (err) {
    return res.status(500).json({ error: "erro ao gerar link da escala anterior", details: err.message });
  }
});

app.get("/api/previous_pdf", pdfAuth, async (req, res) => {
  try {
    const previous = await getPreviousSnapshot();
    if (previous && previous.period && previous.period.start && previous.period.end) {
      return renderFrozenScalePdf(res, previous, "escala_anterior_original.pdf");
    }
    // Ponte inicial: 14/09 a 20/09/2026, fornecida pelo usuário como PDF final.
    if (fs.existsSync(INITIAL_PREVIOUS_PDF)) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'inline; filename="escala_anterior_original_14a20set2026.pdf"');
      return res.sendFile(INITIAL_PREVIOUS_PDF);
    }
    return res.status(404).json({ error: "escala anterior ainda indisponível" });
  } catch (err) {
    return res.status(500).json({ error: "erro ao abrir escala anterior", details: err.message });
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

    // cabeçalho
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
        // DB passa a ser a fonte primária, mas fazemos merge defensivo com o state_store
        notes = (built.notes && typeof built.notes === "object") ? built.notes : {};
        notes_meta = (built.notes_meta && typeof built.notes_meta === "object") ? built.notes_meta : {};
        usedDb = true;
        // merge defensivo: se o DB não tiver observação (ou vier NULL/vazio), mantém o state_store
        for (const k of Object.keys(baseNotes)) {
          const codeNow = assignments && assignments[k] ? String(assignments[k]) : "";
          if (codeNow !== "OUTROS" && !/\*$/.test(codeNow)) continue;
          const dbVal = (notes && notes[k] != null) ? String(notes[k]).trim() : "";
          if (!dbVal) {
            const v = String(baseNotes[k] || "").trim();
            if (v) notes[k] = v;
          }
        }
        // mantém metadados do state_store quando o DB não tiver
        for (const k of Object.keys(baseMeta)) {
          if (!notes_meta[k]) notes_meta[k] = baseMeta[k];
        }
      }
    } catch (_e) {
      // mantém fallback
    }


// histórico para PDF (quando houver DB)
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

    function renderPdfCellText(text, x, y, width) {
      const raw = String(text || "-").trim() || "-";
      const longWithSpace = raw.length > 10 && raw.includes(" ");
      const veryLong = raw.length > 14;
      if (longWithSpace || veryLong) {
        const parts = raw.split(/\s+/).filter(Boolean);
        let lines = [];
        if (parts.length >= 2) {
          lines = [parts[0], parts.slice(1).join(" ")];
        } else {
          lines = [raw];
        }
        doc.fontSize(5.2);
        doc.text(lines.join("\n"), x, y + 1, { width, align: "center", lineGap: 0 });
        doc.fontSize(8);
        return;
      }
      doc.fontSize(8).text(raw, x, y, { width, align: "center" });
    }

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
        renderPdfCellText(code || "-", left + colWName + i * colWDay, y, colWDay);
      }

      const rowLineY = y + 12;
      doc.moveTo(left, rowLineY).lineTo(left + colWName + colWDay * dates.length, rowLineY).stroke();

      y += 14;
      if (y > doc.page.height - 140) {
        doc.addPage({ margin: 28, size: "A4", layout: "landscape" });
        y = doc.y;
      }
    }
    // Horários de referência na primeira página, sem repetir a legenda das situações.
    drawReferenceHours(doc, y + 7);

    // assinaturas sempre na primeira página
    {
      const leftMargin = doc.page.margins.left;
      const usableW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const gap = 40;
      const lineW = (usableW - gap) / 2;
      const xCenter = leftMargin;
      const xRight = xCenter + lineW + gap;
      const yLine = doc.page.height - 72;

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
        doc.font("Helvetica").text(fixText(it.text || ""), { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        
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
    await runOneTimePasswordReset();
    app.listen(PORT, () => {
      console.log(`[OK] Escala online em :${PORT} (TZ=${process.env.TZ})`);
    });
  } catch (e) {
    console.error("[FATAL] Falha ao iniciar:", e);
    process.exit(1);
  }
})();

