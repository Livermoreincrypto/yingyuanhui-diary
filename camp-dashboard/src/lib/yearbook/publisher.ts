import { prisma } from "@/lib/db";
import { lookupPlayerByCampId, startPlayerSync } from "@/lib/player-service";
import { randomUUID } from "node:crypto";

const DEFAULT_ROSTER = [
  "呜呀捉飞鸡",
  "玩家大薄荷糖",
  "积极向上的名",
  "只求爱的人",
  "Swiftie",
];
const DEFAULT_ROSTER_ALIASES: Record<string, string[]> = {
  "积极向上的名": ["你好绿绿", "输了你们无能"],
};
const MODE_NAMES: Record<string, string> = {
  ranked: "排位",
  peak: "巅峰赛",
  fun: "娱乐",
  other: "其他",
};

type JsonRecord = Record<string, unknown>;

function configurationError(message: string) {
  return Object.assign(new Error(message), { status: 503 });
}

function publishError(message: string, status = 502) {
  return Object.assign(new Error(message), { status });
}

function normalizeNickname(value: unknown) {
  return String(value || "").normalize("NFKC").replace(/[\p{Cf}\uFEFF]/gu, "").trim();
}

function asObject(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function configuredRoster() {
  const raw = process.env.YEARBOOK_ROSTER;
  const names = raw ? raw.split("|").map((name) => name.trim()).filter(Boolean) : DEFAULT_ROSTER;
  if (names.length !== 5 || new Set(names.map(normalizeNickname)).size !== 5) {
    throw configurationError("YEARBOOK_ROSTER 必须按顺序填写五个不同昵称，以 | 分隔");
  }
  return names;
}

function getPublishConfig() {
  const token = process.env.YEARBOOK_GITHUB_TOKEN?.trim() || "";
  if (!token) throw configurationError("请在后台服务环境变量中配置 YEARBOOK_GITHUB_TOKEN");

  const repo = process.env.YEARBOOK_GITHUB_REPO?.trim() || "RabbitmanWMQ/yingyuanhui-diary";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw configurationError("YEARBOOK_GITHUB_REPO 格式无效，应为 owner/repository");
  }

  const file = process.env.YEARBOOK_GITHUB_FILE?.trim() || "data/yearbook-2026.json";
  if (!file || file.startsWith("/") || file.split("/").some((part) => !part || part === "." || part === "..")) {
    throw configurationError("YEARBOOK_GITHUB_FILE 必须是仓库内的相对文件路径");
  }

  return {
    token,
    repo,
    file,
    branch: process.env.YEARBOOK_GITHUB_BRANCH?.trim() || "main",
    roster: configuredRoster(),
  };
}

function rosterNicknameMap(roster: string[]) {
  const names = new Map(roster.map((name) => [normalizeNickname(name), name]));
  for (const [canonical, aliases] of Object.entries(DEFAULT_ROSTER_ALIASES)) {
    const canonicalName = names.get(normalizeNickname(canonical));
    if (!canonicalName) continue;
    for (const alias of aliases) names.set(normalizeNickname(alias), canonicalName);
  }

  for (const entry of (process.env.YEARBOOK_ROSTER_ALIASES || "").split("|")) {
    const [canonicalInput, aliasesInput] = entry.split("=");
    const canonicalName = names.get(normalizeNickname(canonicalInput));
    if (!canonicalName || !aliasesInput) continue;
    for (const alias of aliasesInput.split(",").map((value) => value.trim()).filter(Boolean)) {
      names.set(normalizeNickname(alias), canonicalName);
    }
  }
  return names;
}

