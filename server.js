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

// Semana mínima (segunda-feira) para iniciar o sistema automaticamente, sem precisar forçar via variável.
// Ex.: quando a semana anterior já passou, iniciamos diretamente na próxima.
const CUTOVER_WEEK_START = "2026-03-02";

// Chave única: todos os oficiais usam a mesma chave para editar.
const SUPERVISOR_KEY = (process.env.SUPERVISOR_KEY || "sr123").trim();

// DB: Railway (URL) > Docker/local (DB_HOST...)
const DB_URL = (process.env.DB_URL || process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL || "").trim();

// Defaults para Docker/local (quando DB_URL não existir)
const DB_HOST = (process.env.DB_HOST || "db").trim();
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = (process.env.DB_USER || "app").trim();
const DB_PASSWORD = (process.env.DB_PASSWORD || "app").trim();
const DB_NAME = (process.env.DB_NAME || process.env.DB_DATABASE || "escala").trim();

// Admin (somente estes dois geram PDF e podem alterar após fechamento)
const ADMIN_NAMES = new Set(["Alberto Franzini Neto", "Eduardo Mosna Xavier"]);

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
    // evita cache antigo no Railway (app.js/index.html)
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
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function safeString(s) {
  return s === null || s === undefined ? "" : String(s);
}

// formata YYYY-MM-DD usando o timezone local do processo (TZ)
function fmtYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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

function mustBeKey(req, res, next) {
  const key = (req.headers["x-access-key"] || "").toString().trim();
  if (!key || key !== SUPERVISOR_KEY) {
    return res.status(403).json({ error: "Acesso negado." });
  }
  return next();
}

// Fechamento: sexta-feira às 11h (São Paulo) até o fim da semana
function isClosedNow() {
  const now = new Date(); // respeita TZ no processo
  const day = now.getDay(); // 5=sexta
  const hour = now.getHours();

  if (day < 5) return false;
  if (day === 5) return hour >= 11;
  return true; // sábado/domingo após sexta 11h
}

function isAdminByName(name) {
  return ADMIN_NAMES.has((name || "").toString().trim());
}

function canOverride(req) {
  const name = (req.headers["x-user-name"] || "").toString().trim();
  const override = (req.headers["x-admin-override"] || "").toString().trim();
  return isAdminByName(name) && override === "1";
}

// códigos oficiais
const CODES_CORRETOS = ["", "EXP", "SR", "FO", "MA", "VE", "LP", "FÉRIAS", "CFP_DIA", "CFP_NOITE", "OUTROS"];

