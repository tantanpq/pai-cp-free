import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {createEngine} from './engine.mjs';
import {acquireBrowser} from '../proto/operations.mjs';
import {createAdapter as webAdapter} from './adapters/web.mjs';
import {createAdapter as windowsAdapter} from './adapters/windows.mjs';
const sourcePaths=['observe-act/engine.mjs','observe-act/registry.mjs','observe-act/contract.v1.json','observe-act/adapters/web.mjs','observe-act/adapters/cdp-page.mjs','observe-act/adapters/windows.mjs','proto/runner.mjs','proto/operations.mjs'].sort();
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const hostId=()=>process.env.CP_HOST_ID||os.hostname();
const fail=reason=>{throw Error(reason)};

// Runtime metadata belongs to each existing provider. No service/global env.
export async function resolveActivation({baseDir,host=hostId()}) {
 const envFlags={web:process.env.CP_OBSERVE_WEB,desktop:process.env.CP_OBSERVE_DESKTOP,desktopStep:process.env.CP_STEP_DESKTOP};
 if(envFlags.web==='0'&&envFlags.desktop!=='1'&&envFlags.desktopStep!=='1')return {flags:{web:false,desktop:false,desktopStep:false},acceptance:null};
 let acceptance=null;
 try{acceptance=JSON.parse(await fs.readFile(path.join(baseDir,'observe-act','activation.json'),'utf8'))}
 catch(error){if(error.code!=='ENOENT')fail('ACTIVATION_INVALID: '+error.message)}
 if(acceptance){
  if(acceptance.schema!=='cp.observe-act.activation/v1'||acceptance.host!==host||!['INTERNAL_CANARY','INTERNAL_LIVE'].includes(acceptance.phase)||acceptance.enabled?.web!==true||acceptance.enabled?.desktop!==false||acceptance.enabled?.desktopStep!==false||!/^([a-f0-9]{64})$/.test(acceptance.source_manifest_sha256||'')||acceptance.source_acceptance!=='ACCEPTED_INTERNAL'||acceptance.qualification?.web!=='QA_ACCEPTED_SCOPED'||!Array.isArray(acceptance.evidence_refs)||!acceptance.evidence_refs.length||!acceptance.evidence_refs.every(ref=>typeof ref==='string'&&ref.trim().length>0&&ref.length<=4096))fail('ACTIVATION_GATE_INVALID');
  if(acceptance.qualification?.region!==undefined&&(acceptance.qualification.region!=='QA_ACCEPTED_SCOPED'||acceptance.phase!=='INTERNAL_LIVE'))fail('ACTIVATION_REGION_QUALIFICATION_INVALID');
  const bytes=await fs.readFile(path.join(baseDir,'observe-act','source-manifest.json'));
  if(sha(bytes)!==acceptance.source_manifest_sha256)fail('ACTIVATION_MANIFEST_DRIFT');
  const manifest=JSON.parse(bytes);
  if(manifest.schema!=='cp.universal.candidate-source/v1'||!Array.isArray(manifest.files)||manifest.files.length!==sourcePaths.length||JSON.stringify(manifest.files.map(f=>f.path).sort())!==JSON.stringify(sourcePaths))fail('ACTIVATION_SOURCE_SCOPE_INVALID');
  for(const file of manifest.files){if(!/^[a-f0-9]{64}$/.test(file.sha256)||sha(await fs.readFile(new URL('../'+file.path,import.meta.url)))!==file.sha256)fail('ACTIVATION_SOURCE_DRIFT: '+file.path)}
 }
 const flags=Object.fromEntries(Object.entries(envFlags).map(([key,value])=>[key,value===undefined?Boolean(acceptance?.enabled[key]):value==='1']));
 return {flags,acceptance};
}

export function createUniversalRegistry({baseDir,cdpUrl,prefix,legacyActions={},activation}) {
 const {flags,acceptance}=activation??{flags:{web:process.env.CP_OBSERVE_WEB==='1',desktop:process.env.CP_OBSERVE_DESKTOP==='1',desktopStep:process.env.CP_STEP_DESKTOP==='1'},acceptance:null};
 async function run(ctx,params,step=false){
  const surface=params?.target?.surface;if(!['web','desktop'].includes(surface))throw Error('INVALID_TARGET');
  const host=hostId();if(params.target.host!==host)throw Error('TARGET_MISMATCH: host');
  if(step&&Object.hasOwn(params,'region'))throw Error('REGION_STEP_OVERRIDE_UNSUPPORTED');
  if(surface!=='web'&&params.region!=null)throw Error('REGION_SURFACE_UNSUPPORTED');
  let release,adapter;
  try{if(surface==='web'){release=await acquireBrowser(cdpUrl);adapter=webAdapter({cdpUrl,host,verifyResource:release.verify})}else adapter=windowsAdapter({host});const engine=createEngine({baseDir,features:flags,adapters:{[surface]:adapter}});return step?await engine.step({...ctx,verifyResource:release?.verify},params):await engine.observe(params)}
  finally{try{await adapter?.close?.()}finally{await release?.()}}
 }
 return {actions:{
  'cp.observe':(ctx,params)=>run(ctx,params),
  'cp.step':(ctx,params)=>run(ctx,params,true),
  'capabilities.describe':async(ctx,params)=>{
   const original=legacyActions['capabilities.describe']?await legacyActions['capabilities.describe'](ctx,params):{ok:true,data:{}};
   return {...original,data:{...original.data,observe_act:{schema:'cp.observe-act.contract/v1',version:'1.1.0',candidate_only:!acceptance,phase:acceptance?.phase??'CANDIDATE',source_manifest_sha256:acceptance?.source_manifest_sha256??null,canonical_source:'NEEDS_SOURCE',source_acceptance:acceptance?.source_acceptance??'CANDIDATE_ONLY',web:{enabled:flags.web,installed:true,reachable:'NOT_PROBED',qualified:acceptance?'OWNED_WEB_FIXTURE_QA_ACCEPTED':'FIXTURE_ONLY_PENDING_FROZEN_QA',region:{installed:true,enabled:flags.web,reachable:'NOT_PROBED',qualified:acceptance?.phase==='INTERNAL_LIVE'&&acceptance?.qualification?.region==='QA_ACCEPTED_SCOPED'?'OWNED_WEB_REGION_FIXTURE_QA_ACCEPTED':false,input_space:'viewport_css_px',image_mapping:'EXPLICIT_CSS_ORIGIN_SIZE_SCALE',action_kinds:['click','type','wait_for'],pixel_delta:false}},desktop:{enabled:flags.desktop,installed:false,reachable:false,qualified:false,reason:'APPROVED_INTERACTIVE_BACKEND_HOOKS_REQUIRED'},flags}}};
  }
 }};
}
