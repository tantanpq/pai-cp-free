'use strict';
const crypto = require('node:crypto'); const fs = require('node:fs'); const path = require('node:path'); const childProcess = require('node:child_process');
const { parseTaskBoxWire } = require('./chief-delegation-admission');
const CLAIM_READ_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const FETCH_TEXT_MAX_BYTES = 8 * 1024;
const TOOL_RESULT_MAX_BYTES = 12 * 1024;
const SEARCH_RESULT_MAX = 8;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex'); const safeId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value); const deny = code => { throw new Error(code); };
const readTool = (name, description, properties = {}) => ({ name, description, inputSchema: { type: 'object', additionalProperties: false, properties }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } });
const READ_TOOLS = Object.freeze(['pai_resume','pai_get_pulse','pai_get_context_pack'].map(n => readTool(n, 'Read bounded current PAI information.')).concat([readTool('pai_get_recent_intent','Read the bound user recent cross-chat intent projection.',{limit:{type:'integer',minimum:1,maximum:5}}),readTool('pai_get_work_item','Read one lifecycle item and its verified immutable artifact.',{work_item_id:{type:'string',minLength:1,maxLength:160}}),readTool('pai_get_result_event','Read one verified terminal HANDOFF by parent task ID.',{result_event_id:{type:'string',minLength:1,maxLength:160}}),readTool('pai_get_host_capabilities','Read observed host capabilities.'),readTool('search','Search curated PAI objects.',{query:{type:'string',minLength:1,maxLength:512}}),readTool('fetch','Fetch one curated PAI object.',{id:{type:'string',minLength:1,maxLength:160},mode:{type:'string',enum:['POINTER','FULL']}})]));
const BOOT_POINTERS = Object.freeze({ profile:'THIN_BOOT_R3', activeArchitecturePointer:'06_STATE/PAI_ACTIVE_ARCHITECTURE_POINTER.json', notebookOperatingMapPointer:'06_STATE/PAI_CHIEF_WORK_NOTEBOOK_R1/PAI_CHIEF_WORK_NOTEBOOK_CURRENT.md#section-0', retrievalPolicy:{bestEffortFetch:false,defaultMode:'POINTER',maxFullBytes:FETCH_TEXT_MAX_BYTES,maxToolResultBytes:TOOL_RESULT_MAX_BYTES}, usage:'Read the small active-architecture pointer only. Use pai_get_pulse for JIT operational truth and fetch mode FULL only for one exact source required by the next action. Chat history is context only. Do not hydrate complete doctrine documents unless ambiguity requires it.' });
const blocked = failureClass => ({ status:'BLOCKED', failureClass, authority:'READ_ONLY_NO_FALLBACK_STORE' }); const compact = (value,max=12000) => { const text=JSON.stringify(value); return text.length<=max?value:{status:'TRUNCATED',preview:text.slice(0,max),maxBytes:max}; };
const RESUME_CONTEXT_SCHEMA = 'pai-personal-resume-context/v1'; const RESUME_CONTEXT_MAX_BYTES = 7800; const MEANINGFUL_TYPES = new Set(['CORRECTION','DECISION','OPEN_LOOP','INTENT']); const ACTIVE_FRAGMENT_STATUSES = new Set(['ROOM_LOCAL','VERIFIED_POINTER']); const CARD_SCOPES = new Set(['GLOBAL','PROJECT','TOPIC']);
const contextBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const CONTEXT_CONES = Object.freeze(['FARM','CAREER','PUBLICATION','PERSONAL','ARCHITECTURE','CURRENT_RUNTIME']);
const coneSet = new Set(CONTEXT_CONES);
const PROJECT_DISPOSITIONS = new Set(['NOT_MATERIALIZED','MATERIALIZED_NOT_ADMITTED','ADMITTED','RUNNING','WAIT_DEPENDENCY','WAIT_RESOURCE','QUIESCENT','NO_MATERIAL_DELTA','PROGRAM_DONE','UNKNOWN']);
const TERMINAL_RESULT_STATUSES = new Set(['DONE','NOT_DONE','BLOCKED','PASS','FAIL']);
const UNKNOWN = 'UNKNOWN';
const first = (...values) => values.find(value => value !== undefined && value !== null && value !== '') ?? null;
const iso = value => { if (!value) return null; const time=Date.parse(value); return Number.isFinite(time)?new Date(time).toISOString():null; };
const lifecycleItem = value => value?.lifecycle?.item || value?.lifecycle?.current || value?.item || value?.current || null;
const resultBody = value => value?.handoff?.parsed?.result || value?.result || value?.handoff?.result || null;
const artifactFields = value => value?.artifact?.parsed?.fields || value?.fields || null;
function composeProjectStatus({ programId, taskId, owners, now=()=>new Date().toISOString() }) {
  if (!safeId(programId) && !safeId(taskId)) deny('PROJECT_STATUS_ID_REQUIRED');
  const exactTaskId=taskId||programId;
  const work=owners.workItem(exactTaskId);
  const terminal=owners.resultEvent(exactTaskId);
  const item=lifecycleItem(terminal)||lifecycleItem(work)||{};
  const successor=first(item.runningSuccessor,item.running_successor,item.successor,item.currentTask,item.current_task);
  const activeItem=successor&&typeof successor==='object'?successor:item;
  const fields=artifactFields(work)||terminal?.handoff?.parsed?.fields||{};
  const result=resultBody(terminal)||{};
  const stableProgramId=first(programId, fields.ROOT_ID, item.rootId, fields.TASK_ID, item.externalTaskId, exactTaskId);
  const stableTaskId=first(activeItem.externalTaskId,activeItem.taskId,activeItem.task_id,fields.TASK_ID,item.externalTaskId,item.taskId,exactTaskId);
  const lifecycleState=String(first(activeItem.effectiveState,activeItem.state,activeItem.claimState,activeItem.runtimeState,item.effectiveState,item.state,item.claimState,item.runtimeState,work?.runtime_state,UNKNOWN)).toUpperCase();
  const resultStatus=String(first(result.STATUS,terminal?.latest_result_status,UNKNOWN)).toUpperCase();
  const resultAt=iso(first(terminal?.handoff?.observedAt,terminal?.handoff?.createdAt,terminal?.latest_result_at,item.resultAt,item.completedAt));
  const lifecycleAt=iso(first(item.updatedAt,item.claimedAt,item.startedAt,item.createdAt,work?.observedAt));
  const terminalWins=!successor&&TERMINAL_RESULT_STATUSES.has(resultStatus)&&(!resultAt||!lifecycleAt||resultAt>=lifecycleAt);
  const materialized=Boolean(work?.artifact||work?.materialized===true||fields.TASK_ID);
  const admitted=Boolean(item.externalTaskId||item.taskId||item.claimId||item.claim_id||work?.admitted===true)&&work?.failureClass!=='LIFECYCLE_ITEM_NOT_FOUND';
  const explicitProgramDone=[item.programDisposition,item.program_disposition,item.programStatus,item.program_status,work?.program_disposition,terminal?.program_disposition].some(value=>String(value||'').toUpperCase()==='PROGRAM_DONE');
  const blockerDetail=first(result.BLOCKER,item.blockerDetail,item.blocker_detail,work?.blocker_detail);
  let blockerClass=first(item.blockerClass,item.blocker_class,work?.blocker_class);
  if(!blockerClass&&/resource|capacity|host|lane/i.test(String(blockerDetail||'')))blockerClass='RESOURCE';
  if(!blockerClass&&/depend|prerequi|upstream/i.test(String(blockerDetail||'')))blockerClass='DEPENDENCY';
  const waitResource=/WAIT_RESOURCE|RESOURCE_WAIT/.test(lifecycleState)||String(blockerClass||'').toUpperCase()==='RESOURCE';
  const waitDependency=/WAIT_DEPENDENCY|DEPENDENCY_WAIT/.test(lifecycleState)||String(blockerClass||'').toUpperCase()==='DEPENDENCY';
  let disposition=UNKNOWN;
  if(explicitProgramDone&&['PASS','DONE'].includes(resultStatus))disposition='PROGRAM_DONE';
  else if(terminalWins)disposition='NO_MATERIAL_DELTA';
  else if(!materialized&&!admitted)disposition='NOT_MATERIALIZED';
  else if(materialized&&!admitted)disposition='MATERIALIZED_NOT_ADMITTED';
  else if(waitResource)disposition='WAIT_RESOURCE';
  else if(waitDependency)disposition='WAIT_DEPENDENCY';
  else if(/RUNNING|CLAIMED|ACTIVE/.test(lifecycleState))disposition='RUNNING';
  else if(/QUIESCENT|IDLE/.test(lifecycleState))disposition='QUIESCENT';
  else if(admitted)disposition='ADMITTED';
  const needsHosts=disposition==='WAIT_RESOURCE'||disposition==='RUNNING';
  const hosts=needsHosts?owners.hostCapabilities():null;
  const claimId=first(activeItem.claimId,activeItem.claim_id,item.claimId,item.claim_id,work?.claim_id);
  const hostId=first(activeItem.hostId,activeItem.host_id,activeItem.workerId,activeItem.worker_id,item.hostId,item.host_id,item.workerId,item.worker_id,work?.host_id);
  const sourceRefs=[
    work?.artifact?.artifactRef?`work:${work.artifact.artifactRef}`:null,
    terminal?.handoff?.artifactRef?`result:${terminal.handoff.artifactRef}`:null,
    item.externalTaskId||item.taskId?`lifecycle:${stableTaskId}`:null,
    needsHosts&&hosts?.observedAt?'host-capabilities:JIT':null
  ].filter(Boolean);
  const sampledAt=iso(now())||now(); const evidenceAt=resultAt||lifecycleAt||iso(hosts?.observedAt);
  return {
    program_id:stableProgramId||UNKNOWN, program_revision:first(item.programRevision,item.program_revision,work?.program_revision,UNKNOWN),
    program_disposition:PROJECT_DISPOSITIONS.has(disposition)?disposition:UNKNOWN,
    acceptance:first(item.acceptance,work?.acceptance,resultStatus==='PASS'?'PASS':UNKNOWN),
    current_round_or_phase:first(item.currentRoundOrPhase,item.current_round_or_phase,item.round,item.phase,UNKNOWN),
    current_task_id:stableTaskId||UNKNOWN, current_task_type:first(activeItem.taskType,activeItem.task_type,fields.TYPE,item.taskType,item.task_type,UNKNOWN),
    runtime_state:terminalWins?resultStatus:lifecycleState, host_id:hostId||UNKNOWN, claim_id:claimId||UNKNOWN,
    latest_result_status:resultStatus, latest_result_ref:first(terminal?.handoff?.artifactRef,terminal?.latest_result_ref,UNKNOWN), latest_result_at:resultAt||UNKNOWN,
    blocker_class:first(blockerClass, resultStatus==='BLOCKED'?'UNKNOWN':null, UNKNOWN), blocker_detail:blockerDetail||UNKNOWN,
    blocker_owner:first(item.blockerOwner,item.blocker_owner,work?.blocker_owner,UNKNOWN), next_eligible:first(item.nextEligible,item.next_eligible,work?.next_eligible,UNKNOWN),
    decision_required:first(item.decisionRequired,item.decision_required,work?.decision_required,UNKNOWN),
    freshness:{sampled_at:sampledAt,evidence_at:evidenceAt||UNKNOWN,age_ms:evidenceAt?Math.max(0,Date.parse(sampledAt)-Date.parse(evidenceAt)):UNKNOWN,terminal_overrode_stale_projection:terminalWins&&/RUNNING|CLAIMED|ACTIVE/.test(lifecycleState)},
    source_refs:sourceRefs, authority:'READ_ONLY_COMPOSITION_OF_EXISTING_EXACT_OWNERS', bounded_retrieval:{work_items:1,result_events:1,host_capabilities:needsHosts?1:0,broad_searches:0}
  };
}
function queryCone(query) {
  const raw=String(query||''); const explicit=raw.match(/(?:^|\s)cone:(FARM|CAREER|PUBLICATION|PERSONAL|ARCHITECTURE|CURRENT_RUNTIME)(?:\s|$)/i);
  if(explicit)return {cone:explicit[1].toUpperCase(),term:raw.replace(explicit[0],' ').trim().toLowerCase(),explicit:true};
  const lower=raw.toLowerCase();
  if(/\b(farm|taskbox|task box|claim|program|phase|worker)\b/.test(lower))return {cone:'FARM',term:lower,explicit:false};
  if(/\b(runtime|qcheck|pulse|current|status|handoff|result)\b/.test(lower))return {cone:'CURRENT_RUNTIME',term:lower,explicit:false};
  if(/\b(career|cmm|resume|job|portfolio)\b/.test(lower))return {cone:'CAREER',term:lower,explicit:false};
  if(/\b(publish|publication|site|website|zline|hostinger)\b/.test(lower))return {cone:'PUBLICATION',term:lower,explicit:false};
  if(/\b(personal|profile|preference|intent)\b/.test(lower))return {cone:'PERSONAL',term:lower,explicit:false};
  return {cone:'ARCHITECTURE',term:lower,explicit:false};
}
const { createContextBudgetLedger } = require('./context-economy/context-budget-ledger');

