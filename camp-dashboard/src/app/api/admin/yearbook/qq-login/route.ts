import { requireAdmin } from "@/lib/admin-auth";
import { handleRouteError, jsonError, jsonOk } from "@/lib/api";
import { getCampAuthStatus, writeCampAuth } from "@/lib/camp/auth-store";
import { createQqLoginSession, pollQqLoginOnce, removeQqLoginSession } from "@/lib/camp/qq-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const polling = new Set<string>();
const recentResults = new Map<string, { at: number; payload: Record<string, unknown> }>();
const POLL_COOLDOWN_MS = 2_000;

/** Admin-only QQ QR login for yearbook publishing. */
export async function POST() {
  try {
    await requireAdmin();
    const session = await createQqLoginSession();
    return jsonOk({
      taskId: session.taskId,
      qrcodeBase64: session.qrcodeBase64,
      expiresAt: session.expiresAt,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const taskId = new URL(req.url).searchParams.get("taskId")?.trim();
    if (!taskId || !/^[0-9a-f-]{36}$/i.test(taskId)) return jsonError("二维码任务无效", 400);

    const recent = recentResults.get(taskId);
    if (polling.has(taskId) || (recent && Date.now() - recent.at < POLL_COOLDOWN_MS)) {
      return jsonOk(recent?.payload || { status: "waiting" }, { headers: { "Cache-Control": "no-store" } });
    }

    polling.add(taskId);
    try {
      const result = await pollQqLoginOnce(taskId);
      if (result.status === "success") {
        writeCampAuth(result.account);
        const payload = { status: "success", auth: getCampAuthStatus() };
        recentResults.set(taskId, { at: Date.now(), payload });
        return jsonOk(payload, { headers: { "Cache-Control": "no-store" } });
      }
      const payload = {
        status: result.status,
        message: "message" in result ? result.message : undefined,
      };
      recentResults.set(taskId, { at: Date.now(), payload });
      return jsonOk(payload, { headers: { "Cache-Control": "no-store" } });
    } finally {
      polling.delete(taskId);
    }
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    await requireAdmin();
    const taskId = new URL(req.url).searchParams.get("taskId")?.trim();
    if (!taskId || !/^[0-9a-f-]{36}$/i.test(taskId)) return jsonError("二维码任务无效", 400);
    removeQqLoginSession(taskId);
    recentResults.delete(taskId);
    return jsonOk({ canceled: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleRouteError(err);
  }
}
