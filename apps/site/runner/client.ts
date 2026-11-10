import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
export type Auth = {
  deviceId: string;
  token: string;
  ownerId: string;
  ownerName: string;
  serverUrl: string;
};
export class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export async function loadAuth(config: Config): Promise<Auth> {
  let auth: Auth;
  try {
    auth = JSON.parse(
      await readFile(path.join(config.dataDir, "auth.json"), "utf8"),
    );
  } catch {
    throw new Error("먼저 npm run runner -- pair 를 실행해 주세요.");
  }
  if (auth.serverUrl !== config.serverUrl)
    throw new Error("서버 주소가 바뀌었습니다. 새 서버에서 다시 연결하세요.");
  return auth;
}
export async function call(
  config: Config,
  auth: Auth | null,
  action: string,
  args: unknown = {},
): Promise<any> {
  const response = await fetch(`${config.serverUrl}/api/room`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
    body: JSON.stringify({ action, args }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new RequestError(
      response.status,
      "서버 응답이 JSON이 아닙니다. 주소와 배포 상태를 확인하세요.",
    );
  }
  if (!response.ok)
    throw new RequestError(
      response.status,
      data.error?.message || data.error || `서버 오류 ${response.status}`,
    );
  return data;
}
