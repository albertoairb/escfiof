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

// Semana mínima (segunda-feira) para iniciar o sistema automaticamente, sem precisar forçar via variável.
// Ex.: quando a semana anterior já passou, iniciamos diretamente na próxima.
const CUTOVER_WEEK_START = "2026-03-02";

const JWT_SECRET = (process.env.JWT_SECRET || "troque-este-segredo").trim();
const DEFAULT_PASSWORD = (process.env.DEFAULT_PASSWORD || "sr123").trim();

const CLOSE_FRIDAY_HOUR = Number(process.env.CLOSE_FRIDAY_HOUR || 11);

const SYSTEM_NAME = (process.env.SYSTEM_NAME || "Escala Semanal de Oficiais do 4º BPM/M").trim();
const AUTHOR = (process.env.AUTHOR || "Desenvolvido por Alberto Franzini Neto").trim();
const COPYRIGHT_YEAR = (process.env.COPYRIGHT_YEAR || "2026").toString().trim();


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
  { canonical_name: "Helder Antônio de Paula", rank: "Tenente-Coronel PM", name: "Helder Antônio de Paula" },
  { canonical_name: "Eduardo Mosna Xavier", rank: "Major PM", name: "Eduardo Mosna Xavier" },
  { canonical_name: "Alessandra Paula Tonolli", rank: "Major PM", name: "Alessandra Paula Tonolli" },
  { canonical_name: "Carlos Bordim Neto", rank: "Capitão PM", name: "Carlos Bordim Neto" },
  { canonical_name: "Alberto Franzini Neto", rank: "Capitão PM", name: "Alberto Franzini Neto" },
  { canonical_name: "Marcio Saito Essaki", rank: "Capitão PM", name: "Marcio Saito Essaki" },
  { canonical_name: "Daniel Alves de Siqueira", rank: "1º Tenente PM", name: "Daniel Alves de Siqueira" },
  { canonical_name: "Mateus Pedro Teodoro", rank: "1º Tenente PM", name: "Mateus Pedro Teodoro" },
  { canonical_name: "Fernanda Bruno Pomponio Martignago", rank: "2º Tenente PM", name: "Fernanda Bruno Pomponio Martignago" },
  { canonical_name: "Dayana de Oliveira Silva Almeida", rank: "2º Tenente PM", name: "Dayana de Oliveira Silva Almeida" },

  { canonical_name: "André Santarelli de Paula", rank: "Capitão PM", name: "André Santarelli de Paula" },
  { canonical_name: "Vinicio Augusto Voltarelli Tavares", rank: "Capitão PM", name: "Vinicio Augusto Voltarelli Tavares" },
  { canonical_name: "Jose Antonio Marciano Neto", rank: "Capitão PM", name: "Jose Antonio Marciano Neto" },

  { canonical_name: "Uri Filipe dos Santos", rank: "1º Tenente PM", name: "Uri Filipe dos Santos" },
  { canonical_name: "Antônio Ovídio Ferrucio Cardoso", rank: "1º Tenente PM", name: "Antônio Ovídio Ferrucio Cardoso" },
  { canonical_name: "Bruno Antão de Oliveira", rank: "1º Tenente PM", name: "Bruno Antão de Oliveira" },
  { canonical_name: "Larissa Amadeu Leite", rank: "1º Tenente PM", name: "Larissa Amadeu Leite" },
  { canonical_name: "Renato Fernandes Freire", rank: "1º Tenente PM", name: "Renato Fernandes Freire" },
  { canonical_name: "Raphael Mecca Sampaio", rank: "1º Tenente PM", name: "Raphael Mecca Sampaio" },
];

// Após fechamento (sexta 11h+), somente estes podem alterar (qualquer oficial)
const ADMIN_NAMES = new Set([
  "Alberto Franzini Neto",
  "Eduardo Mosna Xavier",
  "Helder Antônio de Paula",
]);

// Códigos válidos (tudo em MAIÚSCULO, conforme regra)
// - FO*: permite descrição
// - FOJ: sem descrição
const CODES = ["EXP", "SR", "FO", "FO*", "FOJ", "MA", "VE", "LP", "FÉRIAS", "CFP_DIA", "CFP_NOITE", "OUTROS"];

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
    });

