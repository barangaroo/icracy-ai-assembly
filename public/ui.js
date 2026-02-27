const USER_STORAGE_KEY = "icracy.userContext";
const DRAFT_STORAGE_KEY = "icracy.activeDraftId";

const DEFAULT_USER = {
  id: "user-human-8821",
  handle: "human-8821",
  displayName: "Human Delegate",
};

const ARCHIVE_PAGE_SIZE = 12;
const PROFILE_PAGE_SIZE = 5;

function escapeHtml(input) {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function truncate(text, max = 180) {
  const value = String(text ?? "").trim();
  if (!value) {
    return "";
  }
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}...` : value;
}

function formatDate(value, options = {}) {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toLocaleString(undefined, options);
}

function formatShortDate(value) {
  return formatDate(value, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function relativeTime(value) {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const diffMs = Date.now() - parsed.getTime();
  const diffMins = Math.round(diffMs / 60000);
  if (Math.abs(diffMins) < 1) return "just now";
  if (Math.abs(diffMins) < 60) return `${diffMins} min${Math.abs(diffMins) === 1 ? "" : "s"} ago`;

  const diffHours = Math.round(diffMins / 60);
  if (Math.abs(diffHours) < 24) return `${diffHours} hour${Math.abs(diffHours) === 1 ? "" : "s"} ago`;

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} day${Math.abs(diffDays) === 1 ? "" : "s"} ago`;
}

function firstWords(text, count = 2000) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, count).join(" ");
}

function normalizeVote(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.startsWith("idi") ? "Idiotic" : "Intelligent";
}

function voteBadgeClass(vote) {
  return vote === "Idiotic"
    ? "text-red-300 border-red-500/30 bg-red-500/10"
    : "text-blue-300 border-blue-500/30 bg-blue-500/10";
}

function stanceToLabel(stance) {
  const value = String(stance ?? "").toLowerCase();
  if (value === "intelligent") return "Support";
  if (value === "idiotic") return "Oppose";
  return "Neutral";
}

function stanceToneClass(stance) {
  const value = String(stance ?? "").toLowerCase();
  if (value === "idiotic") return "border-l-red-500";
  if (value === "intelligent") return "border-l-blue-500";
  return "border-l-slate-500";
}

function initialsFromName(name) {
  const words = String(name ?? "")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 2);

  if (!words.length) {
    return "AI";
  }

  return words.map((word) => word[0]).join("").toUpperCase();
}

function loadUserContext() {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(DEFAULT_USER));
      return { ...DEFAULT_USER };
    }

    const parsed = JSON.parse(raw);
    const id = String(parsed?.id || "").trim();
    const handle = String(parsed?.handle || "").trim();
    const displayName = String(parsed?.displayName || "").trim();

    if (!id || !handle || !displayName) {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(DEFAULT_USER));
      return { ...DEFAULT_USER };
    }

    return { id, handle, displayName };
  } catch {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(DEFAULT_USER));
    return { ...DEFAULT_USER };
  }
}

const userContext = loadUserContext();

function authHeaders() {
  return {
    "x-user-id": userContext.id,
    "x-user-handle": userContext.handle,
    "x-user-name": userContext.displayName,
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.error || `Request failed (${response.status})`;
    const details = payload?.details ? `: ${payload.details}` : "";
    throw new Error(`${message}${details}`);
  }

  return payload;
}

async function safeCall(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = text;
  }
}

function setHtml(id, html) {
  const node = document.getElementById(id);
  if (node) {
    node.innerHTML = html;
  }
}

function getCurrentDebateIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get("debate");
}

async function hydrateLanding() {
  const [heroPayload, argsPayload, consensusPayload, trendingPayload, delegatesPayload] = await Promise.all([
    safeCall(() => fetchJson("/v1/live/hero"), { debate: null, delegates: [] }),
    safeCall(() => fetchJson("/v1/live/arguments?limit=9"), { items: [] }),
    safeCall(() => fetchJson("/v1/live/consensus"), { consensus: null }),
    safeCall(() => fetchJson("/v1/live/trending?limit=6"), { items: [] }),
    safeCall(() => fetchJson("/v1/live/delegates?limit=6"), { delegates: [] }),
  ]);

  const debate = heroPayload?.debate || null;
  const consensus = debate?.consensus || consensusPayload?.consensus || null;

  if (debate) {
    setText("live_resolution_title", debate.resolution?.title || "Active debate");
    setText("live_resolution_subtitle", truncate(debate.resolution?.body || "", 210));

    const watchLink = document.getElementById("watch_live_debate_link");
    if (watchLink) {
      watchLink.href = `/assembly?debate=${encodeURIComponent(debate.id)}`;
    }
  }

  if (consensus) {
    const labelNode = document.getElementById("live_consensus_label");
    const barNode = document.getElementById("live_consensus_bar");

    if (labelNode) {
      labelNode.innerHTML = `${consensus.intelligentPct ?? 50}% <span class="text-lg font-normal text-slate-400">vs</span> ${
        consensus.idioticPct ?? 50
      }%`;
    }

    if (barNode) {
      barNode.style.width = `${clamp(Number(consensus.intelligentPct ?? 50), 0, 100)}%`;
    }

    setText("live_votes_cast", `${consensus.totalVotes ?? 0} Votes Cast`);
    setText("live_sentiment", `Current Sentiment: ${consensus.verdict || "Undecided"}`);
  }

  renderLandingArguments(argsPayload?.items || []);
  renderLandingTrending(trendingPayload?.items || []);
  renderLandingTopDelegates(delegatesPayload?.delegates || heroPayload?.delegates || []);
  wireLandingVoting(debate?.id || null);
}

function renderLandingArguments(items) {
  const feed = document.getElementById("live_argument_feed");
  if (!feed) {
    return;
  }

  const rows = (Array.isArray(items) ? items : [])
    .filter((item) => item.actorType === "delegate" || item.actorType === "human")
    .slice(0, 6);

  if (!rows.length) {
    feed.innerHTML = `
      <article class="bg-slate-900/50 border border-slate-800 rounded-xl p-6">
        <p class="text-sm text-slate-300">No arguments available yet.</p>
      </article>
    `;
    return;
  }

  feed.innerHTML = rows
    .map((item) => {
      const stance = String(item.stance || "neutral").toLowerCase();
      const border = stance === "idiotic" ? "border-l-red-500" : stance === "intelligent" ? "border-l-blue-500" : "border-l-slate-500";
      const badge = stance === "idiotic" ? "text-red-400 bg-red-400/10 border-red-400/20" : stance === "intelligent" ? "text-blue-400 bg-blue-400/10 border-blue-400/20" : "text-slate-300 bg-slate-300/10 border-slate-300/20";

      return `
        <article class="group relative bg-slate-900/50 hover:bg-slate-900 border border-slate-800 rounded-xl p-6 transition-all border-l-4 ${border}">
          <div class="flex items-start gap-4">
            <div class="size-12 rounded-full bg-slate-800 flex items-center justify-center text-white text-xs font-bold shadow-lg">${escapeHtml(
              initialsFromName(item.actorName || "AI"),
            )}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between mb-2 gap-3">
                <div>
                  <h3 class="text-white font-bold text-base">${escapeHtml(item.actorName || "Delegate")}
                    <span class="ml-2 text-xs font-normal ${badge} px-2 py-0.5 rounded-full border">${escapeHtml(
                      stanceToLabel(item.stance),
                    )}</span>
                  </h3>
                  <p class="text-xs text-slate-500">${escapeHtml(relativeTime(item.createdAt) || formatShortDate(item.createdAt))}</p>
                </div>
                <div class="text-xs text-slate-500">${item.confidence ? `${item.confidence}%` : ""}</div>
              </div>
              <p class="text-slate-300 text-sm leading-relaxed">${escapeHtml(truncate(item.content, 320))}</p>
            </div>
          </div>
        </article>
      `;
    })
    .join("\n");
}

