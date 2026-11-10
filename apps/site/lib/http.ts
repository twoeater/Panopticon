import { env } from "cloudflare:workers";
import { RoomService } from "./service.ts";
import { AppError, type Actor, type Database } from "./domain.ts";
import { getChatGPTUser } from "../app/chatgpt-auth";
export function service() {
  if (!env.DB)
    throw new AppError(
      503,
      "database_unavailable",
      "데이터베이스 연결이 필요합니다.",
    );
  return new RoomService(env.DB as unknown as Database);
}
export async function actorFor(
  request: Request,
  room: RoomService,
): Promise<Actor> {
  const auth = request.headers.get("authorization");
  if (auth) {
    const actor = auth.startsWith("Bearer ")
      ? await room.authenticate(auth.slice(7))
      : null;
    if (!actor)
      throw new AppError(401, "invalid_token", "실행기를 다시 연결해 주세요.");
    return actor;
  }
  const user = await getChatGPTUser();
  if (!user)
    throw new AppError(401, "sign_in_required", "ChatGPT 로그인이 필요합니다.");
  return {
    id: user.userId,
    name: user.displayName || user.email || "사용자",
    kind: "user",
  };
}
export async function jsonBody(request: Request) {
  const text = await request.text();
  if (text.length > 180000)
    throw new AppError(413, "too_large", "요청이 너무 큽니다.");
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new AppError(400, "invalid_json", "올바른 JSON 요청이 필요합니다.");
  }
}
export function errorResponse(error: unknown) {
  const expected = error instanceof AppError;
  if (!expected)
    console.error(
      "Panopticon request failed",
      error instanceof Error ? error.message : "unknown",
    );
  return Response.json(
    {
      error: expected ? error.message : "서버 요청을 처리하지 못했습니다.",
      code: expected ? error.code : "internal_error",
    },
    {
      status: expected ? error.status : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
