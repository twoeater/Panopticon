import { AppError, type Database } from "./domain.ts";
const encoder = new TextEncoder();
export const hex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export async function digest(text: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}
export function secret() {
  return hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}
export async function passwordHash(
  password: string,
  salt = secret().slice(0, 32),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: 100000,
    },
    key,
    256,
  );
  return `${salt}:${hex(bits)}`;
}
export async function verifyPassword(password: string, stored: string) {
  const actual = await passwordHash(password, stored.split(":")[0]);
  let diff = actual.length ^ stored.length;
  for (let i = 0; i < stored.length; i++)
    diff |= stored.charCodeAt(i) ^ (actual.charCodeAt(i) || 0);
  return diff === 0;
}
export async function rateLimit(
  db: Database,
  key: string,
  max: number,
  windowMs: number,
) {
  const time = Date.now();
  await db.prepare('DELETE FROM rateBuckets WHERE expiresAt<?').bind(time - 86400000).run();
  const bucket = `${key}:${Math.floor(time / windowMs)}`;
  const row = await db
    .prepare(
      "INSERT INTO rateBuckets (key, count, expiresAt) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
    )
    .bind(bucket, time + windowMs)
    .first<{ count: number }>();
  if (!row || row.count > max)
    throw new AppError(429, "rate_limited", "잠시 후 다시 시도해 주세요.");
}