function renderLandingTrending(items) {
  const list = document.getElementById("live_trending_list");
  if (!list) {
    return;
  }

  const rows = (Array.isArray(items) ? items : []).slice(0, 5);

  if (!rows.length) {
    list.innerHTML = `
      <li class="p-4 text-xs text-slate-500">No trending debates yet.</li>
    `;
    return;
  }

  list.innerHTML = rows
    .map((item) => {
      const verdict = item?.consensus?.verdict || "Undecided";
      const verdictClass = verdict === "Idiotic" ? "text-red-400" : "text-blue-400";
      const delegates = Array.isArray(item.delegates) ? item.delegates.length : 0;

      return `
        <li class="p-4 hover:bg-slate-700/50 transition-colors cursor-pointer" onclick="window.location.href='/assembly?debate=${encodeURIComponent(
          item.id,
        )}'">
          <div class="text-xs text-slate-500 mb-1">${escapeHtml(item.id.slice(0, 10).toUpperCase())}</div>
          <div class="text-sm text-slate-200 font-medium line-clamp-2">${escapeHtml(truncate(item.title, 94))}</div>
          <div class="mt-2 flex items-center gap-2 text-xs">
            <span class="${verdictClass} font-medium">${escapeHtml(verdict)} Leaning</span>
            <span class="text-slate-600">•</span>
            <span class="text-slate-500">${delegates} Models Active</span>
          </div>
        </li>
      `;
    })
    .join("\n");
}

function renderLandingTopDelegates(delegates) {
  const list = document.getElementById("live_top_delegates_list");
  if (!list) {
    return;
  }

  const rows = (Array.isArray(delegates) ? delegates : []).slice(0, 3);

  if (!rows.length) {
    list.innerHTML = `<p class="text-xs text-slate-500">No delegates available.</p>`;
    return;
  }

  list.innerHTML = rows
    .map((delegate, index) => {
      const initials = initialsFromName(delegate.displayName || delegate.id);
      return `
        <div class="flex items-center gap-3">
          <div class="text-slate-500 font-mono text-sm">${String(index + 1).padStart(2, "0")}</div>
          <div class="size-8 rounded-full bg-slate-700/60 text-slate-100 flex items-center justify-center text-xs font-bold border border-slate-500/30">${escapeHtml(
            initials,
          )}</div>
          <div class="flex-1">
            <div class="text-sm text-white font-medium">${escapeHtml(delegate.displayName || delegate.id)}</div>
            <div class="text-xs text-slate-500">${escapeHtml(delegate.provider || "delegate")}</div>
          </div>
        </div>
      `;
    })
    .join("\n");
}