function normalizeBaseState(state) {
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
  const sqls = [
    `CREATE TABLE IF NOT EXISTS state_store (
      id INT PRIMARY KEY,
      payload LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
  ];

  const conn = await pool.getConnection();
  try {
    for (const s of sqls) await conn.query(s);

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
  const desiredWeek = getWeekRangeISO();

  if (!rows.length) {
    // Se a linha principal foi apagada, recria automaticamente
    const initial = normalizeBaseState({});
    await safeQuery("INSERT INTO state_store (id, payload) VALUES (1, ?)", [JSON.stringify(initial)]);
    return initial;
  }

  const stParsed = safeJsonParse(rows[0].payload);
  let st = normalizeBaseState(stParsed || {});

  // Renova automaticamente quando a semana muda (segunda 00:00),
  // zerando os registros (byUser) e atualizando as datas.
  if (!st.period || st.period.start !== desiredWeek.start || st.period.end !== desiredWeek.end) {
    const meta = st.meta && typeof st.meta === "object" ? st.meta : {};
    st = normalizeBaseState({ meta, byUser: {} });

    st.period = { start: desiredWeek.start, end: desiredWeek.end };
    st.dates = buildDatesForWeek(desiredWeek.start);
    st.byUser = {};
    st.updated_at = new Date().toISOString();

    await safeQuery(
      "INSERT INTO state_store (id, payload) VALUES (1, ?) ON DUPLICATE KEY UPDATE payload=VALUES(payload), updated_at=CURRENT_TIMESTAMP",
      [JSON.stringify(st)]
    );
  }

  return st;
}

// merge: atualiza apenas um usuário (ou alvo, se admin)
async function putStateMergedByUser(editorName, targetName, incomingState) {
  const current = await getState();
  const dates = Array.isArray(current.dates) ? current.dates : [];

  const inc = incomingState && typeof incomingState === "object" ? incomingState : {};
  const incByUser = inc.byUser && typeof inc.byUser === "object" ? inc.byUser : {};
  const incUserEntry = incByUser[targetName];

  if (incUserEntry && typeof incUserEntry === "object") {
    current.byUser[targetName] = normalizeUserEntry(incUserEntry, dates);
  }

  current.updated_at = new Date().toISOString();
  await safeQuery(
    "INSERT INTO state_store (id, payload) VALUES (1, ?) ON DUPLICATE KEY UPDATE payload=VALUES(payload), updated_at=CURRENT_TIMESTAMP",
    [JSON.stringify(current)]
  );
  return current;
}

function requirePdfKitOr501(res) {
  try {
    return require("pdfkit");
  } catch {
    res.status(501).json({ error: "Geração de PDF indisponível (instale: npm i pdfkit)." });
    return null;
  }
}

// PDF: texto de célula
function cellText(it) {
  const code = safeString(it && it.code ? it.code : "").trim();
  const obs = safeString(it && it.obs ? it.obs : "").trim();

  if (!obs) return code;

  // Comportamento único para TODAS as opções: sempre mostrar a observação completa.
  // (equivalente ao antigo comportamento do OUTROS)
  return code ? `${code}\n${obs}` : obs;
}

// ===============================
// ROTAS
// ===============================
app.get("/api/health", async (req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    return res.json({ ok: true, tz: TZ, db_mode: DB_URL ? "url" : "host", week: getWeekRangeISO() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : "Falha no health" });
  }
});

app.get("/api/lock", mustBeKey, (req, res) => {
  return res.json({ closed: isClosedNow() });
});

app.post("/api/login", (req, res) => {
  const key = (req.body && req.body.access_key ? req.body.access_key : "").toString().trim();
  if (key !== SUPERVISOR_KEY) return res.status(403).json({ error: "Acesso negado." });
  return res.json({ ok: true, role: "oficial" });
});

app.get("/api/state", mustBeKey, async (req, res) => {
  try {
    const st = await getState();
    return res.json(st);
  } catch (err) {
    return res.status(500).json({ error: "Erro ao carregar state.", details: err.message });
  }
});

app.put("/api/state", mustBeKey, async (req, res) => {
  try {
    const editor = (req.headers["x-user-name"] || "").toString().trim();
    if (!editor) return res.status(400).json({ error: "Nome do usuário ausente (header x-user-name)." });

    const targetHeader = (req.headers["x-target-user"] || "").toString().trim();
    const target = targetHeader && isAdminByName(editor) ? targetHeader : editor;

    if (isClosedNow() && !canOverride(req)) {
      return res.status(423).json({
        error: "Edição bloqueada após sexta-feira às 11h. Somente Alberto/Mosna podem alterar com 'alterar após fechamento'.",
      });
    }

    const incoming = req.body && typeof req.body === "object" ? req.body : null;
    const st = await putStateMergedByUser(editor, target, incoming);
    return res.json({ ok: true, state: st });
  } catch (err) {
    return res.status(500).json({ error: "Erro ao salvar state.", details: err.message });
  }
});

// PDF: somente Alberto/Mosna, sempre com assinaturas, tabela com todos os oficiais (colunas segunda->domingo).
// Ajuste: quando OUTROS tiver texto grande, a linha cresce (altura dinâmica) para caber tudo.
app.get("/api/pdf", mustBeKey, async (req, res) => {
  const editor = (req.headers["x-user-name"] || "").toString().trim();
  if (!isAdminByName(editor)) {
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
    doc.fontSize(8).text("v9", { align: "right" });
    doc.moveDown(0.3);
    doc.fontSize(10).text(`Período: ${st?.period?.start || ""} a ${st?.period?.end || ""}`, { align: "center" });
    doc.moveDown(0.7);

    const dates = Array.isArray(st.dates) ? st.dates : [];
    const byUser = st.byUser && typeof st.byUser === "object" ? st.byUser : {};

    // ===============================
    // PDF: ORDEM FIXA + BIND PELO NOME SALVO
    // ===============================
    // No sistema, o "byUser" é salvo pelo NOME digitado no login (sem posto).
    // No PDF, exibimos "posto + nome" em ordem fixa.
    // Cada linha tem:
    //   label: como aparece no PDF
    //   key: como é procurado no state (nome salvo)
    const OFFICERS_ORDER = [
      { label: "Ten Cel PM Helder Antonio de Paula", key: "Helder Antonio de Paula" },
      { label: "Maj PM Eduardo Mosna Xavier", key: "Eduardo Mosna Xavier" },
      { label: "Maj PM Alessandra Paula Tonolli", key: "Alessandra Paula Tonolli" },
      { label: "Cap PM Carlos Bordim Neto", key: "Carlos Bordim Neto" },
      { label: "Cap PM Alberto Franzini Neto", key: "Alberto Franzini Neto" },
      { label: "Cap PM Marcio Saito Essaki", key: "Marcio Saito Essaki" },
      { label: "1º Ten PM Daniel Alves de Siqueira", key: "Daniel Alves de Siqueira" },
      { label: "1º Ten PM Mateus Pedro Teodoro", key: "Mateus Pedro Teodoro" },
      { label: "2º Ten PM Fernanda Bruno Pomponio Martignago", key: "Fernanda Bruno Pomponio Martignago" },
      { label: "2º Ten PM Dayana de Oliveira Silva Almeida", key: "Dayana de Oliveira Silva Almeida" },

      { label: "Cap PM André Santarelli de Paula", key: "André Santarelli de Paula" },
      { label: "Cap PM Vinicio Augusto Voltarelli Tavares", key: "Vinicio Augusto Voltarelli Tavares" },
      { label: "Cap PM Jose Antonio Marciano Neto", key: "Jose Antonio Marciano Neto" },

      { label: "1º Ten PM Uri Filipe dos Santos", key: "Uri Filipe dos Santos" },
      { label: "1º Ten PM Antônio Ovídio Ferrucio Cardoso", key: "Antônio Ovídio Ferrucio Cardoso" },
      { label: "1º Ten PM Bruno Antão de Oliveira", key: "Bruno Antão de Oliveira" },
      { label: "1º Ten PM Larissa Amadeu Leite", key: "Larissa Amadeu Leite" },
      { label: "1º Ten PM Renato Fernandes Freire", key: "Renato Fernandes Freire" },
      { label: "1º Ten PM Raphael Mecca Sampaio", key: "Raphael Mecca Sampaio" },
    ];

    function normKey(s) {
      return safeString(s)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim()
        .replace(/\s+/g, " ");
    }

    const byUserNormIndex = new Map();
    const byUserNormKeys = [];
    for (const k of Object.keys(byUser)) {
      const nk = normKey(k);
      byUserNormIndex.set(nk, k);
      byUserNormKeys.push(nk);
    }

    function tokenSet(nk) {
      return new Set(nk.split(" ").filter(Boolean));
    }

    function similarity(aNk, bNk) {
      // Jaccard + bônus por primeiro/último token
      const a = tokenSet(aNk);
      const b = tokenSet(bNk);
      const inter = [...a].filter((t) => b.has(t)).length;
      const union = new Set([...a, ...b]).size || 1;
      let score = inter / union;

      const aParts = aNk.split(" ").filter(Boolean);
      const bParts = bNk.split(" ").filter(Boolean);
      if (aParts.length && bParts.length) {
        if (aParts[0] === bParts[0]) score += 0.10; // primeiro nome
        if (aParts[aParts.length - 1] === bParts[bParts.length - 1]) score += 0.15; // último sobrenome
      }
      return score;
    }

    function resolveByUserKey(preferredKey) {
      const nk = normKey(preferredKey);
      const exact = byUserNormIndex.get(nk);
      if (exact) return exact;

      // fallback: melhor aproximação (evita perder preenchimentos por pequenas variações)
      let bestKey = null;
      let bestScore = 0;
      for (const candidateNk of byUserNormKeys) {
        const sc = similarity(nk, candidateNk);
        if (sc > bestScore) {
          bestScore = sc;
          bestKey = candidateNk;
        }
      }
      // limiar conservador: só aceita se parecer ser a mesma pessoa
      if (bestKey && bestScore >= 0.62) return byUserNormIndex.get(bestKey);
      return null;
    }

    const officers = OFFICERS_ORDER.slice();

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const x0 = doc.page.margins.left;
    let y = doc.y;

    const nameColW = 200;
    const colW = (pageWidth - nameColW) / 7;
    const baseRowH = 26;
    const headerH = 24;

    // Desenha célula com:
    // - quebra de linha automática (wrap)
    // - ajuste automático de fonte (reduz até min)
    // - sem truncar (sem ellipsis)
    function drawCell(x, y, w, h, text, isHeader = false) {
      doc.rect(x, y, w, h).stroke();

      const paddingX = 4;
      const paddingTop = isHeader ? 7 : 6;
      const paddingBottom = 6;
      const innerW = Math.max(1, w - paddingX * 2);
      const innerH = Math.max(1, h - paddingTop - paddingBottom);

      if (isHeader) {
        doc.fontSize(9);
        doc.text(text, x + paddingX, y + paddingTop, { width: innerW, align: "center" });
        return;
      }

      // fonte base e mínimos (para manter legibilidade e evitar linhas gigantes)
      const baseFont = 8;
      const minFont = 6;

      let chosen = baseFont;
      for (let fs = baseFont; fs >= minFont; fs--) {
        doc.fontSize(fs);
        const needed = doc.heightOfString(text, { width: innerW, align: "left" });
        if (needed <= innerH) {
          chosen = fs;
          break;
        }
        chosen = fs;
      }

      doc.fontSize(chosen);
      doc.text(text, x + paddingX, y + paddingTop, {
        width: innerW,
        align: "left",
        lineBreak: true,
      });
    }

    function drawHeader() {
      drawCell(x0, y, nameColW, headerH, "oficial", true);
      for (let i = 0; i < 7; i++) {
        drawCell(x0 + nameColW + colW * i, y, colW, headerH, dates[i] || "", true);
      }
      y += headerH;
    }

    drawHeader();

    const bottomReserve = 70; // reserva para assinaturas

    for (const off of officers) {
      const desiredKey = off && off.key ? off.key : "";
      const actualKey = resolveByUserKey(desiredKey) || desiredKey;
      const entry = byUser[actualKey] && typeof byUser[actualKey] === "object" ? byUser[actualKey] : {};

      // 1) calcula altura necessária desta linha (para caber qualquer texto grande)
      let rowHeight = baseRowH;
      for (let i = 0; i < 7; i++) {
        const d = dates[i];
        const it = d ? entry[d] || { code: "", obs: "" } : { code: "", obs: "" };
        const text = cellText(it);

        // altura necessária para este texto na largura da célula, aplicando o mesmo
        // critério de autoajuste de fonte usado no drawCell.
        const paddingX = 4;
        const paddingTop = 6;
        const paddingBottom = 6;
        const innerW = Math.max(1, colW - paddingX * 2);

        const baseFont = 8;
        const minFont = 6;
        let bestNeeded = 0;
        for (let fs = baseFont; fs >= minFont; fs--) {
          doc.fontSize(fs);
          const needed = doc.heightOfString(text, { width: innerW, align: "left" });
          bestNeeded = needed;
          // tenta caber no mínimo (baseRowH), senão continua reduzindo
          const innerTarget = Math.max(1, baseRowH - paddingTop - paddingBottom);
          if (needed <= innerTarget) break;
        }

        const totalNeeded = bestNeeded + paddingTop + paddingBottom;
        rowHeight = Math.max(rowHeight, totalNeeded);
      }

      // 2) quebra de página se não couber
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom - bottomReserve) {
        doc.addPage({ size: "A4", layout: "landscape", margin: 36 });
        y = doc.page.margins.top;
        drawHeader();
      }

      // 3) desenha linha com a altura calculada
      drawCell(x0, y, nameColW, rowHeight, off && off.label ? off.label : "", false);

      for (let i = 0; i < 7; i++) {
        const d = dates[i];
        const it = d ? entry[d] || { code: "", obs: "" } : { code: "", obs: "" };
        drawCell(x0 + nameColW + colW * i, y, colW, rowHeight, cellText(it), false);
      }

      y += rowHeight;
    }

    // assinaturas (sempre que gerar PDF)
    const bottomY = doc.page.height - doc.page.margins.bottom - 40;
    doc.fontSize(10);
    doc.text("______________________________", x0, bottomY);
    doc.text("Alberto Franzini Neto", x0, bottomY + 14);

    doc.text("______________________________", x0 + 340, bottomY);
    doc.text("Eduardo Mosna Xavier", x0 + 340, bottomY + 14);

    doc.end();
  } catch (err) {
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
    app.listen(PORT, () => console.log(`OK - Backend rodando na porta ${PORT} TZ=${TZ}`));
  } catch (err) {
    console.error("FALHA AO INICIALIZAR:", err);
    process.exit(1);
  }
})();