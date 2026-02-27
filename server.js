require("dotenv").config();

const express = require("express");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const Database = require("better-sqlite3");

const app = express();

const PORT = Number(process.env.PORT || 8787);
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const JSON_ARCHIVE_FILE = path.join(DATA_DIR, "archive.json");
const DB_PATH = process.env.DB_PATH || (IS_VERCEL ? "/tmp/icracy.db" : path.join(DATA_DIR, "icracy.db"));

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_RANKINGS_URL = "https://openrouter.ai/rankings";
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || (IS_VERCEL ? "https://icracy.vercel.app" : `http://localhost:${PORT}`);
const OPENROUTER_SITE_NAME = process.env.OPENROUTER_SITE_NAME || "icracy.com";

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || "user-human-8821";
const DEFAULT_USER_HANDLE = process.env.DEFAULT_USER_HANDLE || "human-8821";
const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME || "Human Delegate";

const DELEGATE_SYNC_TTL_MS = 10 * 60 * 1000;
const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;

const runtime = {
  modelCatalogCache: {
    expiresAt: 0,
    data: [],
  },
  delegateSync: {
    expiresAt: 0,
  },
  streamBus: new EventEmitter(),
  schedulerHandle: null,
};

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseAbbreviatedTokens(value) {
  if (!value || typeof value !== "string") {
    return 0;
  }

  const trimmed = value.trim().toUpperCase();
  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)([KMBT])$/);
  if (!match) {
    return Number(trimmed) || 0;
  }

  const amount = Number(match[1]);
  const multipliers = {
    K: 1e3,
    M: 1e6,
    B: 1e9,
    T: 1e12,
  };

  return amount * multipliers[match[2]];
}

function normalizeVote(vote) {
  const normalized = String(vote || "").trim().toLowerCase();
  if (normalized.startsWith("idi")) {
    return "Idiotic";
  }
  return "Intelligent";
}

function flattenOpenRouterContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          return item.text || item.content || "";
        }
        return "";
      })
      .join("\n")
      .trim();
  }

  if (content && typeof content === "object") {
    return content.text || JSON.stringify(content);
  }

  return "";
}