function githubContentUrl(repo: string, file: string, branch: string) {
  const encodedPath = file.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function matchSignature(match: JsonRecord) {
  const players = Array.isArray(match.players) ? match.players : [];
  const playerKey = players
    .map((item) => {
      const player = asObject(item) || {};
      return [normalizeNickname(player.name), String(player.hero || "")].join(":");
    })
    .sort()
    .join("|");
  return [String(match.date || ""), String(match.result || ""), String(match.mode || ""), playerKey].join("~");
}

function clockMinutes(value: unknown) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

function sameManualCampMatch(manual: JsonRecord, camp: JsonRecord) {
  if (manual.source !== "manual" || camp.source !== "camp") return false;
  if (
    String(manual.date || "") !== String(camp.date || "") ||
    String(manual.result || "") !== String(camp.result || "") ||
    String(manual.mode || "") !== String(camp.mode || "")
  ) return false;

  const rosterKey = (match: JsonRecord) =>
    (Array.isArray(match.players) ? match.players : [])
      .map((item) => normalizeNickname(asObject(item)?.name))
      .filter(Boolean)
      .sort()
      .join("|");
  if (!rosterKey(manual) || rosterKey(manual) !== rosterKey(camp)) return false;

  const manualStart = clockMinutes(manual.time);
  const campEnd = clockMinutes(camp.time);
  const duration = Number(manual.durationMinutes);
  if (manualStart == null || campEnd == null || !Number.isFinite(duration) || duration <= 0) return false;
  const difference = Math.abs(((manualStart + Math.round(duration)) % 1440) - campEnd);
  return Math.min(difference, 1440 - difference) <= 1;
}

function mergeMatches(previous: unknown, latest: JsonRecord[]) {
  const byId = new Map<string, JsonRecord>();
  const withoutIdBySignature = new Map<string, JsonRecord>();
  if (Array.isArray(previous)) {
    for (const value of previous) {
      const match = asObject(value);
      if (!match) continue;
      if (match.id) byId.set(String(match.id), match);
      else withoutIdBySignature.set(matchSignature(match), match);
    }
  }
  for (const incoming of latest) {
    let match = incoming;
    if (match.source === "camp") {
      const manualDuplicates = [...byId.entries()].filter(([, previousMatch]) =>
        sameManualCampMatch(previousMatch, match),
      );
      if (manualDuplicates.length) {
        const manual = manualDuplicates[0][1];
        match = {
          ...match,
          time: manual.time || match.time,
          durationMinutes: match.durationMinutes ?? manual.durationMinutes,
        };
        for (const [id] of manualDuplicates) byId.delete(id);
      }
      for (const [signature, previousMatch] of withoutIdBySignature) {
        if (sameManualCampMatch(previousMatch, match)) withoutIdBySignature.delete(signature);
      }
    }

    if (match.id) {
      withoutIdBySignature.delete(matchSignature(match));
      byId.set(String(match.id), match);
    } else {
      withoutIdBySignature.set(matchSignature(match), match);
    }
  }
  return [...withoutIdBySignature.values(), ...byId.values()]
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

export async function buildYearbookData(year: number, campIdInput: string) {
  const campId = campIdInput.trim();
  if (!/^\d{5,15}$/.test(campId)) {
    throw Object.assign(new Error("请输入 5 至 15 位数字的王者营地 ID"), { status: 400 });
  }

  const { roster } = getPublishConfig();
  const lookup = await lookupPlayerByCampId(campId, {
    forceRefresh: true,
    ignoreCooldown: true,
  });

  if (lookup.pendingSync) await startPlayerSync(lookup.pendingSync);

  const player = await prisma.player.findUnique({
    where: { campId: lookup.data.player.campId },
    select: { id: true, gameNickname: true },
  });
  if (!player) throw new Error("营地玩家已查到，但本地战绩记录不存在");

  const start = new Date(`${year}-01-01T00:00:00+08:00`);
  const end = new Date(`${year + 1}-01-01T00:00:00+08:00`);
  const rows = await prisma.match.findMany({
    where: { playerId: player.id, playedAt: { gte: start, lt: end } },
    select: {
      externalId: true,
      playedAt: true,
      mode: true,
      modeName: true,
      result: true,
      durationSec: true,
      rawJson: true,
    },
    orderBy: { playedAt: "desc" },
    take: 1000,
  });

  const wanted = roster.map(normalizeNickname).sort();
  const canonicalNames = rosterNicknameMap(roster);
  const matches = rows.flatMap((row) => {
    if (!row.rawJson) return [];
    let raw: JsonRecord | null = null;
    try {
      raw = asObject(JSON.parse(row.rawJson));
    } catch {
      return [];
    }
    const team = Array.isArray(raw?.yearbookTeamRoster) ? raw.yearbookTeamRoster : [];
    const names = team
      .map((member) => normalizeNickname(asObject(member)?.name))
      .filter(Boolean);
    const canonicalTeam = names.map((name) => canonicalNames.get(name)).filter(Boolean);
    const normalizedCanonicalTeam = canonicalTeam.map(normalizeNickname).sort();
    if (
      names.length !== 5 ||
      new Set(names).size !== 5 ||
      canonicalTeam.length !== 5 ||
      new Set(normalizedCanonicalTeam).size !== 5 ||
      normalizedCanonicalTeam.some((name, i) => name !== wanted[i])
    ) {
      return [];
    }

    const durationSeconds = Number(row.durationSec);
    const durationMinutes = Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.round(durationSeconds / 60)
      : undefined;
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(row.playedAt);

    return [{
      id: row.externalId,
      date: row.playedAt.toISOString().slice(0, 10),
      time,
      ...(durationMinutes ? { durationMinutes } : {}),
      result: row.result === "win" ? "win" : "loss",
      mode: row.modeName || MODE_NAMES[row.mode] || "排位",
      note: "营地对局详情核验五位队友同阵营",
      source: "camp",
      players: team.map((member) => {
        const entry = asObject(member) || {};
        const nickname = normalizeNickname(entry.name);
        return {
          name: canonicalNames.get(nickname) || String(entry.name || ""),
          hero: String(entry.hero || ""),
          role: String(entry.role || ""),
          rating: Number(entry.rating || 0),
          mvp: Boolean(entry.mvp),
          kills: Number(entry.kills || 0),
          deaths: Number(entry.deaths || 0),
          assists: Number(entry.assists || 0),
        };
      }),
    } satisfies JsonRecord];
  });

  if (!matches.length) {
    throw publishError(`已同步“${player.gameNickname}”，但${year}年暂无五位队友同场的已核验对局；网页数据未改动`, 422);
  }

  return {
    year,
    refreshedAt: new Date().toISOString(),
    source: "王者营地历史战绩自动同步",
    roster,
    matches,
  };
}

export async function publishYearbookData(data: Awaited<ReturnType<typeof buildYearbookData>>) {
  const { token, repo, file, branch, roster } = getPublishConfig();
  const url = githubContentUrl(repo, file, branch);
  const getResponse = await fetch(url, {
    headers: githubHeaders(token),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  let sha: string | undefined;
  let previous: JsonRecord = {};
  if (getResponse.ok) {
    const remote = asObject(await getResponse.json());
    sha = typeof remote?.sha === "string" ? remote.sha : undefined;
    const encoded = typeof remote?.content === "string" ? remote.content.replace(/\s/g, "") : "";
    if (encoded) {
      try {
        previous = asObject(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))) || {};
      } catch {
        throw publishError("GitHub 上的年鉴 JSON 无法解析，网页数据未改动", 409);
      }
    }
  } else if (getResponse.status !== 404) {
    throw publishError(`读取 GitHub 年鉴失败（HTTP ${getResponse.status}），请检查仓库权限和路径`);
  }

  const merged = {
    ...data,
    roster,
    matches: mergeMatches(previous.matches, data.matches),
  };
  const putResponse = await fetch(url.split("?")[0], {
    method: "PUT",
    headers: githubHeaders(token),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      message: `Update ${data.year} yearbook data`,
      content: Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });

  const result = asObject(await putResponse.json().catch(() => null));
  if (!putResponse.ok) {
    const detail = putResponse.status === 409 || putResponse.status === 422
      ? "文件刚被其他提交修改或分支受保护，请刷新后重试"
      : `GitHub 写入失败（HTTP ${putResponse.status}），请检查访问令牌权限`;
    throw publishError(detail, putResponse.status === 409 || putResponse.status === 422 ? 409 : 502);
  }

  return {
    repo,
    file,
    branch,
    matchCount: merged.matches.length,
    fetchedMatchCount: data.matches.length,
    commitUrl: asObject(result?.commit)?.html_url || null,
    pageUrl: `https://${repo.split("/")[0].toLowerCase()}.github.io/${repo.split("/")[1]}/?name=diary`,
  };
}

type ManualYearbookMatchInput = {
  date: string;
  result: "win" | "loss";
  mode: string;
  note?: string;
  players: Array<{
    name: string;
    accountName?: string;
    hero?: string;
    role?: string;
    rating: number;
    mvp: boolean;
  }>;
};

/** Append one admin-entered match while keeping its stats attributed to the fixed roster. */
export async function appendManualYearbookMatch(input: ManualYearbookMatchInput) {
  const { token, repo, file, branch, roster } = getPublishConfig();
  const rosterByNickname = new Map(roster.map((name) => [normalizeNickname(name), name]));
  const normalizedPlayers = input.players.map((player) => {
    const canonicalName = rosterByNickname.get(normalizeNickname(player.name));
    if (!canonicalName) throw publishError("队友名单与年鉴固定小队不一致，请刷新后台后重试", 400);
    const accountName = String(player.accountName || "").trim();
    return {
      name: canonicalName,
      ...(accountName && normalizeNickname(accountName) !== normalizeNickname(canonicalName) ? { accountName } : {}),
      hero: String(player.hero || "").trim(),
      role: String(player.role || "").trim(),
      rating: Number(player.rating || 0),
      mvp: Boolean(player.mvp),
      kills: 0,
      deaths: 0,
      assists: 0,
    };
  });
  if (normalizedPlayers.length !== 5 || new Set(normalizedPlayers.map((player) => normalizeNickname(player.name))).size !== 5) {
    throw publishError("一局需要五位不同的固定队友各录入一次", 400);
  }

  const now = new Date().toISOString();
  const match: JsonRecord = {
    id: `manual-${randomUUID()}`,
    date: input.date,
    result: input.result,
    mode: input.mode.trim(),
    note: String(input.note || "").trim(),
    source: "manual",
    players: normalizedPlayers,
  };
  const url = githubContentUrl(repo, file, branch);
  const getResponse = await fetch(url, {
    headers: githubHeaders(token),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  let sha: string | undefined;
  let previous: JsonRecord = {};
  if (getResponse.ok) {
    const remote = asObject(await getResponse.json());
    sha = typeof remote?.sha === "string" ? remote.sha : undefined;
    const encoded = typeof remote?.content === "string" ? remote.content.replace(/\s/g, "") : "";
    if (encoded) {
      try {
        previous = asObject(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))) || {};
      } catch {
        throw publishError("GitHub 上的年鉴 JSON 无法解析，手动战绩未写入", 409);
      }
    }
  } else if (getResponse.status !== 404) {
    throw publishError(`读取 GitHub 年鉴失败（HTTP ${getResponse.status}），请检查仓库权限和路径`);
  }

  const matches = mergeMatches(previous.matches, [match]);
  const merged = {
    ...previous,
    year: 2026,
    refreshedAt: now,
    source: previous.source || "王者营地历史战绩与后台手动补录",
    roster,
    matches,
  };
  const putResponse = await fetch(url.split("?")[0], {
    method: "PUT",
    headers: githubHeaders(token),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      message: "Add manual match to 2026 yearbook",
      content: Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });

  const result = asObject(await putResponse.json().catch(() => null));
  if (!putResponse.ok) {
    const detail = putResponse.status === 409 || putResponse.status === 422
      ? "年鉴文件刚被其他更新修改，请刷新后台后重新提交"
      : `GitHub 写入失败（HTTP ${putResponse.status}），请检查访问令牌权限`;
    throw publishError(detail, putResponse.status === 409 || putResponse.status === 422 ? 409 : 502);
  }

  return {
    year: 2026,
    matchCount: matches.length,
    commitUrl: asObject(result?.commit)?.html_url || null,
    pageUrl: `https://${repo.split("/")[0].toLowerCase()}.github.io/${repo.split("/")[1]}/?name=diary`,
  };
}

