'use strict';
// Real local Claim lifecycle; synthetic PostgreSQL descriptors exercise the
// reader contract only. These tests are not native PostgreSQL/runtime evidence.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createFederationBridge}=require('../src/federation-bridge');
const {createRealReaders}=require('../src/pai-read-gateway');
const {parseTaskBoxWire}=require('../src/chief-delegation-admission');
const {RuntimeAdapter}=require('../../../../body/claim_service/src/runtime-adapter');
const {HomeClaimRepository}=require('../../../../body/claim_service/src/home-claim-repository');
const {FastReadback}=require('../../../../body/claim_service/src/fast-readback');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const identity={role:'PAI_CHIEF',userId:'fixture-user',paiIdentityId:'fixture-pai',projectId:'fixture-project'};
const envelope=()=>({backend:'POSTGRESQL',remote_revision:42,generation:9,fencing_token:41,release_hash:'a'.repeat(64),updated_at:new Date().toISOString()});
function fixture(){
 assert.equal(process.env.PAI_TEST_LOCAL_AUTHORITY,'1','Accepted safety hook required');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chief-accepted-result-')),box=path.join(root,'taskbox'),runtime=path.join(root,'claim-runtime');
 fs.mkdirSync(path.join(box,'items'),{recursive:true});fs.mkdirSync(path.join(box,'handoffs'),{recursive:true});
 const adapter=new RuntimeAdapter({runtimeRoot:runtime});adapter.open();const claims=new HomeClaimRepository(adapter,{taskBoxRoot:box}),fast=new FastReadback({runtimeRoot:runtime}),dbs=[];
 const snapshot=url=>{const u=new URL(url),filter={};for(const k of ['externalTaskId','claimId'])if(u.searchParams.has(k))filter[k]=u.searchParams.get(k);const out=fast.lifecycleSnapshot(filter);out.readback.projection=envelope();return out;};
 const readers=createRealReaders({claimServiceUrl:'http://in-process.fixture',taskBoxRoot:box,fetchJson:snapshot});
 function bridge(bound=identity){const db=new DatabaseSync(path.join(root,'chief.sqlite'));dbs.push(db);return createFederationBridge({identity:bound,db,taskBoxRoot:box,realReaders:readers,sessionRuntime:{_checkAuthority:()=>({available:true,currentFence:'FIXTURE_ONLY'})},publicToolNames:['pai_action_run','pai_run_status','pai_result']});}
 return {root,box,adapter,claims,fast,snapshot,readers,bridge,closeChief(){for(const db of dbs)db.close();dbs.length=0;},close(){for(const db of dbs)db.close();adapter.runtime?.db?.close();}};
}
async function admit(f,bound=identity){const bridge=f.bridge(bound),input={userId:bound.userId,request_id:'accepted-result-request',intent:'CHANGE',objective:'Compute a bounded fixture result',scope:'fixture/work',effect_class:'CANDIDATE_DRAFT',active_claimants:['CANONICAL_WORKSPACE_RW','agentic-edit','HOME_HOST_LOCAL','CODEX_LOCAL','ANTIGRAVITY_LOCAL']},out=await bridge.federationCore.handleActionRun(input),ref='items/'+out.pai_task_id+'.md',bytes=fs.readFileSync(path.join(f.box,ref)),parsed=parseTaskBoxWire(bytes);assert.equal(out.admission_state,'ADMITTED_TASKBOX');return {bridge,input,out,ref,bytes,parsed};}
async function claim(f,a){const caps=a.parsed.fields.REQUIRED_CAPABILITIES.split(','),candidate={externalTaskId:a.out.pai_task_id,artifactRef:a.ref,artifactHash:sha(a.bytes),priority:a.parsed.fields.PRIORITY,mutableScope:a.parsed.fields.MUTABLE_SCOPE,requiredCapabilities:caps,effect:'NONE'},picked=await f.claims.claimNext({hostId:'FIXTURE_HOST',offeredCapabilities:caps,candidates:[candidate]});assert.equal(picked.status,'CLAIMED');return {claim:picked.claim,candidate,caps};}
async function complete(f,a,status='DONE'){
 const picked=await claim(f,a);assert.equal((await f.claims.start(picked.claim)).status,'OK');
 const result=Buffer.from(JSON.stringify({value:[2,3,5].reduce((x,y)=>x+y,0)})+'\n');fs.writeFileSync(path.join(f.root,'result.json'),result);
 const bytes=Buffer.from('# TASK BOX\nTASK_ID: HANDOFF_FIXTURE_RESULT\nTYPE: HANDOFF\nROOT_ID: '+a.parsed.fields.ROOT_ID+'\nPARENT_ID: '+a.out.pai_task_id+'\nPRIORITY: P1\nMUTABLE_SCOPE: NONE\nREQUIRED_CAPABILITIES: none\n---\nResult:\nSTATUS: '+status+'\nTESTS: fixture sum equals 10\nOUTPUTS: result.json; sha256='+sha(result)+'\nNEXT: NONE\nBLOCKER: NONE\n'),ref='handoffs/'+a.out.pai_task_id+'.md';fs.writeFileSync(path.join(f.box,ref),bytes);
 assert.equal((await f.claims.complete({...picked.claim,handoffRef:ref,handoffHash:sha(bytes)})).status,'OK');
 return {...picked,ref,bytes};
}
function resolveMutated(f,a,mutate){let calls=0;const reader=createRealReaders({claimServiceUrl:'http://in-process.fixture',taskBoxRoot:f.box,fetchJson:url=>mutate(f.snapshot(url),url,++calls)});return reader.acceptedResult(a.bridge.federationCore._readAcceptedAdmission(a.out.pai_task_id));}
async function rejectCorruptAdmissionIndex(kind){const f=fixture();try{
 const a=await admit(f),core=a.bridge.federationCore;
 const inputB={...a.input,request_id:'second-valid-request',scope:'fixture/second',objective:'Second independently valid admission'};
 const outB=await core.handleActionRun(inputB),b={...a,input:inputB,out:outB,ref:'items/'+outB.pai_task_id+'.md'};
 b.bytes=fs.readFileSync(path.join(f.box,b.ref));b.parsed=parseTaskBoxWire(b.bytes);await complete(f,b);
 const prefix=core.acceptedReceiptPrefix,keyA=prefix+'task:'+a.out.pai_task_id,aliasA=prefix+'request:'+a.input.request_id,rowB=core.acceptedReceiptRead.get(prefix+'task:'+outB.pai_task_id);
 assert.notEqual(a.out.pai_task_id,outB.pai_task_id);
 assert.equal(core._readAcceptedAdmission(a.input.request_id).taskId,a.out.pai_task_id);
 assert.equal(core._readAcceptedAdmission(inputB.request_id).taskId,outB.pai_task_id);
 if(kind==='rebound-alias')core.db.prepare('UPDATE chief_bridge_receipts SET input_hash=?,body_json=? WHERE receipt_key=?').run(rowB.input_hash,JSON.stringify({taskId:outB.pai_task_id}),aliasA);
 else if(kind==='alias-hash')core.db.prepare('UPDATE chief_bridge_receipts SET input_hash=? WHERE receipt_key=?').run('0'.repeat(64),aliasA);
 else if(kind==='wrong-task-key')core.db.prepare('UPDATE chief_bridge_receipts SET input_hash=?,body_json=? WHERE receipt_key=?').run(rowB.input_hash,rowB.body_json,keyA);
 else {const body=kind==='malformed-alias'?'{':kind==='null-alias'?'null':kind==='array-alias'?'[]':kind==='empty-target'?JSON.stringify({taskId:''}):JSON.stringify({taskId:'MISSING_TASK'});core.db.prepare('UPDATE chief_bridge_receipts SET body_json=? WHERE receipt_key=?').run(body,aliasA);}
 // No first-generation volatile maps may conceal the durable-index defect.
 f.closeChief();const restarted=f.bridge(),fresh=restarted.federationCore;
 const claimsBefore=f.fast.lifecycleSnapshot({}).items;
 const carriers=()=>fs.readdirSync(path.join(f.box,'items')).sort().map(name=>({name,sha256:sha(fs.readFileSync(path.join(f.box,'items',name)))}));
 const carriersBefore=carriers(),receiptsBefore=fresh.db.prepare('SELECT * FROM chief_bridge_receipts ORDER BY receipt_key').all();
 assert.equal(fresh.tasks.size,0);assert.equal(fresh.idempotencyLedger.size,0);
 assert.equal(fresh._readAcceptedAdmission('genuinely-absent'),null);
 assert.equal(restarted.call('pai_result',{run_id:inputB.request_id}).structuredContent.result.status,'DONE');
 assert.equal(restarted.call('pai_run_status',{run_id:outB.pai_task_id}).structuredContent.result.status,'done');
 assert.equal((await fresh.handleActionRun(inputB)).admission_state,'IDEMPOTENT_REPLAY');
 const ids=kind==='wrong-task-key'?[a.out.pai_task_id,a.input.request_id]:[a.input.request_id];
 for(const id of ids){assert.throws(()=>fresh._readAcceptedAdmission(id),/ACCEPTED_ADMISSION_LOOKUP_MISMATCH/);for(const tool of ['pai_result','pai_run_status'])assert.throws(()=>restarted.call(tool,{run_id:id}),/ACCEPTED_ADMISSION_LOOKUP_MISMATCH/);}
 await assert.rejects(fresh.handleActionRun(a.input),/ACCEPTED_ADMISSION_LOOKUP_MISMATCH/);
 assert.deepEqual(f.fast.lifecycleSnapshot({}).items,claimsBefore);assert.deepEqual(carriers(),carriersBefore);
 assert.deepEqual(fresh.db.prepare('SELECT * FROM chief_bridge_receipts ORDER BY receipt_key').all(),receiptsBefore);
 assert.equal(fresh.tasks.size,0);assert.equal(fresh.idempotencyLedger.size,0);assert.equal(fresh.router.activeScopes.size,0);
}finally{f.close();}}
async function namespaceFixture(){
 const inputB={userId:identity.userId,request_id:'namespace-B-request',intent:'CHANGE',objective:'Namespace B fixture',scope:'fixture/B',effect_class:'CANDIDATE_DRAFT',active_claimants:['CANONICAL_WORKSPACE_RW','agentic-edit','HOME_HOST_LOCAL','CODEX_LOCAL','ANTIGRAVITY_LOCAL']};
 // Predict B using ordinary admission in another owned fixture, never forged
 // receipts or a replacement digest/identity derivation in the real chain.
 const probe=fixture();let predicted;try{predicted=(await probe.bridge().federationCore.handleActionRun(inputB)).pai_task_id;}finally{probe.close();}
 const f=fixture();try{const bridge=f.bridge(),inputA={...inputB,request_id:predicted,scope:'fixture/A',objective:'Namespace A fixture'};
 const a={bridge,input:inputA,out:await bridge.federationCore.handleActionRun(inputA)},b={bridge,input:inputB,out:await bridge.federationCore.handleActionRun(inputB)};
 for(const admitted of [a,b]){admitted.ref='items/'+admitted.out.pai_task_id+'.md';admitted.bytes=fs.readFileSync(path.join(f.box,admitted.ref));admitted.parsed=parseTaskBoxWire(admitted.bytes);}
 assert.equal(b.out.pai_task_id,inputA.request_id);assert.notEqual(a.out.pai_task_id,b.out.pai_task_id);await complete(f,b);
 return {f,bridge,a,b};
 }catch(error){f.close();throw error;}
}
function namespaceState(f,core){return {
 claims:f.fast.lifecycleSnapshot({}).items,
 carriers:fs.readdirSync(path.join(f.box,'items')).sort().map(name=>({name,sha256:sha(fs.readFileSync(path.join(f.box,'items',name)))})),
 receipts:core.db.prepare('SELECT * FROM chief_bridge_receipts ORDER BY receipt_key').all(),
 volatile:JSON.stringify({tasks:[...core.tasks],ledger:[...core.idempotencyLedger],locks:[...core.router.activeScopes]})
};}
async function assertNamespaceFailure(f,bridge,a,b,error){const core=bridge.federationCore,before=namespaceState(f,core);
 assert.throws(()=>core._readAcceptedAdmission(a.input.request_id),error);
 for(const tool of ['pai_result','pai_run_status'])assert.throws(()=>bridge.call(tool,{run_id:a.input.request_id}),error);
 await assert.rejects(core.handleActionRun(a.input),error);
 assert.equal(core._readAcceptedAdmission(a.out.pai_task_id).taskId,a.out.pai_task_id);
 assert.equal(bridge.call('pai_result',{run_id:b.input.request_id}).structuredContent.result.status,'DONE');
 assert.equal((await core.handleActionRun(b.input)).admission_state,'IDEMPOTENT_REPLAY');
 assert.equal(core._readAcceptedAdmission('namespace-absent'),null);
 assert.deepEqual(namespaceState(f,core),before,'Rejected lookup, cached replay and valid controls must not change durable or volatile state');
}
test('legitimate task/request collision rejects helper/result/status/replay warm and reconstructed without mutation',async()=>{const {f,bridge,a,b}=await namespaceFixture();try{
 const core=bridge.federationCore,prefix=core.acceptedReceiptPrefix;
 const task=core.acceptedReceiptRead.get(prefix+'task:'+a.input.request_id),alias=core.acceptedReceiptRead.get(prefix+'request:'+a.input.request_id),target=JSON.parse(alias.body_json),request=core.acceptedReceiptRead.get(prefix+'task:'+target.taskId);
 assert.equal(JSON.parse(task.body_json).taskId,b.out.pai_task_id);assert.equal(target.taskId,a.out.pai_task_id);assert.equal(alias.input_hash,request.input_hash);
 assert.equal(core.idempotencyLedger.has(a.input.request_id),true,'Warm A success must already exist to test cache bypass');
 await assertNamespaceFailure(f,bridge,a,b,/ACCEPTED_ADMISSION_LOOKUP_AMBIGUOUS/);
 f.closeChief();const restarted=f.bridge();assert.equal(restarted.federationCore.idempotencyLedger.size,0);
 await assertNamespaceFailure(f,restarted,a,b,/ACCEPTED_ADMISSION_LOOKUP_AMBIGUOUS/);
}finally{f.close();}});
test('malformed or dangling namespace cannot hide behind another valid route, warm or reconstructed',async()=>{const {f,bridge,a,b}=await namespaceFixture();try{
 let current=bridge;const prefix=bridge.federationCore.acceptedReceiptPrefix,taskKey=prefix+'task:'+a.input.request_id,aliasKey=prefix+'request:'+a.input.request_id;
 const taskOriginal=bridge.federationCore.acceptedReceiptRead.get(taskKey),aliasOriginal=bridge.federationCore.acceptedReceiptRead.get(aliasKey);
 const cases=[
  ['alias-json',aliasKey,aliasOriginal.input_hash,'{'],['alias-null',aliasKey,aliasOriginal.input_hash,'null'],['alias-array',aliasKey,aliasOriginal.input_hash,'[]'],
  ['alias-empty',aliasKey,aliasOriginal.input_hash,JSON.stringify({taskId:''})],['alias-dangling',aliasKey,aliasOriginal.input_hash,JSON.stringify({taskId:'MISSING_TASK'})],
  ['alias-hash',aliasKey,'0'.repeat(64),aliasOriginal.body_json],['alias-wrong-request',aliasKey,taskOriginal.input_hash,JSON.stringify({taskId:b.out.pai_task_id})],
  ['task-json',taskKey,taskOriginal.input_hash,'{'],['task-wrong-key',taskKey,aliasOriginal.input_hash,bridge.federationCore.acceptedReceiptRead.get(prefix+'task:'+a.out.pai_task_id).body_json]
 ];
 for(const phase of ['warm','reconstructed']){
  if(phase==='reconstructed'){f.closeChief();current=f.bridge();}
  for(const [kind,key,hash,body] of cases){const core=current.federationCore;core.db.prepare('UPDATE chief_bridge_receipts SET input_hash=?,body_json=? WHERE receipt_key=?').run(hash,body,key);
   try {assert.throws(()=>core._readAcceptedAdmission(a.input.request_id),/ACCEPTED_ADMISSION_LOOKUP_MISMATCH/,phase+':'+kind);
    // When the task row itself is malformed, B's own request also targets it;
    // A's unaffected task remains the valid control instead of claiming B valid.
    const before=namespaceState(f,core);for(const tool of ['pai_result','pai_run_status'])assert.throws(()=>current.call(tool,{run_id:a.input.request_id}),/ACCEPTED_ADMISSION_LOOKUP_MISMATCH/);
    await assert.rejects(core.handleActionRun(a.input),/ACCEPTED_ADMISSION_LOOKUP_MISMATCH/);assert.equal(core._readAcceptedAdmission(a.out.pai_task_id).taskId,a.out.pai_task_id);
    if(key===aliasKey){assert.equal(current.call('pai_result',{run_id:b.input.request_id}).structuredContent.result.status,'DONE');assert.equal((await core.handleActionRun(b.input)).admission_state,'IDEMPOTENT_REPLAY');}
    assert.deepEqual(namespaceState(f,core),before);
   }finally{core.db.prepare('UPDATE chief_bridge_receipts SET input_hash=?,body_json=? WHERE receipt_key=?').run(taskOriginal.input_hash,taskOriginal.body_json,taskKey);core.db.prepare('UPDATE chief_bridge_receipts SET input_hash=?,body_json=? WHERE receipt_key=?').run(aliasOriginal.input_hash,aliasOriginal.body_json,aliasKey);}
  }
 }
}finally{f.close();}});
test('controlled same-identity durable receipt replacement rejects incoming digest warm and reconstructed',async()=>{const f=fixture(),replacement=fixture();try{
 const a=await admit(f),core=a.bridge.federationCore,controlInput={...a.input,request_id:'matching-control',scope:'fixture/control',objective:'Matching replay control'};
 const control=await core.handleActionRun(controlInput),matchingWarm=await core.handleActionRun(controlInput);
 const replacementInput={...a.input,objective:'Independently admitted replacement',scope:'fixture/replacement'},other=replacement.bridge().federationCore,out=await other.handleActionRun(replacementInput);
 const row=other.acceptedReceiptRead.get(other.acceptedReceiptPrefix+'task:'+out.pai_task_id);
 assert.notEqual(out.pai_task_id,a.out.pai_task_id);assert.notEqual(row.input_hash,core.idempotencyLedger.get(a.input.request_id).request_digest);
 // These are genuine independently produced same-identity receipt bytes, but
 // installing them over A's request alias is controlled adversarial DB setup,
 // not natural coexisting admissions or production provenance acceptance.
 core.acceptedReceiptWrite.run(core.acceptedReceiptPrefix+'task:'+out.pai_task_id,row.input_hash,row.body_json,new Date().toISOString());
 core.db.prepare('UPDATE chief_bridge_receipts SET input_hash=?,body_json=? WHERE receipt_key=?').run(row.input_hash,JSON.stringify({taskId:out.pai_task_id}),core.acceptedReceiptPrefix+'request:'+a.input.request_id);
 assert.equal(core._readAcceptedAdmission(a.input.request_id).taskId,out.pai_task_id,'Lookup is internally valid; caller must reject the different digest');
 for(const phase of ['warm','reconstructed']){let current=a.bridge;if(phase==='reconstructed'){f.closeChief();current=f.bridge();}
  const active=current.federationCore,before=namespaceState(f,active);
  assert.equal(active._readAcceptedAdmission(a.input.request_id).taskId,out.pai_task_id);
  await assert.rejects(active.handleActionRun(a.input),/ACTION_IDEMPOTENCY_CONFLICT/,phase);
  const matching=await active.handleActionRun(controlInput);assert.deepEqual(matching,matchingWarm,phase+' matching warm/cold replay parity');assert.equal(matching.pai_task_id,control.pai_task_id);
  assert.deepEqual(namespaceState(f,active),before);
 }
}finally{f.close();replacement.close();}});
test('controlled cached task-ID mismatch rejects warm success; reconstruction uses the matching durable task',async()=>{const f=fixture();try{
 const a=await admit(f),core=a.bridge.federationCore,entry=core.idempotencyLedger.get(a.input.request_id),matching=await core.handleActionRun(a.input);
 core.idempotencyLedger.set(a.input.request_id,{...entry,result:{...entry.result,pai_task_id:'CHIEF_REQUEST_WRONG_CACHED_TASK'}});
 const before=namespaceState(f,core);assert.equal(core._readAcceptedAdmission(a.input.request_id).taskId,a.out.pai_task_id);
 await assert.rejects(core.handleActionRun(a.input),/ACCEPTED_ADMISSION_REPLAY_MISMATCH/);assert.deepEqual(namespaceState(f,core),before);
 core.idempotencyLedger.set(a.input.request_id,entry);assert.deepEqual(await core.handleActionRun(a.input),matching);
 f.closeChief();const restarted=f.bridge(),coldBefore=namespaceState(f,restarted.federationCore);assert.deepEqual(await restarted.federationCore.handleActionRun(a.input),matching);assert.deepEqual(namespaceState(f,restarted.federationCore),coldBefore);
}finally{f.close();}});
test('matching no-effect admission replay labels agree warm and reconstructed without Claim completion',async()=>{for(const effect of ['READ_ONLY','NO_MATERIAL_DELTA']){const f=fixture();try{
 const a=await admit(f),input={...a.input,request_id:'no-effect-'+effect,effect_class:effect,scope:'fixture/no-effect',objective:'No-effect replay parity fixture'},core=a.bridge.federationCore;
 const out=await core.handleActionRun(input);assert.equal(out.admission_state,'NO_EFFECT_CANDIDATE');assert.equal(out.lifecycle_state,'COMPLETED');
 const before=namespaceState(f,core),warm=await core.handleActionRun(input);assert.equal(warm.lifecycle_state,'COMPLETED');assert.deepEqual(namespaceState(f,core),before);
 f.closeChief();const restarted=f.bridge(),coldBefore=namespaceState(f,restarted.federationCore);assert.deepEqual(await restarted.federationCore.handleActionRun(input),warm);
 assert.equal(restarted.call('pai_result',{run_id:out.pai_task_id}).structuredContent.result.status,'RESULT_UNAVAILABLE','Admission label is not Claim completion authority');assert.equal(f.fast.lifecycleSnapshot({externalTaskId:out.pai_task_id}).items.length,0);assert.deepEqual(namespaceState(f,restarted.federationCore),coldBefore);
}finally{f.close();}}});
test('cached admitted TaskBox success cannot replay after its durable receipt indexes disappear',async()=>{const f=fixture();try{
 const a=await admit(f),core=a.bridge.federationCore;
 core.db.prepare('DELETE FROM chief_bridge_receipts WHERE receipt_key IN (?,?)').run(core.acceptedReceiptPrefix+'task:'+a.out.pai_task_id,core.acceptedReceiptPrefix+'request:'+a.input.request_id);
 assert.equal(core._readAcceptedAdmission(a.input.request_id),null);const before=namespaceState(f,core);
 await assert.rejects(core.handleActionRun(a.input),/ACCEPTED_ADMISSION_REPLAY_MISMATCH/);assert.deepEqual(namespaceState(f,core),before);
 // Cold reconstruction's existing durable-intent recovery is covered by the
 // separate interruption-window tests; this negative asserts no warm success.
}finally{f.close();}});
test('same-admission dual namespace is a controlled reader-contract stub, not genuine admission integration',async()=>{const f=fixture();try{
 const a=await admit(f),original=a.bridge.federationCore,binding=original._readAcceptedAdmission(a.out.pai_task_id),id=binding.taskId;
 // A generated task ID/request ID fixed point cannot be constructed by normal
 // admission. Stub the read/derivation boundary solely to cover equality; do
 // not write these synthetic rows or use them as Claim/runtime provenance.
 const core=Object.create(original),body={...binding,requestId:id},row={input_hash:binding.requestDigest,body_json:JSON.stringify(body)},alias={input_hash:binding.requestDigest,body_json:JSON.stringify({taskId:id})};
 const before=namespaceState(f,original);core._boundTaskId=()=>id;core.acceptedReceiptRead={get:key=>key===original.acceptedReceiptPrefix+'task:'+id?row:key===original.acceptedReceiptPrefix+'request:'+id?alias:undefined};
 assert.equal(core._readAcceptedAdmission(id).taskId,id);assert.equal(core._readAcceptedAdmission(id).requestId,id);assert.deepEqual(namespaceState(f,original),before);
}finally{f.close();}});
test('reconstructed Chief rejects request A alias rebound to valid same-identity B with B hash',()=>rejectCorruptAdmissionIndex('rebound-alias'));
test('reconstructed Chief rejects request alias hash mismatch without Claim or carrier mutation',()=>rejectCorruptAdmissionIndex('alias-hash'));
test('reconstructed Chief rejects valid B task body and hash copied under A task key',()=>rejectCorruptAdmissionIndex('wrong-task-key'));
test('existing malformed or dangling request indexes fail closed; absence remains distinct',async()=>{for(const kind of ['malformed-alias','null-alias','array-alias','empty-target','dangling-alias'])await rejectCorruptAdmissionIndex(kind);});
test('real Claim completion, archived bytes, reconstructed Chief and replay use accepted hashes',async()=>{const f=fixture();try{
 const a=await admit(f),done=await complete(f,a);fs.mkdirSync(path.join(f.box,'archive/items'),{recursive:true});fs.renameSync(path.join(f.box,a.ref),path.join(f.box,'archive',a.ref));
 const result=a.bridge.call('pai_result',{run_id:a.out.pai_task_id,userId:identity.userId}).structuredContent.result;assert.equal(result.status,'DONE');assert.equal(result.structuredResult.handoff.sha256,sha(done.bytes));assert.equal(result.structuredResult.dispatch.sha256,sha(a.bytes));assert.equal(result.structuredResult.claimId,done.claim.claimId);
 // Close every first-generation Chief connection, then reconstruct from SQLite.
 f.closeChief();const restarted=f.bridge(),after=restarted.call('pai_result',{run_id:a.input.request_id}).structuredContent.result;assert.equal(after.status,'DONE');assert.equal(after.structuredResult.taskId,a.out.pai_task_id);assert.equal(restarted.federationCore.tasks.size,0);
 const before=f.fast.lifecycleSnapshot({externalTaskId:a.out.pai_task_id,claimId:done.claim.claimId}).items[0];const replay=await restarted.federationCore.handleActionRun(a.input);assert.equal(replay.admission_state,'IDEMPOTENT_REPLAY');
 assert.equal((await f.claims.claimNext({hostId:'FIXTURE_HOST',offeredCapabilities:done.caps,candidates:[done.candidate]})).status,'NO_TASK');assert.deepEqual(f.fast.lifecycleSnapshot({externalTaskId:a.out.pai_task_id,claimId:done.claim.claimId}).items[0],before);
 assert.equal(restarted.call('pai_run_status',{run_id:a.out.pai_task_id}).structuredContent.result.status,'done');await assert.rejects(restarted.federationCore.handleActionRun({...a.input,objective:'conflicting objective'}),/ACTION_IDEMPOTENCY_CONFLICT/);
 fs.writeFileSync(path.join(f.root,'verified-proof.json'),JSON.stringify({classification:'REAL_LOCAL_CLAIM_WITH_SYNTHETIC_POSTGRESQL_ENVELOPE_CONTRACT_TEST_ONLY',nativePostgresqlAcceptance:false,taskId:a.out.pai_task_id,claimId:done.claim.claimId,result,originalChiefMapStatus:a.bridge.federationCore.getMcpTask(a.out.pai_task_id).result.status,afterRestartMapSize:restarted.federationCore.tasks.size,replay:replay.admission_state},null,2));
}finally{f.close();}});
test('unknown Claim task is unavailable and claimed work is pending; local provenance cannot complete',async()=>{const f=fixture();try{const a=await admit(f);assert.equal(a.bridge.call('pai_result',{run_id:a.out.pai_task_id}).structuredContent.result.status,'RESULT_UNAVAILABLE');await claim(f,a);assert.equal(a.bridge.call('pai_result',{run_id:a.out.pai_task_id}).structuredContent.result.status,'NO_RESULT_AVAILABLE');assert.equal(resolveMutated(f,a,s=>({...s,readback:{...s.readback,projection:{...s.readback.projection,backend:'SQLITE'}}})).failureClass,'POSTGRESQL_PROVENANCE_UNAVAILABLE');}finally{f.close();}});
test('bound foreign user and foreign Chief identity cannot read or replay admission',async()=>{const f=fixture();try{const a=await admit(f);await complete(f,a);assert.throws(()=>a.bridge.call('pai_result',{run_id:a.out.pai_task_id,userId:'foreign-user'}),/BRIDGE_IDENTITY_MISMATCH/);await assert.rejects(a.bridge.federationCore.handleActionRun({...a.input,userId:'foreign-user'}),/BRIDGE_IDENTITY_MISMATCH/);const foreign=f.bridge({...identity,userId:'foreign-user'});assert.equal(foreign.call('pai_result',{run_id:a.out.pai_task_id}).structuredContent.result.status,'NO_RESULT_AVAILABLE');assert.equal(foreign.federationCore._readAcceptedAdmission(a.input.request_id),null);}finally{f.close();}});
test('foreign claim, ambiguity, dispatch mismatch and missing attempt/fence fail closed',async()=>{const f=fixture();try{const a=await admit(f);await complete(f,a);const change=fn=>(s,url)=>url.includes('claimId=')?{...s,items:s.items.map(fn)}:s;
 assert.equal(resolveMutated(f,a,change(x=>({...x,claimId:'claim_'+'0'.repeat(8)+'-0000-0000-0000-'+'0'.repeat(12)}))).failureClass,'LIFECYCLE_ITEM_NOT_FOUND');
 assert.equal(resolveMutated(f,a,s=>({...s,items:[...s.items,...s.items]})).failureClass,'LIFECYCLE_IDENTITY_AMBIGUOUS');
 assert.equal(resolveMutated(f,a,change(x=>({...x,artifactHash:'0'.repeat(64)}))).failureClass,'DISPATCH_BINDING_MISMATCH');
 assert.equal(resolveMutated(f,a,change(x=>({...x,attempt:null,fence:null}))).failureClass,'ATTEMPT_FENCE_BINDING_MISSING');
 assert.equal(resolveMutated(f,a,(s,url,n)=>n===3?{...s,items:s.items.map(x=>({...x,fence:x.fence+1}))}:s).failureClass,'CLAIM_COMPLETION_CHANGED');
}finally{f.close();}});
test('stale, future and changing projection evidence and noncanonical terminal status reject',async()=>{const f=fixture();try{const a=await admit(f);await complete(f,a);for(const offset of [-300001,60000])assert.equal(resolveMutated(f,a,s=>({...s,readback:{...s.readback,projection:{...s.readback.projection,updated_at:new Date(Date.now()+offset).toISOString()}}})).failureClass,'POSTGRESQL_PROJECTION_STALE');assert.equal(resolveMutated(f,a,(s,url,n)=>n===2?{...s,readback:{...s.readback,projection:{...s.readback.projection,remote_revision:43}}}:s).failureClass,'POSTGRESQL_PROJECTION_CHANGED');assert.equal(resolveMutated(f,a,(s,url)=>url.includes('claimId=')?{...s,items:s.items.map(x=>({...x,claimStatus:'RUNNING'}))}:s).failureClass,'TERMINAL_CLAIM_DISPATCH_MISMATCH');}finally{f.close();}});
test('exact canonical HANDOFF hash outranks same-parent forged files and rejects hash drift',async()=>{const f=fixture();try{const a=await admit(f),done=await complete(f,a);fs.writeFileSync(path.join(f.box,'handoffs/forged.md'),done.bytes.toString().replace('fixture sum equals 10','forged completion'));assert.equal(a.bridge.call('pai_result',{run_id:a.out.pai_task_id}).structuredContent.result.status,'DONE');fs.appendFileSync(path.join(f.box,done.ref),'drift');assert.equal(a.bridge.call('pai_result',{run_id:a.out.pai_task_id}).structuredContent.result.structuredResult.failureClass,'HANDOFF_HASH_DRIFT');}finally{f.close();}});
test('hash-bound wrong root, parent, scope and TYPE reject without accepting forged lineage',async()=>{const f=fixture();try{const a=await admit(f),done=await complete(f,a);for(const [from,to] of [['ROOT_ID: '+a.out.pai_task_id,'ROOT_ID: FOREIGN_ROOT'],['PARENT_ID: '+a.out.pai_task_id,'PARENT_ID: FOREIGN_PARENT'],['MUTABLE_SCOPE: NONE','MUTABLE_SCOPE: fixture/work'],['TYPE: HANDOFF','TYPE: DISPATCH']]){const bytes=Buffer.from(done.bytes.toString().replace(from,to));fs.writeFileSync(path.join(f.box,done.ref),bytes);const out=resolveMutated(f,a,(s,url)=>url.includes('claimId=')?{...s,items:s.items.map(x=>({...x,handoffHash:sha(bytes)}))}:s);assert.equal(out.status,'UNAVAILABLE');}}finally{f.close();}});
test('dispatch drift and traversal or junction refs reject',async()=>{const f=fixture();try{const a=await admit(f),done=await complete(f,a);assert.equal(resolveMutated(f,a,(s,url)=>url.includes('claimId=')?{...s,items:s.items.map(x=>({...x,handoffRef:'../outside.md'}))}:s).failureClass,'HANDOFF_REF_OUTSIDE_TASK_BOX_OR_MISSING');
 const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,path.basename(done.ref)),done.bytes);const link=path.join(f.box,'handoffs-linked');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
 fs.renameSync(path.join(f.box,'handoffs'),path.join(f.box,'original-handoffs'));fs.renameSync(link,path.join(f.box,'handoffs'));assert.equal(a.bridge.call('pai_result',{run_id:a.out.pai_task_id}).structuredContent.result.structuredResult.failureClass,'HANDOFF_REF_OUTSIDE_TASK_BOX_OR_MISSING');
 fs.appendFileSync(path.join(f.box,a.ref),'drift');assert.equal(a.bridge.call('pai_result',{run_id:a.out.pai_task_id}).structuredContent.result.structuredResult.failureClass,'DISPATCH_HASH_DRIFT');
}finally{f.close();}});
test('reader outage returns bounded unavailable evidence',async()=>{const f=fixture();try{const a=await admit(f);assert.equal(resolveMutated(f,a,()=>{throw Error('fixture outage');}).failureClass,'CLAIM_RESULT_READ_FAILED');}finally{f.close();}});
test('archived completed work cannot be adopted by a second user, PAI or project identity',async()=>{const f=fixture();try{
 const first=await admit(f);await complete(f,first);fs.mkdirSync(path.join(f.box,'archive/items'),{recursive:true});fs.renameSync(path.join(f.box,first.ref),path.join(f.box,'archive',first.ref));
 for(const key of ['userId','paiIdentityId','projectId']){const second=await admit(f,{...identity,[key]:'second-'+key});assert.notEqual(second.out.pai_task_id,first.out.pai_task_id);assert.notEqual(second.bridge.federationCore._readAcceptedAdmission(second.out.pai_task_id).requestDigest,first.bridge.federationCore._readAcceptedAdmission(first.out.pai_task_id).requestDigest);assert.equal(second.bridge.call('pai_result',{run_id:second.input.request_id}).structuredContent.result.status,'RESULT_UNAVAILABLE');assert.equal(second.bridge.federationCore._readAcceptedAdmission(first.out.pai_task_id),null);}
 assert.equal(first.bridge.call('pai_result',{run_id:first.out.pai_task_id}).structuredContent.result.status,'DONE');
}finally{f.close();}});
test('legacy identity-unbound receipt is rejected rather than adopted',async()=>{const f=fixture();try{const a=await admit(f),core=a.bridge.federationCore,key=core.acceptedReceiptPrefix+'task:'+a.out.pai_task_id,row=core.acceptedReceiptRead.get(key),body=JSON.parse(row.body_json);delete body.identityBinding;core.db.prepare('UPDATE chief_bridge_receipts SET body_json=? WHERE receipt_key=?').run(JSON.stringify(body),key);f.closeChief();const restarted=f.bridge();assert.throws(()=>restarted.call('pai_result',{run_id:a.input.request_id}),/ACCEPTED_ADMISSION_LEGACY_UNBOUND/);await assert.rejects(restarted.federationCore.handleActionRun(a.input),/ACCEPTED_ADMISSION_LEGACY_UNBOUND/);assert.equal(restarted.federationCore.tasks.size,0);}finally{f.close();}});
test('failed final receipt COMMIT publishes no volatile success and exact pending intent recovers',async()=>{const f=fixture();try{
 const bridge=f.bridge(),core=bridge.federationCore,db=core.db,original=db.exec.bind(db);let commits=0;db.exec=sql=>{if(sql==='COMMIT'&&++commits===2)throw Error('FIXTURE_FINAL_COMMIT_FAILURE');return original(sql);};
 const input={request_id:'commit-failure',intent:'CHANGE',objective:'Recovery fixture',scope:'fixture/work',effect_class:'CANDIDATE_DRAFT',active_claimants:['CANONICAL_WORKSPACE_RW','agentic-edit','HOME_HOST_LOCAL','CODEX_LOCAL']};
 await assert.rejects(core.handleActionRun(input),/FIXTURE_FINAL_COMMIT_FAILURE/);db.exec=original;assert.equal(core.tasks.size,0);assert.equal(core.idempotencyLedger.size,0);assert.equal(core.router.activeScopes.size,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM chief_bridge_receipts WHERE receipt_key LIKE ?").get(core.acceptedReceiptPrefix+'task:%').n,0);const files=fs.readdirSync(path.join(f.box,'items'));assert.equal(files.length,1);const before=sha(fs.readFileSync(path.join(f.box,'items',files[0])));
 await assert.rejects(core.handleActionRun({...input,objective:'different interrupted request'}),/ACTION_IDEMPOTENCY_CONFLICT/);assert.equal(fs.readdirSync(path.join(f.box,'items')).length,1);
 f.closeChief();const restarted=f.bridge(),recovered=await restarted.federationCore.handleActionRun(input);assert.equal(recovered.admission_state,'ADMITTED_TASKBOX');assert.equal(sha(fs.readFileSync(path.join(f.box,'items',files[0]))),before);assert.equal(fs.readdirSync(path.join(f.box,'items')).length,1);assert.ok(restarted.federationCore._readAcceptedAdmission(recovered.pai_task_id));assert.equal((await restarted.federationCore.handleActionRun(input)).admission_state,'IDEMPOTENT_REPLAY');
}finally{f.close();}});
test('reconstruction after durable intent but before carrier creation recovers one exact carrier',async()=>{const f=fixture();const original=fs.writeFileSync;try{const bridge=f.bridge(),core=bridge.federationCore,input={request_id:'intent-window',intent:'CHANGE',objective:'Recovery fixture',scope:'fixture/work',effect_class:'CANDIDATE_DRAFT',active_claimants:['CANONICAL_WORKSPACE_RW','agentic-edit','HOME_HOST_LOCAL','CODEX_LOCAL']};fs.writeFileSync=(file,...args)=>{if(String(file).startsWith(path.join(f.box,'items')+path.sep))throw Error('FIXTURE_BEFORE_CARRIER');return original(file,...args);};await assert.rejects(core.handleActionRun(input),/FIXTURE_BEFORE_CARRIER/);fs.writeFileSync=original;assert.equal(core.tasks.size,0);assert.equal(fs.readdirSync(path.join(f.box,'items')).length,0);f.closeChief();const restarted=f.bridge(),out=await restarted.federationCore.handleActionRun(input);assert.equal(out.admission_state,'ADMITTED_TASKBOX');assert.equal(fs.readdirSync(path.join(f.box,'items')).length,1);}finally{fs.writeFileSync=original;f.close();}});
test('unbound or tampered interrupted carriers fail closed without successful replay',async()=>{for(const kind of ['unbound','hash-drift']){const f=fixture();try{const a=await admit(f),core=a.bridge.federationCore;core.db.prepare('DELETE FROM chief_bridge_receipts WHERE receipt_key IN (?,?)').run(core.acceptedReceiptPrefix+'task:'+a.out.pai_task_id,core.acceptedReceiptPrefix+'request:'+a.input.request_id);if(kind==='unbound')core.db.prepare('DELETE FROM chief_bridge_receipts WHERE receipt_key=?').run(core.acceptedReceiptPrefix+'pending:'+a.out.pai_task_id);else fs.appendFileSync(path.join(f.box,a.ref),'tamper');f.closeChief();const restarted=f.bridge();for(let retry=0;retry<2;retry++)await assert.rejects(restarted.federationCore.handleActionRun(a.input),/ACCEPTED_MATERIALIZATION_UNBOUND_ORPHAN|ACCEPTED_MATERIALIZATION_ORPHAN_MISMATCH/);assert.equal(restarted.federationCore.tasks.size,0);assert.equal(restarted.federationCore.idempotencyLedger.size,0);assert.equal(restarted.federationCore.router.activeScopes.size,0);}finally{f.close();}}});
test('failed durable-intent COMMIT creates no carrier or receipt and reconstruction retries safely',async()=>{const f=fixture();try{const core=f.bridge().federationCore,db=core.db,original=db.exec.bind(db),input={request_id:'intent-commit-failure',intent:'CHANGE',objective:'Recovery fixture',scope:'fixture/work',effect_class:'CANDIDATE_DRAFT',active_claimants:['CANONICAL_WORKSPACE_RW','agentic-edit','HOME_HOST_LOCAL','CODEX_LOCAL']};db.exec=sql=>{if(sql==='COMMIT')throw Error('FIXTURE_INTENT_COMMIT_FAILURE');return original(sql);};await assert.rejects(core.handleActionRun(input),/FIXTURE_INTENT_COMMIT_FAILURE/);db.exec=original;assert.equal(core.tasks.size,0);assert.equal(core.idempotencyLedger.size,0);assert.equal(fs.readdirSync(path.join(f.box,'items')).length,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM chief_bridge_receipts WHERE receipt_key LIKE ?').get(core.acceptedReceiptPrefix+'%').n,0);f.closeChief();const restarted=f.bridge();assert.equal((await restarted.federationCore.handleActionRun(input)).admission_state,'ADMITTED_TASKBOX');assert.equal(fs.readdirSync(path.join(f.box,'items')).length,1);}finally{f.close();}});
test('reconstruction after committed receipt but before volatile publish replays without another carrier',async()=>{const f=fixture();try{const core=f.bridge().federationCore,original=core._persistAcceptedAdmission.bind(core),input={request_id:'after-commit-window',intent:'CHANGE',objective:'Recovery fixture',scope:'fixture/work',effect_class:'CANDIDATE_DRAFT',active_claimants:['CANONICAL_WORKSPACE_RW','agentic-edit','HOME_HOST_LOCAL','CODEX_LOCAL']};core._persistAcceptedAdmission=(...args)=>{original(...args);throw Error('FIXTURE_AFTER_ADMISSION_COMMIT');};await assert.rejects(core.handleActionRun(input),/FIXTURE_AFTER_ADMISSION_COMMIT/);assert.equal(core.tasks.size,0);assert.equal(core.idempotencyLedger.size,0);f.closeChief();const restarted=f.bridge(),out=await restarted.federationCore.handleActionRun(input);assert.equal(out.admission_state,'IDEMPOTENT_REPLAY');assert.equal(fs.readdirSync(path.join(f.box,'items')).length,1);assert.equal(restarted.federationCore.tasks.size,0);}finally{f.close();}});
test('incomplete pending identity/request alias and archived interrupted carrier cannot be adopted',async()=>{for(const kind of ['missing-alias','archived']){const f=fixture();try{const a=await admit(f),core=a.bridge.federationCore;core.db.prepare('DELETE FROM chief_bridge_receipts WHERE receipt_key IN (?,?)').run(core.acceptedReceiptPrefix+'task:'+a.out.pai_task_id,core.acceptedReceiptPrefix+'request:'+a.input.request_id);if(kind==='missing-alias')core.db.prepare('DELETE FROM chief_bridge_receipts WHERE receipt_key=?').run(core.acceptedReceiptPrefix+'pending-request:'+a.input.request_id);else{fs.mkdirSync(path.join(f.box,'archive/items'),{recursive:true});fs.renameSync(path.join(f.box,a.ref),path.join(f.box,'archive',a.ref));}f.closeChief();const restarted=f.bridge();await assert.rejects(restarted.federationCore.handleActionRun(a.input),/ACCEPTED_MATERIALIZATION_CONFLICT|ACCEPTED_MATERIALIZATION_ARCHIVED_ORPHAN/);assert.equal(restarted.federationCore.tasks.size,0);assert.equal(restarted.federationCore.idempotencyLedger.size,0);if(kind==='archived')assert.equal(fs.readdirSync(path.join(f.box,'items')).length,0);}finally{f.close();}}});