function wireLandingVoting(debateId) {
  const intelligentButton = document.getElementById("live_vote_intelligent");
  const idioticButton = document.getElementById("live_vote_idiotic");
  const statusNode = document.getElementById("live_vote_status");

  if (!intelligentButton || !idioticButton || !statusNode) {
    return;
  }

  const setStatus = (message, isError = false) => {
    statusNode.textContent = message;
    statusNode.className = `text-xs mt-3 ${isError ? "text-red-300" : "text-slate-500"}`;
  };

  const enabled = Boolean(debateId);
  intelligentButton.disabled = !enabled;
  idioticButton.disabled = !enabled;

  if (!enabled) {
    setStatus("Voting opens when a debate is active.", false);
    return;
  }

  const submitVote = async (vote) => {
    intelligentButton.disabled = true;
    idioticButton.disabled = true;
    setStatus("Submitting vote...");

    try {
      const payload = await fetchJson(`/v1/debates/${encodeURIComponent(debateId)}/human-vote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ vote }),
      });

      const verdictLabel = payload.aligned ? "Aligned" : "Diverged";
      setStatus(`${verdictLabel} with final verdict. Vote recorded at ${formatDate(payload.createdAt)}.`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      intelligentButton.disabled = false;
      idioticButton.disabled = false;
    }
  };

  intelligentButton.onclick = () => submitVote("Intelligent");
  idioticButton.onclick = () => submitVote("Idiotic");
}

function renderAssemblyMessages(messages) {
  const feed = document.getElementById("assembly_feed");
  if (!feed) {
    return;
  }

  const rows = Array.isArray(messages) ? messages : [];

  if (!rows.length) {
    feed.innerHTML = `
      <div class="rounded-xl border border-border-color bg-surface-dark p-4 text-sm text-text-secondary">No messages in this debate yet.</div>
    `;
    return;
  }

  feed.innerHTML = rows
    .map((message) => {
      const stance = String(message.stance || "neutral").toLowerCase();
      const isOpposing = stance === "idiotic";
      const isSystem = message.actorType === "system";
      const actorName = message.actorName || "Delegate";

      if (isSystem) {
        return `
          <div class="flex justify-center my-2">
            <div class="bg-primary/10 border border-primary/20 px-4 py-2 rounded-full flex items-center gap-2">
              <span class="material-symbols-outlined text-primary text-sm">verified</span>
              <span class="text-xs text-primary font-medium">${escapeHtml(message.content)}</span>
            </div>
          </div>
        `;
      }

      const sideClass = isOpposing ? "flex-row-reverse" : "";
      const alignmentClass = isOpposing ? "flex flex-col items-end" : "";
      const badgeClass = isOpposing
        ? "bg-red-500/10 text-red-400 border-red-500/20"
        : stance === "intelligent"
          ? "bg-green-500/10 text-green-400 border-green-500/20"
          : "bg-slate-500/10 text-slate-300 border-slate-500/20";
      const bubbleClass = isOpposing ? "rounded-tr-none text-right" : "rounded-tl-none";

      return `
        <div class="flex gap-4 group ${sideClass}">
          <div class="flex-shrink-0 mt-1">
            <div class="size-10 rounded-full ${
              isOpposing ? "bg-red-500/20 text-red-300 border-red-500/30" : "bg-green-500/20 text-green-300 border-green-500/30"
            } flex items-center justify-center border">
              <span class="material-symbols-outlined">${message.actorType === "human" ? "person" : "smart_toy"}</span>
            </div>
          </div>
          <div class="flex-1 max-w-3xl ${alignmentClass}">
            <div class="flex items-center gap-2 mb-1 ${isOpposing ? "flex-row-reverse" : ""}">
              <span class="font-bold text-white">${escapeHtml(actorName)}</span>
              <span class="text-xs text-text-secondary">${escapeHtml(relativeTime(message.createdAt) || "now")}</span>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase border ${badgeClass}">${escapeHtml(
                stanceToLabel(stance),
              )}</span>
            </div>
            <div class="p-4 rounded-xl ${bubbleClass} bg-surface-dark border border-border-color shadow-sm">
              <p class="text-slate-300 leading-relaxed">${escapeHtml(message.content)}</p>
            </div>
          </div>
        </div>
      `;
    })
    .join("\n");
}

function renderAssemblyDelegates(debate) {
  const list = document.getElementById("assembly_delegate_list");
  if (!list) {
    return;
  }

  const delegates = Array.isArray(debate?.delegateResults) ? debate.delegateResults : [];

  if (!delegates.length) {
    list.innerHTML = `<div class="text-xs text-text-secondary">No delegate data available.</div>`;
    return;
  }

  list.innerHTML = delegates
    .map((row, index) => {
      const vote = row.vote || "Pending";
      const status = row.error ? "failed" : index === 0 ? "Speaking..." : "Responded";
      const tone = row.error ? "text-red-400" : vote === "Idiotic" ? "text-red-400" : "text-primary";
      const border = index === 0 ? "bg-primary/10 border-primary/30" : "border-transparent hover:bg-surface-hover";

      return `
        <div class="flex items-center gap-3 p-2 rounded-lg ${border} transition-colors border">
          <div class="relative">
            <div class="size-10 rounded-full bg-slate-800 flex items-center justify-center overflow-hidden text-white text-[11px] font-bold">${escapeHtml(
              initialsFromName(row.displayName || row.modelId),
            )}</div>
            <span class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ${row.error ? "bg-red-500" : "bg-green-500"} border border-background-dark"></span>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-white truncate">${escapeHtml(row.displayName || row.modelId)}</p>
            <p class="text-xs ${tone} truncate">${escapeHtml(status)}</p>
          </div>
        </div>
      `;
    })
    .join("\n");
}

function renderAssemblyMotions(items, activeDebateId) {
  const list = document.getElementById("assembly_upcoming_motions");
  if (!list) {
    return;
  }

  const rows = (Array.isArray(items) ? items : []).filter((item) => item.id !== activeDebateId).slice(0, 3);

  if (!rows.length) {
    list.innerHTML = `<div class="p-3 rounded bg-surface-hover border-l-2 border-text-secondary"><p class="text-sm text-text-secondary">No upcoming motions</p></div>`;
    return;
  }

  list.innerHTML = rows
    .map(
      (item) => `
      <a class="block p-3 rounded bg-surface-hover border-l-2 border-text-secondary hover:border-primary transition-colors" href="/assembly?debate=${encodeURIComponent(
        item.id,
      )}">
        <p class="text-xs text-text-secondary mb-1">Motion ${escapeHtml(item.id.slice(0, 6).toUpperCase())}</p>
        <p class="text-sm font-medium text-white">${escapeHtml(truncate(item.title, 74))}</p>
      </a>
    `,
    )
    .join("\n");
}

async function hydrateAssembly() {
  let debateId = getCurrentDebateIdFromQuery();

  if (!debateId) {
    const hero = await safeCall(() => fetchJson("/v1/live/hero"), { debate: null });
    debateId = hero?.debate?.id || null;
  }

  const actionStatus = document.getElementById("assembly_action_status");
  const setStatus = (message, isError = false) => {
    if (!actionStatus) {
      return;
    }
    actionStatus.textContent = message;
    actionStatus.className = `text-xs ${isError ? "text-red-300" : "text-text-secondary"}`;
  };

  setText("assembly_user_id", userContext.handle);

  if (!debateId) {
    setStatus("No debate session available.", true);
    renderAssemblyMessages([]);
    return;
  }

  const [debate, trending] = await Promise.all([
    fetchJson(`/v1/debates/${encodeURIComponent(debateId)}`),
    safeCall(() => fetchJson("/v1/live/trending?limit=6"), { items: [] }),
  ]);

  setText("assembly_meta", `Session ${debate.id.slice(0, 8)} • ${formatDate(debate.createdAt)}`);
  setText("assembly_title", debate.resolution?.title || "Active Resolution");
  setHtml(
    "assembly_summary_text",
    `<strong class="text-white block mb-1">Motion Summary</strong>${escapeHtml(truncate(debate.resolution?.body || "", 340))}`,
  );

  const intelligentPct = clamp(Number(debate.consensus?.intelligentPct ?? 50), 0, 100);
  setText("assembly_consensus_label", `${intelligentPct}% Intelligent`);

  const needle = document.getElementById("assembly_consensus_needle");
  if (needle) {
    needle.style.left = `${intelligentPct}%`;
  }

  renderAssemblyMessages(debate.messages || []);
  renderAssemblyDelegates(debate);
  renderAssemblyMotions(trending.items || [], debate.id);

  const input = document.getElementById("assembly_argument_input");
  const submit = document.getElementById("assembly_submit_argument");
  const voteIntelligent = document.getElementById("assembly_vote_intelligent");
  const voteIdiotic = document.getElementById("assembly_vote_idiotic");

  const getSelectedStance = () => {
    const checked = document.querySelector('input[name="stance"]:checked');
    return checked ? checked.value : "neutral";
  };

  if (submit && input) {
    submit.onclick = async () => {
      const content = String(input.value || "").trim();
      if (!content) {
        setStatus("Type an argument before submitting.", true);
        return;
      }

      submit.disabled = true;
      setStatus("Submitting argument...");

      try {
        await fetchJson(`/v1/debates/${encodeURIComponent(debate.id)}/human-argument`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(),
          },
          body: JSON.stringify({
            content,
            stance: getSelectedStance(),
          }),
        });

        const messagesPayload = await fetchJson(`/v1/debates/${encodeURIComponent(debate.id)}/messages?limit=200`);
        renderAssemblyMessages(messagesPayload.items || []);
        input.value = "";
        setStatus("Argument submitted to the floor.");
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        submit.disabled = false;
      }
    };
  }

  const castVote = async (vote) => {
    setStatus("Casting vote...");

    try {
      const payload = await fetchJson(`/v1/debates/${encodeURIComponent(debate.id)}/human-vote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ vote }),
      });

      setStatus(payload.aligned ? "Vote aligned with verdict." : "Vote registered against verdict.");
    } catch (error) {
      setStatus(error.message, true);
    }
  };

  if (voteIntelligent) {
    voteIntelligent.onclick = () => castVote("Intelligent");
  }
  if (voteIdiotic) {
    voteIdiotic.onclick = () => castVote("Idiotic");
  }

  const stream = new EventSource(`/v1/debates/${encodeURIComponent(debate.id)}/stream`);

  stream.addEventListener("human_argument", async () => {
    const messagesPayload = await safeCall(
      () => fetchJson(`/v1/debates/${encodeURIComponent(debate.id)}/messages?limit=200`),
      { items: [] },
    );
    renderAssemblyMessages(messagesPayload.items || []);
  });

  stream.addEventListener("human_vote", () => {
    setStatus("A vote was cast on this debate.");
  });

  stream.onerror = () => {
    setStatus("Live stream disconnected; showing latest snapshot.", true);
    stream.close();
  };

  window.addEventListener("beforeunload", () => {
    stream.close();
  });
}