// ===============================
// UTIL
// ===============================
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function normKey(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/\s+/g, " ");
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

// Semana vigente: segunda a domingo, em YYYY-MM-DD (sem usar toISOString para evitar +1 dia)
// Regra adicional: nunca retornar semana anterior a CUTOVER_WEEK_START (segunda-feira).

function getWeekRangeISO() {
  const now = new Date(); // respeita TZ no processo

  // data efetiva = max(agora, CUTOVER_WEEK_START)
  const [cy, cm, cd] = CUTOVER_WEEK_START.split("-").map(Number);
  const cutover = new Date(cy, cm - 1, cd);
  cutover.setHours(0, 0, 0, 0);

  const effective = new Date(Math.max(now.getTime(), cutover.getTime()));

  const day = effective.getDay(); // 0=dom
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(effective);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(effective.getDate() + diffToMonday);

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

// Fechamento: sexta-feira às 11h (São Paulo) até domingo
function isClosedNow() {
  const now = new Date();
  const day = now.getDay(); // 5=sexta
  const hour = now.getHours();

  if (day < 5) return false;
  if (day === 5) return hour >= CLOSE_FRIDAY_HOUR;
  return true; // sábado/domingo
}

function isAdminName(canonicalName) {
  return ADMIN_NAMES.has(String(canonicalName || "").trim());
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
  const year = Number(weekDates[0].slice(0,4));
  const set = new Map();

  // Fixos
  const fixed = [
    ["01-01", "Confraternização Universal"],
    ["21-04", "Tiradentes"],
    ["01-05", "Dia do Trabalhador"],
    ["07-09", "Independência do Brasil"],
    ["12-10", "Nossa Senhora Aparecida"],
    ["02-11", "Finados"],
    ["15-11", "Proclamação da República"],
    ["25-12", "Natal"],
  ];
  for (const [md, name] of fixed) {
    set.set(`${year}-${md}`, name);
  }

  // Móveis (referência nacional)
  const easter = easterDate(year);
  const carnaval = addDays(easter, -47); // terça de carnaval (aprox)
  const sextaSanta = addDays(easter, -2);
  const corpusChristi = addDays(easter, 60);

  set.set(isoFromDate(carnaval), "Carnaval");
  set.set(isoFromDate(sextaSanta), "Paixão de Cristo");
  set.set(isoFromDate(corpusChristi), "Corpus Christi");

  const out = [];
  for (const iso of weekDates) {
    if (set.has(iso)) out.push({ date: iso, name: set.get(iso) });
  }
  return out;
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

    // lançamentos por dia (persistência da semana)
    await conn.query(`CREATE TABLE IF NOT EXISTS escala_lancamentos (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      data DATE NOT NULL,
      oficial VARCHAR(255) NOT NULL,
      codigo VARCHAR(32) NOT NULL,
      observacao TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_data_oficial (data, oficial),
      INDEX idx_data (data),
      INDEX idx_oficial (oficial)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

    // migração defensiva: alguns bancos já possuem a coluna 'observacao'
    const [hasObs] = await conn.query(
      `SELECT COUNT(*) AS c
         FROM information_schema.COLUMNS
        WHERE table_schema = DATABASE()
          AND table_name = 'escala_lancamentos'
          AND column_name = 'observacao'`
    );
    if (!hasObs[0] || Number(hasObs[0].c) === 0) {
      await conn.query("ALTER TABLE escala_lancamentos ADD COLUMN observacao TEXT NULL");
    }

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

  return {
    meta: {
      system_name: SYSTEM_NAME,
      footer_mark: `© ${COPYRIGHT_YEAR} - ${AUTHOR}`,
    },
    period: { start: w.start, end: w.end },
    dates,
    codes: CODES.slice(),
    officers: OFFICERS.slice(),
    assignments: {},
    updated_at: new Date().toISOString(),
  };
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

function isoFromDbDate(v) {
  if (!v) return "";
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
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
  return safeQuery(
    "SELECT data, oficial, codigo, observacao FROM escala_lancamentos WHERE data BETWEEN ? AND ?",
    [periodStartISO, periodEndISO]
  );
}

function buildAssignmentsAndNotesFromLancamentos(rows, validDates) {
  const assignments = {};
  const notes = {};

  const valid = new Set(validDates || []);
  for (const r of rows || []) {
    const iso = isoFromDbDate(r.data);
    if (!valid.has(iso)) continue;

    const canonical = resolveCanonicalFromDbOfficer(r.oficial);
    if (!canonical) continue;

    const key = `${canonical}|${iso}`;
    assignments[key] = String(r.codigo || "").trim();
    const obs = (r.observacao == null) ? "" : String(r.observacao);
    if (obs) notes[key] = obs;
  }

  return { assignments, notes };
}

async function getStateAutoReset() {
  const rows = await safeQuery("SELECT payload FROM state_store WHERE id=1 LIMIT 1");
  let st = rows.length ? safeJsonParse(rows[0].payload) : null;

  const currentWeek = getWeekRangeISO();
  const needReset = !st || !st.period || st.period.start !== currentWeek.start || st.period.end !== currentWeek.end;

  if (needReset) {
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
  st.codes = CODES.slice();
  st.officers = OFFICERS.slice();
  st.period = { start: currentWeek.start, end: currentWeek.end };
  st.dates = buildDatesForWeek(currentWeek.start);
  st.assignments = st.assignments && typeof st.assignments === "object" ? st.assignments : {};
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
        must_change: !!payload.must_change,
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

function resolveOfficerFromInput(nameInput) {
  const nk = normKey(nameInput);
  if (!nk) return null;

  // aceita "posto + nome" ou só "nome"
  // remove posto do início se bater com algum rank
  const stripped = nk
    .replace(/^tenente\-coronel pm\s+/, "")
    .replace(/^tenente coronel pm\s+/, "")
    .replace(/^major pm\s+/, "")
    .replace(/^capit(ao|ão) pm\s+/, "")
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

  // exige mínimo razoável para evitar erro de pessoa
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
    res.status(501).json({ error: "geração de PDF indisponível" });
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

// login: nome + senha
app.post("/api/login", async (req, res) => {
  try {
    const name = (req.body && req.body.name ? req.body.name : "").toString().trim();
    const password = (req.body && req.body.password ? req.body.password : "").toString();

    const off = resolveOfficerFromInput(name);
    if (!off) return res.status(403).json({ error: "nome não reconhecido. use posto + nome completo." });

    const userRow = await findOrCreateUser(off.canonical_name);

    const ok = await bcrypt.compare(password, userRow.password_hash);
    if (!ok) return res.status(403).json({ error: "senha inválida" });

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

// troca obrigatória de senha
app.post("/api/change_password", authRequired(true), async (req, res) => {
  try {
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
    const { st } = await getStateAutoReset();
    const holidays = getHolidaysForWeek(st.dates);

    // se houver lançamentos no MySQL (escala_lancamentos), eles prevalecem
    let assignments = st.assignments || {};
    let notes = {};
    try {
      const rows = await fetchLancamentosForPeriod(st.period.start, st.period.end);
      const built = buildAssignmentsAndNotesFromLancamentos(rows, st.dates);
      if (Object.keys(built.assignments).length) {
        assignments = built.assignments;
        notes = built.notes;
      }
    } catch (_e) {
      // se a tabela ainda não existir em algum ambiente, mantém state_store
    }

    const periodLabel = `período: ${fmtDDMMYYYY(st.period.start)} a ${fmtDDMMYYYY(st.period.end)}`;

    return res.json({
      ok: true,
      me: {
        canonical_name: req.user.canonical_name,
        is_admin: req.user.is_admin,
      },
      meta: {
        system_name: SYSTEM_NAME,
        footer_mark: `© ${COPYRIGHT_YEAR} - ${AUTHOR}`,
        period_label: periodLabel,
      },
      locked: isClosedNow(),
      holidays,
      officers: OFFICERS,
      dates: st.dates,
      codes: CODES,
      assignments,
      notes,
    });
  } catch (err) {
    return res.status(500).json({ error: "erro ao carregar", details: err.message });
  }
});

// salvar alterações (somente após troca de senha)
app.put("/api/assignments", authRequired(false), async (req, res) => {
  try {
    const { st } = await getStateAutoReset();

    const updates = Array.isArray(req.body && req.body.updates) ? req.body.updates : [];
    if (!updates.length) return res.status(400).json({ error: "nenhuma alteração enviada" });

    const locked = isClosedNow();
    const actor = req.user.canonical_name;

    // regra de permissão
    if (locked && !req.user.is_admin) {
      return res.status(423).json({ error: "edição fechada (sexta 11h até domingo)" });
    }

    const validCodes = new Set(CODES);
    const validDates = new Set(st.dates);
    const validOfficers = new Set(OFFICERS.map(o => o.canonical_name));

    let applied = 0;

    for (const u of updates) {
      const target = String(u.canonical_name || "").trim();
      const date = String(u.date || "").trim();
      const code = String(u.code || "").trim();
      const observacaoRaw = (u && Object.prototype.hasOwnProperty.call(u, "observacao")) ? u.observacao : null;
      const observacao = observacaoRaw == null ? "" : String(observacaoRaw).trim();

      if (!validOfficers.has(target)) return res.status(400).json({ error: "oficial inválido" });
      if (!validDates.has(date)) return res.status(400).json({ error: "data inválida" });

      // antes do fechamento: só altera o próprio
      if (!locked && !req.user.is_admin && target !== actor) {
        return res.status(403).json({ error: "você só pode alterar o seu próprio registro até sexta 11h" });
      }

      // depois do fechamento: só admin altera (já passou pelo check)
      if (locked && req.user.is_admin !== true) {
        return res.status(423).json({ error: "edição fechada" });
      }

      if (code && !validCodes.has(code)) return res.status(400).json({ error: "código inválido" });

      const key = `${target}|${date}`;
      const before = st.assignments && st.assignments[key] ? String(st.assignments[key]) : "";

      if (before === code) continue;

      // salva (permite limpar com "")
      st.assignments = st.assignments || {};
      if (!code) delete st.assignments[key];
      else st.assignments[key] = code;

      // persistência no MySQL (para PDF e recarregamento)
      // oficial gravado como canonical_name (garante chave única)
      if (!code) {
        try {
          await safeQuery("DELETE FROM escala_lancamentos WHERE data=? AND oficial=?", [date, target]);
        } catch (_e) {
          // ignora se a tabela ainda não existir em algum ambiente
        }
      } else {
        const needObs = (code === "OUTROS" || code === "FO*");
        const obsToSave = needObs ? (observacao || "") : null;
        try {
          await safeQuery(
            "INSERT INTO escala_lancamentos (data, oficial, codigo, observacao) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE codigo=VALUES(codigo), observacao=VALUES(observacao), updated_at=CURRENT_TIMESTAMP",
            [date, target, code, obsToSave]
          );
        } catch (_e) {
          // ignora se a tabela ainda não existir em algum ambiente
        }
      }

      await logAction(actor, target, "update_day", `${date}: ${before || "-"} -> ${code || "-"}`);
      applied++;
    }

    st.updated_at = new Date().toISOString();

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
app.get("/api/pdf", authRequired(true), async (req, res) => {
  const PDFDocument = requirePdfKitOr501(res);
  if (!PDFDocument) return;

  try {
    const { st } = await getStateAutoReset();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="escala_semanal.pdf"`);

    const doc = new PDFDocument({ margin: 28, size: "A4", layout: "landscape" });
    doc.pipe(res);

    // cabeçalho
    doc.fontSize(16).text(SYSTEM_NAME, { align: "center" });
    doc.moveDown(0.2);
    doc.fontSize(10).text(`Período: ${fmtDDMMYYYY(st.period.start)} a ${fmtDDMMYYYY(st.period.end)}`, { align: "center" });
    doc.moveDown(0.6);

    const dates = st.dates || [];

    // prefere dados do MySQL (escala_lancamentos); fallback para state_store
    let assignments = st.assignments || {};
    let notes = {};
    let usedDb = false;
    try {
      const rows = await fetchLancamentosForPeriod(st.period.start, st.period.end);
      const built = buildAssignmentsAndNotesFromLancamentos(rows, dates);
      if (Object.keys(built.assignments).length) {
        assignments = built.assignments;
        notes = built.notes;
        usedDb = true;
      }
    } catch (_e) {
      // mantém fallback
    }

    // tabela
    const left = doc.page.margins.left;
    const top = doc.y;
    const colWName = 220;
    const colWDay = 80;

    // header row
    doc.fontSize(9).text("OFICIAL", left, top, { width: colWName, align: "left" });
    for (let i = 0; i < dates.length; i++) {
      doc.text(fmtDDMMYYYY(dates[i]), left + colWName + i * colWDay, top, { width: colWDay, align: "center" });
    }
    doc.moveTo(left, top + 14).lineTo(left + colWName + colWDay * dates.length, top + 14).stroke();

    let y = top + 18;

    doc.fontSize(8);
    for (const off of OFFICERS) {
      const label = `${off.rank} ${off.name}`;
      doc.text(label, left, y, { width: colWName, align: "left" });

      for (let i = 0; i < dates.length; i++) {
        const k = `${off.canonical_name}|${dates[i]}`;
        const code = assignments[k] ? String(assignments[k]) : "";
        doc.text(code || "-", left + colWName + i * colWDay, y, { width: colWDay, align: "center" });
      }

      y += 14;
      if (y > doc.page.height - 140) {
        doc.addPage({ margin: 28, size: "A4", layout: "landscape" });
        y = doc.y;
      }
    }

    // detalhamento de descrições (OUTROS e FO*)
    const noteEntries = [];
    for (const k of Object.keys(notes || {})) {
      const [canonical, iso] = k.split("|");
      const off = OFFICERS.find(o => o.canonical_name === canonical);
      if (!off) continue;
      const code = assignments[k] ? String(assignments[k]) : "";
      // só imprime descrições para OUTROS e FO*
      if (code !== "OUTROS" && code !== "FO*") continue;
      noteEntries.push({ iso, off, code, text: notes[k] });
    }
    noteEntries.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));

    if (noteEntries.length) {
      doc.addPage({ margin: 36, size: "A4", layout: "portrait" });
      doc.fontSize(14).text("DESCRIÇÕES (OUTROS / FO*)", { align: "center" });
      doc.moveDown(0.6);
      doc.fontSize(10);

      for (const it of noteEntries) {
        const title = `${fmtDDMMYYYY(it.iso)} - ${it.off.rank} ${it.off.name} (${it.code})`;
        doc.font("Helvetica-Bold").text(title);
        doc.font("Helvetica").text(it.text, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        doc.moveDown(0.6);
        if (doc.y > doc.page.height - 180) {
          doc.addPage({ margin: 36, size: "A4", layout: "portrait" });
          doc.fontSize(14).text("DESCRIÇÕES (OUTROS / FO*)", { align: "center" });
          doc.moveDown(0.6);
          doc.fontSize(10);
        }
      }
    }

    // assinaturas (sempre na última página)
    if (doc.page.layout !== "portrait" || doc.y > doc.page.height - 220) {
      doc.addPage({ margin: 36, size: "A4", layout: "portrait" });
    }

    const xLeft = doc.page.margins.left;
    const xRight = doc.page.width / 2 + 20;
    const lineW = (doc.page.width - doc.page.margins.left - doc.page.margins.right - 40) / 2;
    const yLine = doc.page.height - 160;

    // linhas
    doc.moveTo(xLeft, yLine).lineTo(xLeft + lineW, yLine).stroke();
    doc.moveTo(xRight, yLine).lineTo(xRight + lineW, yLine).stroke();

    // nomes e cargos
    doc.fontSize(10).text("ALBERTO FRANZINI NETO", xLeft, yLine + 6, { width: lineW, align: "center" });
    doc.fontSize(9).text("CH P1/P5", xLeft, yLine + 22, { width: lineW, align: "center" });

    doc.fontSize(10).text("EDUARDO MOSNA XAVIER", xRight, yLine + 6, { width: lineW, align: "center" });
    doc.fontSize(9).text("SUBCMT BTL", xRight, yLine + 22, { width: lineW, align: "center" });

    // rodapé
    doc.fontSize(9).text(`© ${COPYRIGHT_YEAR} - ${AUTHOR}`, 0, doc.page.height - 40, { align: "center" });

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
