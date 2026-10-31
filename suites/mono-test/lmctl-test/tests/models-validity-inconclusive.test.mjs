// issue 094: a probe that failed for quota, rate limit or transport reasons says nothing about the id.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {command,CONTROL_IDS,checkProvider,probeClaudeIds,probeResult,loadClassifier} from './models-validity.mjs';
const fixture=JSON.parse(await readFile(new URL('./fixtures/models-validity/providers.json',import.meta.url),'utf8'));
const suite=fileURLToPath(new URL('./models-validity.mjs',import.meta.url));
const CREDITS="You're out of usage credits. Switch to another model, or manage usage credits in settings.";
const creditsResult={code:1,out:JSON.stringify({subtype:'error',is_error:true,result:CREDITS,terminal_reason:'api_error'}),err:''};
const asClass=cls=>()=>cls;

test('a quota or throttle failure is inconclusive; transport, timeouts or anything else stays an error',()=>{
 for(const cls of ['quota_exhausted','upstream_throttled'])assert.equal(probeResult(creditsResult,asClass(cls)),'inconclusive');
 for(const cls of ['transport_interrupted','unknown','auth_required','binary_missing',null])assert.equal(probeResult(creditsResult,asClass(cls)),'error');
 assert.equal(probeResult(creditsResult),'error','no classifier available: the error stays an error');
 const realClaudeRefusal = JSON.stringify({is_error:true,subtype:'success',result:`There's an issue with the selected model (${CONTROL_IDS.claude}). It may not exist or you may not have access to it. Run --model to pick a different model.`});
 assert.equal(probeResult({code:1,out:realClaudeRefusal,err:''},asClass('quota_exhausted'),CONTROL_IDS.claude),'refused','a refusal is never softened');
 assert.equal(probeResult({code:0,out:JSON.stringify({subtype:'success',result:'OK'}),err:''},asClass('quota_exhausted')),'accepted');
});

test('an inconclusive probe is not cached, not accepted and not refused',async()=>{
 const cache={},now=Date.now(),notes={'claude-fable-5':'out of credits (quota_exhausted)'};
 const result=await probeClaudeIds(['claude-fable-5','claude-opus-5-5'],{cache,now,notes,probe:async id=>id==='claude-fable-5'?'inconclusive':id===CONTROL_IDS.claude?'refused':'accepted'});
 assert.deepEqual(result.accepted,['claude-opus-5-5']);assert.deepEqual(result.refused,[]);
 assert.deepEqual(result.inconclusive,notes);assert.equal('claude-fable-5' in cache,false);assert.equal(result.controlRefused,true);
});

test('an inconclusive id warns instead of failing, for the listing and for a fleet reference; a refused id still fails',()=>{
 const section={provider:'claude',status:'ok',models:[{id:'claude-fable-5',status:'unverified'},{id:'claude-opus-5-5',status:'unverified'}]};
 const member={provider:'claude',model:'claude-fable-5',alias:'F',file:'fleet.lmctl:1'};
 const warnings=[];
 assert.deepEqual(checkProvider(section,['claude-opus-5-5'],[member],{warnings,inconclusive:{'claude-fable-5':'out of credits'}}),[]);
 assert.deepEqual(warnings,['INCONCLUSIVE: claude-fable-5: out of credits']);
 assert.match(checkProvider(section,['claude-opus-5-5'],[member],{refusedIds:['claude-fable-5'],warnings:[]}).join('\n'),/fleet.lmctl:1.*claude-fable-5 is not valid/);
 assert.match(checkProvider(section,['claude-opus-5-5'],[],{warnings:[]}).join('\n'),/listed but not accepted: claude-fable-5/);
});

async function stubPackage(root,{classifier}){
 const pkg=join(root,'pkg');await mkdir(join(pkg,'bin'),{recursive:true});await mkdir(join(pkg,'dist/api'),{recursive:true});
 await writeFile(join(pkg,'package.json'),'{"type":"module"}');
 if(classifier)await writeFile(join(pkg,'dist/api/index.js'),`export const classifyFailure=text=>({status:'ok',class:/out of usage credits/i.test(text)?'quota_exhausted':'unknown',rule:null});\n`);
 return pkg;
}