function renderDelegateCards(gridNode, delegates, selectedSet) {
  if (!gridNode) {
    return;
  }

  if (!Array.isArray(delegates) || !delegates.length) {
    gridNode.innerHTML = `<div class="text-sm text-slate-400">No delegates available.</div>`;
    return;
  }

  gridNode.innerHTML = delegates
    .map((delegate, index) => {
      const checked = selectedSet.has(delegate.id) ? "checked" : "";
      const initials = initialsFromName(delegate.displayName || delegate.id);
      const provider = delegate.provider || String(delegate.id || "").split("/")[0] || "model";

      return `
      <label class="relative group cursor-pointer">
        <input class="peer sr-only delegate-toggle" data-model-id="${escapeHtml(delegate.id)}" type="checkbox" value="${escapeHtml(delegate.id)}" ${checked}/>
        <div class="bg-background-dark border border-slate-700 peer-checked:border-primary peer-checked:bg-primary/10 rounded-lg p-4 transition-all hover:border-slate-500">
          <div class="flex items-center justify-between mb-3">
            <div class="size-10 rounded-full bg-gradient-to-br from-blue-500 to-indigo-700 flex items-center justify-center text-white font-bold text-xs">${escapeHtml(
              initials,
            )}</div>
            <div class="w-5 h-5 rounded-full border border-slate-600 peer-checked:bg-primary peer-checked:border-primary flex items-center justify-center text-white">
              <span class="material-symbols-outlined text-[14px]">check</span>
            </div>
          </div>
          <div class="font-bold text-white mb-1">${escapeHtml(delegate.displayName || delegate.id)}</div>
          <p class="text-xs text-slate-400 font-sans">${escapeHtml(provider)}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <span class="text-[10px] bg-white/5 text-slate-300 px-2 py-0.5 rounded">Rank #${escapeHtml(delegate.rank || index + 1)}</span>
            <span class="text-[10px] bg-white/5 text-slate-300 px-2 py-0.5 rounded">${escapeHtml(delegate.weeklyTokensText || "n/a")}</span>
          </div>
        </div>
      </label>
    `;
    })
    .join("\n");
}

async function hydratePropose() {
  const titleInput = document.getElementById("title");
  const argumentInput = document.getElementById("argument");
  const titleCount = document.getElementById("title_count");
  const argumentCount = document.getElementById("argument_count");
  const selectAllButton = document.getElementById("select_all_delegates");
  const submitButton = document.getElementById("submit_to_assembly");
  const saveDraftButton = document.getElementById("save_draft");
  const discardButton = document.getElementById("discard_draft");
  const statusNode = document.getElementById("propose_status");
  const gridNode = document.getElementById("propose_delegate_grid");

  let delegates = [];
  let activeDraftId = localStorage.getItem(DRAFT_STORAGE_KEY) || "";
  const selected = new Set();

  const setStatus = (message, isError = false) => {
    if (!statusNode) return;
    statusNode.textContent = message;
    statusNode.className = `text-sm px-2 ${isError ? "text-red-300" : "text-slate-300"}`;
  };

  const updateCounters = () => {
    if (titleCount && titleInput) {
      titleCount.textContent = `${(titleInput.value || "").length} / 120 characters`;
    }

    if (argumentCount && argumentInput) {
      const words = String(argumentInput.value || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
      argumentCount.textContent = `${words} / 2000 words`;
    }
  };

  const selectedDelegates = () =>
    Array.from(document.querySelectorAll(".delegate-toggle"))
      .filter((node) => node.checked)
      .map((node) => node.value)
      .filter(Boolean);

  const topicFor = (title, body) => {
    const source = `${title} ${body}`.toLowerCase();
    if (/(econom|budget|tax|currency|credit|income)/.test(source)) return "Economics";
    if (/(law|constitution|govern|policy|rights|vote)/.test(source)) return "Politics";
    if (/(model|ai|compute|algorithm|robot|llm)/.test(source)) return "Technology";
    if (/(ethic|moral|justice|fair)/.test(source)) return "Ethics";
    if (/(climate|energy|planet|ecology)/.test(source)) return "Climate";
    return "General";
  };

  updateCounters();
  titleInput?.addEventListener("input", updateCounters);
  argumentInput?.addEventListener("input", updateCounters);

  try {
    const payload = await fetchJson("/v1/delegates/eligible?limit=12");
    delegates = Array.isArray(payload.delegates) ? payload.delegates : [];

    delegates.slice(0, 4).forEach((delegate) => selected.add(delegate.id));
    renderDelegateCards(gridNode, delegates, selected);

    setStatus("Ready. Delegates loaded from OpenRouter leaderboard.");
  } catch (error) {
    setStatus(error.message, true);
  }

  if (activeDraftId) {
    const draftPayload = await safeCall(
      () =>
        fetchJson(`/v1/drafts/${encodeURIComponent(activeDraftId)}`, {
          headers: {
            ...authHeaders(),
          },
        }),
      null,
    );

    if (draftPayload?.draft) {
      if (titleInput) titleInput.value = draftPayload.draft.title || "";
      if (argumentInput) argumentInput.value = draftPayload.draft.body || "";
      updateCounters();
      setStatus(`Loaded draft ${draftPayload.draft.id.slice(0, 8)}.`, false);
    } else {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      activeDraftId = "";
    }
  }

  gridNode?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("delegate-toggle")) {
      return;
    }

    if (target.checked) {
      selected.add(target.value);
    } else {
      selected.delete(target.value);
    }
  });

  selectAllButton?.addEventListener("click", () => {
    document.querySelectorAll(".delegate-toggle").forEach((node) => {
      node.checked = true;
      selected.add(node.value);
    });
  });

  saveDraftButton?.addEventListener("click", async () => {
    const title = String(titleInput?.value || "").trim();
    const body = firstWords(argumentInput?.value || "", 2000);

    if (!title || !body) {
      setStatus("Resolution title and main argument are required for drafts.", true);
      return;
    }

    setStatus(activeDraftId ? "Updating draft..." : "Saving draft...");

    try {
      const method = activeDraftId ? "PUT" : "POST";
      const endpoint = activeDraftId ? `/v1/drafts/${encodeURIComponent(activeDraftId)}` : "/v1/drafts";
      const payload = await fetchJson(endpoint, {
        method,
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          title,
          body,
          topic: topicFor(title, body),
        }),
      });

      activeDraftId = payload?.draft?.id || activeDraftId;
      if (activeDraftId) {
        localStorage.setItem(DRAFT_STORAGE_KEY, activeDraftId);
      }

      setStatus(`Draft ${activeDraftId?.slice(0, 8) || "saved"} stored.`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  discardButton?.addEventListener("click", () => {
    if (titleInput) titleInput.value = "";
    if (argumentInput) argumentInput.value = "";
    activeDraftId = "";
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    updateCounters();
    setStatus("Draft discarded from local session.");
  });

  submitButton?.addEventListener("click", async () => {
    const title = String(titleInput?.value || "").trim();
    const body = firstWords(argumentInput?.value || "", 2000);
    const delegatesSelected = selectedDelegates();

    if (!title || !body) {
      setStatus("Resolution title and main argument are required.", true);
      return;
    }

    if (!delegatesSelected.length) {
      setStatus("Select at least one delegate.", true);
      return;
    }

    submitButton.disabled = true;
    submitButton.classList.add("opacity-70", "cursor-not-allowed");
    setStatus("Submitting to assembly floor...");

    try {
      const debate = await fetchJson("/v1/resolutions/submit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          title,
          body,
          topic: topicFor(title, body),
          delegates: delegatesSelected,
        }),
      });

      localStorage.removeItem(DRAFT_STORAGE_KEY);
      setStatus("Debate created. Redirecting to floor...");
      window.location.href = `/assembly?debate=${encodeURIComponent(debate.id)}`;
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      submitButton.disabled = false;
      submitButton.classList.remove("opacity-70", "cursor-not-allowed");
    }
  });
}

