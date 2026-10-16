// Trusted one-shot Win32/UIA backend for the existing PAI CP Windows adapter.
// This module does not create a server, discover/activate windows or own the journal/lease.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const fail=(code,message)=>{const e=new Error(message);e.code=code;throw e;};
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const strict=(x,keys,label)=>{if(!object(x)||Object.keys(x).some(k=>!keys.includes(k)))fail('INVALID_REQUEST',`${label}: unexpected fields/object`);};
const digest=x=>createHash('sha256').update(x).digest('hex');
const clone=x=>structuredClone(x);
const root=path.dirname(fileURLToPath(import.meta.url));
const psQuote=x=>"'"+x.replaceAll("'","''")+"'";
export function validateResourceLease(lease) {
  strict(lease,['path','sha256','expires_at'],'resource lease');
  if(typeof lease.path!=='string'||!/^[A-Za-z]:[\\/]/.test(lease.path)||lease.path.length>1000||/[\0\r\n]/.test(lease.path)||typeof lease.sha256!=='string'||!/^[a-f0-9]{64}$/.test(lease.sha256)||typeof lease.expires_at!=='string'||!lease.expires_at.endsWith('Z')||!Number.isFinite(Date.parse(lease.expires_at))||Date.parse(lease.expires_at)<=Date.now())fail('LEASE_LOST','Pinned local unexpired existing resource lease required');
  return Object.freeze(clone(lease));
}
export function validateBinding(binding) {
  strict(binding,['host','app','window_ref','window_id','pid','process_started_at','executable','session_id','allowed_fixture'],'binding');
  if(binding.allowed_fixture!==true||binding.app!=='pai-cp-owned-fixture')fail('BLOCKED_PERMISSION','Only explicit owned fixture is qualified');
  if(typeof binding.host!=='string'||!binding.host||binding.host.length>100)fail('INVALID_REQUEST','Exact machine name required');
  if(typeof binding.window_id!=='string'||!/^[1-9][0-9]{0,14}$/.test(binding.window_id))fail('INVALID_REQUEST','Positive decimal HWND required');
  if(binding.window_ref!=='hwnd:'+BigInt(binding.window_id).toString(16))fail('TARGET_MISMATCH','Exact HWND/window reference required');
  if(!Number.isSafeInteger(binding.pid)||binding.pid<=0||!Number.isSafeInteger(binding.session_id)||binding.session_id<=0)fail('INVALID_REQUEST','Positive authoritative PID/session required');
  if(typeof binding.process_started_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(binding.process_started_at))fail('INVALID_REQUEST','Exact .NET UTC process start required');
  if(typeof binding.executable!=='string'||!path.win32.isAbsolute(binding.executable)||binding.executable.length>1000||/[\0\r\n]/.test(binding.executable))fail('INVALID_REQUEST','Exact absolute executable required');
  return Object.freeze(clone(binding));
}
export function validateAction(action) {
  strict(action,['kind','element_ref','resolved_element','locator','point','space','text','clear','key'],'action');
  if(!['click','type','press'].includes(action.kind))fail('UNSUPPORTED','Only click/type/press are implemented');
  if(action.locator!==undefined) {
    strict(action.locator,['runtime_id'],'locator');
    if(!Array.isArray(action.locator.runtime_id)||action.locator.runtime_id.length<1||action.locator.runtime_id.length>64||!action.locator.runtime_id.every(Number.isInteger))fail('INVALID_REQUEST','Bounded integer runtime ID required');
  }
  if(action.kind==='type'&&(!action.locator||typeof action.text!=='string'||action.text.length>20000||action.text.includes('\0')||action.clear!==true))fail('UNSUPPORTED','Type requires exact locator and explicit clear=true bounded text');
  if(action.kind==='press'&&(!action.locator||!['Enter','ArrowLeft','ArrowRight','Home','End','Backspace','Delete'].includes(action.key)))fail('UNSUPPORTED','Focused edit and allowlisted simple key required');
  if(action.kind==='click'&&!action.locator&&(!Array.isArray(action.point)||action.point.length!==2||!action.point.every(Number.isFinite)||action.space!=='physical_window_px'))fail('INVALID_REQUEST','Click requires exact locator or resolved physical point');
  return clone(action);
}
function decodeImage(facts) {
  if(!facts.image)return facts;
  const image=facts.image;
  strict(image,['mime_type','base64','width','height'],'image');
  if(image.mime_type!=='image/png'||typeof image.base64!=='string'||image.base64.length>32000000||!Number.isInteger(image.width)||!Number.isInteger(image.height))fail('INVALID_NATIVE_OBSERVATION','Malformed bounded PNG');
  const bytes=Buffer.from(image.base64,'base64');
  if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(16)!==image.width||bytes.readUInt32BE(20)!==image.height||image.width!==facts.screenshot_width||image.height!==facts.screenshot_height)fail('INVALID_NATIVE_OBSERVATION','PNG/physical geometry mismatch');
  return {...facts,image:{mime:'image/png',kind:'full',bytes,width:image.width,height:image.height}};
}
export async function createBackend(options={}) {
  strict(options,['binding','sourceSha256','resourceLease','fence','timeoutMs'],'options');
  const binding=validateBinding(options.binding),source=path.join(root,'PaiCpNative.cs');
  if(typeof options.sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(options.sourceSha256))fail('SOURCE_MISMATCH','Pinned reviewed helper SHA256 required');
  const resourceLease=validateResourceLease(options.resourceLease);
  const timeout=options.timeoutMs??15000;
  if(!Number.isInteger(timeout)||timeout<1000||timeout>30000)fail('INVALID_REQUEST','Bounded helper timeout required');
  async function verifySource(){if(digest(await fs.readFile(source))!==options.sourceSha256)fail('SOURCE_MISMATCH','Reviewed helper bytes changed');}
  await verifySource();
  const command=[
    "$ErrorActionPreference='Stop'",
    '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    "$nativeRefs=@('System.dll','System.Core.dll','System.Drawing.dll','System.Web.Extensions.dll',\"$env:WINDIR\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF\\UIAutomationClient.dll\",\"$env:WINDIR\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF\\UIAutomationTypes.dll\",\"$env:WINDIR\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF\\WindowsBase.dll\")",
    `$nativeBytes=[IO.File]::ReadAllBytes(${psQuote(source)})`,
    "$nativeSha=[Security.Cryptography.SHA256]::Create()",
    "$nativeActual=([BitConverter]::ToString($nativeSha.ComputeHash($nativeBytes))).Replace('-','').ToLowerInvariant()",
    `if($nativeActual -ne '${options.sourceSha256}'){throw 'SOURCE_MISMATCH'}`,
    '$nativeSource=[Text.Encoding]::UTF8.GetString($nativeBytes)',
    'Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies $nativeRefs',
    '[PaiCpNative]::RunStdin()'
  ].join('\n');
  const powershell=path.win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  async function invoke(request) {
    await verifySource();
    return await new Promise((resolve,reject)=>{
      const child=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      let stdout='',stderr='',done=false;
      const error=(code,message)=>{if(done)return;done=true;clearTimeout(timer);child.kill();const e=new Error(message);e.code=code;reject(e);};
      const timer=setTimeout(()=>error(request.op==='perform'?'UNKNOWN_EFFECT':'NATIVE_TIMEOUT','One-shot helper exceeded deadline; no retry'),timeout);
      child.on('error',()=>error('BLOCKED_SESSION','Native helper unavailable'));
      child.stdin.on('error',()=>error(request.op==='perform'?'UNKNOWN_EFFECT':'NATIVE_BACKEND_ERROR','Native helper stdin failed'));
      child.stdout.on('data',x=>{stdout+=x;if(stdout.length>34000000)error('INVALID_NATIVE_OBSERVATION','Native output budget exceeded');});
      child.stderr.on('data',x=>{stderr+=x;if(stderr.length>30000)error('NATIVE_BACKEND_ERROR','Native diagnostics budget exceeded');});
      child.on('close',code=>{
        if(done)return;done=true;clearTimeout(timer);
        if(code!==0){
          const e=new Error('One-shot native compiler/helper failed; diagnostics are not observation data');
          e.code=request.op==='perform'?'UNKNOWN_EFFECT':'NATIVE_BACKEND_ERROR';
          // No raw compiler stderr or typed input is propagated. Bounded error identifiers help
          // diagnose a source/compiler problem without exporting source lines or user values.
          e.nativeDiagnostic={stage:'compiler_or_host',exit_code:code,compiler_codes:[...new Set(stderr.match(/\bCS\d{4}\b/g)??[])].slice(0,8),
            powershell_codes:[...new Set(stderr.match(/\b(?:SOURCE_CODE_ERROR|COMPILER_ERRORS|TYPE_ALREADY_EXISTS|SOURCE_MISMATCH)\b/g)??[])].slice(0,8)};
          reject(e);return;
        }
        try {
          const result=JSON.parse(stdout.trim());
          if(!object(result)||typeof result.ok!=='boolean'||typeof result.attempted!=='boolean')fail('INVALID_NATIVE_OBSERVATION','Typed native result required');
          if(!result.ok){
            const e=new Error(result.message??'Native guard rejected');e.code=result.code??'NATIVE_BACKEND_ERROR';e.attempted=result.attempted;
            if(object(result.native_diagnostic)) {
              const d=result.native_diagnostic;
              if(['type','cause_type'].every(k=>typeof d[k]==='string'&&/^[A-Za-z0-9_.+`]{1,200}$/.test(d[k]))&&['hresult','cause_hresult'].every(k=>typeof d[k]==='string'&&/^0x[a-f0-9]{8}$/.test(d[k])))e.nativeDiagnostic=clone(d);
            }
            throw e;
          }
          resolve(result);
        } catch(e){if(!e.code)e.code=request.op==='perform'?'UNKNOWN_EFFECT':'INVALID_NATIVE_OBSERVATION';reject(e);}
      });
      child.stdin.end(JSON.stringify(request),'utf8');
    });
  }
  return {
    async read(target,params={}) {
      if(!object(target)||target.host!==binding.host||target.app!==binding.app||target.window_ref!==binding.window_ref)fail('TARGET_MISMATCH','Target differs from immutable fixture pin');
      if(params.region)fail('UNSUPPORTED','Region capture is not qualified');
      const include_image=params.include_image??'auto';
      if(!['auto','always','never'].includes(include_image))fail('INVALID_REQUEST','Invalid image mode');
      const result=await invoke({schema:1,op:'read',binding,resource_lease:resourceLease,params:{include_image,preflight:params.preflight===true}});
      if(result.attempted||!object(result.facts))fail('INVALID_NATIVE_OBSERVATION','Read must be side effect free');
      return decodeImage(result.facts);
    },
    async preflight(expected,action) {
      const resolved=validateAction(action);
      const result=await invoke({schema:1,op:'preflight',binding,resource_lease:resourceLease,expected:clone(expected),action:resolved});
      if(result.attempted!==false||result.status!=='PREFLIGHT_VERIFIED')fail('INVALID_NATIVE_OBSERVATION','Native preflight must be read-only and explicit');
      return result;
    },
    async perform(expected,action) {
      const resolved=validateAction(action);
      if(typeof options.fence!=='function')fail('BLOCKED_SESSION','Existing journal/lease fence callback required');
      // Callback is owned by existing runner: verifies its lease and returns its already durable markAttempt receipt.
      const fence=await options.fence();
      strict(fence,['resource_verified','journal_attempt_id','resource_lease'],'fence');
      if(fence.resource_verified!==true||typeof fence.journal_attempt_id!=='string'||fence.journal_attempt_id.length<8||fence.journal_attempt_id.length>200)fail('BLOCKED_SESSION','Verified durable existing attempt receipt required');
      validateResourceLease(fence.resource_lease);
      if(!['path','sha256','expires_at'].every(k=>fence.resource_lease[k]===resourceLease[k]))fail('LEASE_LOST','Durable attempt resource lease differs from immutable backend lease');
      return await invoke({schema:1,op:'perform',binding,resource_lease:resourceLease,expected:clone(expected),action:resolved,fence:clone(fence)});
    },
    describe(){return {reachable:process.platform==='win32',qualified:false,qualification_scope:'OWNED_FIXTURE_CANDIDATE',action_kinds:['click','type','press'],supports_clear:true,known_limits:[
      'Exact owned fixture HWND/PID/process-start/path/session pin required; real application packs excluded',
      'Read-only UIA max500 elements; independent raw-tree max10000 secret scan fails closed',
      'Visible password descendant excludes complete observation and capture',
      'Physical scoped CopyFromScreen only for clear foreground fully inside one monitor',
      'No OS can make UIA/SendInput foreground guard and dispatch atomic; changed post-dispatch state is UNKNOWN_EFFECT',
      'No drag/scroll/double-click/chords/title lookup/activation/restore/UAC/security/account/CapCut fallback',
      'Native proof and existing journal/lease integration required before qualification'
    ]};},
    async disconnect(){}
  };
}
