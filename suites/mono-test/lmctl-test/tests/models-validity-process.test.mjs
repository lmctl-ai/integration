import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {command,CONTROL_IDS} from './models-validity.mjs';
const fixture=JSON.parse(await readFile(new URL('./fixtures/models-validity/providers.json',import.meta.url),'utf8'));
const suite=fileURLToPath(new URL('./models-validity.mjs',import.meta.url));

test('executable suite passes, reuses daily cache, reports unmatched as INFO, and fails four live-style controls',async()=>{
 const root=await mkdtemp(join(tmpdir(),'models-validity-'));
 try{
  const home=join(root,'home'),bin=join(root,'bin'),state=join(root,'state');
  for(const path of [bin,join(home,'.kimi-code'),join(home,'repos/skills-scripts'),join(home,'repos/lmctl-website/quickrun')])await mkdir(path,{recursive:true});
  await writeFile(join(root,'package.json'),'{"name":"stub"}\n');
  await writeFile(join(home,'.kimi-code/config.toml'),fixture.kimi);
  const listing=structuredClone(fixture.listing);listing.providers[0].unmatched=['gpt-6-luna'];
  const script=`#!/usr/bin/env node
import {basename} from 'node:path';import {appendFileSync} from 'node:fs';
const fixture=${JSON.stringify(fixture)}, listing=${JSON.stringify(listing)};
const name=basename(process.argv[1]);
if(name==='lmctl') console.log(JSON.stringify(listing));
if(name==='codex') console.log(JSON.stringify(fixture.codex));
if(name==='agy') console.log(fixture.agy);
if(name==='claude') {const flags=fixture.claude_probe_flags;const start=process.argv.indexOf(flags[0]);if(JSON.stringify(process.argv.slice(start,start+flags.length))!==JSON.stringify(flags)){console.error('missing exact low-context flags');process.exit(2);}const id=process.argv[process.argv.indexOf('--model')+1];appendFileSync(process.env.PROBE_LOG,id+'\\n');if(id===${JSON.stringify(CONTROL_IDS.claude)}||id==='claude-mythos-5'){console.log(JSON.stringify({is_error:true,subtype:'success',result:"There's an issue with the selected model ("+id+"). It may not exist or you may not have access to it. Run --model to pick a different model."}));process.exit(1);}else console.log(JSON.stringify({subtype:'success',result:'OK'}));}
`;
  for(const name of ['lmctl','codex','agy','claude'])await writeFile(join(bin,name),script,{mode:0o755});
  const log=join(root,'probes');
  const env={...process.env,HOME:home,PATH:bin+delimiter+process.env.PATH,LMCTL_BIN:join(bin,'lmctl'),LMCTL_PERIODIC_DIR:state,PROBE_LOG:log,LMCTL_MODELS_CONTROL:'0'};
  delete env.KIMI_CODE_HOME;delete env.KIMI_CODE_CONFIG_PATH;
  const first=await command(process.execPath,[suite,'--all-models'],{env});assert.equal(first.code,0,first.out+first.err);
  for(const provider of Object.keys(CONTROL_IDS))assert.match(first.out,new RegExp('== models-validity '+provider+': PASS'));
  assert.match(first.out,/INFO codex: gpt-6-luna/);
  assert.equal((await readFile(log,'utf8')).trim().split('\n').length,2);
  const cached=await readFile(join(state,'claude-probes.json'),'utf8');
  const control=await command(process.execPath,[suite,'--all-models'],{env:{...env,LMCTL_MODELS_CONTROL:'1'}});
  assert.equal(control.code,1,control.out+control.err);
  for(const [provider,id] of Object.entries(CONTROL_IDS)){
   assert.match(control.out,new RegExp('== models-validity '+provider+': FAIL'));
   assert.ok(control.out.includes('listed but not accepted: '+id));
  }
  assert.equal((await readFile(log,'utf8')).trim().split('\n').length,3,'second run probes only bogus Claude id');
  assert.equal(await readFile(join(state,'claude-probes.json'),'utf8'),cached);
  assert.equal('claude-bogus-9-9' in JSON.parse(cached),false);

  // An unused refused Claude model must FAIL, not warn
  const listingRefused=structuredClone(listing);
  listingRefused.providers.find(p=>p.provider==='claude').models.push({id:'claude-mythos-5',status:'unverified'});
  const scriptRefused=script.replace(JSON.stringify(listing),JSON.stringify(listingRefused));
  await writeFile(join(bin,'lmctl'),scriptRefused,{mode:0o755});
  const refusedRun=await command(process.execPath,[suite,'--all-models'],{env});
  assert.equal(refusedRun.code,1,refusedRun.out+refusedRun.err);
  assert.match(refusedRun.out,/== models-validity claude: FAIL/);
  assert.match(refusedRun.out,/listed but not accepted: claude-mythos-5/);
  assert.doesNotMatch(refusedRun.out,/WARN claude: listed but refused: claude-mythos-5/);

  await writeFile(join(home,'repos/skills-scripts/fleet.lmctl'),'_MEMBER_ alias=Refused provider=claude model="claude-mythos-5"\n');
  const refusedFleet=await command(process.execPath,[suite,'--all-models'],{env});
  assert.equal(refusedFleet.code,1,refusedFleet.out+refusedFleet.err);
  assert.match(refusedFleet.out,/fleet.lmctl:1.*claude-mythos-5/);
  assert.doesNotMatch(refusedFleet.out,/WARN claude: listed but refused: claude-mythos-5/);
  await writeFile(join(home,'repos/skills-scripts/fleet.lmctl'),'_MEMBER_ alias=Wrong provider=agy model="Gemini 3.8 Flash (Medium)"\n');
  const fleet=await command(process.execPath,[suite,'--all-models'],{env});assert.equal(fleet.code,1);assert.match(fleet.out,/fleet.lmctl:1.*gemini-3.8-flash-medium/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('periodic step preserves login HOME for models validity and isolates its cache/history',async()=>{
 const root=await mkdtemp(join(tmpdir(),'models-periodic-'));
 try{
  const home=join(root,'home'),state=join(root,'state'),bin=join(root,'bin'),prefix=join(state,'prefix-9.9.9/node_modules/.bin');
  for(const path of [home,bin,prefix])await mkdir(path,{recursive:true});
  await writeFile(join(bin,'npm'),'#!/bin/sh\necho 9.9.9\n',{mode:0o755});
  await writeFile(join(prefix,'lmctl'),'#!/bin/sh\necho "lmctl 9.9.9"\n',{mode:0o755});
  await writeFile(join(bin,'node'),`#!/bin/sh
printf '%s|%s|%s\\n' "$1" "$HOME" "$LMCTL_PERIODIC_DIR" >> '${join(root,'calls')}'
echo '4 providers: 4 pass, 0 fail'
`,{mode:0o755});
  const result=await command('bash',[fileURLToPath(new URL('../../periodic-check.sh',import.meta.url))],{env:{...process.env,HOME:home,PATH:bin+delimiter+process.env.PATH,FORCE:'1',LMCTL_PERIODIC_DIR:state}});
  assert.equal(result.code,0,result.out+result.err);
  const calls=await readFile(join(root,'calls'),'utf8');
  assert.ok(calls.includes(`tests/models-validity.mjs|${home}|${state}`),calls);
  const offline=calls.split('\n').find(x=>x.startsWith('tests/offline-commands.mjs|'));assert.ok(offline&&!offline.includes('|'+home+'|'));
  assert.match(await readFile(join(state,'history.tsv'),'utf8'),/9.9.9\tPASS/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('default run with LMCTL_MODELS_ALL=1 in env does NOT probe all models, and reports fresh vs cached explicitly',async()=>{
 const root=await mkdtemp(join(tmpdir(),'models-allmodels-env-'));
 try{
  const home=join(root,'home'),bin=join(root,'bin'),state=join(root,'state');
  for(const path of [bin,join(home,'.kimi-code'),join(home,'repos/skills-scripts'),join(home,'repos/lmctl-website/quickrun')])await mkdir(path,{recursive:true});
  await writeFile(join(root,'package.json'),'{"name":"stub"}\n');
  await writeFile(join(home,'.kimi-code/config.toml'),fixture.kimi);
  const listing=structuredClone(fixture.listing);
  // Add Opus and Fable models to listing
  listing.providers.find(p=>p.provider==='claude').models.push(
   {id:'claude-fable-5',status:'unverified',pricing:{input_per_1m_tokens:10,output_per_1m_tokens:50}},
   {id:'claude-opus-5-5',status:'unverified',pricing:{input_per_1m_tokens:4,output_per_1m_tokens:20}},
   {id:'claude-haiku-5-5',status:'unverified',pricing:{input_per_1m_tokens:0.1,output_per_1m_tokens:0.5}}
  );
  const script=`#!/usr/bin/env node
import {basename} from 'node:path';import {appendFileSync} from 'node:fs';
const fixture=${JSON.stringify(fixture)}, listing=${JSON.stringify(listing)};
const name=basename(process.argv[1]);
if(name==='lmctl') console.log(JSON.stringify(listing));
if(name==='codex') console.log(JSON.stringify(fixture.codex));
if(name==='agy') console.log(fixture.agy);
if(name==='claude') {
 const id=process.argv[process.argv.indexOf('--model')+1];
 appendFileSync(process.env.PROBE_LOG,id+'\\n');
 if(id===${JSON.stringify(CONTROL_IDS.claude)}){
  console.log(JSON.stringify({is_error:true,subtype:'success',result:"There's an issue with the selected model ("+id+"). It may not exist or you may not have access to it. Run --model to pick a different model."}));
  process.exit(1);
 }else{
  console.log(JSON.stringify({subtype:'success',result:'OK'}));
 }
}
`;
  for(const name of ['lmctl','codex','agy','claude'])await writeFile(join(bin,name),script,{mode:0o755});
  const log=join(root,'probes');
  const env={...process.env,HOME:home,PATH:bin+delimiter+process.env.PATH,LMCTL_BIN:join(bin,'lmctl'),LMCTL_PERIODIC_DIR:state,PROBE_LOG:log,LMCTL_MODELS_CONTROL:'0',LMCTL_MODELS_ALL:'1'};
  delete env.KIMI_CODE_HOME;delete env.KIMI_CODE_CONFIG_PATH;

  // Run WITHOUT --all-models, but with LMCTL_MODELS_ALL=1 in env
  const run1=await command(process.execPath,[suite],{env});
  assert.equal(run1.code,0,run1.out+run1.err);
  assert.match(run1.out,/== models-validity claude: PASS 1 ids \(1 fresh, 0 cached\)/);
  const probed1=(await readFile(log,'utf8')).trim().split('\n');
  assert.deepEqual(probed1,['claude-haiku-5-5',CONTROL_IDS.claude],'must NOT probe Fable or Opus even when LMCTL_MODELS_ALL=1');

  // Second run: cached
  const run2=await command(process.execPath,[suite],{env});
  assert.equal(run2.code,0);
  assert.match(run2.out,/== models-validity claude: PASS 1 ids \(0 fresh, 1 cached\)/);
  const probed2=(await readFile(log,'utf8')).trim().split('\n');
  assert.equal(probed2.length,3,'second run only probes bogus control');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('unpriced Claude models cannot establish cheapest: reports WARN and never PASS 0 ids',async()=>{
 const root=await mkdtemp(join(tmpdir(),'models-unpriced-'));
 try{
  const home=join(root,'home'),bin=join(root,'bin'),state=join(root,'state');
  for(const path of [bin,join(home,'.kimi-code'),join(home,'repos/skills-scripts'),join(home,'repos/lmctl-website/quickrun')])await mkdir(path,{recursive:true});
  await writeFile(join(root,'package.json'),'{"name":"stub"}\n');
  await writeFile(join(home,'.kimi-code/config.toml'),fixture.kimi);
  const listing=structuredClone(fixture.listing);
  // Claude has only unpriced Opus and Haiku
  const claudeProv=listing.providers.find(p=>p.provider==='claude');
  claudeProv.models=[
   {id:'claude-opus-5-5',status:'unverified'},
   {id:'claude-haiku-5-5',status:'unverified'}
  ];
  const script=`#!/usr/bin/env node
import {basename} from 'node:path';import {appendFileSync} from 'node:fs';
const fixture=${JSON.stringify(fixture)}, listing=${JSON.stringify(listing)};
const name=basename(process.argv[1]);
if(name==='lmctl') console.log(JSON.stringify(listing));
if(name==='codex') console.log(JSON.stringify(fixture.codex));
if(name==='agy') console.log(fixture.agy);
if(name==='claude') {
 const id=process.argv[process.argv.indexOf('--model')+1];
 appendFileSync(process.env.PROBE_LOG,id+'\\n');
 if(id===${JSON.stringify(CONTROL_IDS.claude)}){
  console.log(JSON.stringify({is_error:true,subtype:'success',result:"There's an issue with the selected model ("+id+"). It may not exist or you may not have access to it. Run --model to pick a different model."}));
  process.exit(1);
 }else{
  console.log(JSON.stringify({subtype:'success',result:'OK'}));
 }
}
`;
  for(const name of ['lmctl','codex','agy','claude'])await writeFile(join(bin,name),script,{mode:0o755});
  const log=join(root,'probes');
  const env={...process.env,HOME:home,PATH:bin+delimiter+process.env.PATH,LMCTL_BIN:join(bin,'lmctl'),LMCTL_PERIODIC_DIR:state,PROBE_LOG:log,LMCTL_MODELS_CONTROL:'0'};
  delete env.KIMI_CODE_HOME;delete env.KIMI_CODE_CONFIG_PATH;

  const run=await command(process.execPath,[suite],{env});
  assert.equal(run.code,0,run.out+run.err);
  assert.match(run.out,/WARN claude: NOT PROBED: cannot establish cheapest/);
  assert.match(run.out,/== models-validity claude: WARN 0 ids \(cannot establish cheapest\)/);
  assert.doesNotMatch(run.out,/== models-validity claude: PASS/);
  const probed=(await readFile(log,'utf8')).trim().split('\n');
  assert.deepEqual(probed,[CONTROL_IDS.claude],'must only probe control when cheapest cannot be established');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('partially missing prices (unpriced Haiku + priced Sonnet) reports cannot establish cheapest and never probes Sonnet',async()=>{
 const root=await mkdtemp(join(tmpdir(),'models-partial-pricing-'));
 try{
  const home=join(root,'home'),bin=join(root,'bin'),state=join(root,'state');
  for(const path of [bin,join(home,'.kimi-code'),join(home,'repos/skills-scripts'),join(home,'repos/lmctl-website/quickrun')])await mkdir(path,{recursive:true});
  await writeFile(join(root,'package.json'),'{"name":"stub"}\n');
  await writeFile(join(home,'.kimi-code/config.toml'),fixture.kimi);
  const listing=structuredClone(fixture.listing);
  const claudeProv=listing.providers.find(p=>p.provider==='claude');
  claudeProv.models=[
   {id:'claude-opus-5-5',status:'unverified'},
   {id:'claude-haiku-5-5',status:'unverified'},
   {id:'claude-sonnet-5-5',status:'unverified',pricing:{input_per_1m_tokens:2,output_per_1m_tokens:10}}
  ];
  const script=`#!/usr/bin/env node
import {basename} from 'node:path';import {appendFileSync} from 'node:fs';
const fixture=${JSON.stringify(fixture)}, listing=${JSON.stringify(listing)};
const name=basename(process.argv[1]);
if(name==='lmctl') console.log(JSON.stringify(listing));
if(name==='codex') console.log(JSON.stringify(fixture.codex));
if(name==='agy') console.log(fixture.agy);
if(name==='claude') {
 const id=process.argv[process.argv.indexOf('--model')+1];
 appendFileSync(process.env.PROBE_LOG,id+'\\n');
 if(id===${JSON.stringify(CONTROL_IDS.claude)}){
  console.log(JSON.stringify({is_error:true,subtype:'success',result:"There's an issue with the selected model ("+id+"). It may not exist or you may not have access to it. Run --model to pick a different model."}));
  process.exit(1);
 }else{
  console.log(JSON.stringify({subtype:'success',result:'OK'}));
 }
}
`;
  for(const name of ['lmctl','codex','agy','claude'])await writeFile(join(bin,name),script,{mode:0o755});
  const log=join(root,'probes');
  const env={...process.env,HOME:home,PATH:bin+delimiter+process.env.PATH,LMCTL_BIN:join(bin,'lmctl'),LMCTL_PERIODIC_DIR:state,PROBE_LOG:log,LMCTL_MODELS_CONTROL:'0'};
  delete env.KIMI_CODE_HOME;delete env.KIMI_CODE_CONFIG_PATH;

  const run=await command(process.execPath,[suite],{env});
  assert.equal(run.code,0,run.out+run.err);
  assert.match(run.out,/WARN claude: NOT PROBED: cannot establish cheapest/);
  assert.match(run.out,/== models-validity claude: WARN 0 ids \(cannot establish cheapest\)/);
  assert.doesNotMatch(run.out,/== models-validity claude: PASS/);
  const probed=(await readFile(log,'utf8')).trim().split('\n');
  assert.deepEqual(probed,[CONTROL_IDS.claude],'must only probe control when any eligible candidate is unpriced; never probe Sonnet');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('priced Haiku with all-429 (quota exhaustion) exits 0 with WARN, while accepted/error control fails 1',async()=>{
 const root=await mkdtemp(join(tmpdir(),'models-all429-'));
 try{
  const home=join(root,'home'),bin=join(root,'bin'),state=join(root,'state');
  for(const path of [bin,join(home,'.kimi-code'),join(home,'repos/skills-scripts'),join(home,'repos/lmctl-website/quickrun')])await mkdir(path,{recursive:true});
  await writeFile(join(root,'package.json'),'{"name":"stub"}\n');
  await writeFile(join(home,'.kimi-code/config.toml'),fixture.kimi);
  const listing=structuredClone(fixture.listing);
  const claudeProv=listing.providers.find(p=>p.provider==='claude');
  claudeProv.models=[
   {id:'claude-opus-5-5',status:'unverified',pricing:{input_per_1m_tokens:4,output_per_1m_tokens:20}},
   {id:'claude-haiku-5-5',status:'unverified',pricing:{input_per_1m_tokens:0.1,output_per_1m_tokens:0.5}}
  ];
  const makeScript=(controlOutcome)=>`#!/usr/bin/env node
import {basename} from 'node:path';import {appendFileSync} from 'node:fs';
const fixture=${JSON.stringify(fixture)}, listing=${JSON.stringify(listing)};
const name=basename(process.argv[1]);
if(name==='lmctl') console.log(JSON.stringify(listing));
if(name==='codex') console.log(JSON.stringify(fixture.codex));
if(name==='agy') console.log(fixture.agy);
if(name==='claude') {
 const id=process.argv[process.argv.indexOf('--model')+1];
 appendFileSync(process.env.PROBE_LOG,id+'\\n');
 if(id===${JSON.stringify(CONTROL_IDS.claude)}){
  if('${controlOutcome}'==='429'){
   console.log(JSON.stringify({subtype:'error',is_error:true,result:"You're out of usage credits. Switch to another model."}));
   process.exitCode=1;
  }else if('${controlOutcome}'==='accepted'){
   console.log(JSON.stringify({subtype:'success',result:'OK'}));
  }else if('${controlOutcome}'==='error'){
   console.error('internal server error');
   process.exitCode=1;
  }
 }else{
  console.log(JSON.stringify({subtype:'error',is_error:true,result:"You're out of usage credits. Switch to another model."}));
  process.exitCode=1;
 }
}
`;
  for(const name of ['lmctl','codex','agy'])await writeFile(join(bin,name),makeScript('429'),{mode:0o755});
  await writeFile(join(bin,'claude'),makeScript('429'),{mode:0o755});
  const log=join(root,'probes');
  const env={...process.env,HOME:home,PATH:bin+delimiter+process.env.PATH,LMCTL_BIN:join(bin,'lmctl'),LMCTL_PERIODIC_DIR:state,PROBE_LOG:log,LMCTL_MODELS_CONTROL:'0'};
  delete env.KIMI_CODE_HOME;delete env.KIMI_CODE_CONFIG_PATH;

  // 1. All-429 run: exits 0, reports WARN 0 ids, and control inconclusive warning
  const run429=await command(process.execPath,[suite],{env});
  assert.equal(run429.code,0,run429.out+run429.err);
  assert.match(run429.out,/WARN claude: control inconclusive:/);
  assert.match(run429.out,/WARN claude: INCONCLUSIVE: claude-haiku-5-5:/);
  assert.match(run429.out,/== models-validity claude: WARN 0 ids/);
  assert.doesNotMatch(run429.out,/== models-validity claude: FAIL/);
  assert.doesNotMatch(run429.out,/Claude refusal control was not refused/);

  // 2. Control accepted: exits 1, reports FAIL and unrefused error
  await writeFile(join(bin,'claude'),makeScript('accepted'),{mode:0o755});
  const runAcc=await command(process.execPath,[suite],{env});
  assert.equal(runAcc.code,1,runAcc.out+runAcc.err);
  assert.match(runAcc.out,/== models-validity claude: FAIL/);
  assert.match(runAcc.out,/Claude refusal control was not refused with a model error/);

  // 3. Control generic error: exits 1, reports FAIL and unrefused error
  await writeFile(join(bin,'claude'),makeScript('error'),{mode:0o755});
  const runErr=await command(process.execPath,[suite],{env});
  assert.equal(runErr.code,1,runErr.out+runErr.err);
  assert.match(runErr.out,/== models-validity claude: FAIL/);
  assert.match(runErr.out,/Claude refusal control was not refused with a model error/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('negative control: bogus control returning infrastructure errors must FAIL (exit 1), never PASS',async()=>{
 for(const infraError of [
  'configuration file not found',
  'configuration file does not exist',
  'no such file or directory',
  'ENOENT: spawn claude',
  'permission denied',
  'command not found',
  'while loading claude-bogus-9-9: no access to storage',
  'model config does not exist',
  'model cache not found',
  'invalid model configuration',
  'no access to model; HTTP 429',
  'model claude-bogus-9-9 does not exist\nfile not found',
  'unknown model claude-bogus-9-9-other',
  'prefix-claude-bogus-9-9 is not a valid model',
  'unknown model "claude-bogus-9-9-other"',
  "'prefix-claude-bogus-9-9' is not a valid model",
  'unknown model claude-bogus-9-9/other',
  'unknown model prefix/claude-bogus-9-9',
  'unknown model claude-bogus-9-9+other',
  'unknown model +claude-bogus-9-9',
  'unknown model claude-bogus-9-9@other',
  'unknown model @claude-bogus-9-9',
  'unknown model claude-bogus-9-9~other',
  'unknown model ~claude-bogus-9-9',
  'unknown model claude-bogus-9-9=other',
  'unknown model =claude-bogus-9-9',
  'unknown model claude-bogus-9-9#other',
  'unknown model #claude-bogus-9-9',
  'unknown model claude-bogus-9-9\\other',
  'unknown model \\claude-bogus-9-9',
  'unknown model claude-bogus-9-9%other',
  'unknown model %claude-bogus-9-9',
  'unknown model claude-bogus-9-9*other',
  'unknown model *claude-bogus-9-9',
  'unknown model claude-bogus-9-9.1',
  'unknown model claude-bogus-9-9-1',
  'unknown model x:claude-bogus-9-9y',
  'unknown model \'claude-bogus-9-9"',
  'unknown model "claude-bogus-9-9\'',
  "There's an issue with the selected model (claude-bogus-9-9-other). It may not exist or you may not have access to it.",
  "There's an issue with the selected model (other-model). It may not exist or you may not have access to it.",
  "There's an issue with the selected model (claude-bogus-9-9/other). It may not exist or you may not have access to it.",
  "There's an issue with the selected model (claude-bogus-9-9.1). It may not exist or you may not have access to it.",
  JSON.stringify({ is_error: true, result: "There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\nfile not found" }),
  JSON.stringify({ is_error: true, result: "There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\npermission denied" }),
  JSON.stringify({ is_error: true, result: "There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\nENOENT" }),
  JSON.stringify({ is_error: true, error: { message: "There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\nfile not found" } }),
  JSON.stringify({ is_error: true, error: { message: "There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\npermission denied" } }),
  JSON.stringify({ is_error: true, error: { message: "There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\nENOENT" } }),
  '{"is_error":true,"result":"There\'s an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\\u000afile not found"}',
  '{"is_error":true,"result":"There\'s an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\\u000apermission denied"}',
  '{"is_error":true,"result":"There\'s an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\\u000aENOENT"}',
  '{"is_error":true,"error":{"message":"There\'s an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\\u000afile not found"}}',
  '{"is_error":true,"error":{"message":"There\'s an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\\u000apermission denied"}}',
  '{"is_error":true,"error":{"message":"There\'s an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.\\u000aENOENT"}}'
 ]){
  const root=await mkdtemp(join(tmpdir(),'models-infra-error-'));
  try{
   const home=join(root,'home'),bin=join(root,'bin'),state=join(root,'state');
   for(const path of [bin,join(home,'.kimi-code'),join(home,'repos/skills-scripts'),join(home,'repos/lmctl-website/quickrun')])await mkdir(path,{recursive:true});
   await writeFile(join(root,'package.json'),'{"name":"stub"}\n');
   await writeFile(join(home,'.kimi-code/config.toml'),fixture.kimi);
   const listing=structuredClone(fixture.listing);
   const claudeProv=listing.providers.find(p=>p.provider==='claude');
   claudeProv.models=[
    {id:'claude-opus-5-5',status:'unverified',pricing:{input_per_1m_tokens:4,output_per_1m_tokens:20}},
    {id:'claude-haiku-5-5',status:'unverified',pricing:{input_per_1m_tokens:0.1,output_per_1m_tokens:0.5}}
   ];
   const script=`#!/usr/bin/env node
import {basename} from 'node:path';import {appendFileSync} from 'node:fs';
const fixture=${JSON.stringify(fixture)}, listing=${JSON.stringify(listing)};
const name=basename(process.argv[1]);
if(name==='lmctl') console.log(JSON.stringify(listing));
if(name==='codex') console.log(JSON.stringify(fixture.codex));
if(name==='agy') console.log(fixture.agy);
if(name==='claude') {
 const id=process.argv[process.argv.indexOf('--model')+1];
 appendFileSync(process.env.PROBE_LOG,id+'\\n');
 if(id===${JSON.stringify(CONTROL_IDS.claude)}){
  if(${JSON.stringify(infraError)}.startsWith('{')){
   console.log(${JSON.stringify(infraError)});
  }else{
   console.error(${JSON.stringify(infraError)});
  }
  process.exit(1);
 }else{
  console.log(JSON.stringify({subtype:'success',result:'OK'}));
 }
}
`;
   for(const name of ['lmctl','codex','agy','claude'])await writeFile(join(bin,name),script,{mode:0o755});
   const log=join(root,'probes');
   const env={...process.env,HOME:home,PATH:bin+delimiter+process.env.PATH,LMCTL_BIN:join(bin,'lmctl'),LMCTL_PERIODIC_DIR:state,PROBE_LOG:log,LMCTL_MODELS_CONTROL:'0'};
   delete env.KIMI_CODE_HOME;delete env.KIMI_CODE_CONFIG_PATH;

   const run=await command(process.execPath,[suite],{env});
   assert.equal(run.code,1,`expected code 1 for ${infraError}, got ${run.code}: ${run.out}`);
   assert.match(run.out,/== models-validity claude: FAIL/);
   assert.match(run.out,/Claude refusal control was not refused with a model error/);
   assert.doesNotMatch(run.out,/== models-validity claude: PASS/);
  }finally{await rm(root,{recursive:true,force:true});}
 }
});

test('real Claude refusal on bogus control results in PASS',async()=>{
 const root=await mkdtemp(join(tmpdir(),'models-real-refusal-'));
 try{
  const home=join(root,'home'),bin=join(root,'bin'),state=join(root,'state');
  for(const path of [bin,join(home,'.kimi-code'),join(home,'repos/skills-scripts'),join(home,'repos/lmctl-website/quickrun')])await mkdir(path,{recursive:true});
  await writeFile(join(root,'package.json'),'{"name":"stub"}\n');
  await writeFile(join(home,'.kimi-code/config.toml'),fixture.kimi);
  const listing=structuredClone(fixture.listing);
  const claudeProv=listing.providers.find(p=>p.provider==='claude');
  claudeProv.models=[
   {id:'claude-opus-5-5',status:'unverified',pricing:{input_per_1m_tokens:4,output_per_1m_tokens:20}},
   {id:'claude-haiku-5-5',status:'unverified',pricing:{input_per_1m_tokens:0.1,output_per_1m_tokens:0.5}}
  ];
  const realFixture=JSON.parse(await readFile(new URL('./fixtures/models-validity/real-refusals.json',import.meta.url),'utf8'))[0];
  const script=`#!/usr/bin/env node
import {basename} from 'node:path';import {appendFileSync} from 'node:fs';
const fixture=${JSON.stringify(fixture)}, listing=${JSON.stringify(listing)};
const real=${JSON.stringify(realFixture)};
const name=basename(process.argv[1]);
if(name==='lmctl') console.log(JSON.stringify(listing));
if(name==='codex') console.log(JSON.stringify(fixture.codex));
if(name==='agy') console.log(fixture.agy);
if(name==='claude') {
 const id=process.argv[process.argv.indexOf('--model')+1];
 appendFileSync(process.env.PROBE_LOG,id+'\\n');
 if(id===${JSON.stringify(CONTROL_IDS.claude)}){
  console.log(real.stdout);
  console.error(real.stderr);
  process.exit(1);
 }else{
  console.log(JSON.stringify({subtype:'success',result:'OK'}));
 }
}
`;
  for(const name of ['lmctl','codex','agy','claude'])await writeFile(join(bin,name),script,{mode:0o755});
  const log=join(root,'probes');
  const env={...process.env,HOME:home,PATH:bin+delimiter+process.env.PATH,LMCTL_BIN:join(bin,'lmctl'),LMCTL_PERIODIC_DIR:state,PROBE_LOG:log,LMCTL_MODELS_CONTROL:'0'};
  delete env.KIMI_CODE_HOME;delete env.KIMI_CODE_CONFIG_PATH;

  const run=await command(process.execPath,[suite],{env});
  assert.equal(run.code,0,`expected code 0, got ${run.code}: ${run.out+run.err}`);
  assert.match(run.out,/== models-validity claude: PASS 1 ids/);
  assert.match(run.out,/INFO claude probe claude-bogus-9-9: refused/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Reviewer full-stub regressions: double-encoded, error JSON string, and JSON stderr fail closed', async () => {
 const baseMsg = "There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it. Run --model to pick a different model.";
 const stubs = [
  {
   name: 'double-encoded JSON containing refusal + file not found',
   stdout: JSON.stringify({ is_error: true, result: JSON.stringify(baseMsg + '\nfile not found') }),
   stderr: '',
  },
  {
   name: 'refusal in result with infrastructure failure in JSON-encoded error string',
   stdout: JSON.stringify({ is_error: true, result: baseMsg, error: JSON.stringify({ message: 'file\nnot found' }) }),
   stderr: '',
  },
  {
   name: 'refusal in stdout with escaped infrastructure failure inside JSON stderr',
   stdout: JSON.stringify({ is_error: true, subtype: 'success', result: baseMsg }),
   stderr: '{"error":"file\\nnot found"}',
  },
  {
   name: 'reviewer unrecognized_model tag with error in JSON',
   stdout: JSON.stringify({ is_error: true, subtype: 'success', result: baseMsg }),
   stderr: '[claude-code:unrecognized_model] {"error":"file\\nnot found"}',
  },
  {
   name: 'reviewer diagnostic prefix with error in JSON',
   stdout: JSON.stringify({ is_error: true, subtype: 'success', result: baseMsg }),
   stderr: 'diagnostic\n{"error":"file\\nnot found"}',
  },
 ];

 for (const s of stubs) {
  const root = await mkdtemp(join(tmpdir(), 'models-reviewer-regression-'));
  try {
   const home = join(root, 'home'), bin = join(root, 'bin'), state = join(root, 'state');
   for (const path of [bin, join(home, '.kimi-code'), join(home, 'repos/skills-scripts'), join(home, 'repos/lmctl-website/quickrun')]) await mkdir(path, { recursive: true });
   await writeFile(join(root, 'package.json'), '{"name":"stub"}\n');
   await writeFile(join(home, '.kimi-code/config.toml'), fixture.kimi);
   const listing = structuredClone(fixture.listing);
   const claudeProv = listing.providers.find(p => p.provider === 'claude');
   claudeProv.models = [
    { id: 'claude-opus-5-5', status: 'unverified', pricing: { input_per_1m_tokens: 4, output_per_1m_tokens: 20 } },
    { id: 'claude-haiku-5-5', status: 'unverified', pricing: { input_per_1m_tokens: 0.1, output_per_1m_tokens: 0.5 } }
   ];
   const script = `#!/usr/bin/env node
import {basename} from 'node:path';import {appendFileSync} from 'node:fs';
const fixture=${JSON.stringify(fixture)}, listing=${JSON.stringify(listing)};
const stubStdout=${JSON.stringify(s.stdout)};
const stubStderr=${JSON.stringify(s.stderr)};
const name=basename(process.argv[1]);
if(name==='lmctl') console.log(JSON.stringify(listing));
if(name==='codex') console.log(JSON.stringify(fixture.codex));
if(name==='agy') console.log(fixture.agy);
if(name==='claude') {
 const id=process.argv[process.argv.indexOf('--model')+1];
 appendFileSync(process.env.PROBE_LOG,id+'\\n');
 if(id===${JSON.stringify(CONTROL_IDS.claude)}){
  if(stubStdout) console.log(stubStdout);
  if(stubStderr) console.error(stubStderr);
  process.exit(1);
 }else{
  console.log(JSON.stringify({subtype:'success',result:'OK'}));
 }
}
`;
   for (const name of ['lmctl', 'codex', 'agy', 'claude']) await writeFile(join(bin, name), script, { mode: 0o755 });
   const log = join(root, 'probes');
   const env = { ...process.env, HOME: home, PATH: bin + delimiter + process.env.PATH, LMCTL_BIN: join(bin, 'lmctl'), LMCTL_PERIODIC_DIR: state, PROBE_LOG: log, LMCTL_MODELS_CONTROL: '0' };
   delete env.KIMI_CODE_HOME; delete env.KIMI_CODE_CONFIG_PATH;

   const run = await command(process.execPath, [suite], { env });
   assert.equal(run.code, 1, `expected code 1 for ${s.name}, got ${run.code}: ${run.out}`);
   assert.match(run.out, /== models-validity claude: FAIL/);
   assert.match(run.out, /Claude refusal control was not refused with a model error/);
   assert.doesNotMatch(run.out, /== models-validity claude: PASS/);
  } finally { await rm(root, { recursive: true, force: true }); }
 }
});
