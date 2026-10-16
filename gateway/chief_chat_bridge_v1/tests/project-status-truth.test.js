'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {composeProjectStatus,createReadGateway,createCurrentOwnerAdapters}=require('../src/pai-read-gateway');
const fixedNow=()=> '2026-09-19T12:00:00.000Z';
const baseItem={externalTaskId:'TASK_A',rootId:'PROGRAM_A',taskType:'DISPATCH',state:'RUNNING',claimId:'CLAIM_A',hostId:'HOST_A',updatedAt:'2026-09-19T10:00:00.000Z',programRevision:7,phase:'BUILD'};
function fixture({item=baseItem,result=null,materialized=true,hosts=true}={}){const calls={work:0,result:0,hosts:0};const owners={workItem:id=>{calls.work++;return materialized?{workItemId:id,lifecycle:{item},artifact:{artifactRef:`items/${id}.md`,parsed:{fields:{TASK_ID:id,TYPE:'DISPATCH',ROOT_ID:item.rootId}}}}:{workItemId:id,status:'BLOCKED',failureClass:'LIFECYCLE_ITEM_NOT_FOUND'};},resultEvent:id=>{calls.result++;return result?{resultEventId:id,lifecycle:{item},handoff:{artifactRef:`handoffs/${id}.md`,observedAt:result.at,parsed:{fields:{TASK_ID:`${id}_RESULT`,TYPE:'HANDOFF',PARENT_ID:id},result:{STATUS:result.status,BLOCKER:result.blocker||'NONE'}}}}:{resultEventId:id,lifecycle:{item},status:'BLOCKED',failureClass:'TERMINAL_HANDOFF_NOT_FOUND'};},hostCapabilities:()=>{calls.hosts++;return hosts?{observedAt:'2026-09-19T11:59:00.000Z',workers:[{hostId:'HOST_A'}]}:{status:'BLOCKED'};}};return {owners,calls};}
function status(options){const f=fixture(options);return {value:composeProjectStatus({programId:'PROGRAM_A',taskId:'TASK_A',owners:f.owners,now:fixedNow}),calls:f.calls};}

let out=status({result:{status:'DONE',at:'2026-09-19T11:00:00.000Z'}});assert.equal(out.value.program_disposition,'NO_MATERIAL_DELTA');assert.equal(out.value.runtime_state,'DONE');assert.equal(out.value.freshness.terminal_overrode_stale_projection,true);
out=status({item:{...baseItem,state:'DONE',runningSuccessor:{externalTaskId:'TASK_B',state:'RUNNING',claimId:'CLAIM_B',hostId:'HOST_B'}},result:{status:'DONE',at:'2026-09-19T11:00:00.000Z'}});assert.equal(out.value.program_disposition,'RUNNING');assert.equal(out.value.current_task_id,'TASK_B');assert.notEqual(out.value.program_disposition,'PROGRAM_DONE','terminal task never completes Program');
out=status({item:{...baseItem,programDisposition:'PROGRAM_DONE',acceptance:'PASS'},result:{status:'PASS',at:'2026-09-19T11:00:00.000Z'}});assert.equal(out.value.program_disposition,'PROGRAM_DONE');assert.equal(out.value.acceptance,'PASS');
out=status({item:{...baseItem,state:'WAIT_RESOURCE',blockerClass:'RESOURCE',blockerDetail:'No eligible lane',blockerOwner:'FARM'}});assert.equal(out.value.program_disposition,'WAIT_RESOURCE');assert.equal(out.value.blocker_owner,'FARM');assert.equal(out.calls.hosts,1);
out=status({item:{},materialized:true});assert.equal(out.value.program_disposition,'MATERIALIZED_NOT_ADMITTED');
out=status();assert.equal(out.value.program_disposition,'RUNNING');assert.equal(out.value.claim_id,'CLAIM_A');assert.equal(out.value.host_id,'HOST_A');
out=status({item:{...baseItem,state:'WAIT_DEPENDENCY',blockerClass:'DEPENDENCY',blockerOwner:null}});assert.equal(out.value.blocker_owner,'UNKNOWN');
const one=status().value,two=status().value;assert.deepEqual(one,two,'same evidence must be deterministic');assert.deepEqual(Object.keys(one.freshness),['sampled_at','evidence_at','age_ms','terminal_overrode_stale_projection']);
assert.deepEqual(status().calls,{work:1,result:1,hosts:1});assert.equal(JSON.stringify(one).match(/Drive|contact support|no progress/gi),null);
for(const field of ['program_id','program_revision','program_disposition','acceptance','current_round_or_phase','current_task_id','current_task_type','runtime_state','host_id','claim_id','latest_result_status','latest_result_ref','latest_result_at','blocker_class','blocker_detail','blocker_owner','next_eligible','decision_required','freshness','source_refs'])assert.ok(Object.hasOwn(one,field),field);

const f=fixture();const owners={...createCurrentOwnerAdapters(),...f.owners,resume:()=>({status:'VERIFIED'}),pulse:()=>({status:'OK'}),authority:()=>({status:'OK'}),context:()=>({status:'READY'}),recentIntent:()=>({status:'EMPTY'})};
const gateway=createReadGateway({owners});const projected=gateway.projectStatus({program_id:'PROGRAM_A',task_id:'TASK_A'});assert.equal(projected.program_id,'PROGRAM_A');assert.equal(projected.current_task_id,'TASK_A');
const bridgeSource=fs.readFileSync(require.resolve('../src/chief-chat-bridge'),'utf8');assert.match(bridgeSource,/result\.projectStatus = readGateway\.projectStatus/);assert.match(bridgeSource,/name === 'chief_resume'/,'chief_resume regression');
assert.ok(Buffer.byteLength(JSON.stringify(gateway.call('pai_resume').structuredContent),'utf8')<12000,'Context Economy regression');
console.log('project-status-truth: PASS bounded exact status truth and precedence');