function createContextTelemetry({now=()=>new Date().toISOString()}={}) {
  const events=[]; const seen=new Set(); let sourceCount=0,dedupedCount=0,truncatedCount=0;
  const turnLedger = createContextBudgetLedger({ now });
  const record=(tool,payload,meta={})=>{
    const bytes=contextBytes(payload);
    const sourceIds=Array.isArray(meta.sourceIds)?meta.sourceIds:[];
    let deduped=0;
    for(const id of sourceIds){
      sourceCount+=1;
      if(seen.has(id)){deduped+=1;dedupedCount+=1;}
      else seen.add(id);
    }
    if(meta.truncated)truncatedCount+=1;
    events.push({at:now(),tool,cone:meta.cone||null,boot_bytes:meta.bootBytes||0,continuity_bytes:meta.continuityBytes||0,retrieved_source_bytes:meta.retrievedSourceBytes||0,history_bytes:null,tool_result_bytes:bytes,final_prompt_bytes:null,estimated_tokens:Math.ceil(bytes/4),sources:{count:sourceIds.length,deduped_count:deduped,truncated_count:meta.truncated?1:0}});
    if(events.length>50)events.shift();
  };
  const recordTurn=(turnData)=>turnLedger.recordTurn(turnData);
  const report=()=>{
    const byTool={};let toolResultBytes=0,estimatedTokens=0,bootBytes=0,retrievedSourceBytes=0,continuityBytes=0;
    for(const event of events){
      const row=byTool[event.tool]||{requests:0,tool_result_bytes:0,estimated_tokens:0};
      row.requests+=1;row.tool_result_bytes+=event.tool_result_bytes;row.estimated_tokens+=event.estimated_tokens;
      byTool[event.tool]=row;
      toolResultBytes+=event.tool_result_bytes;
      estimatedTokens+=event.estimated_tokens;
      bootBytes+=event.boot_bytes;
      retrievedSourceBytes+=event.retrieved_source_bytes;
      continuityBytes+=event.continuity_bytes;
    }
    return {
      schema:'pai-context-budget/v2',
      status:'MEASURED_PAI_CONTROLLED_ONLY',
      units:'UTF8_BYTES_WITH_TOKEN_ESTIMATE_BYTES_DIV_4',
      layers:{PAI_BOOT:bootBytes,PROJECT_RETRIEVAL:retrievedSourceBytes,TOOL_OUTPUT:toolResultBytes,HISTORY:null,DOWNSTREAM_PACKET:continuityBytes,UNKNOWN_PLATFORM:null},
      hostUnavailable:['HISTORY','UNKNOWN_PLATFORM','platform_system_instructions_bytes','platform_tool_schema_bytes'],
      totals:{requests:events.length,sources:sourceCount,deduped_count:dedupedCount,truncated_count:truncatedCount,tool_result_bytes:toolResultBytes,estimated_tokens:estimatedTokens},
      by_tool:byTool,
      latest:events.at(-1)||null,
      recent_events:events.slice(-10),
      retained_event_count:events.length,
      returned_event_count:Math.min(events.length,10),
      turn_ledger:turnLedger.getReport(),
      authority:'OBSERVABILITY_ONLY_NO_RETRIEVAL_OR_EXECUTION_AUTHORITY'
    };
  };
  return {record,recordTurn,report,seen,turnLedger};
}
function compactCanonicalReality(value) { const source=value&&typeof value==='object'?value:{}; const rawAuthority=source.authority; const authority=rawAuthority&&typeof rawAuthority==='object'?{backend:rawAuthority.backend||null,operationalCutover:rawAuthority.operationalCutover===true,releaseHash:rawAuthority.releaseHash||null,currentRevision:Number.isInteger(rawAuthority.currentRevision)?rawAuthority.currentRevision:null,fencingToken:Number.isInteger(rawAuthority.fencingToken)?rawAuthority.fencingToken:null}:(typeof rawAuthority==='string'?{owner:rawAuthority}:null); const evidence=Array.isArray(source.evidence)?source.evidence.slice(0,1).map(item=>({kind:item.kind||null,status:item.status||null,at:item.at||null,runningClaims:Number.isInteger(item.runningClaims)?item.runningClaims:null,staleRunning:Number.isInteger(item.staleRunning)?item.staleRunning:null})):[]; return { status:typeof source.status==='string'?source.status:'DEGRADED', available:source.available===true, lifecycleStage:typeof source.lifecycleStage==='string'?source.lifecycleStage:'UNKNOWN', ...(typeof source.lastVerifiedAt==='string'?{lastVerifiedAt:source.lastVerifiedAt}:{}), ...(typeof source.sourceType==='string'?{sourceType:source.sourceType}:{}), ...(authority?{authority}:{}), evidence }; }
function compactRoom(room) { return room&&typeof room==='object'?{ roomId:room.roomId||null, roomName:room.roomName||null, primaryTopicId:room.primaryTopicId||null, status:room.status||null, revision:Number.isInteger(room.revision)?room.revision:null, privacyClass:room.privacyClass||null }:null; }
function composeResumeContext({ continuity, contextGateway, behavioralMemory }) {
  if (!contextGateway || typeof contextGateway.peek!=='function' || typeof contextGateway.inspect!=='function') return blocked('MEMORY_ROOM_OWNER_UNAVAILABLE');
  const peek=contextGateway.peek(); const room=peek?.room||null; const base={ schema:RESUME_CONTEXT_SCHEMA, status:'READY', canonicalReality:compactCanonicalReality(continuity()), room:compactRoom(room), recentMeaningful:[], behavioralMemory:{status:'DEGRADED_UNAVAILABLE',cards:[],authority:'CARDS_ONLY_NO_RAW_TRANSCRIPT_OR_EFFECT'}, reopenPointers:[], budget:{maxBytes:RESUME_CONTEXT_MAX_BYTES,maxMeaningfulRecords:3,maxTextCharsPerRecord:480}, authority:'READ_ONLY_COMPOSED_FROM_EXISTING_CONTINUITY_AND_MEMORY_OWNERS' };
  if (!room?.roomId) return base;
  let inspected; try { inspected=contextGateway.inspect({roomId:room.roomId}); } catch (_) { return blocked('MEMORY_ROOM_OWNER_UNAVAILABLE'); } const scopeRoom={...room,projectId:inspected?.room?.projectId||room.projectId||null};
  const seen=new Set(); const recent=(Array.isArray(inspected?.fragments)?inspected.fragments:[]).filter(fragment=>ACTIVE_FRAGMENT_STATUSES.has(fragment?.status)&&MEANINGFUL_TYPES.has(fragment?.type)&&typeof fragment?.text==='string'&&fragment.text.trim()).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))||String(b.fragmentId||'').localeCompare(String(a.fragmentId||''))).filter(fragment=>{const key=`${fragment.sourcePointer?.sourceId||''}\u0000${fragment.text}`; if(seen.has(key))return false; seen.add(key); return true;}).slice(0,3).map(fragment=>({text:fragment.text.slice(0,480),sourceId:fragment.sourcePointer?.sourceId||null,sourceHash:fragment.sourcePointer?.sourceHash||null,type:fragment.type,createdAt:fragment.createdAt||null}));
  base.recentMeaningful=recent; base.reopenPointers=recent.map(({sourceId,sourceHash})=>({sourceId,sourceHash}));
  const query=recent[0]?.text||'';
  try { const recalled=behavioralMemory&&typeof behavioralMemory.recall==='function'?behavioralMemory.recall({message:query,room:scopeRoom}):null; const cards=(Array.isArray(recalled?.cards)?recalled.cards:[]).filter(card=>CARD_SCOPES.has(card?.scope)&&(card.scope==='GLOBAL'||card.scope==='PROJECT'&&card.scopeKey===scopeRoom.projectId||card.scope==='TOPIC'&&card.scopeKey===scopeRoom.primaryTopicId)).map(card=>({cardId:card.cardId||null,scope:card.scope,scopeKey:card.scopeKey||null,state:card.state||null,globalAlways:card.globalAlways===true,projectionHash:card.projectionHash||null})); base.behavioralMemory=recalled?{status:'RECALLED_REDACTED',cards,projectionHash:recalled.projectionHash||null,authority:'CARDS_ONLY_NO_RAW_TRANSCRIPT_OR_EFFECT'}:base.behavioralMemory; } catch (error) { base.status='DEGRADED_BEHAVIORAL_RECALL'; base.behavioralMemory={status:'DEGRADED_FAIL_OPEN',cards:[],reason:`BEHAVIORAL_RECALL_FAILED:${String(error.message||error)}`,authority:'CARDS_ONLY_NO_RAW_TRANSCRIPT_OR_EFFECT'}; }
  while (contextBytes(base)>RESUME_CONTEXT_MAX_BYTES && base.behavioralMemory.cards.length) base.behavioralMemory.cards.pop();
  while (contextBytes(base)>RESUME_CONTEXT_MAX_BYTES && base.recentMeaningful.length) { base.recentMeaningful.pop(); base.reopenPointers=base.reopenPointers.slice(0,base.recentMeaningful.length); }
  return base;
}
function getJson(url) { try { return JSON.parse(childProcess.execFileSync('curl.exe',['--fail','--silent','--show-error','--max-time','5','-H','accept: application/json','-H','cache-control: no-store',url],{encoding:'utf8',windowsHide:true,maxBuffer:CLAIM_READ_MAX_BUFFER_BYTES})); } catch (error) { throw new Error(`CLAIM_READ_FAILED:${String(error.status || error.message)}`); } }
function containment(root, ref) { const base=path.resolve(root); const target=path.resolve(base, String(ref||'')); return target.startsWith(base+path.sep)?target:null; }
function immutableFile(root, ref) {
  if(typeof root!=='string'||typeof ref!=='string'||!ref||ref.includes('\\')||path.isAbsolute(ref)||ref.split('/').some(p=>!p||p==='.'||p==='..'))return null;
  const base=path.resolve(root),file=containment(base,ref);if(!file)return null;
  try {
    if(fs.lstatSync(base).isSymbolicLink())return null;
    let current=base;
    for(const part of ref.split('/')){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())return null;}
    const stat=fs.statSync(file);if(!stat.isFile()||stat.size>65536)return null;
    const realRoot=fs.realpathSync(base),realFile=fs.realpathSync(file);if(!realFile.startsWith(realRoot+path.sep))return null;
    return {file:realFile,artifactRef:ref};
  }catch(_){return null;}
}
function resolveTaskArtifact(root, artifactRef) {
  const refs=[String(artifactRef||'')];
  if(/^(?:items|dispatches|continuations)\//.test(refs[0])) refs.push(`archive/${refs[0]}`);
  for(const ref of refs){const located=immutableFile(root,ref);if(located)return located;}
  return null;
}
function nativeAuthorityFailure(pointer,p,now){
  if(p?.backend!=='SQLITE'||pointer.sqliteAuthority!==true||pointer.postgresqlAuthority!==false||pointer.operationalCutover!==true||p.operationalCutover!==true)return 'SQLITE_PROVENANCE_UNAVAILABLE';
  if(!/^[a-f0-9]{64}$/.test(pointer.manifestSha256||'')||p.releaseHash!==pointer.manifestSha256||!Number.isSafeInteger(pointer.writerFenceEpoch)||pointer.writerFenceEpoch<1||p.fencingToken!==pointer.writerFenceEpoch)return 'SQLITE_RELEASE_OR_FENCE_MISMATCH';
  if(!/^[a-f0-9]{64}$/.test(pointer.sqliteActivationReceiptHash||'')||p.activationReceiptHash!==pointer.sqliteActivationReceiptHash||!/^[a-f0-9]{64}$/.test(p.baselineDigest||''))return 'SQLITE_ACTIVATION_PROOF_MISMATCH';
  if(typeof pointer.sqliteDatabasePath!=='string'||!path.isAbsolute(pointer.sqliteDatabasePath)||/^(?:\\\\|\/\/|file:)/i.test(pointer.sqliteDatabasePath)||p.authorityDatabasePath!==pointer.sqliteDatabasePath||!fs.statSync(pointer.sqliteDatabasePath).isFile())return 'SQLITE_DATABASE_BINDING_MISMATCH';
  if(pointer.sqliteAuthorityHost!==require('node:os').hostname()||p.authorityHost!==pointer.sqliteAuthorityHost)return 'SQLITE_HOME_HOST_BINDING_MISMATCH';
  if(p.activeHolder!=='HOME_CONTROL_01:PAI_RUN_LOOP'||typeof p.activeLeaseId!=='string'||!p.activeLeaseId||!Number.isFinite(Date.parse(p.leaseExpiresAt))||Date.parse(p.leaseExpiresAt)-now()<30000)return 'SQLITE_AUTHORITY_LEASE_NOT_LIVE';
  if(!Number.isSafeInteger(p.currentRevision)||p.currentRevision<0||!Number.isSafeInteger(p.generation)||p.generation<1)return 'SQLITE_AUTHORITY_COUNTER_INVALID';
  return null;
}
function createRealReaders({ claimServiceUrl, taskBoxRoot, systemControlPath, currentPointerPath=null, now=()=>Date.now(), fetchJson=getJson }={}) {
  const lifecycleUrl=claimServiceUrl&&`${claimServiceUrl.replace(/\/$/,'')}/v1/lifecycle-snapshot`; const authorityUrl=claimServiceUrl&&`${claimServiceUrl.replace(/\/$/,'')}/v1/authority-state`;
  let handoffCache={signature:null,byParent:new Map()};
  function boundAuthority(){
    const unavailable=failureClass=>({status:'UNAVAILABLE',authorityBindingFailed:true,failureClass,authority:'CURRENT_BOUND_CLAIM_AUTHORITY_REQUIRED'});
    let before=null,pointer=null;
    try{if(currentPointerPath){if(!path.isAbsolute(currentPointerPath))return unavailable('AUTHORITY_CURRENT_POINTER_REQUIRED');before=fs.readFileSync(currentPointerPath);pointer=JSON.parse(before.toString('utf8').replace(/^\uFEFF/,''));}}
    catch(_){return unavailable('AUTHORITY_CURRENT_POINTER_UNAVAILABLE');}
    const currentFailure=()=>{if(!before)return null;try{return before.equals(fs.readFileSync(currentPointerPath))?null:'AUTHORITY_CURRENT_POINTER_CHANGED';}catch(_){return 'AUTHORITY_CURRENT_POINTER_UNAVAILABLE';}};
    if(!authorityUrl)return before?unavailable(pointer?.sqliteAuthority===true?'SQLITE_AUTHORITY_STATE_UNAVAILABLE':'POSTGRESQL_AUTHORITY_STATE_UNAVAILABLE'):blocked('AUTHORITY_STATE_UNAVAILABLE');
    try{
      const response=fetchJson(authorityUrl);
      const rotated=currentFailure();if(rotated)return unavailable(rotated);
      if(pointer?.sqliteAuthority===true){
        if(response?.status!=='OK')return unavailable('SQLITE_AUTHORITY_STATE_UNAVAILABLE');const failure=nativeAuthorityFailure(pointer,response.authority,now);if(failure)return unavailable(failure);
        if(!before.equals(fs.readFileSync(currentPointerPath)))return unavailable('SQLITE_CURRENT_POINTER_CHANGED');
        return {...response,authorityBackend:'SQLITE',currentBound:true};
      }
      if(response?.authority?.backend==='SQLITE')return unavailable('SQLITE_CURRENT_POINTER_BINDING_REQUIRED');
      if(before){const a=response?.authority;if(response?.status!=='OK'||pointer.postgresqlAuthority!==true||pointer.operationalCutover!==true||a?.backend!=='POSTGRESQL'||a.operationalCutover!==true||!/^[a-f0-9]{64}$/.test(pointer.manifestSha256||'')||a.releaseHash!==pointer.manifestSha256||!Number.isSafeInteger(pointer.writerFenceEpoch)||pointer.writerFenceEpoch<1||a.fencingToken!==pointer.writerFenceEpoch)return unavailable('POSTGRESQL_CURRENT_AUTHORITY_BINDING_MISMATCH');}
      return response;
    }catch(error){const rotated=currentFailure();if(rotated)return unavailable(rotated);if(before)return unavailable(pointer?.sqliteAuthority===true?'SQLITE_AUTHORITY_STATE_UNAVAILABLE':'POSTGRESQL_AUTHORITY_STATE_UNAVAILABLE');throw error;}
  }
  function lifecycleById(id,claimId=null) { if(!lifecycleUrl) return blocked('SANITIZED_CLAIM_SERVICE_UNAVAILABLE'); const suffix=claimId?`?externalTaskId=${encodeURIComponent(id)}&claimId=${encodeURIComponent(claimId)}`:`?externalTaskId=${encodeURIComponent(id)}`; const snapshot=fetchJson(lifecycleUrl+suffix); const matches=Array.isArray(snapshot.items)?snapshot.items.filter(x=>x.externalTaskId===id&&(!claimId||x.claimId===claimId)):[]; return matches.length===1?{status:snapshot.status,graphId:snapshot.graphId,item:matches[0],counts:snapshot.counts,readback:snapshot.readback,filter:snapshot.filter}:blocked(matches.length?'LIFECYCLE_IDENTITY_AMBIGUOUS':'LIFECYCLE_ITEM_NOT_FOUND'); }
  function terminalHandoffs(handoffs,id){const entries=fs.readdirSync(handoffs,{withFileTypes:true}).filter(ent=>ent.isFile()&&ent.name.endsWith('.md')).sort((a,b)=>a.name.localeCompare(b.name));const signature=entries.map(ent=>{const stat=fs.statSync(path.join(handoffs,ent.name));return `${ent.name}:${stat.size}:${stat.mtimeMs}`;}).join('|');if(handoffCache.signature!==signature){const byParent=new Map();for(const ent of entries){const file=path.join(handoffs,ent.name),bytes=fs.readFileSync(file);try{const parsed=parseTaskBoxWire(bytes,'HANDOFF');if(!['DONE','NOT_DONE','BLOCKED'].includes(parsed.result.STATUS))continue;const parent=parsed.fields.PARENT_ID,hits=byParent.get(parent)||[];hits.push({artifactRef:`handoffs/${ent.name}`,sha256:sha256(bytes),parsed});byParent.set(parent,hits);}catch(_){}}handoffCache={signature,byParent};}return handoffCache.byParent.get(id)||[];}
  function acceptedResult(binding) {
    const unavailable=failureClass=>({status:'UNAVAILABLE',failureClass,authority:'CLAIM_CANONICAL_READBACK_REQUIRED'});
    let pointerBytes=null,native=false;
    const legacyKeys=['backend','remote_revision','generation','fencing_token','release_hash'],nativeKeys=['backend','currentRevision','generation','fencingToken','releaseHash','activeHolder','activeLeaseId','activationReceiptHash','baselineDigest','authorityDatabasePath','authorityHost'];
    const changed=(a,b)=>(native?nativeKeys:legacyKeys).some(k=>a[k]!==b[k]);
    const pendingAuthority=()=>native?'CLAIM_HOME_SQLITE_AUTHORITY_READBACK':'CLAIM_POSTGRESQL_PROJECTED_READBACK';
    const validProjection=lifecycle=>{
      const p=lifecycle.readback?.projection,age=now()-Date.parse(p?.updated_at);
      if(p?.backend==='SQLITE'){
        if(lifecycle.readback?.source!=='HOME_SQLITE_AUTHORITY_READ_ONLY')return native?'SQLITE_PROVENANCE_UNAVAILABLE':'POSTGRESQL_PROVENANCE_UNAVAILABLE';
        if(!currentPointerPath||!path.isAbsolute(currentPointerPath))return 'SQLITE_CURRENT_POINTER_BINDING_REQUIRED';
        const bytes=fs.readFileSync(currentPointerPath);if(pointerBytes&&!pointerBytes.equals(bytes))return 'SQLITE_CURRENT_POINTER_CHANGED';pointerBytes=bytes;
        const pointer=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
        if(lifecycle.status!=='OK')return 'SQLITE_PROVENANCE_UNAVAILABLE';const failure=nativeAuthorityFailure(pointer,p,now);if(failure)return failure;
        native=true;return null;
      }
      if(native)return 'AUTHORITY_BACKEND_CHANGED';
      if(currentPointerPath&&JSON.parse(fs.readFileSync(currentPointerPath,'utf8').replace(/^\uFEFF/,'')).sqliteAuthority===true)return 'AUTHORITY_BACKEND_CHANGED';
      if(lifecycle.status!=='OK'||lifecycle.readback?.source!=='LOCAL_POSTGRES_PROJECTION_READ_ONLY'||p?.backend!=='POSTGRESQL'||!Number.isSafeInteger(p.remote_revision)||p.remote_revision<0||!Number.isSafeInteger(p.generation)||p.generation<1||!Number.isSafeInteger(p.fencing_token)||p.fencing_token<1||!/^[a-f0-9]{64}$/.test(p.release_hash||''))return 'POSTGRESQL_PROVENANCE_UNAVAILABLE';
      if(!Number.isFinite(age)||age < -30000||age>300000)return 'POSTGRESQL_PROJECTION_STALE';
      return null;
    };
    try {
      if(!binding||!safeId(binding.taskId)||!/^[a-f0-9]{64}$/.test(binding.dispatchSha256||''))return unavailable('ACCEPTED_RESULT_BINDING_REQUIRED');
      const initial=lifecycleById(binding.taskId);if(initial.status==='BLOCKED')return unavailable(initial.failureClass);
      const initialError=validProjection(initial);if(initialError)return unavailable(initialError);
      const claimId=initial.item?.claimId;
      if(!claimId)return {status:'PENDING',lifecycleState:initial.item.state||'READY',taskId:binding.taskId,authority:pendingAuthority()};
      if(!/^claim_[0-9a-f-]{36}$/.test(claimId))return unavailable('CLAIM_IDENTITY_MISMATCH');
      const exact=lifecycleById(binding.taskId,claimId);if(exact.status==='BLOCKED')return unavailable(exact.failureClass);
      const exactError=validProjection(exact);if(exactError)return unavailable(exactError);
      if(changed(initial.readback.projection,exact.readback.projection))return unavailable(native?'SQLITE_AUTHORITY_OBSERVATION_CHANGED':'POSTGRESQL_PROJECTION_CHANGED');
      const item=exact.item;
      if(exact.filter?.externalTaskId!==binding.taskId||exact.filter?.claimId!==claimId||item.externalTaskId!==binding.taskId||item.claimId!==claimId)return unavailable('CLAIM_IDENTITY_MISMATCH');
      if(item.artifactRef!==binding.dispatchRef||item.artifactHash!==binding.dispatchSha256||item.mutableScope!==binding.mutableScope)return unavailable('DISPATCH_BINDING_MISMATCH');
      if(!Number.isSafeInteger(item.attempt)||item.attempt<1||!Number.isSafeInteger(item.fence)||item.fence<1)return unavailable('ATTEMPT_FENCE_BINDING_MISSING');
      const located=resolveTaskArtifact(taskBoxRoot,binding.dispatchRef);if(!located)return unavailable('DISPATCH_REF_OUTSIDE_TASK_BOX_OR_MISSING');
      const dispatchBytes=fs.readFileSync(located.file);if(sha256(dispatchBytes)!==binding.dispatchSha256)return unavailable('DISPATCH_HASH_DRIFT');
      const dispatch=parseTaskBoxWire(dispatchBytes,'DISPATCH'),h=dispatch.fields;
      if(h.TASK_ID!==binding.taskId||h.TYPE!==binding.dispatchType||h.ROOT_ID!==binding.rootId||(h.PARENT_ID||null)!==binding.parentId||h.MUTABLE_SCOPE!==binding.mutableScope)return unavailable('DISPATCH_IDENTITY_MISMATCH');
      const state=String(item.effectiveState||item.state||'').toUpperCase();
      if(!['DONE','NOT_DONE','BLOCKED'].includes(state))return {status:'PENDING',lifecycleState:state,taskId:binding.taskId,claimId,authority:pendingAuthority()};
      const terminalStatus={DONE:'PASS',NOT_DONE:'FAIL',BLOCKED:'BLOCKED'}[state];
      if(item.rawPayloadState!==state||item.claimStatus!==terminalStatus||item.dispatchStatus!==terminalStatus||!Number.isFinite(Date.parse(item.completedAt))||typeof item.hostId!=='string'||!item.hostId)return unavailable('TERMINAL_CLAIM_DISPATCH_MISMATCH');
      if(!/^handoffs\/[A-Za-z0-9_.-]+\.md$/.test(item.handoffRef||''))return unavailable('HANDOFF_REF_OUTSIDE_TASK_BOX_OR_MISSING');
      if(!/^[a-f0-9]{64}$/.test(item.handoffHash||''))return unavailable('CANONICAL_HANDOFF_BINDING_MISSING');
      const handoffFile=immutableFile(taskBoxRoot,item.handoffRef);if(!handoffFile)return unavailable('HANDOFF_REF_OUTSIDE_TASK_BOX_OR_MISSING');
      const bytes=fs.readFileSync(handoffFile.file),hash=sha256(bytes);if(hash!==item.handoffHash)return unavailable('HANDOFF_HASH_DRIFT');
      const parsed=parseTaskBoxWire(bytes,'HANDOFF');
      if(parsed.fields.TYPE!=='HANDOFF'||parsed.fields.PARENT_ID!==binding.taskId||parsed.fields.ROOT_ID!==binding.rootId||parsed.fields.MUTABLE_SCOPE!=='NONE'||parsed.result.STATUS!==state)return unavailable('HANDOFF_IDENTITY_MISMATCH');
      const reread=lifecycleById(binding.taskId,claimId);if(reread.status==='BLOCKED')return unavailable(reread.failureClass);
      const lastError=validProjection(reread);if(lastError)return unavailable(lastError);
      if(changed(exact.readback.projection,reread.readback.projection))return unavailable(native?'SQLITE_AUTHORITY_OBSERVATION_CHANGED':'POSTGRESQL_PROJECTION_CHANGED');
      const fields=['externalTaskId','claimId','hostId','artifactRef','artifactHash','mutableScope','effectiveState','rawPayloadState','claimStatus','dispatchStatus','completedAt','handoffRef','handoffHash','attempt','fence'];
      if(fields.some(k=>item[k]!==reread.item[k]))return unavailable('CLAIM_COMPLETION_CHANGED');
      if(pointerBytes&&!pointerBytes.equals(fs.readFileSync(currentPointerPath)))return unavailable('SQLITE_CURRENT_POINTER_CHANGED');
      return {status:state,taskId:binding.taskId,claimId,attempt:item.attempt,fence:item.fence,completedAt:item.completedAt,dispatch:{artifactRef:located.artifactRef,sha256:binding.dispatchSha256,mutableScope:binding.mutableScope},handoff:{artifactRef:item.handoffRef,sha256:hash,parsed},provenance:exact.readback,authority:native?'CLAIM_HOME_SQLITE_SELECTED_IMMUTABLE_HANDOFF':'CLAIM_POSTGRESQL_SELECTED_IMMUTABLE_HANDOFF'};
    }catch(_){return unavailable('CLAIM_RESULT_READ_FAILED');}
  }
  return { lifecycleById, acceptedResult, pulse(){ if(!lifecycleUrl) return blocked('SANITIZED_CLAIM_SERVICE_UNAVAILABLE'); const s=fetchJson(`${lifecycleUrl}?summary=1`); let authority=null; try{authority=boundAuthority();}catch(e){authority=blocked('AUTHORITY_STATE_UNAVAILABLE');} return {status:s.status,graphId:s.graphId,count:s.count,counts:s.counts,readback:s.readback,authority}; }, authority:boundAuthority, workItem(id){ const lifecycle=lifecycleById(id); if(lifecycle.status==='BLOCKED')return {workItemId:id,...lifecycle}; let rootAvailable=false; try{rootAvailable=typeof taskBoxRoot==='string'&&!!taskBoxRoot.trim()&&fs.statSync(path.resolve(taskBoxRoot)).isDirectory();}catch(_){} if(!rootAvailable)return {workItemId:id,lifecycle,status:'BLOCKED',failureClass:'TASK_BOX_EVIDENCE_ROOT_UNAVAILABLE'}; const item=lifecycle.item; const located=resolveTaskArtifact(taskBoxRoot,item.artifactRef); if(!located)return {workItemId:id,lifecycle,status:'BLOCKED',failureClass:'ARTIFACT_REF_OUTSIDE_TASK_BOX_OR_MISSING'}; const bytes=fs.readFileSync(located.file); const hash=sha256(bytes); if(hash!==item.artifactHash)return {workItemId:id,lifecycle,status:'BLOCKED',failureClass:'ARTIFACT_HASH_DRIFT',actualHash:hash}; let parsed; try{parsed=parseTaskBoxWire(bytes);}catch(e){return {workItemId:id,lifecycle,status:'BLOCKED',failureClass:`ARTIFACT_WIRE_INVALID:${e.message}`};} return {workItemId:id,lifecycle:{...lifecycle,item:undefined},artifact:{artifactRef:located.artifactRef,sha256:hash,bytes:bytes.subarray(0,12000).toString('utf8'),truncated:bytes.length>12000,parsed},authority:'LIFECYCLE_PLUS_IMMUTABLE_READ_ONLY'}; }, resultEvent(id){ const lifecycle=lifecycleById(id); if(lifecycle.status==='BLOCKED') return {resultEventId:id,...lifecycle}; if(!taskBoxRoot)return {resultEventId:id,lifecycle,status:'BLOCKED',failureClass:'TASK_BOX_EVIDENCE_ROOT_UNAVAILABLE'}; const handoffs=path.join(path.resolve(taskBoxRoot),'handoffs'); if(!fs.existsSync(handoffs))return {resultEventId:id,lifecycle,status:'BLOCKED',failureClass:'HANDOFF_DIRECTORY_UNAVAILABLE'}; const hits=terminalHandoffs(handoffs,id),terminalState=lifecycle.item.effectiveState||lifecycle.item.state||lifecycle.item.claimState,matching=hits.filter(hit=>hit.parsed.result.STATUS===terminalState),selected=matching.length?matching:hits; if(selected.length!==1)return {resultEventId:id,lifecycle,status:'BLOCKED',failureClass:selected.length?'MULTIPLE_TERMINAL_HANDOFF_CONFLICT':'TERMINAL_HANDOFF_NOT_FOUND',matches:selected.length,historicalMatches:hits.length}; return {resultEventId:id,lifecycle,handoff:selected[0],historicalMatches:hits.length,authority:'LIFECYCLE_SELECTED_IMMUTABLE_HANDOFF_READ_ONLY_CACHED_INDEX'}; }, hostCapabilities(){ if(!systemControlPath||!fs.existsSync(systemControlPath))return blocked('SYSTEM_CONTROL_PROJECTION_UNAVAILABLE'); const raw=JSON.parse(fs.readFileSync(systemControlPath,'utf8')); const observedAt=raw?.observed?.at; const ageMs=observedAt?Math.max(0,now()-Date.parse(observedAt)):null; const workers=(raw?.observed?.resident?.fanout?.workers||[]).filter(w=>typeof w?.workerId==='string'&&w.workerId.trim()).map(w=>({workerId:w.workerId,...(typeof w.hostId==='string'&&w.hostId.trim()?{hostId:w.hostId}:{}),configuredCapacity:w.configuredCapacity,reachable:w.reachable,usableActiveLanes:w.usableActiveLanes,healthStatus:w.healthStatus,authorityTimeOnlyDegraded:w.authorityTimeOnlyDegraded})); return {observedAt,ageMs,stale:!observedAt||!Number.isFinite(ageMs)||ageMs>300000,workers,authority:'SYSTEM_CONTROL_OBSERVED_PROJECTION'}; } };
}
function behavioralBootPack(behavioralMemory){if(!behavioralMemory||typeof behavioralMemory.recallGlobal!=='function')return {status:'DEGRADED_UNAVAILABLE',cards:[],authority:'CARDS_ONLY_NO_RAW_TRANSCRIPT_OR_EFFECT'};try{const recalled=behavioralMemory.recallGlobal();return {status:'RECALLED_REDACTED',...compact(recalled,4000),globalAlwaysLimit:recalled.limit??8,authority:'CARDS_ONLY_NO_RAW_TRANSCRIPT_OR_EFFECT'};}catch(error){return {status:'DEGRADED_FAIL_OPEN',cards:[],reason:'BEHAVIORAL_RECALL_FAILED:'+String(error.message||error),authority:'CARDS_ONLY_NO_RAW_TRANSCRIPT_OR_EFFECT'};}}
function createCurrentOwnerAdapters({continuity=()=>blocked('CHIEF_CONTINUITY_OWNER_UNAVAILABLE'),contextGateway=null,realReaders=null,behavioralMemory=null,recentIntent=null,bootPointers=BOOT_POINTERS}={}) { return { resume:()=>({...compactCanonicalReality(continuity()),boot:bootPointers,sourceType:'JIT_CHIEF_CONTINUITY',authority:'CHIEF_CONTINUITY_OWNER_READ_ONLY'}),pulse:()=>realReaders?realReaders.pulse():blocked('SANITIZED_CLAIM_SERVICE_UNAVAILABLE'),authority:()=>realReaders?realReaders.authority():blocked('AUTHORITY_STATE_UNAVAILABLE'),context:()=>composeResumeContext({continuity,contextGateway,behavioralMemory}),recentIntent:args=>recentIntent&&typeof recentIntent.recent==='function'?recentIntent.recent(args):blocked('RECENT_INTENT_OWNER_UNAVAILABLE'),workItem:id=>realReaders?realReaders.workItem(id):blocked('REAL_LIFECYCLE_READER_UNAVAILABLE'),resultEvent:id=>realReaders?realReaders.resultEvent(id):blocked('REAL_HANDOFF_READER_UNAVAILABLE'),hostCapabilities:()=>realReaders?realReaders.hostCapabilities():blocked('SYSTEM_CONTROL_PROJECTION_UNAVAILABLE')}; }
function createReadGateway({owners,catalog=[],telemetry=createContextTelemetry()}={}) {
  if(!owners||['resume','pulse','authority','context','recentIntent','workItem','resultEvent','hostCapabilities'].some(k=>typeof owners[k]!=='function'))deny('PAI_READ_OWNER_ADAPTER_REQUIRED');
  const catalogRows=catalog.filter(x=>x&&safeId(x.id)).map(x=>({...x,cones:(Array.isArray(x.cones)?x.cones:['ARCHITECTURE']).filter(cone=>coneSet.has(cone)),freshness:x.freshness||(x.classification==='JIT_RUNTIME'?'JIT':'STATIC'),authority:x.authority||'PROVENANCE_REQUIRED'}));
  const objects=new Map(); const aliases=new Map(); let catalogDeduped=0, catalogConflicts=0;
  for(const row of catalogRows){
    const canonicalId=String(row.provenance?.fixedDriveId||row.canonicalId||row.id);
    const serialized=typeof row.text==='string'?row.text:JSON.stringify(row.text??null);
    const sourceHash=row.provenance?.contentHash||sha256(Buffer.from(serialized));
    const identity=`${canonicalId}:${sourceHash}`;
    if(objects.has(identity)){catalogDeduped+=1;aliases.set(row.id,objects.get(identity));continue;}
    const canonicalWinner=[...objects.values()].find(item=>item.canonicalId===canonicalId);
    if(canonicalWinner){catalogConflicts+=1;aliases.set(row.id,canonicalWinner);continue;}
    const normalized={...row,canonicalId,sourceHash};objects.set(identity,normalized);aliases.set(row.id,normalized);
  }
  const runtimes=()=>[
    {id:'jit:chief-resume',title:'Current Chief continuity',url:'pai://jit/chief-resume',cones:['CURRENT_RUNTIME'],classification:'JIT_RUNTIME',freshness:'JIT',authority:'CHIEF_CONTINUITY_OWNER',load:owners.resume},
    {id:'jit:recent-user-intent',title:'Recent bound-user intent',url:'pai://jit/recent-user-intent',cones:['PERSONAL'],classification:'JIT_RUNTIME',freshness:'JIT',authority:'PROMPT_EVIDENCE_READ_OWNER',load:owners.recentIntent},
    {id:'jit:pulse',title:'Current operational pulse',url:'pai://jit/pulse',cones:['CURRENT_RUNTIME','FARM'],classification:'JIT_RUNTIME',freshness:'JIT',authority:'CLAIM_READ_OWNER',load:owners.pulse},
    {id:'jit:authority',title:'Current authority state',url:'pai://jit/authority',cones:['CURRENT_RUNTIME'],classification:'JIT_RUNTIME',freshness:'JIT',authority:'AUTHORITY_READ_OWNER',load:owners.authority},
    {id:'jit:host-capabilities',title:'Current host capabilities',url:'pai://jit/host-capabilities',cones:['CURRENT_RUNTIME','FARM'],classification:'JIT_RUNTIME',freshness:'JIT',authority:'SYSTEM_CONTROL_OBSERVER',load:owners.hostCapabilities},
    {id:'jit:context-budget',title:'PAI controlled context budget',url:'pai://jit/context-budget',cones:['ARCHITECTURE','CURRENT_RUNTIME'],classification:'JIT_RUNTIME',freshness:'JIT',authority:'OBSERVABILITY_ONLY',load:telemetry.report}
  ];
  function call(name,args={}){
    if(!READ_TOOLS.some(t=>t.name===name)||!args||typeof args!=='object'||Array.isArray(args))deny('BRIDGE_SCHEMA_INVALID');
    let payload,meta={sourceIds:[]};
    if(name==='pai_resume'){payload=owners.resume();meta={cone:'CURRENT_RUNTIME',bootBytes:contextBytes(payload.boot||{}),continuityBytes:contextBytes({...payload,boot:undefined}),sourceIds:['jit:chief-resume']};}
    else if(name==='pai_get_pulse'){payload=owners.pulse();meta={cone:'CURRENT_RUNTIME',continuityBytes:contextBytes(payload),sourceIds:['jit:pulse']};}
    else if(name==='pai_get_context_pack'){payload=owners.context();meta={cone:'PERSONAL',continuityBytes:contextBytes(payload.canonicalReality||{}),retrievedSourceBytes:contextBytes(payload)-contextBytes(payload.canonicalReality||{}),sourceIds:['jit:chief-resume','jit:recent-user-intent']};}
    else if(name==='pai_get_recent_intent'){payload=owners.recentIntent(args);meta={cone:'PERSONAL',retrievedSourceBytes:contextBytes(payload),sourceIds:['jit:recent-user-intent']};}
    else if(name==='pai_get_work_item'){if(!safeId(args.work_item_id))deny('MCP_INPUT_INVALID');payload=owners.workItem(args.work_item_id);meta={cone:'FARM',retrievedSourceBytes:contextBytes(payload),sourceIds:[`work:${args.work_item_id}`],truncated:payload?.artifact?.truncated===true};}
    else if(name==='pai_get_result_event'){if(!safeId(args.result_event_id))deny('MCP_INPUT_INVALID');payload=owners.resultEvent(args.result_event_id);meta={cone:'FARM',retrievedSourceBytes:contextBytes(payload),sourceIds:[`result:${args.result_event_id}`]};}
    else if(name==='pai_get_host_capabilities'){payload=owners.hostCapabilities();meta={cone:'CURRENT_RUNTIME',retrievedSourceBytes:contextBytes(payload),sourceIds:['jit:host-capabilities']};}
    else if(name==='search'){
      const parsed=queryCone(args.query);if(!parsed.term&&!parsed.explicit)deny('MCP_INPUT_INVALID');const candidates=[...objects.values(),...runtimes()].filter(item=>item.cones.includes(parsed.cone));const seen=new Set();const results=candidates.filter(item=>`${item.id} ${item.title}`.toLowerCase().includes(parsed.term)).filter(item=>{const identity=`${item.canonicalId||item.id}:${item.sourceHash||item.url}`;if(seen.has(identity))return false;seen.add(identity);return true;}).slice(0,SEARCH_RESULT_MAX).map(item=>({id:item.id,canonicalId:item.canonicalId||item.id,sourceHash:item.sourceHash||null,title:item.title,url:item.url,cone:parsed.cone}));payload={cone:parsed.cone,scopeExpanded:false,results,dedupedCount:catalogDeduped,conflictCount:catalogConflicts};meta={cone:parsed.cone,sourceIds:results.map(item=>`${item.canonicalId}:${item.sourceHash||item.url}`)};
    } else {
      const item=aliases.get(String(args.id||''))||runtimes().find(x=>x.id===args.id);if(!item)deny('KNOWLEDGE_OBJECT_NOT_FOUND');const full=String(args.mode||'POINTER').toUpperCase()==='FULL';let serialized='';if(full){const loaded=item.load?item.load(args):item.text;serialized=typeof loaded==='string'?loaded:JSON.stringify(loaded);}const canonicalId=item.canonicalId||item.id;const sourceHash=item.sourceHash||item.provenance?.contentHash||(full?sha256(Buffer.from(serialized)):sha256(Buffer.from(JSON.stringify({canonicalId,url:item.url,classification:item.classification}))));const sourceIdentity=`${canonicalId}:${sourceHash}`;const duplicate=telemetry.seen.has(sourceIdentity)&&!full;const truncated=full&&Buffer.byteLength(serialized,'utf8')>FETCH_TEXT_MAX_BYTES;const text=full?serialized.slice(0,FETCH_TEXT_MAX_BYTES):null;payload={id:item.id,canonicalId,title:item.title,text,url:item.url,metadata:{classification:item.classification,freshness:item.freshness,authority:item.authority,cones:item.cones,sourceHash,deduped:duplicate,pointerOnly:!full,bestEffortFetch:false,fullRef:item.id,maxFullBytes:FETCH_TEXT_MAX_BYTES,provenance:item.provenance||null}};meta={cone:item.cones[0]||null,retrievedSourceBytes:text?Buffer.byteLength(text,'utf8'):0,sourceIds:[sourceIdentity],truncated};
    }
    if(contextBytes(payload)>TOOL_RESULT_MAX_BYTES){const serialized=JSON.stringify(payload);payload={status:'TRUNCATED',preview:serialized.slice(0,TOOL_RESULT_MAX_BYTES-1024),maxBytes:TOOL_RESULT_MAX_BYTES,fullRef:`${name}:${args.id||args.work_item_id||args.result_event_id||'JIT'}`,authority:'POINTER_OR_EXACT_JIT_REF_REQUIRED'};meta.truncated=true;}
    telemetry.record(name,payload,meta);
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload};
  }
  const projectStatus=args=>composeProjectStatus({programId:args?.program_id,taskId:args?.task_id,owners,now:()=>new Date().toISOString()});
  return {tools:READ_TOOLS,call,projectStatus,owners,telemetry};
}
module.exports={BOOT_POINTERS,CLAIM_READ_MAX_BUFFER_BYTES,FETCH_TEXT_MAX_BYTES,TOOL_RESULT_MAX_BYTES,SEARCH_RESULT_MAX,CONTEXT_CONES,READ_TOOLS,RESUME_CONTEXT_SCHEMA,RESUME_CONTEXT_MAX_BYTES,PROJECT_DISPOSITIONS,composeProjectStatus,composeResumeContext,createContextTelemetry,createReadGateway,createCurrentOwnerAdapters,createRealReaders,blocked,queryCone,sha256};
