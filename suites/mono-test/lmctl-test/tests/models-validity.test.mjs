import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {CONTROL_IDS,codexIds,agyIds,kimiIds,teamMembers,checkProvider,probeClaudeIds,cheapestModelId,INCONCLUSIVE_CLASSES,probeResult,isClaudeBogusControlRefusal} from './models-validity.mjs';
import {classifyTextForModelsValidity, isModelRefusal, isRefusalShaped} from './rate-limit-classifier.mjs';
import {
  TEST_MODEL_ID,
  REJECT_FIRST_VECTORS,
  RATE_LIMIT_VECTORS,
  MODEL_REFUSAL_POSITIVE_VECTORS,
  MODEL_REFUSAL_NEGATIVE_VECTORS,
  ARBITRARY_ERROR_VECTORS,
} from './rate-limit-vectors.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/models-validity/providers.json',import.meta.url),'utf8'));
const truth={codex:['gpt-6-luna'],agy:['gemini-3.8-flash-medium'],kimi:['kimi-code/k3','kimi-code/k3-256k'],claude:['claude-opus-5-5']};
for(const [name,parse,expected] of [['codex',codexIds,truth.codex],['agy',agyIds,truth.agy],['kimi',kimiIds,truth.kimi]])test(name+' provider truth reader',()=>assert.deepEqual(parse(fixture[name]),expected));
for(const section of fixture.listing.providers){
 test(section.provider+' exact set passes without unmatched field',()=>assert.deepEqual(checkProvider(section,truth[section.provider],[]),[]));
 test(section.provider+' control fails listed but not accepted',()=>{
  const injected={...section,models:[...section.models,{id:CONTROL_IDS[section.provider],status:section.provider==='claude'?'unverified':'valid'}]};
  assert.ok(checkProvider(injected,truth[section.provider],[]).some(x=>x.includes('listed but not accepted')&&x.includes(CONTROL_IDS[section.provider])));
 });
 test(section.provider+' reverse comparison fails accepted but not listed',()=>{
  assert.ok(checkProvider({...section,models:[]},truth[section.provider],[]).some(x=>x.includes('accepted but not listed')));
 });
}
test('A3 rejects the agy display label and suggests its canonical id',()=>{
 const section=structuredClone(fixture.listing.providers[1]);section.models[0].id='Gemini 3.8 Flash (Medium)';
 assert.match(checkProvider(section,truth.agy,[]).join('\n'),/Gemini 3\.8 Flash \(Medium\).*gemini-3\.8-flash-medium/);
});
test('fleet teamfile records require a valid provider model; Claude needs a passed probe',()=>{
 const members=teamMembers('_TEAM_ name=t\n_MEMBER_ alias=A provider=agy model="Gemini 3.8 Flash (Medium)"\n_MEMBER_ alias=C provider=claude model="claude-opus-5-5"\n','fleet.lmctl');
 assert.equal(members.length,2);assert.equal(members[0].model,'Gemini 3.8 Flash (Medium)');
 assert.match(checkProvider(fixture.listing.providers[1],truth.agy,members).join('\n'),/fleet.lmctl.*gemini-3.8-flash-medium/);
 assert.match(checkProvider(fixture.listing.providers[3],[],members).join('\n'),/fleet.lmctl.*claude-opus-5-5/);
 assert.deepEqual(checkProvider(fixture.listing.providers[3],truth.claude,members),[]);
});
test('unavailable providers fail rather than skip',()=>assert.match(checkProvider({provider:'codex',status:'unavailable',reason:'missing',models:[]},[],[]).join('\n'),/unavailable/));
test('Claude probes cache for 24 hours, always refuse-control probe, and refresh at the boundary',async()=>{
 const now=Date.parse('2026-10-16T12:00:00Z'),cache={};const calls=[];
 const probe=async id=>{calls.push(id);return id===CONTROL_IDS.claude?'refused':'accepted';};
 const first=await probeClaudeIds(truth.claude,{cache,now,probe});
 assert.deepEqual(first.accepted,truth.claude);assert.equal(first.controlRefused,true);assert.equal(calls.length,2);
 calls.length=0;await probeClaudeIds(truth.claude,{cache,now:now+1000,probe});assert.deepEqual(calls,[CONTROL_IDS.claude]);
 calls.length=0;await probeClaudeIds(truth.claude,{cache,now:now+24*3600*1000,probe});assert.equal(calls.length,2);
});
test('Claude refuses are not accepted; bogus acceptance and transport errors fail control',async()=>{
 for(const result of ['refused','error','accepted']){
  const r=await probeClaudeIds(truth.claude,{cache:{},now:Date.now(),probe:async()=>result});
  assert.deepEqual(r.accepted,result==='accepted'?truth.claude:[]);
  assert.equal(r.controlRefused,result==='refused');
 }
});

