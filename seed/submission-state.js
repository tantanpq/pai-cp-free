'use strict';
const object = x => x && typeof x === 'object' && !Array.isArray(x);
// Unwrap known JSON-RPC/MCP envelopes. Conflicting/error envelopes never admit.
function unwrap(value) {
  for (let depth=0;depth<8;depth++) {
    if (!object(value)) return {kind:'UNKNOWN',value};
    if (value.error || value.isError===true || value.ok===false) return {kind:'ERROR',value};
    if (value.jsonrpc==='2.0') { if (!Object.hasOwn(value,'result')) return {kind:'UNKNOWN',value}; value=value.result; continue; }
    if (object(value.structuredContent)) {
      const structured=value.structuredContent.result??value.structuredContent;
      if(Array.isArray(value.content)){const texts=value.content.filter(x=>x?.type==='text');try{if(texts.length!==1||JSON.stringify(JSON.parse(texts[0].text))!==JSON.stringify(structured))return{kind:'UNKNOWN',value};}catch{return{kind:'UNKNOWN',value};}}
      value=structured;continue;
    }
    if (Array.isArray(value.content)) {
      const texts=value.content.filter(x=>x?.type==='text');
      if(texts.length!==1)return {kind:'UNKNOWN',value};
      try{value=JSON.parse(texts[0].text);continue;}catch{return {kind:'UNKNOWN',value};}
    }
    return {kind:'VALUE',value};
  }
  return {kind:'UNKNOWN',value};
}
function classify(response,request) {
  const decoded=unwrap(response),receipt=decoded.value;
  const base={accepted:false,completed:false,result_verified:false};
  if(decoded.kind==='ERROR')return {...base,status:'SUBMISSION_FAILED',receipt};
  if(decoded.kind!=='VALUE')return {...base,status:'SUBMISSION_UNVERIFIED',receipt};
  if(receipt.request_id && receipt.request_id!==request.request_id)return {...base,status:'SUBMISSION_UNVERIFIED',reason:'REQUEST_ID_MISMATCH',receipt};
  const admission=receipt.admission_state??receipt.admission;
  if(/DENIED|REJECT|BLOCKED|UNAVAILABLE|MISMATCH|WAIT_RESOURCE|NEEDS_/.test(String(admission))||receipt.blocker)return {...base,status:'REJECTED_BY_EXISTING_GOVERNOR',receipt};
  if(!['ADMITTED','ADMITTED_TASKBOX','NO_EFFECT_CANDIDATE','IDEMPOTENT_REPLAY'].includes(admission)||receipt.chief_state!=='ADMITTED'||typeof receipt.pai_task_id!=='string'||!receipt.pai_task_id)return {...base,status:admission==='PENDING'?'SUBMISSION_RECEIVED':'SUBMISSION_UNVERIFIED',receipt};
  if(receipt.request_id!==request.request_id)return {...base,status:'SUBMISSION_UNVERIFIED',reason:'REQUEST_ID_MISMATCH',receipt};
  const lifecycle=receipt.lifecycle_state;
  return {...base,accepted:true,status:['FAILED','CANCELLED'].includes(lifecycle)?'EXECUTION_FAILURE_REPORTED':lifecycle==='COMPLETED'?'COMPLETION_REPORTED_RESULT_UNVERIFIED':lifecycle==='RUNNING'?'RUNNING_REPORTED':'ADMITTED_TO_EXISTING_GOVERNOR',receipt};
}
function verifyResult(response,taskId) {
  const decoded=unwrap(response),value=decoded.value;
  if(decoded.kind!=='VALUE'||!object(value))return {verified:false,reason:'RESULT_READ_UNVERIFIED'};
  const identities=[value.pai_task_id,value.task_id,value.taskId,value.mcp_task_id,value.structuredResult?.pai_task_id,value.structuredResult?.binding?.taskId].filter(x=>x!==undefined);
  if(!identities.length||identities.some(x=>x!==taskId))return {verified:false,reason:'RESULT_IDENTITY_MISMATCH'};
  if(!['COMPLETED','DONE','SUCCEEDED'].includes(String(value.status).toUpperCase()))return {verified:false,reason:'RESULT_NOT_SUCCESS_TERMINAL'};
  if(value.structuredResult?.failureClass||['FAILED','NOT_DONE','BLOCKED','CANCELLED'].includes(String(value.structuredResult?.status).toUpperCase()))return{verified:false,reason:'RESULT_CONTRADICTION'};
  return {verified:true,value};
}
module.exports={unwrap,classify,verifyResult};
