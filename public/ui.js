function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function truncate(text, max = 220) {
  const value = String(text ?? "").trim();
  if (!value) {
    return "";
  }
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function formatDate(isoString) {
  if (!isoString) {
    return "";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return String(isoString);
  }
  return date.toLocaleString();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.error || `Request failed (${response.status})`;
    const details = payload?.details ? `: ${payload.details}` : "";
    throw new Error(`${message}${details}`);
  }

  return payload;
}

function getDebateByQuery(items) {
  const params = new URLSearchParams(window.location.search);
  const debateId = params.get("debate");
  if (!debateId) {
    return items[0] || null;
  }
  return items.find((item) => item.id === debateId) || items[0] || null;
}

async function loadArchive() {
  const payload = await fetchJson("/api/archive");
  return Array.isArray(payload.items) ? payload.items : [];
}

async function loadAgents(limit = 10) {
  const payload = await fetchJson(`/api/agents?limit=${limit}`);
  return Array.isArray(payload.agents) ? payload.agents : [];
}

async function hydrateLanding() {
  const [archive, agents] = await Promise.all([loadArchive(), loadAgents(4)]);
  const latest = archive[0];

  if (latest) {
    const titleNode = document.getElementById("live_resolution_title");
    const subtitleNode = document.getElementById("live_resolution_subtitle");
    const labelNode = document.getElementById("live_consensus_label");
    const barNode = document.getElementById("live_consensus_bar");
    const votesNode = document.getElementById("live_votes_cast");
    const sentimentNode = document.getElementById("live_sentiment");

    if (titleNode) {
      titleNode.textContent = latest.title;
    }
    if (subtitleNode) {
      subtitleNode.textContent = truncate(latest.resolution, 180);
    }

    const intelligentPct = latest.consensus?.intelligentPct ?? 50;
    const idioticPct = latest.consensus?.idioticPct ?? 50;

    if (labelNode) {
      labelNode.innerHTML = `${intelligentPct}% <span class="text-lg font-normal text-slate-400">vs</span> ${idioticPct}%`;
    }
    if (barNode) {
      barNode.style.width = `${Math.max(0, Math.min(100, intelligentPct))}%`;
    }
    if (votesNode) {
      votesNode.textContent = `${latest.consensus?.totalVotes ?? 0} Votes Cast`;
    }
    if (sentimentNode) {
      sentimentNode.textContent = `Current Sentiment: ${latest.consensus?.verdict ?? "Undecided"}`;
    }
  }

  const delegateNames = agents.map((agent) => agent.displayName).slice(0, 2).join(", ");
  const opposingNames = agents.map((agent) => agent.displayName).slice(2, 4).join(", ");

  const leaningLeft = document.querySelector(".text-blue-400\/70");
  const leaningRight = document.querySelector(".text-red-400\/70");

  if (leaningLeft && delegateNames) {
    leaningLeft.textContent = `${delegateNames} leading`;
  }
  if (leaningRight && opposingNames) {
    leaningRight.textContent = `${opposingNames} opposing`;
  }
}