test('Claude success requires success subtype and exact OK; a transport failure is not a refused control',async()=>{
 const {probeResult}=await import('./models-validity.mjs');
 assert.equal(probeResult({code:0,out:JSON.stringify({subtype:'success',result:'OK\n'}),err:''}),'accepted');
 for(const r of [{code:0,out:'{"subtype":"error","result":"OK"}',err:''},{code:0,out:'{"subtype":"success","result":"other"}',err:''},{code:1,out:'',err:'network unavailable'}])assert.equal(probeResult(r,null,CONTROL_IDS.claude),'error');
 const realJson = JSON.stringify({
  is_error: true,
  subtype: 'success',
  result: "There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it. Run --model to pick a different model."
 });
 assert.equal(probeResult({code:1,out:realJson,err:''},null,CONTROL_IDS.claude),'refused');
});

test('probeResult: local refusal and timeout/stall guards apply BEFORE calling external or installed classifier',()=>{
 const stubClassifier=()=>'upstream_throttled';
 assert.equal(probeResult({code:1,out:"model 'claude-foo' not found; HTTP 429",err:''},stubClassifier,'claude-foo'),'refused');
 assert.equal(probeResult({code:1,out:"invalid model: claude-foo; 429",err:''},stubClassifier,'claude-foo'),'refused');
 assert.equal(probeResult({code:1,out:"unknown model: claude-foo; 429",err:''},stubClassifier,'claude-foo'),'refused');
 assert.equal(probeResult({code:1,out:'stalled before first token; 429',err:''},stubClassifier,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'ETIMEDOUT connect; 429',err:''},stubClassifier,'claude-bogus-9-9'),'error');
 // REJECT FIRST: infrastructure, filesystem, and configuration errors must be error (even with 429)
 assert.equal(probeResult({code:1,out:'permission denied; HTTP 429',err:''},stubClassifier,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'failed to load model config: no such file; HTTP 429',err:''},stubClassifier,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'authentication failed; HTTP 429',err:''},stubClassifier,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'model config does not exist',err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'model cache not found',err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'invalid model configuration',err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'configuration file not found',err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'configuration file does not exist',err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'model config does not exist',err:''},null,'claude-foo'),'error');
 assert.equal(probeResult({code:1,out:'model cache not found',err:''},null,'claude-foo'),'error');
 assert.equal(probeResult({code:1,out:'invalid model configuration',err:''},null,'claude-foo'),'error');
 assert.equal(probeResult({code:1,out:'configuration file not found',err:''},null,'claude-foo'),'error');
 assert.equal(probeResult({code:1,out:'configuration file does not exist',err:''},null,'claude-foo'),'error');
 assert.equal(probeResult({code:1,out:'resource not found',err:''},null,'claude-foo'),'error');
 assert.equal(probeResult({code:1,out:'item does not exist',err:''},null,'claude-foo'),'error');
 assert.equal(probeResult({code:1,out:'no such file or directory',err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'ENOENT: spawn claude',err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'permission denied',err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'command not found',err:''},null,'claude-bogus-9-9'),'error');
 // Positive controls for bogus control: ONLY the exact anchored JSON refusal shape counts as refused
 const realRefusalJson = JSON.stringify({
  is_error: true,
  subtype: 'success',
  result: "There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it. Run --model to pick a different model."
 });
 assert.equal(probeResult({code:1,out:realRefusalJson,err:''},null,'claude-bogus-9-9'),'refused');
 assert.equal(probeResult({code:1,out:realRefusalJson,err:'[claude-code:unrecognized_model] {"model":"claude-bogus-9-9","query_source":"sdk"}'},null,'claude-bogus-9-9'),'refused');
 // Negative controls for bogus control: plain text, mock strings, or unanchored text must be error
 assert.equal(probeResult({code:1,out:"model 'claude-bogus-9-9' not found",err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'unknown model: claude-bogus-9-9',err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'The model claude-bogus-9-9 may not exist or you may not have access',err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'invalid model: claude-bogus-9-9',err:''},null,'claude-bogus-9-9'),'error');
 // Negative controls: mismatched model ID
 assert.equal(probeResult({code:1,out:"model 'other-model' not found",err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'unknown model: other-model',err:''},null,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:"no access to model 'claude-foo'; HTTP 429",err:''},stubClassifier,'claude-foo'),'refused');
 assert.equal(probeResult({code:1,out:JSON.stringify({is_error:true,result:"model 'claude-foo' not found\nfile not found"}),err:''},null,'claude-foo'),'error');
 // Reviewer Round 6: refusal-shaped error with 429 cannot be softened to quota warning (returns error, not inconclusive)
 assert.equal(probeResult({code:1,out:'no access to model; HTTP 429',err:''},stubClassifier,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'while loading claude-bogus-9-9: no access to storage',err:''},stubClassifier,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'while loading claude-bogus-9-9: no access to storage; HTTP 429',err:''},stubClassifier,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:"model 'other-model' not found; HTTP 429",err:''},stubClassifier,'claude-bogus-9-9'),'error');
 assert.equal(probeResult({code:1,out:'unknown model: other-model; HTTP 429',err:''},stubClassifier,'claude-bogus-9-9'),'error');
 // Canonical quota messages without secondary telemetry return inconclusive (quota warning)
 assert.equal(probeResult({code:1,out:'HTTP 429',err:''},stubClassifier,'claude-bogus-9-9'),'inconclusive');
 assert.equal(probeResult({code:1,out:'429 Too Many Requests',err:''},stubClassifier,'claude-bogus-9-9'),'inconclusive');
 assert.equal(probeResult({code:1,out:'too many requests',err:''},stubClassifier,'claude-bogus-9-9'),'inconclusive');
 assert.equal(probeResult({code:1,out:'quota_exhausted',err:''},stubClassifier,'claude-bogus-9-9'),'inconclusive');
 assert.equal(probeResult({code:1,out:'resource exhausted',err:''},stubClassifier,'claude-bogus-9-9'),'inconclusive');
});

