'use strict';
const {unwrap}=require('./submission-state');
const validId=id=>typeof id==='string'&&/^[A-Za-z][A-Za-z0-9_:.~-]{0,191}$/.test(id);
function identities(value){return [value?.pai_task_id,value?.task_id,value?.taskId,value?.mcp_task_id,value?.structuredResult?.pai_task_id,value?.structuredResult?.taskId,value?.structuredResult?.binding?.taskId,value?.acceptedResult?.taskId,value?.acceptedResult?.binding?.taskId].filter(x=>x!==undefined);}
function resultState(response,taskId){
 const decoded=unwrap(response),v=decoded.value;
 if(decoded.kind!=='VALUE'||!v||typeof v!=='object')return{verified:false,reason:'RESULT_READ_UNVERIFIED'};
 const ids=identities(v);if(!ids.length||ids.some(x=>x!==taskId))return{verified:false,reason:'RESULT_IDENTITY_MISMATCH'};
 const status=String(v.status||'').toUpperCase(),inner=String(v.structuredResult?.status||'').toUpperCase(),success=new Set(['DONE','COMPLETED','SUCCEEDED']),failure=new Set(['NOT_DONE','FAILED','BLOCKED','CANCELLED']);
 if(!success.has(status)&&!failure.has(status))return{verified:false,reason:'RESULT_NOT_TERMINAL'};
 const stateClass=s=>success.has(s)?'SUCCESS':['NOT_DONE','FAILED'].includes(s)?'FAILURE':s;
 if(inner&&stateClass(status)!==stateClass(inner))return{verified:false,reason:'RESULT_STATUS_CONTRADICTION'};
 if(success.has(status)&&v.structuredResult?.failureClass)return{verified:false,reason:'RESULT_FAILURE_CONTRADICTION'};
 return{verified:true,success:success.has(status),terminal_status:status,value:v};
}
async function readTask({taskId,readStatus,readResult}){
 if(!validId(taskId))throw Error('SEED_TASK_ID_INVALID');if(typeof readStatus!=='function'||typeof readResult!=='function')throw Error('SEED_READERS_REQUIRED');
 const base={task_id:taskId,terminal:false,completed:false,result_verified:false,resubmitted:false};
 let statusReply,resultReply;try{statusReply=await readStatus(taskId);}catch{return{...base,status:'READBACK_UNVERIFIED',reason:'STATUS_TRANSPORT_FAILED_NO_RESUBMIT'};}
 const status=unwrap(statusReply),task=status.value?.task;
 if(status.kind!=='VALUE'||!task||!identities(task).length||identities(task).some(x=>x!==taskId))return{...base,status:'READBACK_UNVERIFIED',reason:'STATUS_IDENTITY_UNVERIFIED'};
 try{resultReply=await readResult(taskId);}catch{return{...base,status:'READBACK_UNVERIFIED',reason:'RESULT_TRANSPORT_FAILED_NO_RESUBMIT',read_status:status.value};}
 const proof=resultState(resultReply,taskId);
 if(proof.verified)return{...base,status:proof.success?'COMPLETED_WITH_RESULT':'TERMINAL_FAILURE_WITH_RESULT',terminal:true,completed:proof.success,result_verified:true,terminal_status:proof.terminal_status,read_status:status.value,result:proof.value};
 const lifecycle=String(task.acceptedResult?.lifecycleState||task.acceptedResult?.status||task.status||status.value.status||'UNKNOWN').toUpperCase();
 return{...base,status:lifecycle==='RECONCILE_REQUIRED'?'RECONCILE_REQUIRED':'RESULT_PENDING_OR_UNVERIFIED',lifecycle_state:lifecycle,reason:proof.reason,read_status:status.value};
}
async function waitTask(options){const {timeoutMs=60000,intervalMs=1500,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}=options;if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000||!Number.isSafeInteger(intervalMs)||intervalMs<250||intervalMs>5000)throw Error('SEED_WAIT_BOUNDS_INVALID');const deadline=now()+timeoutMs;let last;do{last=await readTask(options);if(last.terminal||last.status==='RECONCILE_REQUIRED')return last;const remaining=deadline-now();if(remaining<=0)break;await sleep(Math.min(intervalMs,remaining));}while(now()<deadline);return{...last,status:'WAIT_TIMEOUT_NO_RESUBMIT',last_status:last.status};}
module.exports={validId,resultState,readTask,waitTask};
