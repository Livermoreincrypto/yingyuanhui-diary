import { handleRouteError, jsonError, jsonOk } from "@/lib/api";
import { isLocalYearbookRequest } from "@/lib/yearbook/local-only";
import {
  createWechatLoginSession,
  getCampAuthStatus,
  pollWechatLoginOnce,
  removeWechatLoginSession,
  writeCampAuth,
} from "@/lib/camp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const polling = new Set<string>();
const recentResults = new Map<string, { at: number; payload: Record<string, unknown> }>();
const POLL_COOLDOWN_MS = 12_000;

export async function POST(req: Request) {
  if (!isLocalYearbookRequest(req)) return jsonError("仅允许本机访问", 403);
  try {
    const session = await createWechatLoginSession();
    return jsonOk({ taskId: session.taskId, qrcodeBase64: session.qrcodeBase64, expiresAt: session.expiresAt });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function GET(req: Request) {
  if (!isLocalYearbookRequest(req)) return jsonError("仅允许本机访问", 403);
  const taskId = new URL(req.url).searchParams.get("taskId")?.trim();
  if (!taskId) return jsonError("缺少 taskId", 400);
  const recent = recentResults.get(taskId);
  if (polling.has(taskId) || (recent && Date.now() - recent.at < POLL_COOLDOWN_MS)) {
    return jsonOk(recent?.payload || { status: "waiting" });
  }
  polling.add(taskId);
  try {
    const result = await pollWechatLoginOnce(taskId);
    if (result.status === "success") {
      writeCampAuth(result.account);
      const payload = { status: "success", auth: getCampAuthStatus() };
      recentResults.set(taskId, { at: Date.now(), payload });
      return jsonOk(payload);
    }
    const payload = {
      status: result.status,
      message: "message" in result ? result.message : undefined,
    };
    recentResults.set(taskId, { at: Date.now(), payload });
    return jsonOk(payload);
  } catch (err) {
    return handleRouteError(err);
  } finally {
    polling.delete(taskId);
  }
}

export async function DELETE(req: Request) {
  if (!isLocalYearbookRequest(req)) return jsonError("仅允许本机访问", 403);
  const taskId = new URL(req.url).searchParams.get("taskId")?.trim();
  if (!taskId) return jsonError("缺少 taskId", 400);
  removeWechatLoginSession(taskId);
  return jsonOk({ canceled: true });
}
