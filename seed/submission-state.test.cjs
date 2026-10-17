'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),uplink=require('./seed-uplink'),{classify}=require('./submission-state');
const seed={schema:uplink.SCHEMA,seedId:'state-proof-001',intent:'QA',objective:'No-effect state proof',acceptance:['No product effect'],mutableScope:'06_STATE/PAI_SEED_UPLINK_V0',requestedMode:'candidate-only',createdAt:'2026-10-17T00:00:00.000Z'};
const code=uplink.encode(seed),request=uplink.prepareGovernedRequest(code),receipt={request_id:request.request_id,chief_state:'ADMITTED',admission_state:'NO_EFFECT_CANDIDATE',pai_task_id:'task-proof',lifecycle_state:'COMPLETED',result_ref:'pai_result:task-proof'};
const wrap=x=>({jsonrpc:'2.0',result:{content:[{type:'text',text:JSON.stringify(x)}],structuredContent:{result:x}}});
test('cached READY replay is resolved from canonical Result without resubmitting',async()=>{let submits=0,reads=0;const r=await uplink.importSeed({code,confirm:true,submit:async()=>{submits++;return wrap({...receipt,admission_state:'IDEMPOTENT_REPLAY',lifecycle_state:'READY'});},readResult:async()=>{reads++;return wrap({status:'DONE',structuredResult:{pai_task_id:'task-proof',status:'DONE'}});}});assert.equal(r.status,'COMPLETED_WITH_RESULT');assert.equal(r.completed,true);assert.equal(submits,1);assert.equal(reads,1);});
test('HTTP-success JSON-RPC and MCP business errors never become submitted/admitted',async()=>{
  for(const response of[{jsonrpc:'2.0',error:{code:-32000,message:'denied'}},{result:'x',isError:true},{ok:false,error:'BLOCKED'},wrap({...receipt,admission_state:'HOST_CONTROL_DENIED'}),wrap({...receipt,blocker:'UNAVAILABLE'})]){
    const r=await uplink.importSeed({code,confirm:true,submit:async()=>response});assert.equal(r.accepted,false);assert.equal(r.completed,false);assert.match(r.status,/FAILED|REJECTED/);
  }
});
test('pending and unrelated/malformed business replies remain unverified',()=>{
  assert.equal(classify({admission:'PENDING'},request).status,'SUBMISSION_RECEIVED');
  for(const response of[{},null,{accepted:true},wrap({...receipt,request_id:'foreign'})])assert.equal(classify(response,request).accepted,false);
});
test('accepted and running are not terminal success; completion report needs result readback',async()=>{
  for(const lifecycle of['READY','RUNNING','COMPLETED']){const r=await uplink.importSeed({code,confirm:true,submit:async()=>wrap({...receipt,lifecycle_state:lifecycle})});assert.equal(r.accepted,true);assert.equal(r.completed,false);assert.equal(r.result_verified,false);}
});
test('matching terminal Result completes; wrong/missing identity or nonterminal does not',async()=>{
  for(const[body,valid]of[[{status:'COMPLETED',structuredResult:{pai_task_id:'task-proof'}},true],[{status:'COMPLETED',pai_task_id:'foreign'},false],[{status:'COMPLETED'},false],[{status:'RUNNING',pai_task_id:'task-proof'},false],[{status:'FAILED',pai_task_id:'task-proof'},false]]){
    let submitted=0,read=0;const r=await uplink.importSeed({code,confirm:true,submit:async()=>{submitted++;return wrap(receipt)},readResult:async id=>{read++;assert.equal(id,'task-proof');return wrap(body)}});assert.equal(r.completed,valid);assert.equal(r.result_verified,valid);assert.equal(submitted,1);assert.equal(read,1);
  }
});
test('failed result read retains completion-unverified without resubmitting',async()=>{
  let calls=0;const r=await uplink.importSeed({code,confirm:true,submit:async()=>{calls++;return wrap(receipt)},readResult:async()=>{throw Error('disconnect')}});assert.equal(r.status,'COMPLETION_REPORTED_RESULT_UNVERIFIED');assert.equal(r.result_read_reason,'RESULT_READ_FAILED_NO_RESUBMIT');assert.equal(calls,1);
});
test('conflicting MCP representations and missing request identity remain unverified',()=>{const response=wrap(receipt);response.result.content[0].text=JSON.stringify({...receipt,admission_state:'BLOCKED'});assert.equal(classify(response,request).accepted,false);assert.equal(classify({...receipt,request_id:undefined},request).accepted,false);});
test('submit disconnect has explicit unknown state and no automatic retry',async()=>{let calls=0;const r=await uplink.importSeed({code,confirm:true,submit:async()=>{calls++;throw Error('disconnect')}});assert.equal(calls,1);assert.equal(r.status,'SUBMISSION_UNKNOWN');assert.equal(r.completed,false);assert.equal(r.request.idempotency_key,request.idempotency_key);});