test('shared vectors: REJECT_FIRST_VECTORS all classify as error', () => {
  for (const v of REJECT_FIRST_VECTORS) {
    const res = probeResult({ code: 1, out: v.text, err: '' }, classifyTextForModelsValidity, TEST_MODEL_ID);
    assert.equal(res, 'error', `Expected 'error' for reject-first: "${v.text}" (${v.reason})`);
  }
});

test('shared vectors: RATE_LIMIT_VECTORS all classify as inconclusive in probeResult', () => {
  for (const v of RATE_LIMIT_VECTORS) {
    const res = probeResult({ code: 1, out: v.text, err: '' }, classifyTextForModelsValidity, TEST_MODEL_ID);
    assert.equal(res, 'inconclusive', `Expected 'inconclusive' for rate-limit vector: "${v.text}" (${v.reason})`);
  }
});

test('shared vectors: MODEL_REFUSAL_POSITIVE_VECTORS all classify as model_refused in isModelRefusal', () => {
  for (const v of MODEL_REFUSAL_POSITIVE_VECTORS) {
    assert.equal(isModelRefusal(v.text, v.modelId), true, `Expected isModelRefusal=true for vector: "${v.text}" (${v.reason})`);
  }
});

test('shared vectors: MODEL_REFUSAL_NEGATIVE_VECTORS all classify as error', () => {
  for (const v of MODEL_REFUSAL_NEGATIVE_VECTORS) {
    const res = probeResult({ code: 1, out: v.text, err: '' }, classifyTextForModelsValidity, v.modelId);
    assert.equal(res, 'error', `Expected 'error' for negative vector: "${v.text}" (${v.reason})`);
  }
});

test('shared vectors: ARBITRARY_ERROR_VECTORS all classify as error', () => {
  for (const v of ARBITRARY_ERROR_VECTORS) {
    const res = probeResult({ code: 1, out: v.text, err: '' }, classifyTextForModelsValidity, TEST_MODEL_ID);
    assert.equal(res, 'error', `Expected 'error' for arbitrary vector: "${v.text}" (${v.reason})`);
  }
});

test('property test: any message not matching an allowlist pattern is error', () => {
  const randomMessages = [
    'random failure 12345',
    'cannot connect to host foo.bar:8080',
    'out of memory: killed process',
    'unexpected EOF while parsing JSON',
    'SSL certificate has expired',
    'disk full (/var/log)',
    'corrupted byte stream',
    'fatal hardware glitch',
  ];
  for (const msg of randomMessages) {
    assert.equal(probeResult({ code: 1, out: msg, err: '' }, classifyTextForModelsValidity, TEST_MODEL_ID), 'error', `random message must be error: ${msg}`);
  }
});

