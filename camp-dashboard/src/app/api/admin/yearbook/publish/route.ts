import { z } from "zod";
import { requireAdmin } from "@/lib/admin-auth";
import { handleRouteError, jsonOk } from "@/lib/api";
import { buildYearbookData, publishYearbookData } from "@/lib/yearbook/publisher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  year: z.number().int().min(2020).max(2100).default(2026),
  campId: z.string().regex(/^\d{5,15}$/, "请输入 5 至 15 位数字的王者营地 ID"),
});

/** Refresh the requested Camp account, merge verified five-stack matches, and publish the static JSON. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const { year, campId } = schema.parse(await req.json());
    const data = await buildYearbookData(year, campId);
    const published = await publishYearbookData(data);
    return jsonOk({
      year,
      fetchedMatchCount: data.matches.length,
      ...published,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleRouteError(err);
  }
}