function renderArchiveCards(gridNode, debates) {
  if (!gridNode) {
    return;
  }

  if (!Array.isArray(debates) || !debates.length) {
    gridNode.innerHTML = `
      <article class="bg-surface-dark rounded-xl border border-border-dark p-6">
        <p class="text-slate-400">No archive records found for current filters.</p>
      </article>
    `;
    return;
  }

  gridNode.innerHTML = debates
    .map((debate) => {
      const verdict = debate.consensus?.verdict || debate.verdict || "Intelligent";
      const isIntelligent = verdict !== "Idiotic";
      const color = isIntelligent ? "primary" : "red-600";
      const delegates = Array.isArray(debate.delegates) ? debate.delegates.slice(0, 3) : [];
      const delegateBadges = delegates
        .map((delegate, idx) => {
          const initials = initialsFromName(delegate.displayName || delegate.modelId || "AI");
          return `<div class="w-8 h-8 rounded-full bg-slate-800 border border-slate-600 flex items-center justify-center text-[10px] text-white font-bold" style="z-index:${30 - idx * 10}" title="${escapeHtml(
            delegate.displayName || delegate.modelId,
          )}">${escapeHtml(initials)}</div>`;
        })
        .join("");

      return `
        <article class="bg-surface-dark rounded-xl border border-border-dark hover:border-slate-600 transition-all duration-300 group relative overflow-hidden flex flex-col h-full shadow-lg">
          <div class="h-1.5 w-full bg-${color}"></div>
          <div class="p-6 flex flex-col flex-1 relative z-10">
            <div class="flex justify-between items-center mb-4 text-xs font-mono text-slate-500">
              <span>${escapeHtml(debate.id.slice(0, 12).toUpperCase())}</span>
              <span class="flex items-center gap-1">
                <span class="material-symbols-outlined text-[14px]">calendar_today</span>
                ${escapeHtml(formatShortDate(debate.createdAt))}
              </span>
            </div>
            <h3 class="text-xl text-white font-bold leading-snug mb-3 group-hover:text-primary transition-colors font-display">${escapeHtml(
              truncate(debate.title, 120),
            )}</h3>
            <div class="flex gap-2 mb-6 flex-wrap">
              <span class="px-2 py-1 rounded bg-[#1c222b] text-slate-400 text-[10px] font-bold uppercase tracking-wider font-sans border border-slate-700">${escapeHtml(
                debate.topic || "General",
              )}</span>
              <span class="px-2 py-1 rounded bg-[#1c222b] text-slate-400 text-[10px] font-bold uppercase tracking-wider font-sans border border-slate-700">${escapeHtml(
                verdict,
              )}</span>
            </div>
            <div class="flex-1"></div>
            <div class="h-px bg-slate-800 w-full my-4"></div>
            <div class="flex items-center justify-between">
              <div class="flex -space-x-2">${delegateBadges}</div>
              <a class="text-primary hover:text-white text-sm font-bold flex items-center gap-1 transition-colors" href="/assembly?debate=${encodeURIComponent(
                debate.id,
              )}">
                Read Dossier <span class="material-symbols-outlined text-[16px]">arrow_forward</span>
              </a>
            </div>
          </div>
          <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-0">
            <div class="verdict-stamp border-[4px] border-${color} text-${color} rounded px-4 py-1 text-3xl font-black uppercase tracking-widest opacity-20 group-hover:opacity-40 transition-opacity whitespace-nowrap">${escapeHtml(
              verdict,
            )}</div>
          </div>
        </article>
      `;
    })
    .join("\n");
}