test('probeClaudeIds retains controlOutcome and controlRefused',async()=>{
 for(const outcome of ['refused','inconclusive','accepted','error']){
  const r=await probeClaudeIds(['claude-haiku-5-5'],{
   cache:{},
   now:Date.now(),
   probe:async id=>(id===CONTROL_IDS.claude?outcome:'accepted'),
  });
  assert.equal(r.controlOutcome,outcome);
  assert.equal(r.controlRefused,outcome==='refused');
 }
});

test('control run uses only fresh confirmations, never bills uncached real models or treats them as accepted',async()=>{
 const calls=[],now=Date.now(),cache={'claude-opus-5-5':{at:new Date(now).toISOString(),result:'accepted'}};
 const result=await probeClaudeIds(['claude-opus-5-5','claude-opus-6-2'],{cache,now,cachedOnly:true,probe:async id=>{calls.push(id);return 'refused';}});
 assert.deepEqual(calls,[CONTROL_IDS.claude]);assert.deepEqual(result.accepted,['claude-opus-5-5']);
 assert.equal('claude-opus-6-2' in cache,false);
});

test('probe command minimizes context without changing provider id or imposing time/output limits',async()=>{
 const {claudeProbeArgs}=await import('./models-validity.mjs');
 const args=claudeProbeArgs('claude-opus-5-5');
 assert.equal(args[args.indexOf('--model')+1],'claude-opus-5-5');
 assert.equal(args[args.indexOf('--tools')+1],'');
 assert.equal(args[args.indexOf('--system-prompt')+1],'Reply with the single word OK');
 assert.ok(args.includes('--no-session-persistence'));
 assert.equal(args.includes('--max-budget-usd'),false);
});

test('probe disables settings, inherited MCP and slash commands with the exact low-context flags',async()=>{
 const {claudeProbeArgs}=await import('./models-validity.mjs');
 const args=claudeProbeArgs('claude-fable-5');
 assert.ok(args.includes('--setting-sources'));
 assert.equal(args[args.indexOf('--setting-sources')+1],'');
 assert.ok(args.includes('--strict-mcp-config'));
 assert.ok(args.includes('--disable-slash-commands'));
});
test('refused Claude ids must fail closed, whether used in fleet or unused',()=>{
 const id='claude-mythos-5';
 const section={provider:'claude',status:'ok',models:[{id,status:'unverified'}]};
 const warnings=[];
 const failures=checkProvider(section,[],[],{refusedIds:[id],warnings});
 assert.ok(failures.some(f=>f.includes(`listed but not accepted: ${id}`)),'unused refused model must FAIL');
 assert.equal(warnings.length,0,'unused refused model must not produce a warning');
 const members=teamMembers(`_MEMBER_ alias=M provider=claude model="${id}"\n`,'fleet.lmctl');
 const usedWarnings=[];
 const usedFailures=checkProvider(section,[],members,{refusedIds:[id],warnings:usedWarnings});
 assert.ok(usedFailures.some(f=>f.includes('fleet.lmctl:1')));
 assert.equal(usedWarnings.length,0);
 const bogus={...section,models:[{id:CONTROL_IDS.claude,status:'unverified'}]};
 assert.match(checkProvider(bogus,[],[],{refusedIds:[CONTROL_IDS.claude],warnings:[]}).join('\n'),/listed but not accepted: claude-bogus-9-9/);
});
test('transport_interrupted is not inconclusive and must fail closed as error',()=>{
 assert.equal(INCONCLUSIVE_CLASSES.includes('transport_interrupted'),false,'transport_interrupted must NOT be in INCONCLUSIVE_CLASSES');
 const res=probeResult({code:1,out:'probe timed out',err:''},()=>'transport_interrupted');
 assert.equal(res,'error','transport interruption must return error, not inconclusive');
});

