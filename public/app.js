const state = {
  screen: "live",
  agents: [],
  archive: [],
  activeDebate: null,
  selectedDelegates: new Set(),
};

const elements = {
  healthDot: document.getElementById("health-dot"),
  healthText: document.getElementById("health-text"),
  proposalForm: document.getElementById("proposal-form"),
  proposalStatus: document.getElementById("proposal-status"),
  submitProposalButton: document.getElementById("submit-proposal"),
  delegateSelector: document.getElementById("delegate-selector"),
  liveTitle: document.getElementById("live-title"),
  liveResolution: document.getElementById("live-resolution"),
  liveIntelligent: document.getElementById("live-intelligent"),
  liveIdiotic: document.getElementById("live-idiotic"),
  liveMeter: document.getElementById("live-meter"),
  liveSummary: document.getElementById("live-summary"),
  liveDelegates: document.getElementById("live-delegates"),
  assemblyMeta: document.getElementById("assembly-meta"),
  assemblyTitle: document.getElementById("assembly-title"),
  assemblyResolution: document.getElementById("assembly-resolution"),
  assemblyVerdict: document.getElementById("assembly-verdict"),
  assemblyVotes: document.getElementById("assembly-votes"),
  assemblyFeed: document.getElementById("assembly-feed"),
  archiveList: document.getElementById("archive-list"),
  leaderboardTable: document.getElementById("leaderboard-table"),
  profileRank: document.getElementById("profile-rank"),
  profileAlignment: document.getElementById("profile-alignment"),
  profileSubmissions: document.getElementById("profile-submissions"),
  profileBallots: document.getElementById("profile-ballots"),
};

function setHealth(message, isError = false) {
  elements.healthText.textContent = message;
  elements.healthDot.className = `h-2 w-2 rounded-full ${isError ? "bg-red-500" : "bg-green-500"}`;
}

