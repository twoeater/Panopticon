import { actorFor, service, jsonBody, errorResponse } from "../../lib/http";
import { handleMcp } from "../../lib/mcp.ts";
import { AppError } from "../../lib/domain.ts";
export async function POST(request: Request) {
  try {
    const room = service(),
      actor = await actorFor(request, room);
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) throw new AppError(403, 'invalid_origin', '요청 출처를 확인할 수 없습니다.');
    const result = await handleMcp(room, actor, await jsonBody(request));
    return result === null
      ? new Response(null, { status: 202 })
      : Response.json(result, {headers: {'Cache-Control': 'no-store'}});
  } catch (error) {
    return errorResponse(error);
  }
}