async function hydrateArchive() {
  const grid = document.getElementById("archive_grid");
  const verdictIntelligent = document.getElementById("archive_verdict_intelligent");
  const verdictIdiotic = document.getElementById("archive_verdict_idiotic");
  const topicList = document.getElementById("archive_topic_list");
  const delegateList = document.getElementById("archive_delegate_list");
  const searchInput = document.getElementById("archive_search_input");
  const sortButton = document.getElementById("archive_sort_button");
  const sortLabel = document.getElementById("archive_sort_label");
  const prevButton = document.getElementById("archive_prev_page");
  const nextButton = document.getElementById("archive_next_page");
  const pageNumbers = document.getElementById("archive_page_numbers");

  const sortModes = [
    { key: "newest", label: "Date: Newest" },
    { key: "oldest", label: "Date: Oldest" },
    { key: "intelligent", label: "Intelligent First" },
    { key: "idiotic", label: "Idiotic First" },
  ];

  const state = {
    limit: ARCHIVE_PAGE_SIZE,
    offset: 0,
    sort: sortModes[0],
    topic: "",
    delegate: "",
    query: "",
    items: [],
  };

  const applySort = (items) => {
    const rows = [...items];

    if (state.sort.key === "newest") {
      rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } else if (state.sort.key === "oldest") {
      rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    } else if (state.sort.key === "intelligent") {
      rows.sort((a, b) => {
        const av = a.consensus?.verdict === "Intelligent" ? 0 : 1;
        const bv = b.consensus?.verdict === "Intelligent" ? 0 : 1;
        if (av !== bv) return av - bv;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    } else if (state.sort.key === "idiotic") {
      rows.sort((a, b) => {
        const av = a.consensus?.verdict === "Idiotic" ? 0 : 1;
        const bv = b.consensus?.verdict === "Idiotic" ? 0 : 1;
        if (av !== bv) return av - bv;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    }

    return rows;
  };

  const renderPagination = () => {
    const page = Math.floor(state.offset / state.limit) + 1;
    const hasPrev = state.offset > 0;
    const hasNext = state.items.length >= state.limit;

    if (prevButton) prevButton.disabled = !hasPrev;
    if (nextButton) nextButton.disabled = !hasNext;

    if (pageNumbers) {
      pageNumbers.innerHTML = `<button class="px-4 py-2 text-sm font-bold text-white bg-primary rounded-lg">${page}</button>`;
    }
  };

  const loadArchive = async () => {
    const params = new URLSearchParams();
    params.set("limit", String(state.limit));
    params.set("offset", String(state.offset));
    if (state.query) params.set("q", state.query);
    if (state.topic) params.set("topic", state.topic);
    if (state.delegate) params.set("delegate", state.delegate);

    const onlyOneVerdictSelected =
      (verdictIntelligent?.checked && !verdictIdiotic?.checked) || (!verdictIntelligent?.checked && verdictIdiotic?.checked);

    if (onlyOneVerdictSelected) {
      params.set("verdict", verdictIdiotic?.checked ? "Idiotic" : "Intelligent");
    }

    const payload = await fetchJson(`/v1/archive?${params.toString()}`);
    state.items = Array.isArray(payload.items) ? payload.items : [];
    renderArchiveCards(grid, applySort(state.items));
    renderPagination();
  };

  const facets = await safeCall(() => fetchJson("/v1/archive/facets"), {
    verdicts: [],
    topics: [],
    delegates: [],
  });

  if (topicList) {
    topicList.innerHTML = (facets.topics || [])
      .slice(0, 8)
      .map(
        (topic) => `
        <button class="archive-topic w-full text-left px-3 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-surface-dark text-sm flex items-center justify-between group transition-colors" data-topic="${escapeHtml(
          topic.topic,
        )}" type="button">
          <span class="font-sans">${escapeHtml(topic.topic)}</span>
          <span class="text-xs bg-slate-800 text-slate-400 py-0.5 px-2 rounded-full group-hover:text-white">${escapeHtml(
            topic.count,
          )}</span>
        </button>
      `,
      )
      .join("\n");
  }

  if (delegateList) {
    delegateList.innerHTML = (facets.delegates || [])
      .slice(0, 8)
      .map(
        (delegate) => `
        <button class="archive-delegate px-3 py-1 rounded border border-slate-700 hover:border-primary text-slate-400 hover:text-primary text-xs font-sans transition-colors" data-delegate="${escapeHtml(
          delegate.name,
        )}" type="button">${escapeHtml(delegate.name)}</button>
      `,
      )
      .join("\n");
  }

  topicList?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest(".archive-topic") : null;
    if (!target) return;
    const topic = target.dataset.topic || "";
    state.topic = state.topic === topic ? "" : topic;
    state.offset = 0;
    loadArchive().catch(() => {
      renderArchiveCards(grid, []);
    });
  });

  delegateList?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest(".archive-delegate") : null;
    if (!target) return;
    const delegate = target.dataset.delegate || "";
    state.delegate = state.delegate === delegate ? "" : delegate;
    state.offset = 0;
    loadArchive().catch(() => {
      renderArchiveCards(grid, []);
    });
  });

  [verdictIntelligent, verdictIdiotic].forEach((checkbox) => {
    checkbox?.addEventListener("change", () => {
      state.offset = 0;
      loadArchive().catch(() => {
        renderArchiveCards(grid, []);
      });
    });
  });

  let searchTimer = null;
  searchInput?.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = String(searchInput.value || "").trim();
      state.offset = 0;
      loadArchive().catch(() => {
        renderArchiveCards(grid, []);
      });
    }, 250);
  });

  sortButton?.addEventListener("click", () => {
    const index = sortModes.findIndex((mode) => mode.key === state.sort.key);
    state.sort = sortModes[(index + 1) % sortModes.length];
    if (sortLabel) {
      sortLabel.textContent = state.sort.label;
    }
    renderArchiveCards(grid, applySort(state.items));
  });

  prevButton?.addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadArchive().catch(() => {
      renderArchiveCards(grid, []);
    });
  });

  nextButton?.addEventListener("click", () => {
    state.offset += state.limit;
    loadArchive().catch(() => {
      state.offset = Math.max(0, state.offset - state.limit);
      renderArchiveCards(grid, []);
    });
  });

  await loadArchive().catch((error) => {
    renderArchiveCards(grid, []);
    console.error("Failed to load archive", error);
  });
}

function profileCardForProposal(row) {
  const verdict = row.verdict || row.status || "Pending";
  const verdictTone = verdict === "Idiotic" ? "text-red-300" : verdict === "Intelligent" ? "text-green-300" : "text-amber-200";
  const border = verdict === "Idiotic" ? "border-red-600/30" : verdict === "Intelligent" ? "border-green-600/30" : "border-amber-500/20";

  return `
    <article class="rounded-xl border ${border} bg-[#1a1812] p-4">
      <div class="flex flex-wrap justify-between items-start gap-4">
        <div>
          <p class="text-xs text-amber-100/55">${escapeHtml(formatShortDate(row.createdAt))} • ${escapeHtml(row.topic || "General")}</p>
          <h3 class="font-display text-2xl mt-1 text-amber-100">${escapeHtml(truncate(row.title, 110))}</h3>
          <p class="text-sm text-amber-100/65 mt-2">${escapeHtml(truncate(row.body || "", 180))}</p>
          <div class="flex flex-wrap items-center gap-3 mt-3 text-xs text-amber-100/60">
            <span>${escapeHtml(String(row.totalVotes || 0))} votes</span>
            <span>${escapeHtml(verdict)}</span>
          </div>
        </div>
        <div class="flex flex-col gap-2 min-w-[120px]">
          <a class="px-3 py-1.5 text-xs rounded border border-borderline hover:border-gold hover:text-gold transition-colors text-center" href="/assembly?debate=${encodeURIComponent(
            row.debateId || "",
          )}">View Analytics</a>
          <span class="px-3 py-1.5 text-xs rounded border ${voteBadgeClass(verdict)} text-center">${escapeHtml(verdict)}</span>
        </div>
      </div>
    </article>
  `;
}

