import { z } from "zod";
import { requireAdmin } from "@/lib/admin-auth";
import { handleRouteError, jsonOk } from "@/lib/api";
import { appendManualYearbookMatch } from "@/lib/yearbook/publisher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const playerSchema = z.object({
  name: z.string().trim().min(1).max(40),
  accountName: z.string().trim().max(40).optional(),
  hero: z.string().trim().max(40).optional(),
  role: z.string().trim().max(20).optional(),
  rating: z.number().min(0).max(20),
  mvp: z.boolean(),
});

const schema = z.object({
  date: z.string().regex(/^2026-\d{2}-\d{2}$/, "日期必须在 2026 年内").refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "请输入有效日期"),
  result: z.enum(["win", "loss"]),
  mode: z.string().trim().min(1).max(40),
  note: z.string().trim().max(120).optional(),
  players: z.array(playerSchema).length(5),
});

/** Add one manually recorded five-stack match to the public yearbook. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const input = schema.parse(await req.json());
    const published = await appendManualYearbookMatch(input);
    return jsonOk(published, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleRouteError(err);
  }
}

