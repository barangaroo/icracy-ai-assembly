require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const app = express();

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const ARCHIVE_FILE = path.join(DATA_DIR, "archive.json");

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_RANKINGS_URL = "https://openrouter.ai/rankings";
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || `http://localhost:${PORT}`;
const OPENROUTER_SITE_NAME = process.env.OPENROUTER_SITE_NAME || "icracy.com";

const CACHE_TTL_MS = 10 * 60 * 1000;
const MODELS_TTL_MS = 10 * 60 * 1000;

const runtimeCache = {
  agents: {
    expiresAt: 0,
    data: [],
  },
  models: {
    expiresAt: 0,
    data: [],
  },
};

const runtimeState = {
  archiveInMemory: null,
  dataReadyPromise: null,
};

app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));
app.use(async (_req, _res, next) => {
  await ensureDataFiles();
  next();
});

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
  const unit = match[2];
  const multipliers = {
    K: 1e3,
    M: 1e6,
    B: 1e9,
    T: 1e12,
  };

  return amount * multipliers[unit];
}

function normalizeDelegateVote(vote) {
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
    // Continue to bracket extraction.
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
  const fallbackArgument = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim();

  const parsed = maybeParseJsonObject(rawText);
  if (parsed && typeof parsed === "object") {
    const vote = normalizeDelegateVote(parsed.vote || parsed.verdict);
    const confidence = clamp(Number(parsed.confidence) || 55, 1, 100);
    const argument = String(parsed.argument || parsed.reasoning || fallbackArgument || "No argument returned.").trim();
    const rebuttal = String(parsed.rebuttal || parsed.counterpoint || "").trim();

    return {
      vote,
      confidence,
      argument,
      rebuttal,
    };
  }

  const voteMatch = fallbackArgument.match(/\b(Intelligent|Idiotic)\b/i);
  const confidenceMatch = fallbackArgument.match(/\b(\d{1,3})\s*%/);

  return {
    vote: normalizeDelegateVote(voteMatch ? voteMatch[1] : "Intelligent"),
    confidence: clamp(Number(confidenceMatch ? confidenceMatch[1] : 55), 1, 100),
    argument: fallbackArgument || "No argument returned.",
    rebuttal: "",
  };
}

function buildDelegatePrompt(title, resolution) {
  return [
    {
      role: "system",
      content:
        "You are an AI delegate in a UN-style assembly. You must evaluate the proposal and decide whether it is Intelligent or Idiotic. Reply with strict JSON only.",
    },
    {
      role: "user",
      content: [
        "Evaluate this resolution:",
        `Title: ${title}`,
        `Resolution: ${resolution}`,
        "",
        "Return JSON in exactly this shape:",
        '{"vote":"Intelligent|Idiotic","confidence":0-100,"argument":"2-4 sentence argument","rebuttal":"1 sentence likely counterargument"}',
      ].join("\n"),
    },
  ];
}

