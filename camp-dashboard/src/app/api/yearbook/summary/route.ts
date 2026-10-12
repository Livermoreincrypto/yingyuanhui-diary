import { handleRouteError, jsonError, jsonOk } from "@/lib/api";
import { prisma } from "@/lib/db";
import { isLocalYearbookRequest } from "@/lib/yearbook/local-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function roleFromMedal(medal: string | null) {
  const match = medal?.match(/对抗路|打野|中路|发育路|游走/);
  return match?.[0] || "";
}

function teamFromRawJson(rawJson: string | null) {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    return Array.isArray(parsed.yearbookTeamRoster) ? parsed.yearbookTeamRoster : [];
  } catch {
    return [];
  }
}

function normalizeNickname(value: unknown) {
  return String(value || "").normalize("NFKC").replace(/[\p{Cf}\uFEFF]/gu, "").trim();
}

export async function GET(req: Request) {
  if (!isLocalYearbookRequest(req)) return jsonError("仅允许本机访问", 403);
  try {
    const url = new URL(req.url);
    const campIds = [...new Set((url.searchParams.get("campIds") || "").split(",").map((x) => x.trim()).filter(Boolean))];
    const year = Number(url.searchParams.get("year") || new Date().getFullYear());
    const nicknames = (url.searchParams.get("nicknames") || "").split("|").map((name) => name.trim()).filter(Boolean);
    if (campIds.length < 1 || campIds.length > 5 || campIds.some((id) => !/^\d{5,15}$/.test(id))) {
      return jsonError("请至少提供一位队友的营地 ID", 400);
    }
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
      return jsonError("年份参数无效", 400);
    }

    const start = new Date(`${year}-01-01T00:00:00+08:00`);
    const end = new Date(`${year + 1}-01-01T00:00:00+08:00`);

    // A single logged-in teammate is enough to inspect complete battle details.
    // Keep only matches where the same-side detail roster exactly matches the five names.
    if (campIds.length < 5) {
      const players = await prisma.player.findMany({
        where: { campId: { in: campIds } },
        select: { id: true, campId: true, gameNickname: true, lastSyncAt: true, lastSyncError: true },
      });
      const playerIds = players.map((player) => player.id);
      const [rows, jobs] = await Promise.all([
        prisma.match.findMany({
          where: { playerId: { in: playerIds }, playedAt: { gte: start, lt: end } },
          select: { externalId: true, playerId: true, playedAt: true, mode: true, modeName: true, result: true, rawJson: true },
          orderBy: { playedAt: "desc" },
          take: 100,
        }),
        prisma.syncJob.findMany({
          where: { playerId: { in: playerIds } },
          select: { playerId: true, status: true, message: true, pulled: true, startedAt: true, finishedAt: true },
          orderBy: { startedAt: "desc" },
        }),
      ]);
      const wanted = nicknames.map(normalizeNickname).sort();
      const canonicalNames = new Map(nicknames.map((name) => [normalizeNickname(name), name]));
      const matches = rows.flatMap((row) => {
        const team = teamFromRawJson(row.rawJson) as Array<Record<string, unknown>>;
        const names = team.map((member) => normalizeNickname(member.name)).filter(Boolean);
        if (wanted.length !== 5 || new Set(names).size !== 5 || names.length !== 5 || [...names].sort().some((name, index) => name !== wanted[index])) return [];
        return [{
          id: row.externalId,
          date: row.playedAt.toISOString().slice(0, 10),
          result: row.result === "win" ? "win" : "loss",
          mode: row.modeName || ({ ranked: "排位", peak: "巅峰赛", fun: "娱乐", other: "其他" }[row.mode] || "排位"),
          note: "营地对局详情核验五位队友同阵营",
          source: "camp",
          players: team.map((member) => ({
            name: canonicalNames.get(normalizeNickname(member.name)) || String(member.name || ""),
            hero: String(member.hero || ""),
            role: String(member.role || ""),
            rating: Number(member.rating || 0),
            mvp: Boolean(member.mvp),
            kills: Number(member.kills || 0),
            deaths: Number(member.deaths || 0),
            assists: Number(member.assists || 0),
          })),
        }];
      });
      const latestJob = new Map<string, (typeof jobs)[number]>();
      for (const job of jobs) if (!latestJob.has(job.playerId)) latestJob.set(job.playerId, job);
      const roster = players.map((player) => {
        const job = latestJob.get(player.id);
        return {
          campId: player.campId,
          nickname: player.gameNickname,
          lastSyncAt: player.lastSyncAt?.toISOString() || null,
          lastSyncError: player.lastSyncError,
          syncStatus: job?.status || (player.lastSyncAt ? "success" : "pending"),
          syncMessage: job?.message || null,
          pulled: job?.pulled || 0,
        };
      });
      return jsonOk({ year, roster, matches, verification: "same-side-detail" }, { headers: { "Cache-Control": "no-store" } });
    }

    const players = await prisma.player.findMany({
      where: { campId: { in: campIds } },
      select: {
        id: true,
        campId: true,
        gameNickname: true,
        lastSyncAt: true,
        lastSyncError: true,
      },
    });
    const playerIds = players.map((player) => player.id);
    const [rows, jobs] = await Promise.all([
      prisma.match.findMany({
        where: { playerId: { in: playerIds }, playedAt: { gte: start, lt: end } },
        select: {
          id: true,
          playerId: true,
          externalId: true,
          playedAt: true,
          mode: true,
          modeName: true,
          heroName: true,
          result: true,
          kills: true,
          deaths: true,
          assists: true,
          score: true,
          mvp: true,
          mvpType: true,
          medal: true,
          side: true,
          rawJson: true,
        },
        orderBy: { playedAt: "desc" },
      }),
      prisma.syncJob.findMany({
        where: { playerId: { in: playerIds } },
        select: { playerId: true, status: true, message: true, pulled: true, startedAt: true, finishedAt: true },
        orderBy: { startedAt: "desc" },
      }),
    ]);

    const latestJob = new Map<string, (typeof jobs)[number]>();
    for (const job of jobs) if (!latestJob.has(job.playerId)) latestJob.set(job.playerId, job);
    const playerById = new Map(players.map((player) => [player.id, player]));
    const playerByCampId = new Map(players.map((player) => [player.campId, player]));
    const grouped = new Map<string, Map<string, (typeof rows)[number]>>();
    for (const row of rows) {
      let group = grouped.get(row.externalId);
      if (!group) {
        group = new Map();
        grouped.set(row.externalId, group);
      }
      group.set(row.playerId, row);
    }

    const matches = [...grouped.entries()]
      .filter(([, group]) => group.size === 5)
      .map(([externalId, group]) => {
        const gameRows = campIds.flatMap((campId) => {
          const player = playerByCampId.get(campId);
          const row = player ? group.get(player.id) : undefined;
          return row ? [row] : [];
        });
        const sides = new Set(gameRows.map((row) => row.side).filter((side): side is string => Boolean(side)));
        if (gameRows.length !== 5 || sides.size > 1) return null;
        const result = gameRows[0].result === "win" ? "win" : "loss";
        if (gameRows.some((row) => (row.result === "win" ? "win" : "loss") !== result)) return null;

        return {
          id: externalId,
          date: gameRows[0].playedAt.toISOString().slice(0, 10),
          result,
          mode: gameRows[0].modeName || ({ ranked: "排位", peak: "巅峰赛", fun: "娱乐", other: "其他" }[gameRows[0].mode] || "排位"),
          note: "五位队友在营地战报中同场",
          source: "camp",
          players: gameRows.map((row) => {
            const player = playerById.get(row.playerId)!;
            return {
              campId: player.campId,
              name: player.gameNickname,
              hero: row.heroName,
              role: roleFromMedal(row.medal),
              rating: Number(row.score || 0),
              mvp: row.mvp || row.mvpType === "mvp",
              kills: row.kills,
              deaths: row.deaths,
              assists: row.assists,
            };
          }),
        };
      })
      .filter((match) => match !== null)
      .sort((a, b) => b.date.localeCompare(a.date));

    const roster = campIds.map((campId) => {
      const player = players.find((item) => item.campId === campId);
      if (!player) return { campId, nickname: null, lastSyncAt: null, lastSyncError: null, syncStatus: "missing", syncMessage: "尚未添加" };
      const job = latestJob.get(player.id);
      return {
        campId,
        nickname: player.gameNickname,
        lastSyncAt: player.lastSyncAt?.toISOString() || null,
        lastSyncError: player.lastSyncError,
        syncStatus: job?.status || (player.lastSyncAt ? "success" : "pending"),
        syncMessage: job?.message || null,
        pulled: job?.pulled || 0,
      };
    });

    return jsonOk({ year, roster, matches }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleRouteError(err);
  }
}