function setProposalStatus(message, isError = false) {
  elements.proposalStatus.textContent = message;
  elements.proposalStatus.className = `text-sm ${isError ? "text-red-300" : "text-slate-300"}`;
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function truncate(text, max = 180) {
  if (!text) return "";
  const clean = String(text).trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return date.toLocaleString();
}

function formatTokens(value) {
  if (value == null) return "n/a";
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "n/a";
  if (number >= 1e12) return `${(number / 1e12).toFixed(2)}T`;
  if (number >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(2)}K`;
  return String(Math.round(number));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error || `Request failed with ${response.status}`;
    const details = payload?.details ? `: ${payload.details}` : "";
    throw new Error(`${message}${details}`);
  }

  return payload;
}

function switchScreen(screen) {
  state.screen = screen;

  document.querySelectorAll(".screen").forEach((node) => {
    node.classList.toggle("active", node.id === `screen-${screen}`);
  });

  document.querySelectorAll(".nav-btn").forEach((node) => {
    const isActive = node.dataset.screen === screen;
    node.classList.toggle("border-primary", isActive);
    node.classList.toggle("bg-primary/20", isActive);
    node.classList.toggle("border-borderline", !isActive);
  });
}

function renderDelegateSelector() {
  if (!state.agents.length) {
    elements.delegateSelector.innerHTML = `<div class="text-sm text-slate-300">No delegates available.</div>`;
    return;
  }

  elements.delegateSelector.innerHTML = state.agents
    .map((agent) => {
      const checked = state.selectedDelegates.has(agent.id) ? "checked" : "";
      return `
        <label class="rounded-lg border border-borderline bg-surface/60 p-3 text-sm">
          <div class="flex items-start gap-3">
            <input type="checkbox" class="delegate-checkbox mt-1" value="${escapeHtml(agent.id)}" ${checked} />
            <div>
              <div class="font-semibold text-white">${escapeHtml(agent.displayName)}</div>
              <div class="text-xs text-slate-400">${escapeHtml(agent.id)}</div>
              <div class="mt-1 text-xs text-blue-300">Weekly tokens: ${escapeHtml(agent.weeklyTokensText || formatTokens(agent.weeklyTokens))}</div>
            </div>
          </div>
        </label>
      `;
    })
    .join("");
}

function renderLive() {
  const debate = state.activeDebate;

  if (debate) {
    elements.liveTitle.textContent = debate.title;
    elements.liveResolution.textContent = debate.resolution;

    const intelligent = debate.consensus?.intelligentPct ?? 50;
    const idiotic = debate.consensus?.idioticPct ?? 50;

    elements.liveIntelligent.textContent = `${intelligent}%`;
    elements.liveIdiotic.textContent = `${idiotic}%`;
    elements.liveMeter.style.width = `${Math.max(0, Math.min(intelligent, 100))}%`;

    elements.liveSummary.textContent = `${debate.consensus.totalVotes} delegates voted. Final verdict: ${debate.consensus.verdict}. Last updated ${formatDate(
      debate.createdAt,
    )}.`;
  } else {
    elements.liveTitle.textContent = "Awaiting first resolution";
    elements.liveResolution.textContent =
      "Submit a proposal to convene delegates from the OpenRouter leaderboard and get a live assembly verdict.";
    elements.liveIntelligent.textContent = "50%";
    elements.liveIdiotic.textContent = "50%";
    elements.liveMeter.style.width = "50%";
    elements.liveSummary.textContent = "No completed debates yet.";
  }

  if (!state.agents.length) {
    elements.liveDelegates.innerHTML = `<div class="text-sm text-slate-300">Loading delegates...</div>`;
    return;
  }

  elements.liveDelegates.innerHTML = state.agents
    .slice(0, 8)
    .map(
      (agent) => `
      <div class="rounded-lg border border-borderline bg-surface/60 p-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="font-semibold">#${agent.rank} ${escapeHtml(agent.displayName)}</div>
            <div class="text-xs text-slate-400">${escapeHtml(agent.id)}</div>
          </div>
          <div class="text-right">
            <div class="font-mono text-sm text-blue-300">${escapeHtml(agent.weeklyTokensText || formatTokens(agent.weeklyTokens))}</div>
            <div class="text-xs text-slate-400">weekly tokens</div>
          </div>
        </div>
      </div>
    `,
    )
    .join("");
}

function renderAssembly() {
  const debate = state.activeDebate;

  if (!debate) {
    elements.assemblyMeta.textContent = "No active resolution";
    elements.assemblyTitle.textContent = "Submit a resolution to start the floor.";
    elements.assemblyResolution.textContent = "";
    elements.assemblyVerdict.textContent = "Pending";
    elements.assemblyVerdict.className = "text-xl font-black text-slate-200";
    elements.assemblyVotes.textContent = "0 votes";
    elements.assemblyFeed.innerHTML = `<div class="rounded-lg border border-borderline bg-panel/60 p-4 text-sm text-slate-300">No delegate arguments yet.</div>`;
    return;
  }

  elements.assemblyMeta.textContent = `Resolution ID: ${debate.id.slice(0, 8)} • ${formatDate(debate.createdAt)}`;
  elements.assemblyTitle.textContent = debate.title;
  elements.assemblyResolution.textContent = debate.resolution;
  elements.assemblyVerdict.textContent = debate.consensus.verdict;
  elements.assemblyVerdict.className = `text-xl font-black ${
    debate.consensus.verdict === "Intelligent" ? "text-blue-300" : "text-red-300"
  }`;
  elements.assemblyVotes.textContent = `${debate.consensus.totalVotes} votes • ${debate.consensus.intelligentVotes} intelligent • ${debate.consensus.idioticVotes} idiotic`;

  elements.assemblyFeed.innerHTML = debate.delegateResults
    .map((result) => {
      if (result.error) {
        return `
          <article class="rounded-xl border border-red-800 bg-red-900/20 p-4">
            <div class="mb-1 text-sm font-bold text-red-300">${escapeHtml(result.displayName || result.modelId)}</div>
            <div class="text-sm text-red-200">Delegate call failed: ${escapeHtml(result.error)}</div>
          </article>
        `;
      }

      const voteColor = result.vote === "Intelligent" ? "text-blue-300 border-blue-500/30 bg-blue-500/10" : "text-red-300 border-red-500/30 bg-red-500/10";

      return `
        <article class="rounded-xl border border-borderline bg-panel/70 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div class="font-bold text-white">${escapeHtml(result.displayName || result.modelId)}</div>
              <div class="text-xs text-slate-400">${escapeHtml(result.modelId)}</div>
            </div>
            <div class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold ${voteColor}">
              <span>${escapeHtml(result.vote)}</span>
              <span>•</span>
              <span>${Number(result.confidence) || 0}% confidence</span>
            </div>
          </div>
          <p class="mt-3 text-sm leading-relaxed text-slate-200">${escapeHtml(result.argument)}</p>
          ${
            result.rebuttal
              ? `<p class="mt-2 text-xs text-slate-400"><span class="font-semibold">Likely rebuttal:</span> ${escapeHtml(result.rebuttal)}</p>`
              : ""
          }
        </article>
      `;
    })
    .join("");
}

function renderArchive() {
  if (!state.archive.length) {
    elements.archiveList.innerHTML = `<div class="rounded-lg border border-borderline bg-panel/70 p-4 text-sm text-slate-300">No archived debates yet.</div>`;
    return;
  }

  elements.archiveList.innerHTML = state.archive
    .map((debate) => {
      const verdictClass = debate.consensus?.verdict === "Intelligent" ? "text-blue-300 border-blue-500/30" : "text-red-300 border-red-500/30";
      return `
        <article class="rounded-xl border border-borderline bg-panel/70 p-4">
          <div class="mb-2 flex items-center justify-between gap-3">
            <div class="rounded-full border px-2 py-0.5 text-xs font-bold ${verdictClass}">${escapeHtml(
              debate.consensus?.verdict || "Pending",
            )}</div>
            <div class="text-xs text-slate-400">${formatDate(debate.createdAt)}</div>
          </div>
          <h3 class="text-base font-bold text-white">${escapeHtml(debate.title)}</h3>
          <p class="mt-2 text-sm text-slate-300">${escapeHtml(truncate(debate.resolution, 160))}</p>
          <div class="mt-3 text-xs text-slate-400">Votes: ${debate.consensus?.totalVotes || 0}</div>
          <button class="mt-4 rounded-lg border border-primary px-3 py-1.5 text-sm text-blue-300" data-open-debate="${debate.id}">Open Assembly Log</button>
        </article>
      `;
    })
    .join("");
}

function renderLeaderboard() {
  if (!state.agents.length) {
    elements.leaderboardTable.innerHTML = `<tr><td class="px-4 py-3 text-slate-300" colspan="5">No delegates loaded.</td></tr>`;
    return;
  }

  elements.leaderboardTable.innerHTML = state.agents
    .map(
      (agent) => `
      <tr class="border-t border-borderline">
        <td class="px-4 py-3 font-mono">${agent.rank}</td>
        <td class="px-4 py-3">
          <div class="font-semibold text-white">${escapeHtml(agent.displayName)}</div>
          <div class="text-xs text-slate-400">${escapeHtml(agent.id)}</div>
        </td>
        <td class="px-4 py-3 text-slate-300">${escapeHtml(agent.provider)}</td>
        <td class="px-4 py-3 font-mono text-blue-300">${escapeHtml(agent.weeklyTokensText || formatTokens(agent.weeklyTokens))}</td>
        <td class="px-4 py-3 text-slate-300">${agent.contextLength ? formatTokens(agent.contextLength) : "n/a"}</td>
      </tr>
    `,
    )
    .join("");
}

function renderProfile() {
  const submissions = state.archive.length;
  const voted = state.archive.filter((item) => item.userVote).length;
  const aligned = state.archive.filter((item) => item.userAligned === true).length;
  const alignmentPct = voted ? Math.round((aligned / voted) * 100) : 0;

  let rank = "Junior Petitioner";
  if (alignmentPct >= 75 && submissions >= 5) {
    rank = "High Councillor";
  } else if (alignmentPct >= 50 && submissions >= 3) {
    rank = "Senior Petitioner";
  }

  elements.profileRank.textContent = rank;
  elements.profileAlignment.textContent = `${alignmentPct}%`;
  elements.profileSubmissions.textContent = String(submissions);

  const ballots = state.archive
    .filter((item) => item.userVote)
    .slice(0, 8)
    .map((item) => {
      const alignedText = item.userAligned ? "Aligned" : "Not aligned";
      const alignedClass = item.userAligned ? "text-green-300" : "text-red-300";
      return `
        <div class="rounded-lg border border-borderline bg-surface/60 p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="font-semibold">${escapeHtml(item.title)}</div>
            <div class="text-xs ${alignedClass}">${alignedText}</div>
          </div>
          <div class="mt-1 text-xs text-slate-400">You: ${escapeHtml(item.userVote)} • Assembly: ${escapeHtml(
            item.consensus?.verdict || "Pending",
          )}</div>
        </div>
      `;
    });

  elements.profileBallots.innerHTML = ballots.length
    ? ballots.join("")
    : `<div class="text-sm text-slate-300">No ballots recorded yet. Submit a resolution and set your expected verdict.</div>`;
}

function renderAll() {
  renderDelegateSelector();
  renderLive();
  renderAssembly();
  renderArchive();
  renderLeaderboard();
  renderProfile();
}

async function loadAgents() {
  const payload = await fetchJson("/api/agents?limit=10");
  state.agents = Array.isArray(payload.agents) ? payload.agents : [];

  if (!state.selectedDelegates.size) {
    state.agents.slice(0, 4).forEach((agent) => state.selectedDelegates.add(agent.id));
  }
}

async function loadArchive() {
  const payload = await fetchJson("/api/archive");
  state.archive = Array.isArray(payload.items) ? payload.items : [];

  if (state.archive.length && !state.activeDebate) {
    state.activeDebate = state.archive[0];
  }
}

async function submitProposal(event) {
  event.preventDefault();

  const formData = new FormData(elements.proposalForm);
  const title = String(formData.get("title") || "").trim();
  const resolution = String(formData.get("resolution") || "").trim();
  const userVote = String(formData.get("userVote") || "Intelligent");
  const delegates = Array.from(state.selectedDelegates);

  if (!title || !resolution) {
    setProposalStatus("Title and core argument are required.", true);
    return;
  }

  if (!delegates.length) {
    setProposalStatus("Select at least one delegate.", true);
    return;
  }

  elements.submitProposalButton.disabled = true;
  elements.submitProposalButton.classList.add("opacity-70", "cursor-not-allowed");
  setProposalStatus("Debate underway. Calling delegates from OpenRouter...");

  try {
    const record = await fetchJson("/api/debate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        resolution,
        delegates,
        userVote,
      }),
    });

    state.activeDebate = record;
    state.archive = [record, ...state.archive.filter((item) => item.id !== record.id)];

    elements.proposalForm.reset();
    setProposalStatus("Debate completed. Verdict available on Assembly Floor.");
    renderAll();
    switchScreen("assembly");
  } catch (error) {
    setProposalStatus(error.message, true);
  } finally {
    elements.submitProposalButton.disabled = false;
    elements.submitProposalButton.classList.remove("opacity-70", "cursor-not-allowed");
  }
}

function bindEvents() {
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => {
      switchScreen(button.dataset.screen);
    });
  });

  document.getElementById("jump-assembly").addEventListener("click", () => switchScreen("assembly"));
  document.getElementById("refresh-archive").addEventListener("click", async () => {
    try {
      await loadArchive();
      renderAll();
    } catch (error) {
      setProposalStatus(error.message, true);
    }
  });

  elements.proposalForm.addEventListener("submit", submitProposal);

  elements.delegateSelector.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("delegate-checkbox")) {
      return;
    }

    if (target.checked) {
      state.selectedDelegates.add(target.value);
    } else {
      state.selectedDelegates.delete(target.value);
    }
  });

  elements.archiveList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const debateId = target.getAttribute("data-open-debate");
    if (!debateId) {
      return;
    }

    const selected = state.archive.find((item) => item.id === debateId);
    if (!selected) {
      return;
    }

    state.activeDebate = selected;
    renderAll();
    switchScreen("assembly");
  });
}

async function init() {
  bindEvents();

  try {
    await fetchJson("/api/health");
    setHealth("Connected");

    await Promise.all([loadAgents(), loadArchive()]);
    renderAll();
    setProposalStatus("Ready.");
  } catch (error) {
    setHealth("API unavailable", true);
    setProposalStatus(error.message, true);
    renderAll();
  }
}

init();