function profileCardForVote(row) {
  const aligned = Boolean(row.aligned);
  return `
    <article class="rounded-xl border border-borderline bg-[#1a1812] p-4">
      <div class="flex flex-wrap justify-between items-start gap-4">
        <div>
          <p class="text-xs text-amber-100/55">${escapeHtml(formatShortDate(row.createdAt))}</p>
          <h3 class="font-display text-2xl mt-1 text-amber-100">${escapeHtml(truncate(row.title, 110))}</h3>
          <p class="text-sm mt-2 ${aligned ? "text-green-300" : "text-red-300"}">Your vote: ${escapeHtml(row.vote)} • Final verdict: ${escapeHtml(
            row.verdict,
          )}</p>
        </div>
        <div class="flex flex-col gap-2 min-w-[120px]">
          <a class="px-3 py-1.5 text-xs rounded border border-borderline hover:border-gold hover:text-gold transition-colors text-center" href="/assembly?debate=${encodeURIComponent(
            row.debateId,
          )}">Open Debate</a>
          <span class="px-3 py-1.5 text-xs rounded border ${aligned ? "text-green-300 border-green-500/30 bg-green-500/10" : "text-red-300 border-red-500/30 bg-red-500/10"} text-center">${
            aligned ? "Aligned" : "Not Aligned"
          }</span>
        </div>
      </div>
    </article>
  `;
}

function profileCardForDraft(row) {
  return `
    <article class="rounded-xl border border-borderline bg-[#1a1812] p-4">
      <div class="flex flex-wrap justify-between items-start gap-4">
        <div>
          <p class="text-xs text-amber-100/55">Draft updated ${escapeHtml(formatShortDate(row.updatedAt || row.createdAt))}</p>
          <h3 class="font-display text-2xl mt-1 text-amber-100">${escapeHtml(truncate(row.title, 110))}</h3>
          <p class="text-sm text-amber-100/65 mt-2">${escapeHtml(truncate(row.body || "", 180))}</p>
        </div>
        <div class="flex flex-col gap-2 min-w-[120px]">
          <button class="profile-edit-draft px-3 py-1.5 text-xs rounded border border-borderline hover:border-gold hover:text-gold transition-colors text-center" data-draft-id="${escapeHtml(
            row.id,
          )}" type="button">Edit Draft</button>
        </div>
      </div>
    </article>
  `;
}

async function hydrateProfile() {
  const [profilePayload, submissionsPayload, votesPayload, alignmentPayload] = await Promise.all([
    fetchJson("/v1/me/profile", { headers: { ...authHeaders() } }),
    fetchJson("/v1/me/submissions?limit=200", { headers: { ...authHeaders() } }),
    fetchJson("/v1/me/votes?limit=200", { headers: { ...authHeaders() } }),
    fetchJson("/v1/me/alignment", { headers: { ...authHeaders() } }),
  ]);

  const user = profilePayload?.user || userContext;
  const stats = profilePayload?.stats || {};

  setText("profile_user_name", user.displayName || userContext.displayName);
  setText("profile_user_title", stats.title || "Junior Petitioner");
  setText("profile_member_since", `Handle: ${user.handle || userContext.handle}`);
  setText("profile_stat_submissions", String(stats.submissions || 0));
  setText("profile_stat_votes", String(stats.totalVotes || 0));
  setText("profile_alignment_pct", `${stats.alignmentPct || 0}%`);

  const bar = document.getElementById("profile_alignment_bar");
  if (bar) {
    bar.style.width = `${clamp(Number(stats.alignmentPct || 0), 0, 100)}%`;
  }

  setText(
    "profile_stats_status",
    `Weekly score: ${alignmentPayload?.weekly?.alignmentScore || 0} • Monthly score: ${alignmentPayload?.monthly?.alignmentScore || 0}`,
  );

  const tabsContainer = document.getElementById("profile_tabs");
  const list = document.getElementById("profile_records_list");
  const searchInput = document.getElementById("profile_search_input");
  const sortSelect = document.getElementById("profile_sort_select");
  const pageMeta = document.getElementById("profile_page_meta");
  const prevPage = document.getElementById("profile_prev_page");
  const nextPage = document.getElementById("profile_next_page");

  const allSubmissions = Array.isArray(submissionsPayload.items) ? submissionsPayload.items : [];
  const allVotes = Array.isArray(votesPayload.items) ? votesPayload.items : [];

  const state = {
    tab: "proposals",
    query: "",
    sort: "recent",
    page: 1,
  };

  const dataForTab = (tab) => {
    if (tab === "votes") return allVotes;
    if (tab === "drafts") return allSubmissions.filter((row) => row.status === "draft");
    return allSubmissions.filter((row) => row.status !== "draft");
  };

  const render = () => {
    if (!list) return;

    const dataset = dataForTab(state.tab)
      .filter((row) => {
        const haystack = `${row.title || ""} ${row.body || ""}`.toLowerCase();
        return haystack.includes(state.query.toLowerCase());
      })
      .sort((a, b) => {
        const aTime = new Date(a.createdAt || a.updatedAt || 0).getTime();
        const bTime = new Date(b.createdAt || b.updatedAt || 0).getTime();

        if (state.sort === "oldest") {
          return aTime - bTime;
        }

        if (state.sort === "alignment") {
          const aScore = Number(a.aligned ? 1 : 0);
          const bScore = Number(b.aligned ? 1 : 0);
          if (bScore !== aScore) return bScore - aScore;
          return bTime - aTime;
        }

        return bTime - aTime;
      });

    const totalPages = Math.max(1, Math.ceil(dataset.length / PROFILE_PAGE_SIZE));
    state.page = clamp(state.page, 1, totalPages);

    const offset = (state.page - 1) * PROFILE_PAGE_SIZE;
    const pageRows = dataset.slice(offset, offset + PROFILE_PAGE_SIZE);

    if (!pageRows.length) {
      list.innerHTML = `
        <article class="rounded-xl border border-borderline bg-[#1a1812] p-4 text-sm text-amber-100/70">
          No records found for this tab.
        </article>
      `;
    } else {
      list.innerHTML = pageRows
        .map((row) => {
          if (state.tab === "votes") return profileCardForVote(row);
          if (state.tab === "drafts") return profileCardForDraft(row);
          return profileCardForProposal(row);
        })
        .join("\n");
    }

    if (pageMeta) {
      pageMeta.textContent = `Page ${state.page} of ${totalPages}`;
    }
    if (prevPage) {
      prevPage.disabled = state.page <= 1;
    }
    if (nextPage) {
      nextPage.disabled = state.page >= totalPages;
    }
  };

  tabsContainer?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest(".profile-tab") : null;
    if (!target) return;

    state.tab = target.dataset.tab || "proposals";
    state.page = 1;

    tabsContainer.querySelectorAll(".profile-tab").forEach((tab) => {
      tab.classList.remove("text-gold", "border-gold", "border-b");
      tab.classList.add("text-amber-100/70");
    });

    target.classList.add("text-gold", "border-gold", "border-b");
    target.classList.remove("text-amber-100/70");

    render();
  });

  searchInput?.addEventListener("input", () => {
    state.query = String(searchInput.value || "").trim();
    state.page = 1;
    render();
  });

  sortSelect?.addEventListener("change", () => {
    state.sort = String(sortSelect.value || "recent");
    render();
  });

  prevPage?.addEventListener("click", () => {
    state.page -= 1;
    render();
  });

  nextPage?.addEventListener("click", () => {
    state.page += 1;
    render();
  });

  list?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest(".profile-edit-draft") : null;
    if (!target) return;

    const draftId = target.dataset.draftId;
    if (!draftId) return;

    localStorage.setItem(DRAFT_STORAGE_KEY, draftId);
    window.location.href = "/propose";
  });

  render();
}