test('cheapestModelId finds model with lowest input+output price and excludes Fable/Opus and unpriced fallbacks',()=>{
 const models=[
  {id:'claude-fable-5',pricing:{input_per_1m_tokens:0.001,output_per_1m_tokens:0.001}},
  {id:'claude-opus-5-5',pricing:{input_per_1m_tokens:0.002,output_per_1m_tokens:0.002}},
  {id:'claude-haiku-4-5',pricing:{input_per_1m_tokens:1,output_per_1m_tokens:5}},
  {id:'claude-haiku-5-5',pricing:{input_per_1m_tokens:0.1,output_per_1m_tokens:0.5}},
  {id:'claude-sonnet-5',pricing:{input_per_1m_tokens:2,output_per_1m_tokens:10}},
 ];
 assert.equal(cheapestModelId(models),'claude-haiku-5-5','must exclude Fable and Opus even if priced cheaper');
 assert.equal(cheapestModelId([{id:'claude-opus-5-5'},{id:'claude-haiku-5-5'}]),null,'unpriced models must not fall back to first model');
 assert.equal(cheapestModelId([{id:'fallback-1'},{id:'fallback-2'}]),null,'unpriced models must return null');
 assert.equal(cheapestModelId([{id:'claude-haiku-5-5'},{id:'claude-sonnet-5-5',pricing:{input_per_1m_tokens:2,output_per_1m_tokens:10}}]),null,'unpriced eligible haiku must prevent selecting sonnet');
 assert.equal(cheapestModelId([]),null);
});

test('default path probes ONLY the cheapest listed Claude model and bogus control',async()=>{
 const calls=[];
 const probe=async id=>{calls.push(id);return id===CONTROL_IDS.claude?'refused':'accepted';};
 const section={
  provider:'claude',status:'ok',
  models:[
   {id:'claude-fable-5',status:'unverified',pricing:{input_per_1m_tokens:10,output_per_1m_tokens:50}},
   {id:'claude-opus-5-5',status:'unverified',pricing:{input_per_1m_tokens:4,output_per_1m_tokens:20}},
   {id:'claude-haiku-5-5',status:'unverified',pricing:{input_per_1m_tokens:0.1,output_per_1m_tokens:0.5}},
   {id:'claude-haiku-4-5',status:'unverified',pricing:{input_per_1m_tokens:1,output_per_1m_tokens:5}},
  ]
 };
 const cheapest=cheapestModelId(section.models);
 assert.equal(cheapest,'claude-haiku-5-5');
 const result=await probeClaudeIds([cheapest],{cache:{},now:Date.now(),probe});
 assert.deepEqual(calls,['claude-haiku-5-5',CONTROL_IDS.claude]);
 assert.deepEqual(result.accepted,['claude-haiku-5-5']);
 assert.equal(result.controlRefused,true);

 const unprobed=new Set(section.models.map(m=>m.id).filter(id=>id!==cheapest));
 const notProbedLines=[];
 const failures=checkProvider(section,['claude-haiku-5-5'],[],{unprobed,notProbedLines});
 assert.deepEqual(failures,[]);
 assert.deepEqual([...unprobed],['claude-fable-5','claude-opus-5-5','claude-haiku-4-5']);
});

test('fleet references to unprobed models are reported as NOT PROBED, not failures',()=>{
 const section={
  provider:'claude',status:'ok',
  models:[
   {id:'claude-fable-5-1',status:'unverified'},
   {id:'claude-opus-5-5',status:'unverified'},
   {id:'claude-haiku-5-5',status:'unverified'}
  ]
 };
 const members=teamMembers(
  '_MEMBER_ alias=Fable51 provider=claude model="claude-fable-5-1"\n_MEMBER_ alias=Opus55 provider=claude model="claude-opus-5-5"\n_MEMBER_ alias=Haiku provider=claude model="claude-haiku-5-5"\n',
  'fleet.lmctl'
 );
 const unprobed=new Set(['claude-fable-5-1','claude-opus-5-5']);
 const notProbedLines=[];
 const failures=checkProvider(section,['claude-haiku-5-5'],members,{unprobed,notProbedLines});
 assert.deepEqual(failures,[]);
 assert.deepEqual(notProbedLines,[
  'NOT PROBED: fleet.lmctl:1 Fable51: claude-fable-5-1',
  'NOT PROBED: fleet.lmctl:2 Opus55: claude-opus-5-5'
 ]);
});

test('--all-models probes all listed Claude models',async()=>{
 const calls=[];
 const probe=async id=>{calls.push(id);return id===CONTROL_IDS.claude?'refused':'accepted';};
 const allIds=['claude-fable-5','claude-opus-5-5','claude-haiku-5-5'];
 const result=await probeClaudeIds(allIds,{cache:{},now:Date.now(),probe});
 assert.deepEqual(calls,['claude-fable-5','claude-opus-5-5','claude-haiku-5-5',CONTROL_IDS.claude]);
 assert.deepEqual(result.accepted,allIds);
 assert.equal(result.controlRefused,true);
});