function computeConsensus(delegateResults) {
  const successful = delegateResults.filter((item) => !item.error);

  let intelligentVotes = 0;
  let idioticVotes = 0;
  let intelligentWeight = 0;
  let idioticWeight = 0;

  for (const result of successful) {
    if (result.vote === "Idiotic") {
      idioticVotes += 1;
      idioticWeight += result.confidence;
    } else {
      intelligentVotes += 1;
      intelligentWeight += result.confidence;
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

  return {
    verdict,
    intelligentVotes,
    idioticVotes,
    totalVotes,
    intelligentPct,
    idioticPct: 100 - intelligentPct,
  };
}

function extractRankedModelRows(html, limit) {
  // OpenRouter rankings page renders model rows with author/model href + abbreviated token totals.
  const rowRegex = /href="\/([^"?#]+\/[^"?#]+)">([^<]+)<\/a>[\s\S]*?<div>([0-9]+(?:\.[0-9]+)?[KMBT])<!-- --> tokens<\/div>/g;
  const seen = new Set();
  const rows = [];

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const slug = match[1].trim();
    const displayName = match[2].trim();
    const tokenText = match[3].trim();

    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    rows.push({
      slug,
      displayName,
      tokenText,
      tokenValue: parseAbbreviatedTokens(tokenText),
      rank: rows.length + 1,
    });

    if (rows.length >= limit) {
      break;
    }
  }

  return rows;
}

async function readArchive() {
  if (Array.isArray(runtimeState.archiveInMemory)) {
    return [...runtimeState.archiveInMemory];
  }

  try {
    const content = await fs.readFile(ARCHIVE_FILE, "utf8");
    const parsed = JSON.parse(content);
    const normalized = Array.isArray(parsed) ? parsed : [];
    runtimeState.archiveInMemory = [...normalized];
    return normalized;
  } catch {
    return Array.isArray(runtimeState.archiveInMemory) ? [...runtimeState.archiveInMemory] : [];
  }
}

async function writeArchive(items) {
  const normalized = Array.isArray(items) ? items : [];
  runtimeState.archiveInMemory = [...normalized];

  try {
    await fs.writeFile(ARCHIVE_FILE, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  } catch {
    // Serverless targets may have read-only filesystems; keep in-memory archive instead.
  }
}

async function appendArchive(item) {
  const archive = await readArchive();
  archive.push(item);
  await writeArchive(archive);
}

async function fetchModelCatalog() {
  const now = Date.now();
  if (runtimeCache.models.expiresAt > now && runtimeCache.models.data.length) {
    return runtimeCache.models.data;
  }

  const response = await fetch(`${OPENROUTER_API_BASE}/models`);
  if (!response.ok) {
    throw new Error(`Failed to load OpenRouter models: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const models = Array.isArray(payload?.data) ? payload.data : [];

  runtimeCache.models = {
    expiresAt: now + MODELS_TTL_MS,
    data: models,
  };

  return models;
}

function buildFallbackAgents(models, limit) {
  return models.slice(0, limit).map((model, index) => ({
    rank: index + 1,
    id: model.id,
    slug: model.id,
    displayName: model.name || model.id,
    provider: model.id.split("/")[0] || "unknown",
    weeklyTokens: null,
    weeklyTokensText: "n/a",
    description: model.description || "",
    contextLength: model.context_length || null,
    promptPrice: model.pricing?.prompt || null,
    completionPrice: model.pricing?.completion || null,
  }));
}

async function fetchLeaderboardAgents(limit = 10) {
  const boundedLimit = clamp(Number(limit) || 10, 1, 20);
  const now = Date.now();

  if (runtimeCache.agents.expiresAt > now && runtimeCache.agents.data.length >= boundedLimit) {
    return runtimeCache.agents.data.slice(0, boundedLimit);
  }

  const models = await fetchModelCatalog();
  const modelMap = new Map();

  for (const model of models) {
    modelMap.set(model.id, model);
    if (model.id.endsWith(":free")) {
      modelMap.set(model.id.replace(/:free$/, ""), model);
    }
  }

  let rankedRows = [];

  try {
    const rankingsResponse = await fetch(OPENROUTER_RANKINGS_URL);
    if (!rankingsResponse.ok) {
      throw new Error(`HTTP ${rankingsResponse.status}`);
    }

    const html = await rankingsResponse.text();
    rankedRows = extractRankedModelRows(html, boundedLimit);
  } catch {
    rankedRows = [];
  }

  let agents;
  if (rankedRows.length) {
    agents = rankedRows.map((row) => {
      const model = modelMap.get(row.slug) || modelMap.get(row.slug.replace(/:free$/, ""));
      const resolvedId = model?.id || row.slug;
      const provider = (resolvedId.split("/")[0] || "unknown").trim();

      return {
        rank: row.rank,
        id: resolvedId,
        slug: row.slug,
        displayName: model?.name || row.displayName,
        provider,
        weeklyTokens: row.tokenValue,
        weeklyTokensText: row.tokenText,
        description: model?.description || "",
        contextLength: model?.context_length || null,
        promptPrice: model?.pricing?.prompt || null,
        completionPrice: model?.pricing?.completion || null,
      };
    });
  } else {
    agents = buildFallbackAgents(models, boundedLimit);
  }

  runtimeCache.agents = {
    expiresAt: now + CACHE_TTL_MS,
    data: agents,
  };

  return agents.slice(0, boundedLimit);
}

async function runDelegateDebate(modelId, title, resolution) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
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
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/agents", async (req, res) => {
  const limit = clamp(Number(req.query.limit) || 10, 1, 20);

  try {
    const agents = await fetchLeaderboardAgents(limit);
    res.json({
      source: OPENROUTER_RANKINGS_URL,
      updatedAt: new Date().toISOString(),
      agents,
    });
  } catch (error) {
    res.status(502).json({
      error: "Unable to fetch leaderboard agents",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/archive", async (_req, res) => {
  const items = await readArchive();
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ items });
});

app.post("/api/debate", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  const resolution = String(req.body?.resolution || "").trim();
  const userVote = req.body?.userVote ? normalizeDelegateVote(req.body.userVote) : null;

  if (!title || !resolution) {
    res.status(400).json({ error: "title and resolution are required" });
    return;
  }

  if (!process.env.OPENROUTER_API_KEY) {
    res.status(400).json({
      error: "OPENROUTER_API_KEY is required to run debates",
    });
    return;
  }

  let requestedDelegates = Array.isArray(req.body?.delegates)
    ? req.body.delegates.map((d) => String(d).trim()).filter(Boolean)
    : [];

  if (!requestedDelegates.length) {
    const fallbackAgents = await fetchLeaderboardAgents(4);
    requestedDelegates = fallbackAgents.map((agent) => agent.id);
  }

  requestedDelegates = requestedDelegates.slice(0, 6);

  const agentList = await fetchLeaderboardAgents(20);
  const agentById = new Map(agentList.map((agent) => [agent.id, agent]));

  const settled = await Promise.allSettled(
    requestedDelegates.map((modelId) => runDelegateDebate(modelId, title, resolution)),
  );

  const delegateResults = [];

  settled.forEach((result, index) => {
    const modelId = requestedDelegates[index];
    const metadata = agentById.get(modelId);

    if (result.status === "fulfilled") {
      delegateResults.push({
        ...result.value,
        displayName: metadata?.displayName || modelId,
        provider: metadata?.provider || modelId.split("/")[0] || "unknown",
      });
    } else {
      delegateResults.push({
        modelId,
        displayName: metadata?.displayName || modelId,
        provider: metadata?.provider || modelId.split("/")[0] || "unknown",
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  const successfulResults = delegateResults.filter((item) => !item.error);
  if (!successfulResults.length) {
    res.status(502).json({
      error: "All delegate calls failed",
      delegateResults,
    });
    return;
  }

  const consensus = computeConsensus(delegateResults);

  const record = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    title,
    resolution,
    requestedDelegates,
    delegateResults,
    consensus,
    userVote,
    userAligned: userVote ? userVote === consensus.verdict : null,
  };

  await appendArchive(record);

  res.status(201).json(record);
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

app.get(/^(?!\/api).*/, (_req, res) => {
  res.redirect("/");
});

async function ensureDataFiles() {
  if (runtimeState.dataReadyPromise) {
    return runtimeState.dataReadyPromise;
  }

  runtimeState.dataReadyPromise = (async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });

      try {
        await fs.access(ARCHIVE_FILE);
      } catch {
        await fs.writeFile(ARCHIVE_FILE, "[]\n", "utf8");
      }
    } catch {
      if (!Array.isArray(runtimeState.archiveInMemory)) {
        runtimeState.archiveInMemory = [];
      }
    }
  })();

  return runtimeState.dataReadyPromise;
}

async function start() {
  await ensureDataFiles();

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
