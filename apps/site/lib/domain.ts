export type { Provider } from "./providers.ts";
export type GoalPhase = "goal_discuss" | "goal_compact" | "goal_propose" | "goal_vote";
export type Phase = "chat" | "review" | "revise" | "summary" | "heartbeat" | GoalPhase;
export interface Actor {
  id: string;
  name: string;
  kind: "user" | "device";
  deviceId?: string;
}
export interface Participant {
  ownerName?: string;
  goalsSupported?: number;
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
  goalId?: string | null;
  goalTitle?: string | null;
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
  mentions: string;
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
  heartbeatParticipants: number; // 0 means every eligible online participant.
  nextHeartbeatAt: number;
  paused: number;
  createdAt: number;
}
export interface Round {
  id: string;
  channelId: string;
  requestorId: string;
  triggerId: string | null;
  kind: "chat" | "verify" | "heartbeat" | "goal";
  goalId?: string | null;
  goalRevision?: number;
  contextThrough?: number;
  phase: Phase;
  status: string;
  roster: string;
  targetParticipantIds: string;
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
  goal?: GoalContext;
  job: Job;
  round: Round;
  channel: Channel;
  participant: Participant;
  trigger: Message | null;
  history: Message[];
  phaseMessages: Message[];
}
export interface Goal {
  id: string; channelId: string; creatorId: string; title: string; instructions: string;
  deadline: number; finalDeadline: number; intervalSeconds: number;
  status: "active" | "finalizing" | "completed" | "cancelled";
  phase: GoalPhase | "waiting" | "held";
  roster: string; revision: number; mutationId: string; cycle: number;
  roundId: string | null; proposalId: string | null; summary: string;
  summaryThrough: number; issues: string; cutoffSeq: number | null;
  afterCompact: GoalPhase; nextRunAt: number; lastError: string | null;
  outcome: string | null; createdAt: number; completedAt: number | null;
}
export type GoalMember = Pick<Participant,"id"|"name"|"ownerId"|"deviceId"|"provider"> & {ownerName?:string};
export interface GoalProposal { id: string; goalId: string; version: number; text: string; sourceSeq: number; createdAt: number }
export interface GoalVote { id: string; goalId: string; proposalId: string; participantId: string; decision: "agree"|"disagree"|"abstain"; reason: string; conclusion: string; createdAt: number }
export interface GoalSummary {
  id: string; title: string; creatorId: string; status: Goal["status"]; phase: Goal["phase"];
  deadline: number; finalDeadline: number; cycle: number; outcome: string | null;
  lastError: string | null; participantCount: number; agreeCount: number;
}
export interface GoalContext {
  goal: Goal; participants: GoalMember[]; proposal: GoalProposal | null;
  opinions: GoalVote[]; votes: GoalVote[]; positions: Message[]; historyComplete: boolean;
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