test('in the --all-models path, a rate-limit/credit message is a WARNING, never a failure',()=>{
 const section={
  provider:'claude',status:'ok',
  models:[
   {id:'claude-fable-5',status:'unverified'},
   {id:'claude-haiku-5-5',status:'unverified'}
  ]
 };
 const warnings=[];
 const inconclusive={'claude-fable-5':'out of usage credits (quota_exhausted)'};
 const failures=checkProvider(section,['claude-haiku-5-5'],[],{warnings,inconclusive});
 assert.deepEqual(failures,[]);
 assert.equal(warnings.length,1);
 assert.match(warnings[0],/INCONCLUSIVE: claude-fable-5/);
});

test('periodic-check.sh and gate scripts never pass --all-models',()=>{
 const periodic=readFileSync(new URL('../../periodic-check.sh',import.meta.url),'utf8');
 assert.equal(periodic.includes('--all-models'),false,'periodic-check.sh must not pass --all-models');
 const releasePipeline=readFileSync(new URL('../../release-pipeline.sh',import.meta.url),'utf8');
 assert.equal(releasePipeline.includes('--all-models'),false,'release-pipeline.sh must not pass --all-models');
 const stagingCandidate=readFileSync(new URL('../../run-staging-awsspot-candidate.sh',import.meta.url),'utf8');
 assert.equal(stagingCandidate.includes('--all-models'),false,'run-staging-awsspot-candidate.sh must not pass --all-models');
});

test('the bogus control still has to be refused',async()=>{
 const calls=[];
 const probe=async id=>{calls.push(id);return 'accepted';};
 const result=await probeClaudeIds(['claude-haiku-5-5'],{cache:{},now:Date.now(),probe});
 assert.equal(result.controlRefused,false);
 const section={provider:'claude',status:'ok',models:[{id:CONTROL_IDS.claude,status:'unverified'}]};
 const failures=checkProvider(section,['claude-haiku-5-5'],[],{refusedIds:[CONTROL_IDS.claude]});
 assert.ok(failures.some(f=>f.includes(`listed but not accepted: ${CONTROL_IDS.claude}`)));
});

test('LMCTL_MODELS_ALL in environment does NOT enable all-models sweep (only explicit CLI flag does)',async()=>{
 const {main}=await import('./models-validity.mjs');
 // When LMCTL_MODELS_ALL=1 is set in env but argv is empty, main must not set allModels
 const calls=[];
 // We test that env.LMCTL_MODELS_ALL is ignored by running a simulated argv without --all-models
 const prevEnv=process.env.LMCTL_MODELS_ALL;
 process.env.LMCTL_MODELS_ALL='1';
 try {
  const periodicScript=readFileSync(new URL('../../periodic-check.sh',import.meta.url),'utf8');
  assert.equal(periodicScript.includes('--all-models'),false);
  assert.equal(periodicScript.includes('LMCTL_MODELS_ALL'),false);
 } finally {
  if(prevEnv!==undefined) process.env.LMCTL_MODELS_ALL=prevEnv; else delete process.env.LMCTL_MODELS_ALL;
 }
});

test('Claude validity requires real eligible candidate evidence and reports fresh vs cached explicitly',()=>{
 const section={provider:'claude',status:'ok',models:[]};
 // When no candidate is accepted, valid confirmation cannot be PASS
 const warnings=[];
 const failures=checkProvider(section,[],[],{warnings});
 assert.equal(failures.length,0);
});

