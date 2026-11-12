import { AppError, id, now, requiredString, type Actor, type Channel, type DbStatement, type Goal, type GoalContext, type GoalMember, type GoalPhase, type GoalProposal, type GoalSummary, type GoalVote, type Job, type Message, type Participant, type Round } from "./domain.ts";
import { digest, rateLimit } from "./security.ts";
import { goalMajorityThreshold } from "./goal-protocol.ts";
import type { RoomService } from "./service.ts";

const live = (g: Goal) => g.status === "active" || g.status === "finalizing";
const roster = (g: Goal): GoalMember[] => JSON.parse(g.roster);
const integer = (value: unknown, min: number, max: number, label: string) => {
  if(typeof value==="string"&&/^\d+$/.test(value))value=Number(value);
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new AppError(400,"invalid_goal",label+" 값을 확인해 주세요.");
  return Number(value);
};
export class Goals {
  room: RoomService;
  constructor(room: RoomService) { this.room=room; }
  statement(sql: string,...args: unknown[]) { return this.room.db.prepare(sql).bind(...args); }
  async get(goalId: string, channelId?: string) {
    const g=await this.room.one<Goal>("SELECT * FROM goals WHERE id=?",goalId);
    if(!g || (channelId && g.channelId!==channelId)) throw new AppError(404,"goal_not_found","목표를 찾을 수 없습니다.");
    return g;
  }
  async authorize(actor: Actor,args: Record<string,unknown>) {
    const channel=await this.room.member(actor,requiredString(args.channelId,"채널",100));
    const goal=await this.get(requiredString(args.goalId,"목표",100),channel.id);
    return {channel,goal};
  }
  async manage(actor: Actor,channel: Channel,g: Goal) {
    this.room.user(actor);
    if(actor.id!==g.creatorId && actor.id!==channel.ownerId)
      throw new AppError(403,"goal_owner_required","목표 생성자와 방장만 관리할 수 있습니다.");
  }
  async eligible(channelId: string): Promise<GoalMember[]> {
    const candidates=await this.room.all<Participant & {ownerName:string}>("SELECT p.*,m.name ownerName FROM participants p JOIN devices d ON d.id=p.deviceId JOIN members m ON m.channelId=p.channelId AND m.userId=p.ownerId WHERE p.channelId=? AND p.enabled=1 AND p.goalsSupported=1 AND p.onlineAt>? AND d.revoked=0 AND m.banned=0 ORDER BY p.rowid",channelId,now()-30000);
    return candidates.map(p=>({id:p.id,name:p.name,ownerId:p.ownerId,ownerName:p.ownerName,deviceId:p.deviceId,provider:p.provider}));
  }
  async admit(g: Goal,time: number) {
    // Membership only grows during discussion. Disconnecting cannot turn dissent into consensus.
    if(g.status!=="active" || time>=g.deadline)return g;
    const members=roster(g);
    const added=(await this.eligible(g.channelId)).filter(p=>!members.some(m=>m.id===p.id));
    if(!added.length || now()>=g.deadline)return g;
    return this.change(g,{
      roster:JSON.stringify([...members,...added]),
      phase:g.phase==="held"?"held":"waiting",roundId:null,proposalId:null,
      nextRunAt:members.length?Math.max(g.nextRunAt,time+g.intervalSeconds*1000):time,
      lastError:g.phase==="held"?g.lastError:"새 AI "+added.length+"명이 공통 과제에 합류했습니다. 새 참가자와 함께 다음 회차를 진행합니다.",
    });
  }
  // All transition side effects are conditional on the winning compare-and-swap token.
  async change(g: Goal,patch: Partial<Goal>,extra: (guard: string,token: string)=>DbStatement[]=()=>[]) {
    const token=id(), entries=Object.entries(patch);
    const guard="EXISTS (SELECT 1 FROM goals WHERE id='"+g.id.replaceAll("'","''")+"' AND mutationId=?)";
    await this.room.db.batch([
      this.statement("UPDATE goals SET revision=revision+1,mutationId=?,"+entries.map(([k])=>k+"=?").join(",")+" WHERE id=? AND revision=?",token,...entries.map(([,v])=>v),g.id,g.revision),
      this.statement("UPDATE jobs SET status='cancelled',error='목표 단계가 변경되었습니다.' WHERE roundId IN (SELECT id FROM rounds WHERE goalId=?) AND status IN ('pending','running') AND "+guard,g.id,token),
      this.statement("UPDATE rounds SET status='completed' WHERE goalId=? AND status='active' AND "+guard,g.id,token),
      ...extra(guard,token),
    ]);
    return this.get(g.id);
  }
  async start(actor: Actor,args: Record<string,unknown>) {
    this.room.user(actor);
    const channel=await this.room.member(actor,requiredString(args.channelId,"채널",100));
    const goalId=await digest("goal:"+actor.id+":"+channel.id+":"+requiredString(args.requestId,"요청 ID",100));
    if(await this.room.one("SELECT id FROM deletedGoals WHERE id=?",goalId))
      throw new AppError(410,"goal_deleted","삭제된 목표입니다. 새 목표는 새 요청으로 시작해 주세요.");
    const previous=await this.room.one<Goal>("SELECT * FROM goals WHERE id=?",goalId);
    if(previous) return previous;
    await this.tick(channel);
    if(channel.paused) throw new AppError(409,"paused","채널 일시정지를 해제한 뒤 시작해 주세요.");
    if(await this.active(channel.id)) throw new AppError(409,"goal_exists","진행 중인 목표를 먼저 완료하거나 취소해 주세요.");
    const title=requiredString(args.title,"목표 제목",120), instructions=requiredString(args.instructions,"목표 지시",16000);
    const deadline=integer(args.deadline,now()+1000,8640000000000000-600000,"마감");
    const interval=integer(args.intervalSeconds??60,10,86400,"토의 간격");
    // Goals belong to the whole channel. Legacy participantIds cannot narrow the audience.
    const members=await this.eligible(channel.id);
    await rateLimit(this.room.db,"goal-start:"+actor.id,10,60000);
    const time=now();
    try {
      await this.room.db.batch([
        this.statement("INSERT INTO goals (id,channelId,creatorId,title,instructions,deadline,finalDeadline,intervalSeconds,roster,nextRunAt,createdAt) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM deletedGoals WHERE id=?)",goalId,channel.id,actor.id,title,instructions,deadline,deadline+600000,interval,JSON.stringify(members),time,time,goalId),
        this.statement("INSERT INTO messages (id,channelId,ownerId,author,kind,text,phase,goalId,createdAt) SELECT ?,?,?,?,'human',?,'goal_notice',?,? WHERE EXISTS (SELECT 1 FROM goals WHERE id=?)","goal-start:"+goalId,channel.id,actor.id,actor.name,instructions,goalId,time,goalId),
        this.statement("UPDATE jobs SET status='cancelled',error='목표 토의 중에는 자동 수다를 중단합니다.' WHERE channelId=? AND status IN ('pending','running') AND roundId IN (SELECT id FROM rounds WHERE kind='heartbeat')",channel.id),
        this.statement("UPDATE rounds SET status='cancelled' WHERE channelId=? AND kind='heartbeat' AND status='active'",channel.id),
      ]);
    } catch(error) {
      const existing=await this.room.one<Goal>("SELECT * FROM goals WHERE id=?",goalId);
      if(existing) return existing;
      if(await this.active(channel.id)) throw new AppError(409,"goal_exists","다른 목표가 먼저 시작되었습니다.");
      throw error;
    }
    await this.tick(channel);
    return this.get(goalId);
  }
  async active(channelId: string) {
    return this.room.one<Goal>("SELECT * FROM goals WHERE channelId=? AND status IN ('active','finalizing')",channelId);
  }
  async overview(g: Goal): Promise<GoalSummary> {
    const count=await this.room.one<{n:number}>("SELECT count(*) n FROM goalVotes WHERE goalId=? AND proposalId=? AND decision='agree'",g.id,g.proposalId);
    return {id:g.id,title:g.title,creatorId:g.creatorId,status:g.status,phase:g.phase,deadline:g.deadline,finalDeadline:g.finalDeadline,cycle:g.cycle,outcome:g.outcome,lastError:g.lastError,participantCount:roster(g).length,agreeCount:count?.n||0};
  }
  async list(actor: Actor,args: Record<string,unknown>) {
    const channel=await this.room.member(actor,requiredString(args.channelId,"채널",100));
    await this.tick(channel);
    const offset=integer(args.offset??0,0,1000000,"페이지");
    const goals=await this.room.all<Goal>("SELECT * FROM goals WHERE channelId=? ORDER BY createdAt DESC,id DESC LIMIT 21 OFFSET ?",channel.id,offset);
    return {goals:await Promise.all(goals.slice(0,20).map(g=>this.overview(g))),nextOffset:goals.length>20?offset+20:null};
  }
  async detail(g: Goal): Promise<GoalContext> {
    const proposal=g.proposalId ? await this.room.one<GoalProposal>("SELECT * FROM goalProposals WHERE id=?",g.proposalId) : null;
    const votes=proposal?await this.room.all<GoalVote>("SELECT * FROM goalVotes WHERE proposalId=? ORDER BY participantId",proposal.id):[];
    const opinions=await this.room.all<GoalVote>("SELECT v.* FROM goalVotes v WHERE v.goalId=? AND NOT EXISTS (SELECT 1 FROM goalVotes newer WHERE newer.goalId=v.goalId AND newer.participantId=v.participantId AND (newer.createdAt>v.createdAt OR (newer.createdAt=v.createdAt AND newer.rowid>v.rowid)))",g.id);
    const positions=await this.room.all<Message>("SELECT m.* FROM messages m WHERE m.goalId=? AND m.participantId IS NOT NULL AND m.phase IN ('goal_discuss','goal_conclusion') AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.goalId=m.goalId AND newer.participantId=m.participantId AND newer.phase IN ('goal_discuss','goal_conclusion') AND newer.seq>m.seq)",g.id);
    return {goal:g,participants:roster(g),proposal,votes,opinions,positions,historyComplete:true};
  }
  async read(actor: Actor,args: Record<string,unknown>) {
    let {channel,goal}=await this.authorize(actor,args);
    await this.tick(channel); goal=await this.get(goal.id);
    const offset=integer(args.proposalOffset??0,0,1000000,"초안 페이지");
    const proposals=await this.room.all<GoalProposal>("SELECT * FROM goalProposals WHERE goalId=? ORDER BY version DESC LIMIT 21 OFFSET ?",goal.id,offset);
    const selected=typeof args.proposalId==="string"?await this.room.one<GoalProposal>("SELECT * FROM goalProposals WHERE goalId=? AND id=?",goal.id,args.proposalId):null;
    const checkpoint=await this.room.one("SELECT * FROM goalCheckpoints WHERE goalId=? ORDER BY throughSeq DESC LIMIT 1",goal.id);
    return {...await this.detail(goal),checkpoint,proposals:proposals.slice(0,20),nextProposalOffset:proposals.length>20?offset+20:null,selectedProposal:selected,selectedVotes:selected?await this.room.all<GoalVote>("SELECT * FROM goalVotes WHERE proposalId=?",selected.id):[]};
  }
  async history(actor: Actor,args: Record<string,unknown>) {
    const {goal}=await this.authorize(actor,args);
    const before=integer(args.before??Number.MAX_SAFE_INTEGER,1,Number.MAX_SAFE_INTEGER,"이전 기록");
    const after=integer(args.after??0,0,Number.MAX_SAFE_INTEGER,"이후 기록");
    const limit=integer(args.limit??100,1,100,"기록 개수");
    const records=await this.room.all<Message>("SELECT m.*,g.title goalTitle FROM messages m JOIN goals g ON g.id=m.goalId WHERE m.goalId=? AND m.seq<? AND m.seq>? ORDER BY m.seq DESC LIMIT ?",goal.id,before,after,limit+1);
    const messages=records.slice(0,limit).reverse();
    return {messages,nextBefore:records.length>limit?messages[0].seq:null};
  }
  async post(actor: Actor,args: Record<string,unknown>,messageId: string,author: string,kind: "human"|"llm") {
    const {channel}=await this.authorize(actor,args);
    const text=requiredString(args.text,"목표 보충 의견",16000);
    for(let attempt=0;attempt<3;attempt++) {
      const prior=await this.room.one<Message>("SELECT * FROM messages WHERE id=?",messageId);
      if(prior) return prior;
      await this.tick(channel);
      const g=await this.get(String(args.goalId),channel.id);
      if(g.status!=="active" || now()>=g.deadline) throw new AppError(409,"goal_closed","토의가 마감되어 보충 의견을 제출할 수 없습니다.");
      await this.change(g,{phase:"waiting",roundId:null,proposalId:null,nextRunAt:now()+g.intervalSeconds*1000,lastError:null},(guard,token)=>[
        this.statement("INSERT OR IGNORE INTO messages (id,channelId,ownerId,author,kind,text,phase,goalId,createdAt) SELECT ?,?,?,?,?,?,'goal_discuss',?,? WHERE "+guard,messageId,channel.id,actor.id,author,kind,text,g.id,now(),token),
      ]);
    }
    const saved=await this.room.one<Message>("SELECT * FROM messages WHERE id=?",messageId);
    if(!saved) throw new AppError(409,"goal_changed","목표 상태가 변경되었습니다. 다시 보내 주세요.");
    return saved;
  }
  async cancel(actor: Actor,args: Record<string,unknown>) {
    const {channel,goal}=await this.authorize(actor,args); await this.manage(actor,channel,goal);
    let g=goal;
    for(let attempt=0;attempt<3&&live(g);attempt++)g=await this.change(g,{status:"cancelled",completedAt:now(),outcome:"cancelled",roundId:null,lastError:null});
    if(live(g))throw new AppError(409,"goal_changed","목표 상태가 변경되었습니다. 다시 취소해 주세요.");
    return g;
  }
  async retry(actor: Actor,args: Record<string,unknown>) {
    const {channel,goal}=await this.authorize(actor,args); await this.manage(actor,channel,goal);
    await this.tick(channel);
    const current=await this.get(goal.id);
    if(!live(current) || current.phase!=="held") throw new AppError(409,"not_held","보류 중인 목표만 다시 시도할 수 있습니다.");
    await this.change(current,{phase:"waiting",roundId:null,proposalId:null,lastError:null,nextRunAt:now()});
    await this.tick(channel); return this.get(goal.id);
  }
  async remove(actor: Actor,args: Record<string,unknown>) {
    this.room.user(actor);
    const channel=await this.room.member(actor,requiredString(args.channelId,"채널",100));
    const goalId=requiredString(args.goalId,"목표",100);
    const g=await this.room.one<Goal>("SELECT * FROM goals WHERE id=? AND channelId=?",goalId,channel.id);
    const deleted=await this.room.one<{creatorId:string}>("SELECT creatorId FROM deletedGoals WHERE id=? AND channelId=?",goalId,channel.id);
    if(!g&&!deleted)throw new AppError(404,"goal_not_found","목표를 찾을 수 없습니다.");
    if(actor.id!==(g??deleted)!.creatorId&&actor.id!==channel.ownerId)
      throw new AppError(403,"goal_owner_required","목표 생성자와 방장만 삭제할 수 있습니다.");
    if(!g)return {ok:true,duplicate:true};
    if(live(g))throw new AppError(409,"goal_live","진행 중인 목표는 먼저 취소한 뒤 삭제해 주세요.");
    // Atomic content removal, plus a content-free tombstone for request deduplication.
    await this.room.db.batch([
      this.statement("INSERT OR IGNORE INTO deletedGoals (id,channelId,creatorId,deletedAt) SELECT id,channelId,creatorId,? FROM goals WHERE id=? AND status IN ('completed','cancelled')",now(),goalId),
      this.statement("DELETE FROM jobs WHERE roundId IN (SELECT id FROM rounds WHERE goalId=?)",goalId),
      this.statement("DELETE FROM rounds WHERE goalId=?",goalId),
      this.statement("DELETE FROM messages WHERE goalId=?",goalId),
      this.statement("DELETE FROM goalVotes WHERE goalId=?",goalId),
      this.statement("DELETE FROM goalProposals WHERE goalId=?",goalId),
      this.statement("DELETE FROM goalCheckpoints WHERE goalId=?",goalId),
      this.statement("UPDATE channels SET historyRevision=historyRevision+1 WHERE id=? AND EXISTS (SELECT 1 FROM goals WHERE id=?)",channel.id,goalId),
      this.statement("DELETE FROM goals WHERE id=?",goalId),
    ]);
    return {ok:true};
  }
  async latestSeq(g: Goal) {
    const row=await this.room.one<{seq:number}>("SELECT COALESCE(MAX(seq),0) seq FROM messages WHERE goalId=? AND seq<=?",g.id,g.cutoffSeq??Number.MAX_SAFE_INTEGER);
    return row!.seq;
  }
  async next(g: Goal,target: GoalPhase,cycle=g.cycle) {
    let phase=target,through=await this.latestSeq(g);
    if((target==="goal_discuss" || target==="goal_propose") && g.summaryThrough<through && !(target==="goal_discuss" && g.cycle===0)) {
      phase="goal_compact";
      const chunk=await this.room.all<Message>("SELECT * FROM messages WHERE goalId=? AND seq>? AND seq<=? ORDER BY seq LIMIT 20",g.id,g.summaryThrough,through);
      let length=0; through=chunk[0]?.seq??g.summaryThrough;
      for(const m of chunk) { if(length && length+m.text.length>16000)break; length+=m.text.length;through=m.seq; }
    }
    const members=roster(g), offset=(Math.max(cycle,1)-1)%members.length;
    const online=await this.room.all<{id:string}>("SELECT p.id FROM participants p JOIN devices d ON d.id=p.deviceId WHERE p.channelId=? AND p.enabled=1 AND p.goalsSupported=1 AND p.onlineAt>? AND d.revoked=0",g.channelId,now()-30000);
    const ordered=[...members.slice(offset),...members.slice(0,offset)];
    let coordinator=ordered.find(p=>online.some(o=>o.id===p.id))||ordered[0];
    if (phase==="goal_compact") {
      const channel=await this.room.one<Channel>("SELECT * FROM channels WHERE id=?",g.channelId);
      if (channel?.goalSummaryParticipantId) {
        const fixed=members.find(p=>p.id===channel.goalSummaryParticipantId);
        if (!fixed || !online.some(p=>p.id===fixed.id)) {
          await this.change(g,{phase:"held",cycle,roundId:null,lastError:fixed
            ? `목표 보류: 고정 요약 담당 ${fixed.name}이 오프라인이거나 목표 작업을 처리할 수 없습니다. 연결·설정을 확인한 뒤 다시 시도해 주세요.`
            : "목표 보류: 고정 요약 담당이 이 목표의 참가 명단에 없습니다. 요약 담당 설정을 확인한 뒤 다시 시도해 주세요."});
          return;
        }
        coordinator=fixed;
      }
    }
    const assigned=phase==="goal_compact"||phase==="goal_propose"?[coordinator]:members;
    const roundId="goal:"+g.id+":"+id(), time=now();
    await this.change(g,{phase,cycle,roundId,lastError:null,afterCompact:target},(guard,token)=>[
      this.statement("INSERT INTO rounds (id,channelId,requestorId,kind,phase,status,roster,goalId,goalRevision,contextThrough,createdAt) SELECT ?,?,?,'goal',?,'active',?,?,?,?,? WHERE "+guard,roundId,g.channelId,g.creatorId,phase,JSON.stringify(assigned.map(p=>p.id)),g.id,g.revision+1,through,time,token),
      ...assigned.map(p=>this.statement("INSERT INTO jobs (id,roundId,channelId,participantId,phase,status,createdAt) SELECT ?,?,?,?,?,'pending',? WHERE "+guard,roundId+":"+p.id,roundId,g.channelId,p.id,phase,time,token)),
    ]);
  }
  async tick(channel: Channel) {
    let g=await this.active(channel.id);
    if(!g)return;
    const time=now();
    if(time>=g.finalDeadline) {
      await this.change(g,{status:"completed",outcome:"unresolved",completedAt:g.finalDeadline,roundId:null});return;
    }
    if(g.status==="active" && time>=g.deadline) {
      const cutoff=await this.room.one<{seq:number}>("SELECT COALESCE(MAX(seq),0) seq FROM messages WHERE goalId=? AND createdAt<?",g.id,g.deadline);
      g=await this.change(g,{status:"finalizing",phase:"waiting",cutoffSeq:cutoff!.seq,roundId:null,proposalId:null,nextRunAt:time,lastError:null});
    }
    g=await this.admit(g,time);
    if(!live(g))return;
    if(channel.paused) {
      if(g.roundId)await this.change(g,{phase:"waiting",roundId:null,proposalId:null,nextRunAt:time,lastError:"채널 일시정지"});
      return;
    }
    if(g.phase==="held")return;
    if(!roster(g).length)return;
    if(g.phase==="waiting") {
      if(time>=g.nextRunAt)await this.next(g,g.status==="finalizing"?"goal_propose":"goal_discuss",g.cycle+1);
      return;
    }
    if(!g.roundId)return;
    await this.room.expireJobs(channel.id);
    const jobs=await this.room.all<Job>("SELECT * FROM jobs WHERE roundId=?",g.roundId);
    if(!jobs.length)return;
    const current=await this.get(g.id);
    if(current.revision!==g.revision)return;
    g=current;
    if(g.phase==="goal_vote") {
      const votes=await this.room.all<GoalVote>("SELECT * FROM goalVotes WHERE goalId=? AND proposalId=?",g.id,g.proposalId);
      const members=roster(g);
      const agreed=members.filter(p=>votes.some(v=>v.participantId===p.id&&v.decision==="agree"&&v.conclusion.trim())).length;
      // The denominator includes missing, offline and abstaining participants.
      // Once a strict majority is recorded, remaining votes cannot reverse it.
      if(agreed>=goalMajorityThreshold(members.length)) {
        await this.change(g,{status:"completed",outcome:agreed===members.length?"unanimous":"majority",completedAt:time,roundId:null});return;
      }
    }
    if(jobs.some(j=>j.status==="pending"||j.status==="running"))return;
    if(g.phase==="goal_vote" && g.status==="finalizing") {
      await this.change(g,{status:"completed",outcome:"unresolved",completedAt:time,roundId:null});return;
    }
    // An individual failure is not a veto over usable discussion or votes.
    // A phase with no usable result still stops rather than retrying forever.
    if(!jobs.some(j=>j.status==="completed")) {
      const cause=jobs.find(j=>j.error)?.error?.replace(/^목표 (?:보류|작업 실패): /,"");
      await this.change(g,{phase:"held",roundId:null,lastError:"목표 보류: 유효한 단계 결과가 없습니다. "+(cause||"실행기를 확인한 뒤 다시 시도해 주세요.")});return;
    }
    if(g.phase==="goal_compact") { await this.next(g,g.afterCompact);return; }
    if(g.phase==="goal_discuss") { await this.next(g,"goal_propose");return; }
    if(g.phase==="goal_propose") { await this.next(g,"goal_vote");return; }
    await this.change(g,{phase:"waiting",roundId:null,nextRunAt:time+g.intervalSeconds*1000});
  }
  async context(round: Round,count: number) {
    const g=await this.get(round.goalId!);
    const detail=await this.detail(g);
    const through=g.cutoffSeq??Number.MAX_SAFE_INTEGER;
    const recent=round.phase==="goal_compact"?[]:await this.room.all<Message>("SELECT * FROM messages WHERE goalId=? AND seq<=? ORDER BY seq DESC LIMIT ?",g.id,through,count);
    const pending=await this.room.all<Message>("SELECT * FROM messages WHERE goalId=? AND seq>? AND seq<=? ORDER BY seq LIMIT 1001",g.id,g.summaryThrough,round.phase==="goal_compact"?round.contextThrough:through);
    const history=[...new Map([...recent,...pending.slice(0,1000)].map(m=>[m.id,m])).values()].sort((a,b)=>a.seq-b.seq);
    return {goal:{...detail,historyComplete:pending.length<=1000},history};
  }
  async complete(actor: Actor,job: Job,args: Record<string,unknown>) {
    const round=(await this.room.one<Round>("SELECT * FROM rounds WHERE id=?",job.roundId))!;
    if(!round)throw new AppError(404,"goal_not_found","삭제되었거나 없는 목표 작업입니다.");
    const channel=await this.room.member(actor,job.channelId);
    await this.tick(channel);
    const g=await this.get(round.goalId!);
    const stored=(await this.room.one<Job>("SELECT * FROM jobs WHERE id=?",job.id))!;
    if(!stored)throw new AppError(404,"goal_not_found","삭제되었거나 없는 목표 작업입니다.");
    if(["completed","skipped","failed"].includes(stored.status))return {ok:true,duplicate:true};
    if(stored.status!=="running" || !live(g) || g.roundId!==round.id || g.revision!==round.goalRevision || channel.paused)
      throw new AppError(409,"goal_changed","이 목표 작업은 더 이상 유효하지 않습니다.");
    const member=roster(g).find(p=>p.id===job.participantId);
    if(!member)throw new AppError(403,"goal_participant","목표 참가자가 아닙니다.");
    const time=now(),token=id(), failed=Boolean(args.error)||args.blocked===true,skipped=args.skipped===true;
    if(time>=g.finalDeadline || (g.status==="active" && time>=g.deadline)) {
      await this.tick(channel);
      throw new AppError(409,"goal_changed","이 목표 작업의 제출 기한이 지났습니다.");
    }
    let status=failed?"failed":skipped?"skipped":"completed";
    const result=(args.goalResult||{}) as Record<string,unknown>;
    const extras: DbStatement[]=[];
    const guard="EXISTS (SELECT 1 FROM jobs j JOIN goals g ON g.id=? WHERE j.id=? AND j.resultToken=? AND g.revision=? AND g.roundId=?)";
    const bind=[g.id,job.id,token,g.revision,round.id];
    const evidence=JSON.stringify(Array.isArray(args.evidence)?args.evidence:[]);
    if(evidence.length>64000)throw new AppError(400,"too_long","근거 데이터가 너무 큽니다.");
    const message=(phase:string,text:string,suffix="")=>this.statement("INSERT OR IGNORE INTO messages (id,channelId,ownerId,participantId,author,kind,text,roundId,phase,goalId,evidence,createdAt) SELECT ?,?,?,?,?,'llm',?,?,?,?,?,? WHERE "+guard,"answer:"+job.id+suffix,g.channelId,actor.id,member.id,actor.name+" / "+member.name,text,round.id,phase,g.id,evidence,time,...bind);
    if(!failed&&!skipped) {
      if(job.phase==="goal_compact") {
        const summary=requiredString(result.summary,"누적 요약",12000);
        if(result.throughSeq!==round.contextThrough || !Array.isArray(result.unresolvedIssues) || result.unresolvedIssues.some(x=>typeof x!=="string") || JSON.stringify(result.unresolvedIssues).length>8000)
          throw new AppError(400,"invalid_goal_result","요약 범위와 미해결 쟁점을 확인해 주세요.");
        const sources=result.sourceMessageIds;
        const chunk=await this.room.all<Message>("SELECT id FROM messages WHERE goalId=? AND seq>? AND seq<=?",g.id,g.summaryThrough,round.contextThrough);
        if(!Array.isArray(sources)||!sources.length||sources.some(x=>typeof x!=="string"||!chunk.some(m=>m.id===x)))throw new AppError(400,"invalid_goal_result","요약 근거는 처리한 목표 메시지여야 합니다.");
        const issues=JSON.stringify(result.unresolvedIssues);
        extras.push(this.statement("INSERT OR IGNORE INTO goalCheckpoints (id,goalId,throughSeq,summary,issues,sources,createdAt) SELECT ?,?,?,?,?,?,? WHERE "+guard,job.id,g.id,round.contextThrough,summary,issues,JSON.stringify(sources),time,...bind));
        extras.push(this.statement("UPDATE goals SET summary=?,summaryThrough=?,issues=? WHERE id=? AND "+guard,summary,round.contextThrough,issues,g.id,...bind));
      } else if(job.phase==="goal_propose") {
        const text=requiredString(result.text,"결과 초안",16000);
        extras.push(this.statement("INSERT OR IGNORE INTO goalProposals (id,goalId,version,text,sourceSeq,createdAt) SELECT ?,?,?,?,?,? WHERE "+guard,job.id,g.id,g.cycle,text,round.contextThrough,time,...bind));
        extras.push(this.statement("UPDATE goals SET proposalId=? WHERE id=? AND "+guard,job.id,g.id,...bind),message("goal_propose",text));
      } else if(job.phase==="goal_vote") {
        if(result.proposalId!==g.proposalId || !["agree","disagree","abstain"].includes(String(result.decision)))throw new AppError(400,"invalid_goal_result","현재 초안에 대한 동의·반대·판단 보류가 필요합니다.");
        const reason=requiredString(result.reason,"판단 사유",4000), conclusion=requiredString(result.conclusion,"개인 결론",8000);
        extras.push(this.statement("INSERT OR IGNORE INTO goalVotes (id,goalId,proposalId,participantId,decision,reason,conclusion,createdAt) SELECT ?,?,?,?,?,?,?,? WHERE "+guard,job.id,g.id,g.proposalId,member.id,result.decision,reason,conclusion,time,...bind));
        extras.push(message("goal_vote",({agree:"동의",disagree:"반대",abstain:"판단 보류"} as Record<string,string>)[String(result.decision)]+" · 초안 "+g.cycle+"\n"+reason),message("goal_conclusion",conclusion,":conclusion"));
      } else extras.push(message("goal_discuss",requiredString(result.text??args.text,"목표 토의",24000)));
    }
    const error=failed?"목표 작업 실패: "+String(args.error||"실행기 호출 한도 또는 문맥 상한").slice(0,900):skipped?"의견 또는 결론 미제출":null;
    await this.room.db.batch([
      this.statement("UPDATE jobs SET status=?,error=?,resultToken=? WHERE id=? AND status='running' AND EXISTS (SELECT 1 FROM goals WHERE id=? AND revision=? AND roundId=?)",status,error,token,job.id,g.id,g.revision,round.id),
      ...extras,
    ]);
    await this.tick(channel);
    return {ok:true};
  }
}