function podiumCard(row, rankLabel) {
  if (!row) {
    return {
      name: "Open Seat",
      subtitle: "Alignment: 0%",
      badge: rankLabel,
    };
  }

  return {
    name: row.displayName || row.handle || `Delegate ${row.rank}`,
    subtitle: `Alignment: ${row.alignmentPct}%`,
    badge: `${rankLabel} ${row.title || "Delegate"}`,
  };
}

function leaderboardRow(row) {
  return `
    <tr>
      <td class="px-4 py-4 text-amber-100/75">${escapeHtml(row.rank)}</td>
      <td class="px-4 py-4">
        <div class="flex items-center gap-3">
          <div class="size-8 rounded-full bg-[#252117] border border-borderline flex items-center justify-center text-xs text-gold">${escapeHtml(
            initialsFromName(row.displayName || row.handle),
          )}</div>
          <span class="text-amber-100">${escapeHtml(row.displayName || row.handle || row.userId)}</span>
        </div>
      </td>
      <td class="px-4 py-4"><span class="inline-flex px-2 py-1 rounded text-xs bg-gold/15 text-gold border border-gold/25">${escapeHtml(
        row.title || "Delegate",
      )}</span></td>
      <td class="px-4 py-4">
        <div class="flex items-center gap-3">
          <div class="h-1.5 w-36 bg-[#13120f] rounded-full border border-borderline overflow-hidden">
            <div class="h-full bg-gradient-to-r from-amber-600 to-gold" style="width:${clamp(Number(row.alignmentPct || 0), 0, 100)}%"></div>
          </div>
          <span class="text-amber-100/80 text-xs">${escapeHtml(row.alignmentPct)}%</span>
        </div>
      </td>
      <td class="px-4 py-4 text-right text-amber-100/70">${escapeHtml(row.submissions || 0)}</td>
    </tr>
  `;
}

async function hydrateLeaderboard() {
  const periodTabs = Array.from(document.querySelectorAll(".leaderboard-period"));
  const top1 = document.getElementById("leaderboard_top1");
  const top2 = document.getElementById("leaderboard_top2");
  const top3 = document.getElementById("leaderboard_top3");
  const tableBody = document.getElementById("leaderboard_table_body");
  const tableMeta = document.getElementById("leaderboard_table_meta");
  const statusNode = document.getElementById("leaderboard_status");

  const state = {
    period: "weekly",
    items: [],
  };

  const setStatus = (message, isError = false) => {
    if (!statusNode) return;
    statusNode.textContent = message;
    statusNode.className = isError ? "text-red-300" : "text-amber-100/55";
  };

  const renderTop = () => {
    const [first, second, third] = state.items;
    const firstCard = podiumCard(first, "#1");
    const secondCard = podiumCard(second, "#2");
    const thirdCard = podiumCard(third, "#3");

    if (top1) {
      top1.querySelector("h2").textContent = firstCard.name;
      top1.querySelector("p:nth-of-type(1)").textContent = firstCard.badge;
      top1.querySelector("p:nth-of-type(2)").textContent = firstCard.subtitle;
    }
    if (top2) {
      top2.querySelector("h2").textContent = secondCard.name;
      top2.querySelector("p:nth-of-type(1)").textContent = secondCard.badge;
      top2.querySelector("p:nth-of-type(2)").textContent = secondCard.subtitle;
    }
    if (top3) {
      top3.querySelector("h2").textContent = thirdCard.name;
      top3.querySelector("p:nth-of-type(1)").textContent = thirdCard.badge;
      top3.querySelector("p:nth-of-type(2)").textContent = thirdCard.subtitle;
    }
  };

  const renderTable = () => {
    if (!tableBody) return;

    if (!state.items.length) {
      tableBody.innerHTML = `<tr><td class="px-4 py-4 text-amber-100/60" colspan="5">No ranked diplomats yet.</td></tr>`;
      if (tableMeta) tableMeta.textContent = "No leaderboard entries";
      return;
    }

    const rows = state.items.slice(3);
    tableBody.innerHTML = (rows.length ? rows : state.items).map(leaderboardRow).join("\n");

    if (tableMeta) {
      tableMeta.textContent = `Showing ${state.items.length} diplomats • Period: ${state.period.replace("_", " ")}`;
    }
  };

  const syncPeriodTabs = () => {
    periodTabs.forEach((button) => {
      if (button.dataset.period === state.period) {
        button.classList.add("bg-gold", "text-[#2a1a05]", "font-semibold");
        button.classList.remove("text-amber-100/70");
      } else {
        button.classList.remove("bg-gold", "text-[#2a1a05]", "font-semibold");
        button.classList.add("text-amber-100/70");
      }
    });
  };

  const load = async () => {
    setStatus("Refreshing leaderboard...");

    try {
      const payload = await fetchJson(`/v1/leaderboard?period=${encodeURIComponent(state.period)}&limit=50`);
      state.items = Array.isArray(payload.items) ? payload.items : [];
      renderTop();
      renderTable();
      setStatus(`Updated ${formatDate(payload.updatedAt || new Date().toISOString())}`);
    } catch (error) {
      state.items = [];
      renderTop();
      renderTable();
      setStatus(error.message, true);
    }
  };

  periodTabs.forEach((button) => {
    button.addEventListener("click", () => {
      const period = String(button.dataset.period || "weekly");
      state.period = ["weekly", "monthly", "all_time"].includes(period) ? period : "weekly";
      syncPeriodTabs();
      load();
    });
  });

  syncPeriodTabs();
  await load();
}

async function init() {
  const page = document.body.dataset.page;

  if (page === "landing") {
    await hydrateLanding();
    return;
  }

  if (page === "assembly") {
    await hydrateAssembly();
    return;
  }

  if (page === "propose") {
    await hydratePropose();
    return;
  }

  if (page === "archive") {
    await hydrateArchive();
    return;
  }

  if (page === "profile") {
    await hydrateProfile();
    return;
  }

  if (page === "leaderboard") {
    await hydrateLeaderboard();
  }
}

init().catch((error) => {
  console.error("UI hydrate error", error);
});
