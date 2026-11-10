export type { Provider } from "./providers.ts";
export type Phase = "chat" | "review" | "revise" | "summary" | "heartbeat";
export interface Actor {
  id: string;
  name: string;
  kind: "user" | "device";
  deviceId?: string;
}
export interface Participant {
  id: string;
  channelId: string;
  ownerId: string;
  deviceId: string;
  profileId: string;
  name: string;
  provider: string;
  onlineAt: number;
  enabled: number;
}
export interface Message {
  id: string;
  seq: number;
  channelId: string;
  ownerId: string;
  participantId: string | null;
  author: string;
  kind: "human" | "llm";
  text: string;
  replyTo: string | null;
  roundId: string | null;
  phase: string;
  evidence: string;
  createdAt: number;
}
export interface Channel {
  id: string;
  name: string;
  ownerId: string;
  situation: string;
  situationVersion: number;
  heartbeatEnabled: number;
  heartbeatSeconds: number;
  nextHeartbeatAt: number;
  paused: number;
  createdAt: number;
}
export interface Round {
  id: string;
  channelId: string;
  requestorId: string;
  triggerId: string | null;
  kind: "chat" | "verify" | "heartbeat";
  phase: Phase;
  status: string;
  roster: string;
  createdAt: number;
}
export interface Job {
  id: string;
  roundId: string;
  channelId: string;
  participantId: string;
  phase: Phase;
  status: string;
  createdAt: number;
  startedAt: number | null;
  error: string | null;
}
export interface TurnJob {
  job: Job;
  round: Round;
  channel: Channel;
  participant: Participant;
  trigger: Message | null;
  history: Message[];
  phaseMessages: Message[];
}
export interface DbStatement {
  bind(...args: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface Database {
  prepare(sql: string): DbStatement;
  batch(statements: DbStatement[]): Promise<unknown[]>;
}
export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function requiredString(
  value: unknown,
  name: string,
  max = 8000,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AppError(
      400,
      "invalid_input",
      `${name}: 1~${max}자 문자열이 필요합니다.`,
    );
  return value.trim();
}
export const id = () => crypto.randomUUID();
export const now = () => Date.now();