function maybeParseJsonObject(text) {
  if (!text || typeof text !== "string") {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || start >= end) {
    return null;
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseDelegateOutput(rawText) {
  const fallback = String(rawText || "").replace(/\s+/g, " ").trim();
  const parsed = maybeParseJsonObject(rawText);

  if (parsed && typeof parsed === "object") {
    return {
      vote: normalizeVote(parsed.vote || parsed.verdict),
      confidence: clamp(Number(parsed.confidence) || 55, 1, 100),
      argument: String(parsed.argument || parsed.reasoning || fallback || "No argument returned.").trim(),
      rebuttal: String(parsed.rebuttal || parsed.counterpoint || "").trim(),
    };
  }

  const voteMatch = fallback.match(/\b(Intelligent|Idiotic)\b/i);
  const confidenceMatch = fallback.match(/\b(\d{1,3})\s*%/);

  return {
    vote: normalizeVote(voteMatch ? voteMatch[1] : "Intelligent"),
    confidence: clamp(Number(confidenceMatch ? confidenceMatch[1] : 55), 1, 100),
    argument: fallback || "No argument returned.",
    rebuttal: "",
  };
}

function computeConsensus(delegateRows) {
  let intelligentVotes = 0;
  let idioticVotes = 0;
  let intelligentWeight = 0;
  let idioticWeight = 0;

  for (const row of delegateRows) {
    if (row.error) {
      continue;
    }

    if (row.vote === "Idiotic") {
      idioticVotes += 1;
      idioticWeight += row.confidence;
    } else {
      intelligentVotes += 1;
      intelligentWeight += row.confidence;
    }
  }

  const totalVotes = intelligentVotes + idioticVotes;

  let verdict = "Intelligent";
  if (idioticVotes > intelligentVotes) {
    verdict = "Idiotic";
  } else if (idioticVotes === intelligentVotes) {
    verdict = idioticWeight > intelligentWeight ? "Idiotic" : "Intelligent";
  }

  const intelligentPct = totalVotes ? Math.round((intelligentVotes / totalVotes) * 100) : 50;
  const idioticPct = 100 - intelligentPct;

  return {
    verdict,
    intelligentVotes,
    idioticVotes,
    totalVotes,
    intelligentPct,
    idioticPct,
  };
}

function extractRankedModelRows(html, limit) {
  const regex = /href="\/([^"?#]+\/[^"?#]+)">([^<]+)<\/a>[\s\S]*?<div>([0-9]+(?:\.[0-9]+)?[KMBT])<!-- --> tokens<\/div>/g;
  const rows = [];
  const seen = new Set();
  let match;

  while ((match = regex.exec(html)) !== null) {
    const slug = match[1].trim();
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);

    rows.push({
      rank: rows.length + 1,
      slug,
      displayName: match[2].trim(),
      tokenText: match[3].trim(),
      tokenValue: parseAbbreviatedTokens(match[3].trim()),
    });

    if (rows.length >= limit) {
      break;
    }
  }

  return rows;
}

function inferTopic(title, body) {
  const source = `${title} ${body}`.toLowerCase();
  if (/(econom|budget|tax|currency|credit|income)/.test(source)) return "Economics";
  if (/(law|constitution|govern|policy|rights|vote)/.test(source)) return "Politics";
  if (/(model|ai|compute|algorithm|robot|llm)/.test(source)) return "Technology";
  if (/(ethic|moral|justice|fair)/.test(source)) return "Ethics";
  if (/(climate|energy|planet|ecology)/.test(source)) return "Climate";
  return "General";
}

function periodStart(period) {
  const now = Date.now();
  if (period === "weekly") {
    return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (period === "monthly") {
    return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  }
  return null;
}

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDirSync(DATA_DIR);

if (!fs.existsSync(JSON_ARCHIVE_FILE)) {
  fs.writeFileSync(JSON_ARCHIVE_FILE, "[]\n", "utf8");
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'citizen',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delegate_models (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  weekly_tokens INTEGER,
  weekly_tokens_text TEXT,
  context_length INTEGER,
  prompt_price REAL,
  completion_price REAL,
  rank_position INTEGER,
  source_updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resolutions (
  id TEXT PRIMARY KEY,
  author_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(author_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS resolution_delegate_picks (
  resolution_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(resolution_id, model_id),
  FOREIGN KEY(resolution_id) REFERENCES resolutions(id) ON DELETE CASCADE,
  FOREIGN KEY(model_id) REFERENCES delegate_models(id)
);

CREATE TABLE IF NOT EXISTS debates (
  id TEXT PRIMARY KEY,
  resolution_id TEXT NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT,
  intelligent_votes INTEGER NOT NULL DEFAULT 0,
  idiotic_votes INTEGER NOT NULL DEFAULT 0,
  total_votes INTEGER NOT NULL DEFAULT 0,
  intelligent_pct INTEGER NOT NULL DEFAULT 50,
  idiotic_pct INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(resolution_id) REFERENCES resolutions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS debate_messages (
  id TEXT PRIMARY KEY,
  debate_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  stance TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(debate_id) REFERENCES debates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS delegate_votes (
  id TEXT PRIMARY KEY,
  debate_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  vote TEXT,
  confidence INTEGER,
  argument TEXT,
  rebuttal TEXT,
  raw_output TEXT,
  error TEXT,
  source TEXT NOT NULL DEFAULT 'openrouter',
  created_at TEXT NOT NULL,
  FOREIGN KEY(debate_id) REFERENCES debates(id) ON DELETE CASCADE,
  FOREIGN KEY(model_id) REFERENCES delegate_models(id)
);

CREATE TABLE IF NOT EXISTS human_votes (
  id TEXT PRIMARY KEY,
  debate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  vote TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(debate_id, user_id),
  FOREIGN KEY(debate_id) REFERENCES debates(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS human_arguments (
  id TEXT PRIMARY KEY,
  debate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  stance TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(debate_id) REFERENCES debates(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
  snapshot_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  alignment_score INTEGER NOT NULL,
  submissions INTEGER NOT NULL,
  correct_votes INTEGER NOT NULL,
  total_votes INTEGER NOT NULL,
  PRIMARY KEY(snapshot_id, rank),
  FOREIGN KEY(snapshot_id) REFERENCES leaderboard_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_resolutions_author ON resolutions(author_user_id);
CREATE INDEX IF NOT EXISTS idx_resolutions_status ON resolutions(status);
CREATE INDEX IF NOT EXISTS idx_debates_resolution ON debates(resolution_id);
CREATE INDEX IF NOT EXISTS idx_debates_status_created ON debates(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_debate_created ON debate_messages(debate_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_delegate_votes_debate ON delegate_votes(debate_id);
CREATE INDEX IF NOT EXISTS idx_human_votes_debate ON human_votes(debate_id);
CREATE INDEX IF NOT EXISTS idx_delegate_models_rank ON delegate_models(rank_position);
`);

function ensureColumn(tableName, columnName, sqlType) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlType}`);
  }
}

ensureColumn("delegate_votes", "source", "TEXT NOT NULL DEFAULT 'openrouter'");

const upsertUserStmt = db.prepare(`
INSERT INTO users (id, handle, display_name, role, created_at, updated_at)
VALUES (@id, @handle, @display_name, @role, @created_at, @updated_at)
ON CONFLICT(id) DO UPDATE SET
  handle = excluded.handle,
  display_name = excluded.display_name,
  updated_at = excluded.updated_at
`);

const getUserByIdStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
const getUserByHandleStmt = db.prepare(`SELECT * FROM users WHERE handle = ?`);

function ensureUser({ id, handle, displayName, role = "citizen" }) {
  const timestamp = nowIso();
  upsertUserStmt.run({
    id,
    handle,
    display_name: displayName,
    role,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return getUserByIdStmt.get(id);
}

ensureUser({
  id: DEFAULT_USER_ID,
  handle: DEFAULT_USER_HANDLE,
  displayName: DEFAULT_USER_NAME,
});

function getCurrentUser(req) {
  const userId = String(req.get("x-user-id") || "").trim();
  const userHandle = String(req.get("x-user-handle") || "").trim();
  const userName = String(req.get("x-user-name") || "").trim();

  if (userId) {
    const existing = getUserByIdStmt.get(userId);
    if (existing) {
      return existing;
    }

    return ensureUser({
      id: userId,
      handle: userHandle || `user-${userId.slice(0, 8)}`,
      displayName: userName || `User ${userId.slice(0, 6)}`,
    });
  }

  if (userHandle) {
    const existingByHandle = getUserByHandleStmt.get(userHandle);
    if (existingByHandle) {
      return existingByHandle;
    }

    const generatedId = `user-${createHash("sha1").update(userHandle).digest("hex").slice(0, 16)}`;
    return ensureUser({
      id: generatedId,
      handle: userHandle,
      displayName: userName || userHandle,
    });
  }

  return getUserByIdStmt.get(DEFAULT_USER_ID);
}

async function fetchModelCatalog() {
  const now = Date.now();
  if (runtime.modelCatalogCache.expiresAt > now && runtime.modelCatalogCache.data.length) {
    return runtime.modelCatalogCache.data;
  }

  const response = await fetch(`${OPENROUTER_API_BASE}/models`);
  if (!response.ok) {
    throw new Error(`Failed to load OpenRouter models (HTTP ${response.status})`);
  }

  const payload = await response.json();
  const models = Array.isArray(payload?.data) ? payload.data : [];

  runtime.modelCatalogCache = {
    expiresAt: now + MODEL_CATALOG_TTL_MS,
    data: models,
  };

  return models;
}

function upsertDelegateModel(agent) {
  db.prepare(`
    INSERT INTO delegate_models (
      id, slug, display_name, provider, weekly_tokens, weekly_tokens_text,
      context_length, prompt_price, completion_price, rank_position, source_updated_at
    ) VALUES (
      @id, @slug, @display_name, @provider, @weekly_tokens, @weekly_tokens_text,
      @context_length, @prompt_price, @completion_price, @rank_position, @source_updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      slug = excluded.slug,
      display_name = excluded.display_name,
      provider = excluded.provider,
      weekly_tokens = excluded.weekly_tokens,
      weekly_tokens_text = excluded.weekly_tokens_text,
      context_length = excluded.context_length,
      prompt_price = excluded.prompt_price,
      completion_price = excluded.completion_price,
      rank_position = excluded.rank_position,
      source_updated_at = excluded.source_updated_at
  `).run(agent);
}

function getDelegates(limit = 10) {
  return db
    .prepare(`
      SELECT
        id,
        slug,
        display_name AS displayName,
        provider,
        weekly_tokens AS weeklyTokens,
        weekly_tokens_text AS weeklyTokensText,
        context_length AS contextLength,
        prompt_price AS promptPrice,
        completion_price AS completionPrice,
        rank_position AS rank,
        source_updated_at AS sourceUpdatedAt
      FROM delegate_models
      ORDER BY rank_position ASC, display_name ASC
      LIMIT ?
    `)
    .all(limit);
}

async function syncDelegates(limit = 20, force = false) {
  const now = Date.now();
  if (!force && runtime.delegateSync.expiresAt > now) {
    const cached = getDelegates(limit);
    if (cached.length) {
      return cached;
    }
  }

  const timestamp = nowIso();

  try {
    const [catalog, rankingsHtmlResponse] = await Promise.all([
      fetchModelCatalog(),
      fetch(OPENROUTER_RANKINGS_URL),
    ]);

    if (!rankingsHtmlResponse.ok) {
      throw new Error(`Failed to load rankings page (HTTP ${rankingsHtmlResponse.status})`);
    }

    const html = await rankingsHtmlResponse.text();
    const rows = extractRankedModelRows(html, limit);

    const modelMap = new Map();
    for (const model of catalog) {
      modelMap.set(model.id, model);
      if (model.id.endsWith(":free")) {
        modelMap.set(model.id.replace(/:free$/, ""), model);
      }
    }

    if (!rows.length) {
      throw new Error("No model rows parsed from OpenRouter rankings");
    }

    const transaction = db.transaction(() => {
      for (const row of rows) {
        const model = modelMap.get(row.slug) || modelMap.get(row.slug.replace(/:free$/, ""));
        const id = model?.id || row.slug;

        upsertDelegateModel({
          id,
          slug: row.slug,
          display_name: model?.name || row.displayName,
          provider: (id.split("/")[0] || "unknown").trim(),
          weekly_tokens: row.tokenValue,
          weekly_tokens_text: row.tokenText,
          context_length: model?.context_length || null,
          prompt_price: model?.pricing?.prompt ? Number(model.pricing.prompt) : null,
          completion_price: model?.pricing?.completion ? Number(model.pricing.completion) : null,
          rank_position: row.rank,
          source_updated_at: timestamp,
        });
      }
    });

    transaction();
    runtime.delegateSync.expiresAt = now + DELEGATE_SYNC_TTL_MS;
    return getDelegates(limit);
  } catch (error) {
    const existing = getDelegates(limit);
    if (existing.length) {
      runtime.delegateSync.expiresAt = now + 60 * 1000;
      return existing;
    }

    const fallback = [
      { id: "openai/gpt-4o-mini", displayName: "GPT-4o Mini", provider: "openai" },
      { id: "anthropic/claude-3.5-sonnet", displayName: "Claude Sonnet", provider: "anthropic" },
      { id: "google/gemini-2.0-flash", displayName: "Gemini Flash", provider: "google" },
      { id: "meta-llama/llama-3.1-70b-instruct", displayName: "Llama 3.1 70B", provider: "meta-llama" },
    ];

    const transaction = db.transaction(() => {
      fallback.forEach((agent, index) => {
        upsertDelegateModel({
          id: agent.id,
          slug: agent.id,
          display_name: agent.displayName,
          provider: agent.provider,
          weekly_tokens: null,
          weekly_tokens_text: "n/a",
          context_length: null,
          prompt_price: null,
          completion_price: null,
          rank_position: index + 1,
          source_updated_at: timestamp,
        });
      });
    });

    transaction();
    runtime.delegateSync.expiresAt = now + 60 * 1000;
    return getDelegates(limit);
  }
}

function buildDelegatePrompt(title, resolution) {
  return [
    {
      role: "system",
      content:
        "You are an AI delegate in a UN-style assembly. Evaluate the resolution and return strict JSON only. No markdown.",
    },
    {
      role: "user",
      content: [
        "Evaluate this resolution for the digital assembly.",
        `Title: ${title}`,
        `Resolution: ${resolution}`,
        "",
        "Return exactly this JSON schema:",
        '{"vote":"Intelligent|Idiotic","confidence":0-100,"argument":"2-4 sentence argument","rebuttal":"1 sentence counterargument"}',
      ].join("\n"),
    },
  ];
}

function mockDelegateDebate(modelId, title, resolution) {
  const seed = createHash("sha256").update(`${modelId}::${title}::${resolution}`).digest("hex");
  const n = Number.parseInt(seed.slice(0, 8), 16);
  const vote = n % 2 === 0 ? "Intelligent" : "Idiotic";
  const confidence = 55 + (n % 40);

  const proArgument =
    "The resolution is internally coherent, actionable, and likely to increase institutional clarity with measurable outcomes.";
  const conArgument =
    "The resolution introduces governance risk and uneven burden distribution, with unclear enforcement and potential systemic side effects.";

  return {
    modelId,
    vote,
    confidence,
    argument: vote === "Intelligent" ? proArgument : conArgument,
    rebuttal:
      vote === "Intelligent"
        ? "Opponents may argue adoption cost exceeds benefit in the near term."
        : "Supporters may argue long-term gains justify transitional complexity.",
    raw: JSON.stringify({ vote, confidence }),
    usage: null,
    source: "mock",
  };
}

async function runDelegateDebate(modelId, title, resolution) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return mockDelegateDebate(modelId, title, resolution);
  }

  const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": OPENROUTER_SITE_URL,
      "X-Title": OPENROUTER_SITE_NAME,
    },
    body: JSON.stringify({
      model: modelId,
      temperature: 0.4,
      max_tokens: 450,
      messages: buildDelegatePrompt(title, resolution),
    }),
  });

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`OpenRouter request failed for ${modelId}: HTTP ${response.status} ${bodyText.slice(0, 200)}`);
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error(`OpenRouter returned invalid JSON for ${modelId}`);
  }

  const content = flattenOpenRouterContent(payload?.choices?.[0]?.message?.content);
  const parsed = parseDelegateOutput(content);

  return {
    modelId,
    vote: parsed.vote,
    confidence: parsed.confidence,
    argument: parsed.argument,
    rebuttal: parsed.rebuttal,
    raw: content,
    usage: payload?.usage || null,
    source: "openrouter",
  };
}

function emitDebateEvent(debateId, type, payload) {
  runtime.streamBus.emit(`debate:${debateId}`, {
    type,
    payload,
    at: nowIso(),
  });
}

function mapDebateRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.debateId,
    createdAt: row.debateCreatedAt,
    updatedAt: row.debateUpdatedAt,
    status: row.debateStatus,
    verdict: row.debateVerdict,
    consensus: {
      verdict: row.debateVerdict,
      intelligentVotes: row.intelligentVotes,
      idioticVotes: row.idioticVotes,
      totalVotes: row.totalVotes,
      intelligentPct: row.intelligentPct,
      idioticPct: row.idioticPct,
    },
    resolution: {
      id: row.resolutionId,
      title: row.title,
      body: row.body,
      topic: row.topic,
      status: row.resolutionStatus,
      authorUserId: row.authorUserId,
      createdAt: row.resolutionCreatedAt,
      updatedAt: row.resolutionUpdatedAt,
    },
  };
}

function getDebateById(debateId) {
  const row = db
    .prepare(`
      SELECT
        d.id AS debateId,
        d.status AS debateStatus,
        d.verdict AS debateVerdict,
        d.intelligent_votes AS intelligentVotes,
        d.idiotic_votes AS idioticVotes,
        d.total_votes AS totalVotes,
        d.intelligent_pct AS intelligentPct,
        d.idiotic_pct AS idioticPct,
        d.created_at AS debateCreatedAt,
        d.updated_at AS debateUpdatedAt,
        r.id AS resolutionId,
        r.author_user_id AS authorUserId,
        r.title,
        r.body,
        r.topic,
        r.status AS resolutionStatus,
        r.created_at AS resolutionCreatedAt,
        r.updated_at AS resolutionUpdatedAt
      FROM debates d
      JOIN resolutions r ON r.id = d.resolution_id
      WHERE d.id = ?
    `)
    .get(debateId);

  const mapped = mapDebateRow(row);
  if (!mapped) {
    return null;
  }

  const delegateVotes = db
    .prepare(`
      SELECT
        dv.model_id AS modelId,
        dm.display_name AS displayName,
        dm.provider,
        dv.vote,
        dv.confidence,
        dv.argument,
        dv.rebuttal,
        dv.error,
        dv.created_at AS createdAt,
        dv.source
      FROM delegate_votes dv
      LEFT JOIN delegate_models dm ON dm.id = dv.model_id
      WHERE dv.debate_id = ?
      ORDER BY dv.created_at ASC
    `)
    .all(debateId);

  const messages = db
    .prepare(`
      SELECT
        id,
        actor_type AS actorType,
        actor_id AS actorId,
        actor_name AS actorName,
        stance,
        content,
        confidence,
        created_at AS createdAt
      FROM debate_messages
      WHERE debate_id = ?
      ORDER BY created_at ASC
    `)
    .all(debateId);

  const humanVotes = db
    .prepare(`
      SELECT
        hv.id,
        hv.user_id AS userId,
        u.display_name AS userName,
        hv.vote,
        hv.created_at AS createdAt
      FROM human_votes hv
      JOIN users u ON u.id = hv.user_id
      WHERE hv.debate_id = ?
      ORDER BY hv.created_at ASC
    `)
    .all(debateId);

  return {
    ...mapped,
    delegateResults: delegateVotes,
    messages,
    humanVotes,
  };
}

function createDraft({ userId, title, body, topic }) {
  const timestamp = nowIso();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO resolutions (id, author_user_id, title, body, topic, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(id, userId, title, body, topic, timestamp, timestamp);

  return db.prepare(`SELECT * FROM resolutions WHERE id = ?`).get(id);
}

function updateDraft({ draftId, userId, title, body, topic }) {
  const draft = db.prepare(`SELECT * FROM resolutions WHERE id = ?`).get(draftId);
  if (!draft) {
    return null;
  }

  if (draft.author_user_id !== userId) {
    const error = new Error("You do not own this draft");
    error.code = "FORBIDDEN";
    throw error;
  }

  const timestamp = nowIso();

  db.prepare(`
    UPDATE resolutions
    SET title = ?, body = ?, topic = ?, updated_at = ?
    WHERE id = ? AND status = 'draft'
  `).run(title, body, topic, timestamp, draftId);

  return db.prepare(`SELECT * FROM resolutions WHERE id = ?`).get(draftId);
}

function pickDelegates(delegateIds, fallbackLimit = 4) {
  let candidates = [];

  if (Array.isArray(delegateIds) && delegateIds.length) {
    const lookup = db.prepare(`SELECT id FROM delegate_models WHERE id = ?`);
    const sanitized = [...new Set(delegateIds.map((id) => String(id).trim()).filter(Boolean))];
    candidates = sanitized.filter((id) => Boolean(lookup.get(id)));
  }

  if (!candidates.length) {
    candidates = getDelegates(fallbackLimit).map((item) => item.id);
  }

  return candidates.slice(0, 6);
}

async function runDebateForResolution({ resolutionId, title, body, delegateIds }) {
  const timestamp = nowIso();
  const debateId = randomUUID();

  db.prepare(`
    INSERT INTO debates (
      id, resolution_id, status, created_at, updated_at
    ) VALUES (?, ?, 'active', ?, ?)
  `).run(debateId, resolutionId, timestamp, timestamp);

  db.prepare(`
    UPDATE resolutions
    SET status = 'debating', updated_at = ?
    WHERE id = ?
  `).run(timestamp, resolutionId);

  db.prepare(`
    INSERT INTO debate_messages (
      id, debate_id, actor_type, actor_id, actor_name, stance, content, confidence, created_at
    ) VALUES (?, ?, 'system', NULL, 'Assembly Clerk', 'neutral', ?, NULL, ?)
  `).run(randomUUID(), debateId, `Debate opened for resolution: ${title}`, timestamp);

  emitDebateEvent(debateId, "debate_started", { debateId, resolutionId, title });

  const settled = await Promise.allSettled(delegateIds.map((modelId) => runDelegateDebate(modelId, title, body)));

  const insertVoteStmt = db.prepare(`
    INSERT INTO delegate_votes (
      id, debate_id, model_id, vote, confidence, argument, rebuttal, raw_output, error, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMessageStmt = db.prepare(`
    INSERT INTO debate_messages (
      id, debate_id, actor_type, actor_id, actor_name, stance, content, confidence, created_at
    ) VALUES (?, ?, 'delegate', ?, ?, ?, ?, ?, ?)
  `);

  const delegateRows = [];

  const metadataById = new Map(getDelegates(50).map((d) => [d.id, d]));

  const tx = db.transaction(() => {
    settled.forEach((result, index) => {
      const modelId = delegateIds[index];
      const modelMeta = metadataById.get(modelId);
      const createdAt = nowIso();

      if (result.status === "fulfilled") {
        const row = result.value;
        delegateRows.push({
          modelId,
          displayName: modelMeta?.displayName || modelId,
          provider: modelMeta?.provider || modelId.split("/")[0] || "unknown",
          vote: row.vote,
          confidence: row.confidence,
          argument: row.argument,
          rebuttal: row.rebuttal,
          error: null,
          source: row.source || "openrouter",
          createdAt,
        });

        insertVoteStmt.run(
          randomUUID(),
          debateId,
          modelId,
          row.vote,
          row.confidence,
          row.argument,
          row.rebuttal,
          row.raw,
          null,
          row.source || "openrouter",
          createdAt,
        );

        insertMessageStmt.run(
          randomUUID(),
          debateId,
          modelId,
          modelMeta?.displayName || modelId,
          row.vote === "Idiotic" ? "idiotic" : "intelligent",
          row.argument,
          row.confidence,
          createdAt,
        );
      } else {
        const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
        delegateRows.push({
          modelId,
          displayName: modelMeta?.displayName || modelId,
          provider: modelMeta?.provider || modelId.split("/")[0] || "unknown",
          vote: null,
          confidence: null,
          argument: null,
          rebuttal: null,
          error: errorMessage,
          source: "openrouter",
          createdAt,
        });

        insertVoteStmt.run(
          randomUUID(),
          debateId,
          modelId,
          null,
          null,
          null,
          null,
          null,
          errorMessage,
          "openrouter",
          createdAt,
        );

        insertMessageStmt.run(
          randomUUID(),
          debateId,
          modelId,
          modelMeta?.displayName || modelId,
          "neutral",
          `Delegate failed to respond: ${errorMessage}`,
          null,
          createdAt,
        );
      }
    });
  });

  tx();

  const consensus = computeConsensus(delegateRows);
  const finalizedAt = nowIso();

  db.prepare(`
    UPDATE debates
    SET
      status = 'closed',
      verdict = ?,
      intelligent_votes = ?,
      idiotic_votes = ?,
      total_votes = ?,
      intelligent_pct = ?,
      idiotic_pct = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    consensus.verdict,
    consensus.intelligentVotes,
    consensus.idioticVotes,
    consensus.totalVotes,
    consensus.intelligentPct,
    consensus.idioticPct,
    finalizedAt,
    debateId,
  );

  db.prepare(`UPDATE resolutions SET status = 'closed', updated_at = ? WHERE id = ?`).run(finalizedAt, resolutionId);

  db.prepare(`
    INSERT INTO debate_messages (
      id, debate_id, actor_type, actor_id, actor_name, stance, content, confidence, created_at
    ) VALUES (?, ?, 'system', NULL, 'Assembly Clerk', 'neutral', ?, NULL, ?)
  `).run(
    randomUUID(),
    debateId,
    `Final verdict: ${consensus.verdict} (${consensus.intelligentPct}% intelligent / ${consensus.idioticPct}% idiotic)`,
    finalizedAt,
  );

  emitDebateEvent(debateId, "debate_completed", {
    debateId,
    consensus,
    totalDelegates: delegateIds.length,
  });

  return getDebateById(debateId);
}

function listArchive({ verdict, topic, delegate, q, dateFrom, dateTo, limit = 20, offset = 0 }) {
  const params = [];
  const where = [`d.status = 'closed'`];

  if (verdict) {
    where.push(`d.verdict = ?`);
    params.push(normalizeVote(verdict));
  }

  if (topic) {
    where.push(`r.topic = ?`);
    params.push(topic);
  }

  if (q) {
    where.push(`(r.title LIKE ? OR r.body LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`);
  }

  if (dateFrom) {
    where.push(`d.created_at >= ?`);
    params.push(dateFrom);
  }

  if (dateTo) {
    where.push(`d.created_at <= ?`);
    params.push(dateTo);
  }

  if (delegate) {
    where.push(`EXISTS (
      SELECT 1 FROM delegate_votes dvf
      WHERE dvf.debate_id = d.id
        AND (dvf.model_id = ? OR dvf.model_id LIKE ?)
    )`);
    params.push(delegate, `%${delegate}%`);
  }

  params.push(limit, offset);

  const rows = db
    .prepare(`
      SELECT
        d.id AS debateId,
        d.created_at AS createdAt,
        d.updated_at AS updatedAt,
        d.verdict,
        d.intelligent_votes AS intelligentVotes,
        d.idiotic_votes AS idioticVotes,
        d.total_votes AS totalVotes,
        d.intelligent_pct AS intelligentPct,
        d.idiotic_pct AS idioticPct,
        r.id AS resolutionId,
        r.title,
        r.body,
        r.topic,
        r.author_user_id AS authorUserId,
        u.display_name AS authorName
      FROM debates d
      JOIN resolutions r ON r.id = d.resolution_id
      JOIN users u ON u.id = r.author_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params);

  return rows.map((row) => {
    const delegates = db
      .prepare(`
        SELECT
          dv.model_id AS modelId,
          dm.display_name AS displayName,
          dm.provider
        FROM delegate_votes dv
        LEFT JOIN delegate_models dm ON dm.id = dv.model_id
        WHERE dv.debate_id = ?
        ORDER BY dv.created_at ASC
      `)
      .all(row.debateId);

    return {
      id: row.debateId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      verdict: row.verdict,
      consensus: {
        verdict: row.verdict,
        intelligentVotes: row.intelligentVotes,
        idioticVotes: row.idioticVotes,
        totalVotes: row.totalVotes,
        intelligentPct: row.intelligentPct,
        idioticPct: row.idioticPct,
      },
      title: row.title,
      resolution: row.body,
      topic: row.topic,
      authorUserId: row.authorUserId,
      authorName: row.authorName,
      delegates,
    };
  });
}

function getArchiveFacets() {
  const verdicts = db
    .prepare(`
      SELECT verdict, COUNT(*) AS count
      FROM debates
      WHERE status = 'closed'
      GROUP BY verdict
      ORDER BY count DESC
    `)
    .all();

  const topics = db
    .prepare(`
      SELECT topic, COUNT(*) AS count
      FROM resolutions
      WHERE status = 'closed'
      GROUP BY topic
      ORDER BY count DESC
    `)
    .all();

  const delegates = db
    .prepare(`
      SELECT
        dm.display_name AS name,
        dm.provider,
        COUNT(*) AS count
      FROM delegate_votes dv
      JOIN delegate_models dm ON dm.id = dv.model_id
      GROUP BY dv.model_id
      ORDER BY count DESC
      LIMIT 20
    `)
    .all();

  return { verdicts, topics, delegates };
}

function getUserStats(userId, period = "all_time") {
  const start = periodStart(period);
  const params = [userId];
  const dateFilter = start ? `AND hv.created_at >= ?` : "";
  if (start) {
    params.push(start);
  }

  const submissionsFilter = start ? `AND r.created_at >= ?` : "";
  const submissionsParams = [userId];
  if (start) {
    submissionsParams.push(start);
  }

  const submissions = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM resolutions r
      WHERE r.author_user_id = ?
        AND r.status != 'draft'
        ${submissionsFilter}
    `)
    .get(...submissionsParams).count;

  const voteSummary = db
    .prepare(`
      SELECT
        COUNT(*) AS totalVotes,
        SUM(CASE WHEN hv.vote = d.verdict THEN 1 ELSE 0 END) AS alignedVotes
      FROM human_votes hv
      JOIN debates d ON d.id = hv.debate_id
      WHERE hv.user_id = ?
      ${dateFilter}
    `)
    .get(...params);

  const totalVotes = voteSummary.totalVotes || 0;
  const alignedVotes = voteSummary.alignedVotes || 0;
  const alignmentPct = totalVotes ? Math.round((alignedVotes / totalVotes) * 100) : 0;

  const activityBonus = Math.min(30, submissions * 4 + totalVotes * 2);
  const alignmentScore = Math.round(alignmentPct * 0.7 + activityBonus);

  let title = "Junior Petitioner";
  if (alignmentScore >= 90 && submissions >= 8) {
    title = "Grand Envoy";
  } else if (alignmentScore >= 75 && submissions >= 5) {
    title = "High Councillor";
  } else if (alignmentScore >= 60 && submissions >= 3) {
    title = "Senior Petitioner";
  }

  return {
    submissions,
    totalVotes,
    alignedVotes,
    alignmentPct,
    alignmentScore,
    title,
  };
}

function computeLeaderboard(period = "weekly", limit = 100) {
  const users = db.prepare(`SELECT id, handle, display_name AS displayName FROM users`).all();

  const rows = users
    .map((user) => {
      const stats = getUserStats(user.id, period);
      return {
        userId: user.id,
        handle: user.handle,
        displayName: user.displayName,
        alignmentScore: stats.alignmentScore,
        alignmentPct: stats.alignmentPct,
        submissions: stats.submissions,
        totalVotes: stats.totalVotes,
        alignedVotes: stats.alignedVotes,
        title: stats.title,
      };
    })
    .filter((row) => row.submissions > 0 || row.totalVotes > 0)
    .sort((a, b) => {
      if (b.alignmentScore !== a.alignmentScore) return b.alignmentScore - a.alignmentScore;
      if (b.alignedVotes !== a.alignedVotes) return b.alignedVotes - a.alignedVotes;
      return b.submissions - a.submissions;
    })
    .slice(0, limit)
    .map((row, idx) => ({ ...row, rank: idx + 1 }));

  return rows;
}

function persistLeaderboardSnapshot(period = "weekly") {
  const snapshotId = randomUUID();
  const timestamp = nowIso();
  const rows = computeLeaderboard(period, 100);

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO leaderboard_snapshots (id, period, created_at) VALUES (?, ?, ?)`).run(snapshotId, period, timestamp);

    const insertEntry = db.prepare(`
      INSERT INTO leaderboard_entries (
        snapshot_id, rank, user_id, alignment_score, submissions, correct_votes, total_votes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      insertEntry.run(
        snapshotId,
        row.rank,
        row.userId,
        row.alignmentScore,
        row.submissions,
        row.alignedVotes,
        row.totalVotes,
      );
    }
  });

  tx();
  return { snapshotId, period, createdAt: timestamp, rows };
}

async function bootstrapFromLegacyArchive() {
  const existingClosedCount = db.prepare(`SELECT COUNT(*) AS count FROM debates`).get().count;
  if (existingClosedCount > 0) {
    return;
  }

  try {
    const raw = await fsp.readFile(JSON_ARCHIVE_FILE, "utf8");
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || !items.length) {
      return;
    }

    for (const item of items) {
      const author = getUserByIdStmt.get(DEFAULT_USER_ID);
      const resolutionId = randomUUID();
      const createdAt = item.createdAt || nowIso();
      const updatedAt = createdAt;
      const topic = inferTopic(item.title || "", item.resolution || "");

      db.prepare(`
        INSERT INTO resolutions (id, author_user_id, title, body, topic, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'closed', ?, ?)
      `).run(resolutionId, author.id, item.title || "Untitled", item.resolution || "", topic, createdAt, updatedAt);

      const debateId = item.id || randomUUID();
      db.prepare(`
        INSERT INTO debates (
          id, resolution_id, status, verdict, intelligent_votes, idiotic_votes, total_votes,
          intelligent_pct, idiotic_pct, created_at, updated_at
        ) VALUES (?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        debateId,
        resolutionId,
        item.consensus?.verdict || "Intelligent",
        item.consensus?.intelligentVotes || 0,
        item.consensus?.idioticVotes || 0,
        item.consensus?.totalVotes || 0,
        item.consensus?.intelligentPct || 50,
        item.consensus?.idioticPct || 50,
        createdAt,
        updatedAt,
      );
    }
  } catch {
    // ignore bootstrap failures
  }
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

app.use(async (_req, _res, next) => {
  try {
    await syncDelegates(20);
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/v1/health", (_req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    dbPath: DB_PATH,
    openrouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
  });
});

app.get("/v1/delegates/eligible", async (req, res, next) => {
  try {
    const limit = clamp(Number(req.query.limit) || 10, 1, 50);
    const delegates = await syncDelegates(limit);
    res.json({
      source: OPENROUTER_RANKINGS_URL,
      updatedAt: nowIso(),
      delegates,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/live/hero", (_req, res) => {
  const latest = db
    .prepare(`
      SELECT d.id AS debateId
      FROM debates d
      ORDER BY d.created_at DESC
      LIMIT 1
    `)
    .get();

  if (!latest) {
    res.json({ debate: null });
    return;
  }

  const debate = getDebateById(latest.debateId);
  const delegates = getDelegates(6);

  res.json({ debate, delegates });
});

app.get("/v1/live/arguments", (req, res) => {
  const limit = clamp(Number(req.query.limit) || 20, 1, 100);

  const latest = db
    .prepare(`
      SELECT id
      FROM debates
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get();

  if (!latest) {
    res.json({ items: [] });
    return;
  }

  const items = db
    .prepare(`
      SELECT
        id,
        actor_type AS actorType,
        actor_id AS actorId,
        actor_name AS actorName,
        stance,
        content,
        confidence,
        created_at AS createdAt
      FROM debate_messages
      WHERE debate_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(latest.id, limit);

  res.json({ items });
});

app.get("/v1/live/consensus", (_req, res) => {
  const row = db
    .prepare(`
      SELECT
        id,
        verdict,
        intelligent_votes AS intelligentVotes,
        idiotic_votes AS idioticVotes,
        total_votes AS totalVotes,
        intelligent_pct AS intelligentPct,
        idiotic_pct AS idioticPct,
        status,
        updated_at AS updatedAt
      FROM debates
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get();

  res.json({ consensus: row || null });
});

app.get("/v1/live/delegates", (req, res) => {
  const limit = clamp(Number(req.query.limit) || 10, 1, 50);
  res.json({ delegates: getDelegates(limit) });
});

app.get("/v1/live/trending", (req, res) => {
  const limit = clamp(Number(req.query.limit) || 8, 1, 30);
  const items = listArchive({ limit, offset: 0 });
  res.json({ items });
});

app.post("/v1/drafts", (req, res) => {
  const user = getCurrentUser(req);
  const title = String(req.body?.title || "").trim();
  const body = String(req.body?.body || req.body?.resolution || "").trim();

  if (!title || !body) {
    res.status(400).json({ error: "title and body are required" });
    return;
  }

  const topic = String(req.body?.topic || inferTopic(title, body));
  const draft = createDraft({ userId: user.id, title, body, topic });

  res.status(201).json({
    draft: {
      id: draft.id,
      authorUserId: draft.author_user_id,
      title: draft.title,
      body: draft.body,
      topic: draft.topic,
      status: draft.status,
      createdAt: draft.created_at,
      updatedAt: draft.updated_at,
    },
  });
});

app.put("/v1/drafts/:id", (req, res) => {
  const user = getCurrentUser(req);
  const draftId = req.params.id;
  const title = String(req.body?.title || "").trim();
  const body = String(req.body?.body || req.body?.resolution || "").trim();

  if (!title || !body) {
    res.status(400).json({ error: "title and body are required" });
    return;
  }

  const topic = String(req.body?.topic || inferTopic(title, body));

  try {
    const updated = updateDraft({ draftId, userId: user.id, title, body, topic });
    if (!updated) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }

    res.json({
      draft: {
        id: updated.id,
        authorUserId: updated.author_user_id,
        title: updated.title,
        body: updated.body,
        topic: updated.topic,
        status: updated.status,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      },
    });
  } catch (error) {
    if (error.code === "FORBIDDEN") {
      res.status(403).json({ error: error.message });
      return;
    }
    throw error;
  }
});

app.get("/v1/drafts/:id", (req, res) => {
  const user = getCurrentUser(req);
  const draft = db.prepare(`SELECT * FROM resolutions WHERE id = ? AND status = 'draft'`).get(req.params.id);

  if (!draft) {
    res.status(404).json({ error: "Draft not found" });
    return;
  }

  if (draft.author_user_id !== user.id) {
    res.status(403).json({ error: "Not allowed" });
    return;
  }

  res.json({
    draft: {
      id: draft.id,
      authorUserId: draft.author_user_id,
      title: draft.title,
      body: draft.body,
      topic: draft.topic,
      status: draft.status,
      createdAt: draft.created_at,
      updatedAt: draft.updated_at,
    },
  });
});

async function submitResolutionPayload({ user, title, body, topic, delegateIds, userVote }) {
  const resolutionId = randomUUID();
  const timestamp = nowIso();

  db.prepare(`
    INSERT INTO resolutions (id, author_user_id, title, body, topic, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?)
  `).run(resolutionId, user.id, title, body, topic, timestamp, timestamp);

  const pickInsert = db.prepare(`
    INSERT OR IGNORE INTO resolution_delegate_picks (resolution_id, model_id, created_at)
    VALUES (?, ?, ?)
  `);
  for (const modelId of delegateIds) {
    pickInsert.run(resolutionId, modelId, timestamp);
  }

  const debate = await runDebateForResolution({
    resolutionId,
    title,
    body,
    delegateIds,
  });

  if (userVote) {
    const vote = normalizeVote(userVote);
    db.prepare(`
      INSERT INTO human_votes (id, debate_id, user_id, vote, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(debate_id, user_id) DO UPDATE SET
        vote = excluded.vote,
        created_at = excluded.created_at
    `).run(randomUUID(), debate.id, user.id, vote, nowIso());
  }

  persistLeaderboardSnapshot("weekly");
  persistLeaderboardSnapshot("monthly");
  persistLeaderboardSnapshot("all_time");

  return debate;
}

app.post("/v1/resolutions/submit", async (req, res, next) => {
  try {
    const user = getCurrentUser(req);
    const title = String(req.body?.title || "").trim();
    const body = String(req.body?.body || req.body?.resolution || "").trim();

    if (!title || !body) {
      res.status(400).json({ error: "title and body are required" });
      return;
    }

    const topic = String(req.body?.topic || inferTopic(title, body));
    const delegateIds = pickDelegates(req.body?.delegates, 4);

    const debate = await submitResolutionPayload({
      user,
      title,
      body,
      topic,
      delegateIds,
      userVote: req.body?.userVote || null,
    });

    res.status(201).json(debate);
  } catch (error) {
    next(error);
  }
});

app.get("/v1/debates/:id", (req, res) => {
  const debate = getDebateById(req.params.id);
  if (!debate) {
    res.status(404).json({ error: "Debate not found" });
    return;
  }
  res.json(debate);
});

app.get("/v1/debates/:id/messages", (req, res) => {
  const limit = clamp(Number(req.query.limit) || 100, 1, 500);
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const items = db
    .prepare(`
      SELECT
        id,
        actor_type AS actorType,
        actor_id AS actorId,
        actor_name AS actorName,
        stance,
        content,
        confidence,
        created_at AS createdAt
      FROM debate_messages
      WHERE debate_id = ?
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `)
    .all(req.params.id, limit, offset);

  res.json({ items, limit, offset });
});

app.post("/v1/debates/:id/human-vote", (req, res) => {
  const user = getCurrentUser(req);
  const debateId = req.params.id;
  const debate = db.prepare(`SELECT id, verdict FROM debates WHERE id = ?`).get(debateId);

  if (!debate) {
    res.status(404).json({ error: "Debate not found" });
    return;
  }

  const vote = normalizeVote(req.body?.vote);
  const timestamp = nowIso();

  db.prepare(`
    INSERT INTO human_votes (id, debate_id, user_id, vote, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(debate_id, user_id) DO UPDATE SET
      vote = excluded.vote,
      created_at = excluded.created_at
  `).run(randomUUID(), debateId, user.id, vote, timestamp);

  const aligned = vote === debate.verdict;

  emitDebateEvent(debateId, "human_vote", {
    userId: user.id,
    vote,
    aligned,
  });

  persistLeaderboardSnapshot("weekly");
  persistLeaderboardSnapshot("monthly");
  persistLeaderboardSnapshot("all_time");

  res.status(201).json({
    debateId,
    userId: user.id,
    vote,
    aligned,
    createdAt: timestamp,
  });
});

app.post("/v1/debates/:id/human-argument", (req, res) => {
  const user = getCurrentUser(req);
  const debateId = req.params.id;
  const content = String(req.body?.content || "").trim();
  const stanceInput = String(req.body?.stance || "neutral").trim().toLowerCase();
  const stance = ["intelligent", "idiotic", "neutral"].includes(stanceInput) ? stanceInput : "neutral";

  const exists = db.prepare(`SELECT id FROM debates WHERE id = ?`).get(debateId);
  if (!exists) {
    res.status(404).json({ error: "Debate not found" });
    return;
  }

  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const id = randomUUID();
  const createdAt = nowIso();

  db.prepare(`
    INSERT INTO human_arguments (id, debate_id, user_id, stance, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, debateId, user.id, stance, content, createdAt);

  db.prepare(`
    INSERT INTO debate_messages (id, debate_id, actor_type, actor_id, actor_name, stance, content, confidence, created_at)
    VALUES (?, ?, 'human', ?, ?, ?, ?, NULL, ?)
  `).run(randomUUID(), debateId, user.id, user.display_name, stance, content, createdAt);

  const payload = {
    id,
    debateId,
    userId: user.id,
    userName: user.display_name,
    stance,
    content,
    createdAt,
  };

  emitDebateEvent(debateId, "human_argument", payload);

  res.status(201).json(payload);
});

app.get("/v1/debates/:id/consensus", (req, res) => {
  const row = db
    .prepare(`
      SELECT
        id AS debateId,
        verdict,
        intelligent_votes AS intelligentVotes,
        idiotic_votes AS idioticVotes,
        total_votes AS totalVotes,
        intelligent_pct AS intelligentPct,
        idiotic_pct AS idioticPct,
        status,
        updated_at AS updatedAt
      FROM debates
      WHERE id = ?
    `)
    .get(req.params.id);

  if (!row) {
    res.status(404).json({ error: "Debate not found" });
    return;
  }

  res.json(row);
});

app.get("/v1/debates/:id/stream", (req, res) => {
  const debateId = req.params.id;

  const exists = db.prepare(`SELECT id FROM debates WHERE id = ?`).get(debateId);
  if (!exists) {
    res.status(404).json({ error: "Debate not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (eventName, data) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("connected", { debateId, at: nowIso() });

  const listener = (event) => {
    send(event.type, event);
  };

  const keepAlive = setInterval(() => {
    send("ping", { at: nowIso() });
  }, 15000);

  runtime.streamBus.on(`debate:${debateId}`, listener);

  req.on("close", () => {
    clearInterval(keepAlive);
    runtime.streamBus.off(`debate:${debateId}`, listener);
  });
});

app.get("/v1/archive", (req, res) => {
  const limit = clamp(Number(req.query.limit) || 20, 1, 100);
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const items = listArchive({
    verdict: req.query.verdict ? String(req.query.verdict) : null,
    topic: req.query.topic ? String(req.query.topic) : null,
    delegate: req.query.delegate ? String(req.query.delegate) : null,
    q: req.query.q ? String(req.query.q) : null,
    dateFrom: req.query.date_from ? String(req.query.date_from) : null,
    dateTo: req.query.date_to ? String(req.query.date_to) : null,
    limit,
    offset,
  });

  res.json({ items, limit, offset });
});

app.get("/v1/archive/facets", (_req, res) => {
  res.json(getArchiveFacets());
});

app.get("/v1/archive/:id", (req, res) => {
  const debate = getDebateById(req.params.id);
  if (!debate) {
    res.status(404).json({ error: "Archive item not found" });
    return;
  }
  res.json(debate);
});

app.get("/v1/archive/:id/transcript", (req, res) => {
  const items = db
    .prepare(`
      SELECT
        id,
        actor_type AS actorType,
        actor_id AS actorId,
        actor_name AS actorName,
        stance,
        content,
        confidence,
        created_at AS createdAt
      FROM debate_messages
      WHERE debate_id = ?
      ORDER BY created_at ASC
    `)
    .all(req.params.id);

  res.json({ items });
});

app.get("/v1/archive/:id/votes", (req, res) => {
  const delegateVotes = db
    .prepare(`
      SELECT
        dv.id,
        dv.model_id AS modelId,
        dm.display_name AS displayName,
        dm.provider,
        dv.vote,
        dv.confidence,
        dv.created_at AS createdAt,
        dv.error
      FROM delegate_votes dv
      LEFT JOIN delegate_models dm ON dm.id = dv.model_id
      WHERE dv.debate_id = ?
      ORDER BY dv.created_at ASC
    `)
    .all(req.params.id);

  const humanVotes = db
    .prepare(`
      SELECT
        hv.id,
        hv.user_id AS userId,
        u.display_name AS userName,
        hv.vote,
        hv.created_at AS createdAt
      FROM human_votes hv
      JOIN users u ON u.id = hv.user_id
      WHERE hv.debate_id = ?
      ORDER BY hv.created_at ASC
    `)
    .all(req.params.id);

  res.json({ delegateVotes, humanVotes });
});

app.get("/v1/me/profile", (req, res) => {
  const user = getCurrentUser(req);
  const stats = getUserStats(user.id, "all_time");

  res.json({
    user: {
      id: user.id,
      handle: user.handle,
      displayName: user.display_name,
      role: user.role,
    },
    stats,
  });
});

app.get("/v1/me/submissions", (req, res) => {
  const user = getCurrentUser(req);
  const limit = clamp(Number(req.query.limit) || 30, 1, 100);

  const items = db
    .prepare(`
      SELECT
        r.id,
        r.title,
        r.body,
        r.topic,
        r.status,
        r.created_at AS createdAt,
        r.updated_at AS updatedAt,
        d.id AS debateId,
        d.verdict,
        d.total_votes AS totalVotes,
        d.intelligent_pct AS intelligentPct,
        d.idiotic_pct AS idioticPct
      FROM resolutions r
      LEFT JOIN debates d ON d.resolution_id = r.id
      WHERE r.author_user_id = ?
      ORDER BY r.created_at DESC
      LIMIT ?
    `)
    .all(user.id, limit);

  res.json({ items });
});

app.get("/v1/me/votes", (req, res) => {
  const user = getCurrentUser(req);
  const limit = clamp(Number(req.query.limit) || 100, 1, 200);

  const items = db
    .prepare(`
      SELECT
        hv.id,
        hv.vote,
        hv.created_at AS createdAt,
        d.id AS debateId,
        d.verdict,
        d.total_votes AS totalVotes,
        r.title
      FROM human_votes hv
      JOIN debates d ON d.id = hv.debate_id
      JOIN resolutions r ON r.id = d.resolution_id
      WHERE hv.user_id = ?
      ORDER BY hv.created_at DESC
      LIMIT ?
    `)
    .all(user.id, limit)
    .map((row) => ({
      ...row,
      aligned: row.vote === row.verdict,
    }));

  res.json({ items });
});

app.get("/v1/me/alignment", (req, res) => {
  const user = getCurrentUser(req);
  const stats = getUserStats(user.id, "all_time");
  const weekly = getUserStats(user.id, "weekly");
  const monthly = getUserStats(user.id, "monthly");

  res.json({
    allTime: stats,
    weekly,
    monthly,
  });
});

app.get("/v1/me/stats", (req, res) => {
  const user = getCurrentUser(req);

  const timeline = db
    .prepare(`
      SELECT
        substr(hv.created_at, 1, 10) AS day,
        COUNT(*) AS totalVotes,
        SUM(CASE WHEN hv.vote = d.verdict THEN 1 ELSE 0 END) AS alignedVotes
      FROM human_votes hv
      JOIN debates d ON d.id = hv.debate_id
      WHERE hv.user_id = ?
      GROUP BY substr(hv.created_at, 1, 10)
      ORDER BY day DESC
      LIMIT 30
    `)
    .all(user.id)
    .map((row) => ({
      day: row.day,
      totalVotes: row.totalVotes,
      alignedVotes: row.alignedVotes || 0,
      alignmentPct: row.totalVotes ? Math.round(((row.alignedVotes || 0) / row.totalVotes) * 100) : 0,
    }));

  res.json({
    user: {
      id: user.id,
      handle: user.handle,
      displayName: user.display_name,
    },
    summary: getUserStats(user.id, "all_time"),
    timeline,
  });
});

app.get("/v1/leaderboard", (req, res) => {
  const periodRaw = String(req.query.period || "weekly").toLowerCase();
  const period = ["weekly", "monthly", "all_time"].includes(periodRaw) ? periodRaw : "weekly";
  const limit = clamp(Number(req.query.limit) || 100, 1, 200);

  const items = computeLeaderboard(period, limit);
  res.json({ period, items, updatedAt: nowIso() });
});

app.get("/v1/leaderboard/history", (req, res) => {
  const periodRaw = String(req.query.period || "weekly").toLowerCase();
  const period = ["weekly", "monthly", "all_time"].includes(periodRaw) ? periodRaw : "weekly";
  const limit = clamp(Number(req.query.limit) || 12, 1, 100);

  const snapshots = db
    .prepare(`
      SELECT id, period, created_at AS createdAt
      FROM leaderboard_snapshots
      WHERE period = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(period, limit);

  res.json({ snapshots });
});

app.get("/v1/users/:id/rank-history", (req, res) => {
  const userId = req.params.id;

  const rows = db
    .prepare(`
      SELECT
        ls.period,
        ls.created_at AS createdAt,
        le.rank,
        le.alignment_score AS alignmentScore,
        le.submissions,
        le.correct_votes AS correctVotes,
        le.total_votes AS totalVotes
      FROM leaderboard_entries le
      JOIN leaderboard_snapshots ls ON ls.id = le.snapshot_id
      WHERE le.user_id = ?
      ORDER BY ls.created_at DESC
      LIMIT 100
    `)
    .all(userId);

  res.json({ items: rows });
});

// Compatibility API (legacy UI contract)
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    dbPath: DB_PATH,
    openrouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
  });
});

app.get("/api/agents", async (req, res, next) => {
  try {
    const limit = clamp(Number(req.query.limit) || 10, 1, 50);
    const delegates = await syncDelegates(limit);
    const agents = delegates.map((d) => ({
      rank: d.rank,
      id: d.id,
      slug: d.slug,
      displayName: d.displayName,
      provider: d.provider,
      weeklyTokens: d.weeklyTokens,
      weeklyTokensText: d.weeklyTokensText,
      contextLength: d.contextLength,
      promptPrice: d.promptPrice,
      completionPrice: d.completionPrice,
    }));

    res.json({
      source: OPENROUTER_RANKINGS_URL,
      updatedAt: nowIso(),
      agents,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/archive", (req, res) => {
  const items = listArchive({
    limit: clamp(Number(req.query.limit) || 50, 1, 200),
    offset: Math.max(0, Number(req.query.offset) || 0),
  });

  res.json({ items });
});

app.post("/api/debate", async (req, res, next) => {
  try {
    const user = getCurrentUser(req);
    const title = String(req.body?.title || "").trim();
    const body = String(req.body?.resolution || req.body?.body || "").trim();

    if (!title || !body) {
      res.status(400).json({ error: "title and resolution are required" });
      return;
    }

    const topic = String(req.body?.topic || inferTopic(title, body));
    const delegateIds = pickDelegates(req.body?.delegates, 4);

    const debate = await submitResolutionPayload({
      user,
      title,
      body,
      topic,
      delegateIds,
      userVote: req.body?.userVote || null,
    });

    res.status(201).json(debate);
  } catch (error) {
    next(error);
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/assembly", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "assembly.html"));
});

app.get("/propose", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "propose.html"));
});

app.get("/archive", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "archive.html"));
});

app.get("/profile", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "profile.html"));
});

app.get("/leaderboard", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "leaderboard.html"));
});

app.get(/^(?!\/v1\/|\/api\/).*/, (_req, res) => {
  res.redirect("/");
});

app.use((error, _req, res, _next) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("API error", message);
  res.status(500).json({ error: "Internal server error", details: message });
});

async function start() {
  await bootstrapFromLegacyArchive();
  await syncDelegates(20);

  if (!runtime.schedulerHandle && !IS_VERCEL) {
    runtime.schedulerHandle = setInterval(() => {
      try {
        persistLeaderboardSnapshot("weekly");
        persistLeaderboardSnapshot("monthly");
        persistLeaderboardSnapshot("all_time");
      } catch (error) {
        console.error("Leaderboard snapshot job failed", error);
      }
    }, 10 * 60 * 1000);
  }

  const server = app.listen(PORT, () => {
    console.log(`icracy listening on http://localhost:${PORT}`);
  });

  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Failed to start server", error);
    process.exit(1);
  });
}

module.exports = app;