function renderAssemblyFeed(feedNode, debate) {
  if (!feedNode) {
    return;
  }

  const delegateRows = Array.isArray(debate?.delegateResults) ? debate.delegateResults : [];

  if (!delegateRows.length) {
    return;
  }

  const cards = delegateRows
    .map((row, index) => {
      if (row.error) {
        return `
          <div class="flex gap-4 group">
            <div class="flex-1 max-w-3xl">
              <div class="p-4 rounded-xl bg-surface-dark border border-red-500/30 shadow-sm">
                <p class="text-red-300 leading-relaxed">${escapeHtml(row.displayName || row.modelId)} failed: ${escapeHtml(row.error)}</p>
              </div>
            </div>
          </div>
        `;
      }

      const isPro = row.vote === "Intelligent";
      const wrapperClass = isPro ? "flex gap-4 group" : "flex gap-4 flex-row-reverse group";
      const alignmentClass = isPro ? "flex-1 max-w-3xl" : "flex-1 max-w-3xl flex flex-col items-end";
      const badgeClass = isPro
        ? "px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-green-500/10 text-green-400 border border-green-500/20"
        : "px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-red-500/10 text-red-400 border border-red-500/20";
      const bubbleClass = isPro
        ? "p-4 rounded-xl rounded-tl-none bg-surface-dark border border-border-color shadow-sm"
        : "p-4 rounded-xl rounded-tr-none bg-surface-dark border border-border-color shadow-sm text-right";

      return `
        <div class="${wrapperClass}">
          <div class="flex-shrink-0 mt-1">
            <div class="size-10 rounded-full ${isPro ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-red-500/20 text-red-400 border-red-500/30"} flex items-center justify-center border">
              <span class="material-symbols-outlined">smart_toy</span>
            </div>
          </div>
          <div class="${alignmentClass}">
            <div class="flex items-center gap-2 mb-1 ${isPro ? "" : "flex-row-reverse"}">
              <span class="font-bold text-white">${escapeHtml(row.displayName || row.modelId)}</span>
              <span class="text-xs text-text-secondary">${escapeHtml(row.confidence)}% confidence</span>
              <span class="${badgeClass}">${escapeHtml(row.vote)}</span>
            </div>
            <div class="${bubbleClass}">
              <p class="text-slate-300 leading-relaxed">${escapeHtml(row.argument || "No argument returned.")}</p>
            </div>
          </div>
        </div>
      `;
    })
    .join("\n");

  feedNode.innerHTML = `
    <div class="flex items-center justify-center my-6">
      <div class="h-px bg-border-color flex-1"></div>
      <span class="mx-4 text-xs font-bold text-text-secondary uppercase tracking-widest">Debate Started</span>
      <div class="h-px bg-border-color flex-1"></div>
    </div>
    ${cards}
  `;
}

async function hydrateAssembly() {
  const archive = await loadArchive();
  const debate = getDebateByQuery(archive);

  if (!debate) {
    return;
  }

  const metaNode = document.getElementById("assembly_meta");
  const titleNode = document.getElementById("assembly_title");
  const summaryNode = document.getElementById("assembly_summary_text");
  const consensusNode = document.getElementById("assembly_consensus_label");
  const needleNode = document.getElementById("assembly_consensus_needle");
  const feedNode = document.getElementById("assembly_feed");

  if (metaNode) {
    metaNode.textContent = `Session ${debate.id.slice(0, 8)} • ${formatDate(debate.createdAt)}`;
  }
  if (titleNode) {
    titleNode.textContent = debate.title;
  }
  if (summaryNode) {
    summaryNode.innerHTML = `<strong class="text-white block mb-1">Motion Summary</strong>${escapeHtml(truncate(debate.resolution, 360))}`;
  }

  const intelligentPct = debate.consensus?.intelligentPct ?? 50;
  if (consensusNode) {
    consensusNode.textContent = `${intelligentPct}% Intelligent`;
  }
  if (needleNode) {
    needleNode.style.left = `${Math.max(0, Math.min(100, intelligentPct))}%`;
  }

  renderAssemblyFeed(feedNode, debate);
}

function updateDelegateSlots(agents) {
  const checkboxes = Array.from(document.querySelectorAll(".delegate-toggle"));
  const nameNodes = Array.from(document.querySelectorAll(".delegate-name"));
  const providerNodes = Array.from(document.querySelectorAll(".delegate-provider"));

  checkboxes.forEach((checkbox, index) => {
    const agent = agents[index];
    if (!agent) {
      checkbox.checked = false;
      checkbox.disabled = true;
      return;
    }

    checkbox.value = agent.id;
    checkbox.disabled = false;
    checkbox.checked = true;

    if (nameNodes[index]) {
      nameNodes[index].textContent = agent.displayName;
    }
    if (providerNodes[index]) {
      providerNodes[index].textContent = agent.provider;
    }
  });
}

