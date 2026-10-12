import { after } from "next/server";
import { z } from "zod";
import { handleRouteError, jsonOk } from "@/lib/api";
import { lookupPlayerByCampId, startPlayerSync } from "@/lib/player-service";
import { getWzryApiClient } from "@/lib/wzry-api";
import { isLocalYearbookRequest } from "@/lib/yearbook/local-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  campIds: z.array(z.string().regex(/^(?:\d{5,15})?$/, "营地 ID 应为 5–15 位数字"))
    .length(5, "请保留五个成员位置")
    .refine((ids) => ids.some(Boolean), "至少填写一位队友的营地 ID")
    .refine((ids) => new Set(ids.filter(Boolean)).size === ids.filter(Boolean).length, "营地 ID 不能重复"),
  nicknames: z.array(z.string().trim().min(1).max(40)).length(5, "请填写五位队友昵称"),
});

/** 本机年鉴：核对 ID 对应的游戏昵称后排队同步，避免同时请求营地接口。 */
export async function POST(req: Request) {
  if (!isLocalYearbookRequest(req)) return Response.json({ ok: false, error: "仅允许本机访问" }, { status: 403 });
  try {
    const body = schema.parse(await req.json());
    const pending = [];
    const players = [];
    const resolvedCampIds = ["", "", "", "", ""];
    for (let slot = 0; slot < body.campIds.length; slot += 1) {
      const campId = body.campIds[slot];
      if (!campId) continue;
      const hits = await getWzryApiClient().searchByNickname(campId);
      const actualNickname = hits[0]?.gameNickname || "";
      const rosterSlot = body.nicknames.indexOf(actualNickname);
      if (rosterSlot < 0) {
        return Response.json({
          ok: false,
          error: `营地 ID ${campId} 对应的游戏昵称是“${actualNickname || "未知"}”，与填写的五位队友昵称不一致。请检查 ID 或昵称。`,
        }, { status: 400 });
      }
      if (resolvedCampIds[rosterSlot]) {
        return Response.json({ ok: false, error: `“${actualNickname}”对应了重复的营地 ID` }, { status: 400 });
      }
      const { data, pendingSync } = await lookupPlayerByCampId(campId);
      players.push({ campId, nickname: data.player.gameNickname });
      resolvedCampIds[rosterSlot] = campId;
      if (pendingSync) pending.push(pendingSync);
    }

    if (pending.length) {
      after(async () => {
        for (const job of pending) {
          try {
            await startPlayerSync(job);
          } catch {
            // SyncJob 保存失败状态，避免在响应中暴露上游认证信息。
          }
        }
      });
    }

    return jsonOk({ players, queued: pending.length, campIds: resolvedCampIds, missing: body.nicknames.filter((_, i) => !resolvedCampIds[i]) });
  } catch (err) {
    return handleRouteError(err);
  }
}
