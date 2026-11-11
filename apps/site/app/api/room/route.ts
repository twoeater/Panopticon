import { actorFor, service, jsonBody, errorResponse } from "../../../lib/http";
import { AppError } from "../../../lib/domain.ts";
import { rateLimit } from "../../../lib/security.ts";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request),
      room = service();
    if (body.action === "pair_claim") {
      await rateLimit(
        room.db,
        `pair:${request.headers.get("cf-connecting-ip") || "unknown"}`,
        30,
        60000,
      );
      return Response.json(await room.pair(body.args?.code, body.args?.name), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const actor = await actorFor(request, room);
    if (
      actor.kind === "user" &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      throw new AppError(
        403,
        "invalid_origin",
        "요청 출처를 확인할 수 없습니다.",
      );
    return Response.json(await room.call(actor, body.action, body.args), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function GET(request: Request) {
  try {
    const room = service(),
      actor = await actorFor(request, room),
      url = new URL(request.url),
      action = url.searchParams.get("action") || "bootstrap";
    if (!["bootstrap", "snapshot", "job_state", "goal_list", "goal_read", "goal_history"].includes(action))
      throw new AppError(
        405,
        "read_only",
        "GET은 조회에만 사용할 수 있습니다.",
      );
    return Response.json(
      await room.call(actor, action, Object.fromEntries(url.searchParams)),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