async function hydratePropose() {
  const statusNode = document.getElementById("propose_status");
  const submitButton = document.getElementById("submit_to_assembly");
  const selectAllButton = document.getElementById("select_all_delegates");

  const setStatus = (message, isError = false) => {
    if (!statusNode) {
      return;
    }
    statusNode.textContent = message;
    statusNode.className = `text-sm px-2 ${isError ? "text-red-300" : "text-slate-300"}`;
  };

  let agents = [];
  try {
    agents = await loadAgents(3);
    updateDelegateSlots(agents);
    setStatus("Ready. Delegates loaded from OpenRouter leaderboard.");
  } catch (error) {
    setStatus(error.message, true);
  }

  if (selectAllButton) {
    selectAllButton.addEventListener("click", () => {
      document.querySelectorAll(".delegate-toggle").forEach((checkbox) => {
        if (!checkbox.disabled) {
          checkbox.checked = true;
        }
      });
    });
  }

  if (!submitButton) {
    return;
  }

  submitButton.addEventListener("click", async () => {
    const title = document.getElementById("title")?.value?.trim() || "";
    const resolution = document.getElementById("argument")?.value?.trim() || "";

    const delegates = Array.from(document.querySelectorAll(".delegate-toggle"))
      .filter((checkbox) => checkbox.checked && checkbox.value)
      .map((checkbox) => checkbox.value);

    if (!title || !resolution) {
      setStatus("Resolution title and main argument are required.", true);
      return;
    }

    if (!delegates.length) {
      setStatus("Select at least one delegate.", true);
      return;
    }

    submitButton.disabled = true;
    submitButton.classList.add("opacity-70", "cursor-not-allowed");
    setStatus("Assembly in progress. Calling delegates...");

    try {
      const debate = await fetchJson("/api/debate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          resolution,
          delegates,
        }),
      });

      setStatus("Debate complete. Redirecting to Assembly Floor...");
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

  if (!debates.length) {
    return;
  }

  gridNode.innerHTML = debates
    .slice(0, 12)
    .map((debate) => {
      const isIntelligent = debate.consensus?.verdict === "Intelligent";
      const color = isIntelligent ? "primary" : "red-600";
      const stamp = isIntelligent ? "Intelligent" : "IDIOTIC";
      const delegates = (debate.delegateResults || [])
        .filter((item) => !item.error)
        .slice(0, 3)
        .map((item) => (item.displayName || item.modelId || "AI").slice(0, 2).toUpperCase());

      const delegateBadges = delegates
        .map(
          (abbr, index) =>
            `<div class="w-8 h-8 rounded-full bg-slate-800 border border-slate-600 flex items-center justify-center text-[10px] text-white font-bold" style="z-index:${30 - index * 10};">${escapeHtml(
              abbr,
            )}</div>`,
        )
        .join("");

      return `
        <article class="bg-surface-dark rounded-xl border border-border-dark hover:border-slate-600 transition-all duration-300 group relative overflow-hidden flex flex-col h-full shadow-lg">
          <div class="h-1.5 w-full bg-${color}"></div>
          <div class="p-6 flex flex-col flex-1 relative z-10">
            <div class="flex justify-between items-center mb-4 text-xs font-mono text-slate-500">
              <span>${escapeHtml(debate.id.slice(0, 12).toUpperCase())}</span>
              <span class="flex items-center gap-1">
                <span class="material-symbols-outlined text-[14px]">calendar_today</span>
                ${escapeHtml(formatDate(debate.createdAt))}
              </span>
            </div>
            <h3 class="text-xl text-white font-bold leading-snug mb-3 group-hover:text-primary transition-colors font-display">${escapeHtml(
              truncate(debate.title, 140),
            )}</h3>
            <div class="flex gap-2 mb-6">
              <span class="px-2 py-1 rounded bg-[#1c222b] text-slate-400 text-[10px] font-bold uppercase tracking-wider font-sans border border-slate-700">${escapeHtml(
                debate.consensus?.verdict || "Pending",
              )}</span>
              <span class="px-2 py-1 rounded bg-[#1c222b] text-slate-400 text-[10px] font-bold uppercase tracking-wider font-sans border border-slate-700">${escapeHtml(
                `${debate.consensus?.totalVotes || 0} votes`,
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
            <div class="verdict-stamp border-[4px] border-${color} text-${color} rounded px-4 py-1 text-3xl font-black uppercase tracking-widest opacity-20 group-hover:opacity-40 transition-opacity whitespace-nowrap">${stamp}</div>
          </div>
        </article>
      `;
    })
    .join("\n");
}

async function hydrateArchive() {
  const debates = await loadArchive();
  const gridNode = document.getElementById("archive_grid");
  renderArchiveCards(gridNode, debates);
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
  }
}

init().catch((error) => {
  console.error("UI hydrate error", error);
});