test('loadClassifier reads classifyFailure from the installed package and is null without one',async()=>{
 const root=await mkdtemp(join(tmpdir(),'models-classifier-'));
 try{
  const withApi=await stubPackage(join(root,'a'),{classifier:true}),without=await stubPackage(join(root,'b'),{classifier:false});
  await writeFile(join(withApi,'bin/lmctl'),'');await writeFile(join(without,'bin/lmctl'),'');
  assert.equal((await loadClassifier(join(withApi,'bin/lmctl')))(CREDITS),'quota_exhausted');
  assert.equal(await loadClassifier(join(without,'bin/lmctl')),null);
  assert.equal(await loadClassifier(join(root,'missing')),null);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('with an installed lmctl, the real classifier calls the out-of-credits probe text quota_exhausted',{skip:!process.env.LMCTL_BIN},async()=>{
 const classify=await loadClassifier(process.env.LMCTL_BIN);
 assert.equal(typeof classify,'function','explicit LMCTL_BIN must export the classifier for this integration check');
 assert.equal(classify(creditsResult.out),'quota_exhausted');
});

async function runSuite(root,name,{classifier,fable,control='refuse',fleet,viaPath=false}){
 const home=join(root,name,'home'),bin=join(root,name,'bin'),state=join(root,name,'state');
 for(const path of [bin,join(home,'.kimi-code'),join(home,'repos/skills-scripts'),join(home,'repos/lmctl-website/quickrun')])await mkdir(path,{recursive:true});
 await writeFile(join(home,'.kimi-code/config.toml'),fixture.kimi);
 if(fleet)await writeFile(join(home,'repos/skills-scripts/fleet.lmctl'),fleet);
 const listing=structuredClone(fixture.listing);listing.providers.find(p=>p.provider==='claude').models.push({id:'claude-fable-5',status:'unverified'});
 const pkg=await stubPackage(join(root,name),{classifier});
 const failureBody=fable==='object'?{error:{message:CREDITS}}:{subtype:'error',is_error:true,result:CREDITS,terminal_reason:'api_error'};
 const body=()=>`#!/usr/bin/env node
import {basename} from 'node:path';
const fixture=${JSON.stringify(fixture)}, listing=${JSON.stringify(listing)};
const name=basename(process.argv[1]);
if(name==='lmctl') console.log(JSON.stringify(listing));
if(name==='codex') console.log(JSON.stringify(fixture.codex));
if(name==='agy') console.log(fixture.agy);
if(name==='claude'){const id=process.argv[process.argv.indexOf('--model')+1];
 const credits=()=>{console.log(JSON.stringify(${JSON.stringify(failureBody)}));process.exitCode=1;};
 const refuse=()=>{
  if(id===${JSON.stringify(CONTROL_IDS.claude)}){
   console.log(JSON.stringify({is_error:true,subtype:'success',result:"There's an issue with the selected model ("+id+"). It may not exist or you may not have access to it. Run --model to pick a different model."}));
   process.exit(1);
  }else{
   console.error('unknown model: ' + id);process.exitCode=1;
  }
 };
 const accept=()=>{console.log(JSON.stringify({subtype:'success',result:'OK'}));};
 const genericError=()=>{console.error('internal server error');process.exitCode=1;};
 if(id===${JSON.stringify(CONTROL_IDS.claude)}) ${control==='refuse'?'refuse()':control==='accepted'?'accept()':control==='error'?'genericError()':'credits()'};
 else if(id==='claude-fable-5') ${fable==='refuse'?'refuse()':'credits()'};
 else console.log(JSON.stringify({subtype:'success',result:'OK'}));}
`;
 for(const n of ['codex','agy','claude'])await writeFile(join(bin,n),body(),{mode:0o755});
 await writeFile(join(pkg,'bin/lmctl'),body(),{mode:0o755});
 if(viaPath)await symlink(join(pkg,'bin/lmctl'),join(bin,'lmctl'));
 const env={...process.env,HOME:home,PATH:bin+delimiter+process.env.PATH,LMCTL_BIN:viaPath?'lmctl':join(pkg,'bin/lmctl'),LMCTL_PERIODIC_DIR:state,LMCTL_MODELS_CONTROL:'0'};
 delete env.KIMI_CODE_HOME;delete env.KIMI_CODE_CONFIG_PATH;
 return command(process.execPath,[suite,'--all-models'],{env});
}

test('executable suite: out-of-credits on a listed id is INCONCLUSIVE and exits 0; refusal, a missing classifier and an unrefused control still fail',async()=>{
 const root=await mkdtemp(join(tmpdir(),'models-inconclusive-'));
 try{
  const ok=await runSuite(root,'ok',{classifier:true});
  assert.equal(ok.code,0,ok.out+ok.err);
  assert.match(ok.out,/== models-validity claude: PASS/);
  assert.match(ok.out,/WARN claude: INCONCLUSIVE: claude-fable-5: .*out of usage credits.*quota_exhausted/);
  const messageObject=await runSuite(root,'message-object',{classifier:true,fable:'object',viaPath:true});
  assert.equal(messageObject.code,0);assert.match(messageObject.out,/WARN claude: INCONCLUSIVE: claude-fable-5: .*out of usage credits/);
  const noClassifier=await runSuite(root,'plain',{classifier:false});
  assert.equal(noClassifier.code,1,noClassifier.out);assert.match(noClassifier.out,/listed but not accepted: claude-fable-5/);
  const refused=await runSuite(root,'refused',{classifier:true,fable:'refuse',fleet:'_MEMBER_ alias=F provider=claude model="claude-fable-5"\n'});
  assert.equal(refused.code,1,refused.out);assert.match(refused.out,/fleet.lmctl:1.*claude-fable-5 is not valid/);
  const control=await runSuite(root,'control',{classifier:true,control:'credits'});
  assert.equal(control.code,0,control.out);assert.match(control.out,/WARN claude: control inconclusive:/);
  assert.doesNotMatch(control.out,/Claude refusal control was not refused/);
  const controlAccepted=await runSuite(root,'control-acc',{classifier:true,control:'accepted'});
  assert.equal(controlAccepted.code,1,controlAccepted.out);assert.match(controlAccepted.out,/Claude refusal control was not refused/);
  const controlError=await runSuite(root,'control-err',{classifier:true,control:'error'});
  assert.equal(controlError.code,1,controlError.out);assert.match(controlError.out,/Claude refusal control was not refused/);
 }finally{await rm(root,{recursive:true,force:true});}
});


test('explicit refusal wins over a quota message and never invokes classification',()=>{
 const mixed='invalid model: claude-foo; '+CREDITS;
 for(const code of [0,1]){
  let calls=0;
  assert.equal(probeResult({code,out:JSON.stringify({subtype:'error',is_error:true,result:mixed}),err:''},()=>{calls++;return 'quota_exhausted';},'claude-foo'),'refused');
  assert.equal(calls,0);
 }
});

test('inherited names are not inconclusive and explicit refused evidence wins',()=>{
 const section={provider:'claude',status:'ok',models:[{id:'constructor',status:'unverified'}]};
 assert.ok(checkProvider(section,[],[]).length>0);
 const member={provider:'claude',model:'constructor',alias:'F',file:'fleet.lmctl:1'};
 assert.ok(checkProvider(section,[],[member],{refusedIds:['constructor'],inconclusive:{constructor:'quota'}}).length>0);
});

test('inconclusive invalidates old evidence, probes duplicate ids once per run, and retries only on a later invocation',async()=>{
 const id='claude-fable-5',now=Date.now(),cache={[id]:{at:new Date(now-86400001).toISOString(),result:'accepted'}};
 const calls=[];const probe=async name=>{calls.push(name);return name===CONTROL_IDS.claude?'refused':'inconclusive';};
 const first=await probeClaudeIds([id,id],{cache,now,probe});
 assert.equal(Object.hasOwn(cache,id),false);assert.deepEqual(first.accepted,[]);assert.deepEqual(calls,[id,CONTROL_IDS.claude]);
 calls.length=0;await probeClaudeIds([id,id],{cache,now:now+1,probe});assert.deepEqual(calls,[id,CONTROL_IDS.claude]);
 calls.length=0;await probeClaudeIds([id],{cache,now:now+2,probe,cachedOnly:true});assert.deepEqual(calls,[CONTROL_IDS.claude]);
});

test('resolves an executable PATH name and an npm .bin symlink to the same package API',async()=>{
 const root=await mkdtemp(join(tmpdir(),'models-bin-link-'));
 try {
  const pkg=await stubPackage(root,{classifier:true});await writeFile(join(pkg,'bin/lmctl'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const bin=join(root,'node_modules','.bin');await mkdir(bin,{recursive:true});await symlink(join(pkg,'bin/lmctl'),join(bin,'lmctl'));
  assert.equal((await loadClassifier(join(bin,'lmctl')))(CREDITS),'quota_exhausted');
  const shadow=join(root,'shadow');await mkdir(join(shadow,'lmctl'),{recursive:true});
  const named=await loadClassifier('lmctl',{PATH:shadow+delimiter+bin});assert.equal(typeof named,'function');assert.equal(named(CREDITS),'quota_exhausted');
 } finally {await rm(root,{recursive:true,force:true});}
});

test('the real built package API loads through an install-shaped .bin symlink',{skip:!process.env.LMCTL_BIN},async()=>{
 const root=await mkdtemp(join(tmpdir(),'models-real-link-'));
 try {
  const bin=join(root,'node_modules','.bin');await mkdir(bin,{recursive:true});await symlink(process.env.LMCTL_BIN,join(bin,'lmctl'));
  const classify=await loadClassifier(join(bin,'lmctl'));assert.equal(typeof classify,'function');
  assert.equal(classify(CREDITS),'quota_exhausted');
  assert.equal(probeResult({code:1,out:'invalid model; '+CREDITS,err:''},classify),'refused');
 } finally {await rm(root,{recursive:true,force:true});}
});