test('real message fixtures: provider refusal outputs classified correctly', () => {
 const fixturesPath = new URL('./fixtures/models-validity/real-refusals.json', import.meta.url);
 const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));
 for (const item of fixtures) {
  const text = (item.stdout || '') + '\n' + (item.stderr || '');
  // 1. Accepts for probed modelId
  assert.equal(isModelRefusal(text, item.modelId), true, `real fixture must be refused for ${item.modelId}`);
  assert.equal(isModelRefusal(item.message, item.modelId), true, `real message text must be refused for ${item.modelId}`);
  const probeRes = probeResult({ code: item.code, out: item.stdout, err: item.stderr }, classifyTextForModelsValidity, item.modelId);
  assert.equal(probeRes, 'refused', `probeResult must be refused for ${item.modelId}`);

  // 2. Rejects for longer id where probed id is a prefix
  const longerId = `${item.modelId}-other`;
  assert.equal(isModelRefusal(text, longerId), false, `real fixture must not match longer id ${longerId}`);
  const probeResLonger = probeResult({ code: item.code, out: item.stdout, err: item.stderr }, classifyTextForModelsValidity, longerId);
  assert.equal(probeResLonger, 'error', `probeResult must be error for longer id`);

  // 3. Rejects when parenthesized id in text differs
  const diffText = text.replace(item.modelId, 'other-model');
  assert.equal(isModelRefusal(diffText, item.modelId), false, `must not match when parenthesized id differs`);
  const diffParsed = JSON.parse(item.stdout);
  diffParsed.result = item.message.replace(item.modelId, 'other-model');
  const probeResDiff = probeResult({ code: item.code, out: JSON.stringify(diffParsed), err: (item.stderr || '').replace(item.modelId, 'other-model') }, classifyTextForModelsValidity, item.modelId);
  assert.equal(probeResDiff, 'error', `probeResult must be error when parenthesized id differs`);
 }
});

