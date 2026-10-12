import { CampApiError, getHeroWinRateByPosition } from "@/lib/camp/camp-api";
import { handleRouteError, jsonError, jsonOk } from "@/lib/api";
import { isLocalYearbookRequest } from "@/lib/yearbook/local-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const roleNames: Record<number, string> = {
  1: "对抗路",
  2: "中路",
  3: "发育路",
  4: "游走",
  5: "打野",
};
const cache = new Map<number, { expiresAt: number; payload: Record<string, unknown> }>();
const CACHE_MS = 10 * 60 * 1000;

export async function GET(req: Request) {
  if (!isLocalYearbookRequest(req)) return jsonError("仅允许本机访问", 403);
  try {
    const url = new URL(req.url);
    const position = Number(url.searchParams.get("position") || "1");
    const refresh = url.searchParams.get("refresh") === "1";
    if (!roleNames[position]) return jsonError("分路参数无效", 400);

    const cached = cache.get(position);
    if (!refresh && cached && cached.expiresAt > Date.now()) {
      return jsonOk(cached.payload, { headers: { "Cache-Control": "no-store" } });
    }

    const response = await getHeroWinRateByPosition(position, 1);
    const data =
      response.data && typeof response.data === "object"
        ? (response.data as Record<string, unknown>)
        : {};
    const payload = {
      role: roleNames[position],
      position,
      segment: 1,
      updateTime: data.updateTime ?? null,
      heroes: Array.isArray(data.list) ? data.list : [],
      fetchedAt: new Date().toISOString(),
    };
    cache.set(position, { expiresAt: Date.now() + CACHE_MS, payload });
    return jsonOk(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof CampApiError) return jsonError(err.message, 503);
    return handleRouteError(err);
  }
}
