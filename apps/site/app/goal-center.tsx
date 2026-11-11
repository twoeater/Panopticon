"use client";
import {useEffect,useRef,useState} from "react";
import {Target,X,Plus,ChevronLeft} from "lucide-react";
import type {GoalContext,GoalProposal,GoalSummary,GoalVote,Message,Participant} from "../lib/domain";
import {MessageMarkdown} from "./message-markdown";
import {goalMajorityThreshold} from "../lib/goal-protocol";
function GoalMarkdown({text,messageId}:{text:string;messageId:string}) {
  return <div className="message-text"><MessageMarkdown text={text} messageId={messageId}/></div>;
}
type Api=(action:string,args?:Record<string,unknown>)=>Promise<any>;
type Detail=GoalContext & {proposals:GoalProposal[];nextProposalOffset:number|null;selectedProposal:GoalProposal|null;selectedVotes:GoalVote[];checkpoint:{sources:string;throughSeq:number}|null};
export const goalPhaseLabels:Record<string,string>={goal_notice:"목표 지시",goal_discuss:"목표토의",goal_compact:"기록 정리",goal_propose:"결과 초안",goal_vote:"동의·이의",goal_conclusion:"개인결론",goal_result:"목표 결과",waiting:"다음 토의 대기",held:"보류"};
const decisionLabels:Record<string,string>={agree:"찬성",disagree:"반대",abstain:"판단 보류"};
const statusLabel=(goal:{status:string;outcome:string|null;phase:string})=>goal.status==="completed"?(goal.outcome==="majority"?"과반 찬성 채택":goal.outcome==="unanimous"?"전원 찬성 채택":"미채택 종료"):goal.status==="cancelled"?"취소됨":goal.status==="finalizing"?"최종 정리 중":goalPhaseLabels[goal.phase]||"토의 중";
const date=(value:number)=>new Date(value).toLocaleString("ko-KR",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
const remaining=(end:number,time:number)=>{const minutes=Math.ceil((end-time)/60000);return minutes<=0?"기한 도달":minutes<60?minutes+"분 남음":Math.floor(minutes/60)+"시간 "+minutes%60+"분 남음";};
function localDeadline(){const d=new Date(Date.now()+3600000);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16);}
export function GoalCenter({channelId,ownerId,userId,participants,active,serverTime,view,setView,api,onChange}:{channelId:string;ownerId:string;userId:string;participants:Participant[];active:GoalSummary|null;serverTime:number;view:string|null;setView:(id:string|null)=>void;api:Api;onChange:()=>Promise<void>}) {
  const [detail,setDetail]=useState<Detail|null>(null),[goals,setGoals]=useState<GoalSummary[]>([]),[offset,setOffset]=useState(0),[nextOffset,setNextOffset]=useState<number|null>(null);
  const [tab,setTab]=useState("result"),[messages,setMessages]=useState<Message[]>([]),[before,setBefore]=useState<number|undefined>(),[nextBefore,setNextBefore]=useState<number|null>(null);
  const [proposalId,setProposalId]=useState(""),[proposalOffset,setProposalOffset]=useState(0);
  const [creating,setCreating]=useState(false),[title,setTitle]=useState(""),[instructions,setInstructions]=useState(""),[deadline,setDeadline]=useState(localDeadline),[interval,setIntervalSeconds]=useState(60);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const request=useRef<{key:string;id:string}|null>(null),version=useRef(0);
  const ownerLabel=(p:{ownerId:string;ownerName?:string})=>p.ownerId===userId?"내 AI":p.ownerName||"참여자 "+p.ownerId.slice(0,8);
  const available=participants.filter(p=>p.goalsSupported===1&&p.onlineAt>serverTime-30000&&p.deviceId!=="mcp");
  const participation=(p:Participant)=>p.deviceId==="mcp"?"보충 발언 가능":p.goalsSupported!==1?"실행기 업데이트·재시작 필요":p.onlineAt<=serverTime-30000?"온라인 연결 대기":"자동 참여";
  useEffect(()=>{setView(null);setDetail(null);setCreating(false);},[channelId]); // A goal never carries into another channel.
  useEffect(()=>{setDetail(null);setBefore(undefined);setProposalId("");setProposalOffset(0);setTab("result");setError("");},[view]);
  useEffect(()=>{
    if(!view)return;
    let disposed=false;const ticket=++version.current;
    const refresh=async()=>{
      try{
        const list=await api("goal_list",{channelId,offset});
        if(disposed||ticket!==version.current)return;
        setGoals(list.goals);setNextOffset(list.nextOffset);
        if(view!=="list"){
          const data=await api("goal_read",{channelId,goalId:view,proposalId:proposalId||undefined,proposalOffset});
          if(disposed||ticket!==version.current)return;setDetail(data);
          if(tab==="history"){
            const history=await api("goal_history",{channelId,goalId:view,before});
            if(disposed||ticket!==version.current)return;setMessages(history.messages);setNextBefore(history.nextBefore);
          }
        }
      }catch(e){if(!disposed)setError(e instanceof Error?e.message:"목표 조회 실패");}
    };
    void refresh();const timer=setInterval(refresh,5000);return()=>{disposed=true;clearInterval(timer);};
  },[view,channelId,offset,proposalId,proposalOffset,tab,before,api]);
  const act=async(fn:()=>Promise<void>)=>{setBusy(true);setError("");try{await fn();}catch(e){setError(e instanceof Error?e.message:"요청 실패");}finally{setBusy(false);}};
  const begin=()=>{setCreating(true);setTitle("");setInstructions("");setDeadline(localDeadline());setIntervalSeconds(60);setError("");request.current=null;};
  const g=detail?.goal,canManage=g&&(g.creatorId===userId||ownerId===userId),live=g&&(g.status==="active"||g.status==="finalizing");
  const shownProposal=detail?.selectedProposal||detail?.proposal,shownVotes=detail?.selectedProposal?detail.selectedVotes:detail?.votes||[];
  return <>
    <button className={"goal-center "+(active?"has-goal":"")} onClick={()=>{setCreating(false);setView(active?.id||"list");}} aria-label="목표 설정과 이력">
      <Target size={18}/><span><strong>{active?.title||"목표 설정 · 이력"}</strong><small>{active?statusLabel(active)+" · "+remaining(active.status==="finalizing"?active.finalDeadline:active.deadline,serverTime)+" · 찬성 "+active.agreeCount+"/"+active.participantCount+" · 채택 "+goalMajorityThreshold(active.participantCount)+"명":"목표를 정하고 AI들과 결론을 모으세요"}</small></span>
    </button>
    {view&&<div className="modal-backdrop"><section className="modal goal-modal" role="dialog" aria-modal="true" aria-label="목표 토의와 결과">
      <div className="goal-modal-heading"><h2>목표 토의</h2><button className="icon" aria-label="목표 창 닫기" onClick={()=>setView(null)}><X size={20}/></button></div>
      {error&&<p className="error-banner" role="alert">{error}</p>}
      <nav className="goal-toolbar"><button onClick={()=>{setCreating(false);setView("list");}}>목표 목록</button><button disabled={Boolean(active)||busy} onClick={begin}><Plus size={15}/> 새 목표</button></nav>
      {creating?<form className="goal-form" onSubmit={e=>{e.preventDefault();void act(async()=>{
        const payload={channelId,title,instructions,deadline:new Date(deadline).getTime(),intervalSeconds:interval};
        const key=JSON.stringify(payload);if(request.current?.key!==key)request.current={key,id:crypto.randomUUID()};
        const created=await api("goal_start",{...payload,requestId:request.current.id});await onChange();setCreating(false);setView(created.id);
      });}}>
        <label>목표 제목<input required maxLength={120} value={title} onChange={e=>setTitle(e.target.value)}/></label>
        <label>목표 지시<textarea required rows={5} maxLength={16000} value={instructions} onChange={e=>setInstructions(e.target.value)}/></label>
        <div className="goal-fields"><label>DEADLINE · 내 시간대<input type="datetime-local" required value={deadline} onChange={e=>setDeadline(e.target.value)}/></label><label>회차 사이 대기(초)<input type="number" min={10} max={86400} value={interval} onChange={e=>setIntervalSeconds(Number(e.target.value))}/></label></div>
        <section className="goal-channel-task" aria-label="채널 공통 과제">
          <h4>채널 공통 과제</h4><p className="goal-help">이 채널의 모든 사용자와 AI가 함께 풀 과제입니다. 목표를 지원하는 온라인 AI는 소유자 구분 없이 자동 참여하며, 토의 마감 전 새로 연결된 AI도 합류합니다.</p>
          <p className="goal-status">지금 자동 참여 가능: {available.length}명</p>
          <ul className="goal-participation">{participants.map(p=><li key={p.id}><div><strong>{p.name}</strong><small>{ownerLabel(p)}</small></div><span>{participation(p)}</span></li>)}</ul>
          {!available.length&&<p className="goal-help">AI가 없어도 과제를 시작할 수 있습니다. 목표 지원 실행기가 연결되면 토의가 시작됩니다.</p>}
        </section>
        <p className="goal-help">전체 참가 AI의 과반수가 같은 초안에 찬성하고 개인 결론을 제출하면 즉시 채택합니다. 미응답·판단 보류는 찬성이 아닙니다. 마감 후 최종 정리는 최대 10분이며, 실행기의 호출 한도가 적용됩니다.</p>
        <button className="primary" disabled={busy||Boolean(active)} type="submit">공통 과제 시작</button>
      </form>:view==="list"?<div>
        <h3>과거 목표와 진행 상태</h3>
        {!goals.length&&<p className="goal-help">아직 목표가 없습니다. 채널에 참여한 사람이 목표를 시작할 수 있습니다.</p>}
        <div className="goal-list">{goals.map(goal=><button key={goal.id} onClick={()=>setView(goal.id)}><strong>{goal.title}</strong><span>{statusLabel(goal)} · {date(goal.deadline)} · 찬성 {goal.agreeCount}/{goal.participantCount}</span></button>)}</div>
        <div className="goal-toolbar"><button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-20))}>이전 목록</button><button disabled={nextOffset===null} onClick={()=>setOffset(nextOffset!)}>다음 목록</button></div>
      </div>:g&&detail?<div>
        <h3 className="goal-title">{g.title}</h3><div className="goal-status">{statusLabel(g)} · {g.cycle}회차 · 마감 {date(g.deadline)}{g.status==="finalizing"&&" · 최종 제출 "+date(g.finalDeadline)}</div>
        {g.lastError&&<p role="status" className="goal-help">{g.lastError}</p>}
        {g.status==="active"&&<p className="goal-help">채널 공통 과제 · 토의 마감 전 연결되는 목표 지원 AI는 자동 합류합니다. {detail.participants.length===0&&"목표 지원 실행기의 연결을 기다리고 있습니다."}</p>}
        <details className="goal-instructions"><summary>목표 지시 · 참가자 {detail.participants.length}명</summary><GoalMarkdown text={g.instructions} messageId={g.id}/><p>{detail.participants.map(p=>p.name).join(" · ")}</p></details>
        {canManage&&live&&<div className="goal-toolbar">
          {g.phase==="held"&&<button disabled={busy} onClick={()=>void act(async()=>{await api("goal_retry",{channelId,goalId:g.id});await onChange();setDetail(await api("goal_read",{channelId,goalId:g.id}));})}>보류 작업 다시 시도</button>}
          <button disabled={busy} onClick={()=>void act(async()=>{await api("goal_cancel",{channelId,goalId:g.id});await onChange();setDetail(await api("goal_read",{channelId,goalId:g.id}));})}>목표 취소</button>
        </div>}
        <div className="goal-tabs" role="tablist" aria-label="목표 정보">{[["result","공동 결과"],["opinions","개인 결론"],["history","토의 기록"]].map(([key,label])=><button key={key} role="tab" aria-selected={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</div>
        {tab==="result"&&<>
          <label className="goal-proposal-select">초안 이력<select value={proposalId} onChange={e=>setProposalId(e.target.value)}><option value="">현재 결과</option>{detail.proposals.map(p=><option key={p.id} value={p.id}>{p.version}회차 초안 · {date(p.createdAt)}</option>)}</select></label>
          <div className="goal-toolbar"><button disabled={!proposalOffset} onClick={()=>setProposalOffset(Math.max(0,proposalOffset-20))}>최신 초안 쪽</button><button disabled={detail.nextProposalOffset===null} onClick={()=>setProposalOffset(detail.nextProposalOffset!)}>이전 초안 더 보기</button></div>
          <h4>{["unanimous","majority"].includes(g.outcome||"")&&shownProposal?.id===g.proposalId?"채택된 결과":g.status==="completed"?"미채택 초안":"검토 중인 초안"}</h4>
          <p className="goal-help">전체 {detail.participants.length}명 중 {goalMajorityThreshold(detail.participants.length)}명 찬성이 채택 기준입니다. 이 초안의 찬성: {shownVotes.filter(v=>v.decision==="agree").length}명. 반대·판단 보류·미제출은 아래에 보존합니다.</p>
          {shownProposal?<div className="goal-result"><GoalMarkdown text={shownProposal.text} messageId={shownProposal.id}/></div>:<p className="goal-help">아직 유효한 초안이 없습니다. 토의와 기록 정리 후 초안을 작성합니다.</p>}
          <div className="goal-votes">{detail.participants.map(p=>{const vote=shownVotes.find(v=>v.participantId===p.id);return <div key={p.id}><strong>{p.name}</strong><span className={vote?.decision||"missing"}>{vote?decisionLabels[vote.decision]:"미제출"}</span><small>{ownerLabel(p)}</small>{vote&&<p>{vote.reason}</p>}</div>;})}</div>
          <details className="goal-instructions"><summary>누적 요약·미해결 쟁점</summary><GoalMarkdown text={g.summary||"아직 누적 요약이 없습니다."} messageId={g.id+"-summary"}/><ul>{(JSON.parse(g.issues) as string[]).map((issue,i)=><li key={i}>{issue}</li>)}</ul><small>요약 반영 위치: {g.summaryThrough}{detail.checkpoint&&" · 근거 "+JSON.parse(detail.checkpoint.sources).length+"개"}</small></details>
        </>}
        {tab==="opinions"&&<div className="goal-opinions">{detail.participants.map(p=>{const vote=detail.opinions.find(v=>v.participantId===p.id);return <article key={p.id}><h4>{p.name} <small>{ownerLabel(p)} · {vote?decisionLabels[vote.decision]:"개인 결론 미제출"}</small></h4>{vote&&<><small>{vote.proposalId===g.proposalId?"현재 초안 기준":"이전 초안 기준"} · {date(vote.createdAt)}</small><GoalMarkdown text={vote.conclusion} messageId={vote.id}/></>}</article>;})}</div>}
        {tab==="history"&&<>
          <div className="goal-toolbar"><button disabled={nextBefore===null} onClick={()=>setBefore(nextBefore!)}><ChevronLeft size={14}/> 이전 기록 100개</button><button disabled={!before} onClick={()=>setBefore(undefined)}>최신 기록</button></div>
          <div className="goal-history">{messages.map(m=><article key={m.id}><div className="goal-status">{goalPhaseLabels[m.phase]||m.phase} · {m.author} · {date(m.createdAt)}</div><GoalMarkdown text={m.text} messageId={m.id}/></article>)}</div>
        </>}
      </div>:<p className="goal-help">목표를 불러오는 중…</p>}
    </section></div>}
  </>;
}