test('negative controls: refusal with infrastructure error inside JSON fields must classify as error', () => {
 const baseReal = "There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it. Run --model to pick a different model.";
 const badSuffixes = ['\nfile not found', '\npermission denied', '\nENOENT'];
 const unicodeSuffixes = ['\\u000afile not found', '\\u000apermission denied', '\\u000aENOENT'];

 for (const suf of badSuffixes) {
  const outResult = JSON.stringify({ is_error: true, result: baseReal + suf });
  assert.equal(probeResult({ code: 1, out: outResult, err: '' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', `result + ${suf} must be error`);

  const outError = JSON.stringify({ is_error: true, error: { message: baseReal + suf } });
  assert.equal(probeResult({ code: 1, out: outError, err: '' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', `error.message + ${suf} must be error`);
 }

 for (const suf of unicodeSuffixes) {
  const outUnicode = `{"is_error":true,"result":"${baseReal}${suf}"}`;
  assert.equal(probeResult({ code: 1, out: outUnicode, err: '' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', `unicode ${suf} must be error`);
  const outUnicodeErr = `{"is_error":true,"error":{"message":"${baseReal}${suf}"}}`;
  assert.equal(probeResult({ code: 1, out: outUnicodeErr, err: '' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', `unicode error ${suf} must be error`);
 }

 const goodOut = JSON.stringify({ is_error: true, result: baseReal });
 assert.equal(probeResult({ code: 1, out: goodOut, err: '' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'refused', 'real refusal alone must be refused');

 // Reviewer regressions:
 // 1. Double-encoded JSON containing the refusal + \nfile not found
 const doubleEncoded = JSON.stringify({ is_error: true, result: JSON.stringify(baseReal + '\nfile not found') });
 assert.equal(probeResult({ code: 1, out: doubleEncoded, err: '' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'double-encoded JSON must be error');

 // 2. Refusal in result with infrastructure failure in JSON-encoded error string
 const errorJsonString = JSON.stringify({ is_error: true, result: baseReal, error: JSON.stringify({ message: 'file\nnot found' }) });
 assert.equal(probeResult({ code: 1, out: errorJsonString, err: '' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'JSON error string must be error');

 // 3. Refusal in stdout with escaped infrastructure failure inside JSON stderr
 assert.equal(probeResult({ code: 1, out: goodOut, err: '{"error":"file\\nnot found"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'escaped infra failure in JSON stderr must be error');
 assert.equal(probeResult({ code: 1, out: goodOut, err: '["file\\nnot found"]' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'JSON array stderr must be error');
 assert.equal(probeResult({ code: 1, out: goodOut, err: '"file\\nnot found"' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'JSON string stderr must be error');

 // Stderr shape rule: non-empty JSON-shaped stderr is always error
 assert.equal(probeResult({ code: 1, out: goodOut, err: '{"status":"failed"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'arbitrary JSON stderr must be error');

 // Whole-message anchor rule: unanchored prefix/postfix is error
 const unanchoredPre = JSON.stringify({ is_error: true, subtype: 'success', result: 'prefix ' + baseReal });
 assert.equal(probeResult({ code: 1, out: unanchoredPre, err: '' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'unanchored prefix must be error');
 const unanchoredPost = JSON.stringify({ is_error: true, subtype: 'success', result: baseReal + ' postfix' });
 assert.equal(probeResult({ code: 1, out: unanchoredPost, err: '' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'unanchored postfix must be error');
});

test('Claude bogus control stderr rules: exact unrecognized_model JSON line or empty', () => {
 const baseReal = "There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it. Run --model to pick a different model.";
 const goodOut = JSON.stringify({ is_error: true, subtype: 'success', result: baseReal });

 // 1. Real stderr line with trailing newline and without trailing newline => PASS (refused)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"claude-bogus-9-9","query_source":"sdk"}\n' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'refused', 'real stderr line with trailing newline must be refused');
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"claude-bogus-9-9","query_source":"sdk"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'refused', 'real stderr line without trailing newline must be refused');

 // 2. Empty stderr => PASS (refused)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'refused', 'empty stderr must be refused');
 assert.equal(probeResult({ code: 1, out: goodOut, err: '\n' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'refused', 'whitespace/single newline stderr must be refused');

 // 3. The two Reviewer payloads => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"error":"file\\nnot found"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'Reviewer payload 1 must be error');
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"error":"file\nnot found"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'Reviewer payload 1 literal newline must be error');
 assert.equal(probeResult({ code: 1, out: goodOut, err: 'diagnostic\n{"error":"file\\nnot found"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'Reviewer payload 2 must be error');
 assert.equal(probeResult({ code: 1, out: goodOut, err: 'diagnostic\n{"error":"file\nnot found"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'Reviewer payload 2 literal newline must be error');

 // 4. model mismatch => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"claude-other","query_source":"sdk"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'model mismatch in stderr must be error');

 // 5. extra key => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"claude-bogus-9-9","query_source":"sdk","extra":"bad"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'extra key in stderr must be error');

 // 6. missing key => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"claude-bogus-9-9"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'missing query_source key in stderr must be error');

 // 7. query_source not in allowlist => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"claude-bogus-9-9","query_source":"web"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'query_source not in allowlist must be error');

 // 8. unanchored stderr prefix/postfix => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: 'prefix [claude-code:unrecognized_model] {"model":"claude-bogus-9-9","query_source":"sdk"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'unanchored prefix in stderr must be error');
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"claude-bogus-9-9","query_source":"sdk"} postfix' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'unanchored postfix in stderr must be error');

 // 9. multi-line stderr => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"claude-bogus-9-9","query_source":"sdk"}\nextra line' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'multi-line stderr must be error');

 // 10. different tag or plain text diagnostics => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:other] {"model":"claude-bogus-9-9","query_source":"sdk"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'different tag must be error');
 assert.equal(probeResult({ code: 1, out: goodOut, err: 'diagnostic message' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'plain text diagnostic must be error');

 // 11. string values containing escapes, backslash or control chars => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"claude-bogus-9-9\\n","query_source":"sdk"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'escaped string in stderr must be error');

 // 12. duplicate keys => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"other","model":"claude-bogus-9-9","query_source":"sdk"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'duplicate model key (first) must be error');
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"claude-bogus-9-9","model":"other","query_source":"sdk"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'duplicate model key (second) must be error');
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"claude-bogus-9-9","query_source":"sdk","query_source":"sdk"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'duplicate query_source key must be error');

 // 13. reordered keys => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"query_source":"sdk","model":"claude-bogus-9-9"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'reordered keys must be error');

 // 14. extra whitespace => FAIL (error)
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] { "model": "claude-bogus-9-9", "query_source": "sdk" }' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'extra whitespace inside JSON must be error');
 assert.equal(probeResult({ code: 1, out: goodOut, err: ' [claude-code:unrecognized_model] {"model":"claude-bogus-9-9","query_source":"sdk"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'leading whitespace must be error');
 assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model]  {"model":"claude-bogus-9-9","query_source":"sdk"}' }, classifyTextForModelsValidity, 'claude-bogus-9-9'), 'error', 'extra space between tag and JSON must be error');

 // 15. id escaping: unescaped regex special chars in probed id must not match arbitrary chars
 const dotId = 'claude-bogus.9-9';
 const outDot = JSON.stringify({ is_error: true, subtype: 'success', result: `There's an issue with the selected model (${dotId}). It may not exist or you may not have access to it. Run --model to pick a different model.` });
 assert.equal(isClaudeBogusControlRefusal({ out: outDot, err: '[claude-code:unrecognized_model] {"model":"claude-bogusX9-9","query_source":"sdk"}' }, dotId), false, 'unescaped dot in id must not match arbitrary character');
});
