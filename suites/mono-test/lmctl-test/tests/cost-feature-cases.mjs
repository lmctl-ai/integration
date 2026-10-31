// Offline black-box checks for stored usage and the native-reader pricing fixes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root=mkdtempSync(join(tmpdir(),'lmctl-cost-cases-'));
const bin=process.env.LMCTL_BIN||'lmctl';
const env={...process.env,HOME:join(root,'home'),LMCTL_HOME:join(root,'home','.lmctl'),LMCTL_DB:join(root,'state.db'),LMCTL_NO_UPDATE_NOTIFIER:'1',LMCTL_PRICE_DATA:join(root,'base-prices'),TZ:'UTC',LC_ALL:'C',CODEX_HOME:join(root,'home','.codex'),CLAUDE_CONFIG_DIR:join(root,'home','.claude'),XDG_CACHE_HOME:join(root,'home','.cache'),XDG_CONFIG_HOME:join(root,'home','.config'),XDG_DATA_HOME:join(root,'home','.local','share')};
for(const key of ['LMCTL_SELF_SESSIONID','LMCTL_INVOCATION_ID','LMBEE_TEAM_NAME','LMCTL_SELF_TEAMFILE','LMCTL_SELF_ALIAS','CLAUDECODE'])delete env[key];
const ok=[];
function check(name,fn){fn();ok.push(name);console.log(`PASS ${name}`);}
function assertUsageContract(payload){
  assert.equal(payload.schema_version,1);assert.equal(payload.total.turns,2);
  assert.equal(payload.total.input,100);assert.equal(payload.total.cacheRead,20);assert.equal(payload.total.cacheWrite,30);assert.equal(payload.total.output,40);
  assert.equal(payload.total.costUsd,.000649);
  assert.deepEqual(payload.groups.map(g=>g.key),['(unknown)','claude-haiku-4-5']);
  assert.equal(payload.groups[0].costUsd,null);assert.equal(payload.groups[1].costUsd,.000649);assert.equal(payload.total.unknownUsageCount,1);assert.equal(payload.total.unknownCostCount,1);
  assert.equal(payload.reasons.usage.native_record_missing,1);assert.equal(payload.reasons.cost.usage_unavailable,1);
}
function assertSeedPromptUsage(payload,by,sessionId){
  assert.equal(payload.schema_version,1);assert.equal(payload.by,by);
  assert.deepEqual(payload.total,{key:'total',turns:2,input:null,cacheRead:null,cacheWrite:null,output:null,costUsd:null,cacheHitPercent:null,unknownUsageCount:2,unknownCostCount:2});
  assert.equal(payload.groups.length,1);const group=payload.groups[0];
  assert.equal(group.key,by==='session'?sessionId:'mock-default');
  assert.equal(group.turns,2);assert.equal(group.unknownUsageCount,2);assert.equal(group.unknownCostCount,2);
  assert.deepEqual(payload.reasons,{usage:{mock_estimate:2},cost:{usage_unavailable:2}});
}
function run(args,extra={}){const r=spawnSync(bin,args,{env:{...env,...extra},encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});if(r.error)throw r.error;return{code:r.status,out:r.stdout||'',err:r.stderr||''};}
function fixtureDb(){
  // Bootstrap through the shipped migration/recorder schema, not a copied price formula.
  const team=join(root,'bootstrap.lmctl');
  writeFileSync(join(env.LMCTL_HOME,'init.toml'),[1,2,3].map(i=>`[Provider${i}]\nprovider = "ClaudeMock"\nmodel1 = "mock-default"\nmodel2 = "mock-default"\nmodel3 = "mock-default"\n`).join('\n'));
  writeFileSync(team,'_TEAM_ name=bootstrap\n_MEMBER_ alias=Lead provider=ClaudeMock model=mock-default\n');
  const seeded=run(['seed',team],{LMCTL_ENABLE_MOCK_PROVIDER:'1',LMCTL_CLAUDE_MOCK_STORE:join(root,'bootstrap-mock.json')});
  assert.equal(seeded.code,0,seeded.out+seeded.err);
  const db=new DatabaseSync(env.LMCTL_DB);
  const insert=db.prepare(`INSERT INTO team_chat_log(root_teamfile,receiver_teamfile,receiver_alias,message,origin,status,created_at,attempt_key,provider,native_session_id,cwd,model_reported,tok_input_uncached,tok_cache_read,tok_cache_write,tok_output,usage_source,usage_reason,rate_input_1m,rate_output_1m,rate_cache_read_1m,rate_cache_write_1m,cost_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('/teams/a.lmctl','/teams/a.lmctl','Lead','not a prompt','operator','ok','2026-10-04T12:00:00.000Z','turn-known','claude','aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','/work','claude-haiku-4-5',100,20,30,40,'wire',null,2,10,.2,1.5,null);
  insert.run('/teams/a.lmctl','/teams/a.lmctl','Lead','not a prompt','operator','ok','2026-10-05T12:00:00.000Z','turn-unknown','claude','sid-unknown','/work',null,null,null,null,null,null,'native_record_missing',null,null,null,null,'usage_unavailable');
  db.close();
}
function nativeClaudeFixture(){
  const sid='11111111-2222-3333-4444-555555555555';
  const project=join(env.HOME,'.claude','projects','fixture');mkdirSync(project,{recursive:true});
  const batches=[
    {id:'msg-1',input:10,write5m:1000,write1h:0,read:2000,output:80},
    {id:'msg-2',input:8,write5m:3000,write1h:0,read:10000,output:80},
    {id:'msg-3',input:10,write5m:1795,write1h:4000,read:46896,output:108},
  ];
  const rows=[];
  for(const item of batches){
    const usage={input_tokens:item.input,cache_creation_input_tokens:item.write5m+item.write1h,cache_read_input_tokens:item.read,output_tokens:item.output,cache_creation:{ephemeral_5m_input_tokens:item.write5m,ephemeral_1h_input_tokens:item.write1h}};
    const base={type:'assistant',cwd:'/fixture/work',timestamp:'2026-10-04T00:00:00Z',message:{id:item.id,model:'claude-sonnet-5',usage,content:[{type:'text',text:'x'}]}};
    rows.push(base,{...base,message:{...base.message,content:[{type:'thinking',thinking:'x'},{type:'tool_use',name:'tool'}]}});
  }
  writeFileSync(join(project,sid+'.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const prices=join(root,'prices');mkdirSync(prices);
  writeFileSync(join(prices,'model_list.json'),JSON.stringify({schema_version:1,generated_at:'2026-10-05T00:00:00Z',records:[{record_id:'fixture:claude-sonnet-5',source:'litellm',source_model_id:'claude-sonnet-5',provider:'anthropic',mode:'chat',pricing:{input_per_1m_tokens:2,output_per_1m_tokens:10,input_cache_read_per_1m_tokens:.2,input_cache_write_per_1m_tokens:2.5,source_cost_fields:{cache_creation_input_token_cost_above_1hr:.000002}}}]}));
  writeFileSync(join(prices,'aliases.json'),JSON.stringify({schema_version:1,standards:[],aliases:[]}));
  const result=run(['cost',sid,'--provider','claude','--json'],{LMCTL_PRICE_DATA:prices});
  return {result,sid};
}
function inclusiveReaderFixtures(){
  const sid='22222222-3333-4444-5555-666666666666';
  const project=join(env.HOME,'.gemini','tmp','fixture','chats');mkdirSync(project,{recursive:true});
  writeFileSync(join(project,`session-2026-10-04T00-00-${sid}.json`),JSON.stringify({sessionId:sid,messages:[{type:'gemini',model:'gemini-probe',content:'x',tokens:{input:100,cached:80,output:5,thoughts:3}}]}));
  const qwen=join(env.HOME,'.qwen','projects','fixture','chats');mkdirSync(qwen,{recursive:true});
  writeFileSync(join(qwen,`${sid}.jsonl`),JSON.stringify({type:'assistant',model:'qwen-probe',cwd:'/fixture/work',message:{role:'assistant',model:'qwen-probe',content:'x'},usageMetadata:{promptTokenCount:100,cachedContentTokenCount:80,candidatesTokenCount:5,thoughtsTokenCount:3,totalTokenCount:105}})+'\n');
  const codex=join(env.HOME,'.codex','sessions','2026','10','04');mkdirSync(codex,{recursive:true});
  const usage=(timestamp,ordinal,input,cached,output)=>({timestamp,ordinal,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output},last_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output}}}});
  writeFileSync(join(codex,`rollout-2026-10-04T00-00-00-${sid}.jsonl`),[
    {type:'session_meta',payload:{id:sid,cwd:'/fixture/work'}},{type:'turn_context',payload:{model:'codex-probe'}},
    usage('2026-10-04T00:00:01Z',1,100,80,5),usage('2026-10-04T00:00:02Z',2,20,10,2),
  ].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const prices=join(root,'inclusive-prices');mkdirSync(prices);
  const providers=[['gemini','gemini-probe','gemini/gemini-probe'],['qwen','qwen-probe','qwen/qwen-probe'],['codex','codex-probe','codex/codex-probe']];
  const records=providers.map(([provider,model],i)=>({record_id:`inclusive-${i}`,source:'litellm',source_model_id:model,provider,mode:'chat',pricing:{input_per_1m_tokens:1,output_per_1m_tokens:5,input_cache_read_per_1m_tokens:.1}}));
  const standards=records.map(r=>({standard_slug:r.record_id,catalog_record_id:r.record_id}));
  const aliases=providers.map(([provider,model,alias],i)=>({alias,standard_slug:records[i].record_id,evidence:'established'}));
  writeFileSync(join(prices,'model_list.json'),JSON.stringify({schema_version:1,generated_at:'2026-10-05T00:00:00Z',records}));
  writeFileSync(join(prices,'aliases.json'),JSON.stringify({schema_version:1,standards,aliases}));
  return providers.map(([provider,model])=>({provider,model,result:run(['cost',sid,'--provider',provider,'--json'],{LMCTL_PRICE_DATA:prices})}));
}
try {
  mkdirSync(env.LMCTL_HOME,{recursive:true});
  const basePrices=env.LMCTL_PRICE_DATA;mkdirSync(basePrices);
  writeFileSync(join(basePrices,'model_list.json'),JSON.stringify({schema_version:1,generated_at:'2026-10-05T00:00:00Z',records:[{record_id:'fixture:claude-haiku-4-5',source:'litellm',source_model_id:'claude-haiku-4-5',provider:'anthropic',mode:'chat',pricing:{input_per_1m_tokens:2,output_per_1m_tokens:10,input_cache_read_per_1m_tokens:.2,input_cache_write_per_1m_tokens:1.5}}]}));
  writeFileSync(join(basePrices,'aliases.json'),JSON.stringify({schema_version:1,standards:[],aliases:[]}));
  fixtureDb();
  check('usage JSON groups stored known and unknown turns with explicit reasons',()=>{
    const r=run(['usage','--since','2026-10-04','--until','2026-10-06','--by','model','--json']);
    assert.equal(r.code,0,r.err);const p=JSON.parse(r.out);
    assertUsageContract(p);
    const broken=structuredClone(p);broken.total.cacheWrite++;
    assert.throws(()=>assertUsageContract(broken),'mutated bucket total must fail the same contract assertion');
  });
  check('text usage includes UTC period, buckets and unknown reasons',()=>{
    const r=run(['usage','--since','2026-10-04','--until','2026-10-06','--by','day']);
    assert.equal(r.code,0,r.err);assert.match(r.out,/Period \(UTC\): 2026-10-04T00:00:00\.000Z/);assert.match(r.out,/cache-read/);assert.match(r.out,/native_record_missing=1/);assert.match(r.out,/usage_unavailable=1/);
  });
  check('ClaudeMock seed and prompt each record one usage row with unknown reasons',()=>{
    const mockRoot=join(root,'mock-turn');const home=join(mockRoot,'home');const lmhome=join(home,'.lmctl');const db=join(mockRoot,'state.db');const team=join(mockRoot,'team.lmctl');const store=join(mockRoot,'claudemock.json');
    mkdirSync(lmhome,{recursive:true});writeFileSync(join(lmhome,'init.toml'),[1,2,3].map(i=>`[Provider${i}]\nprovider = "ClaudeMock"\nmodel1 = "mock-default"\nmodel2 = "mock-default"\nmodel3 = "mock-default"\n`).join('\n'));
    writeFileSync(team,'_TEAM_ name=usage-recording\n_MEMBER_ alias=Lead provider=ClaudeMock model=mock-default\n');
    const mockEnv={HOME:home,LMCTL_HOME:lmhome,LMCTL_DB:db,LMCTL_ENABLE_MOCK_PROVIDER:'1',LMCTL_CLAUDE_MOCK_STORE:store};
    const seeded=run(['seed',team],mockEnv);assert.equal(seeded.code,0,seeded.out+seeded.err);
    const prompt=run(['prompt',team,'Lead','usage recording smoke prompt'],mockEnv);assert.equal(prompt.code,0,prompt.out+prompt.err);
    const inspect=new DatabaseSync(db);
    const rows=inspect.prepare('SELECT origin,status,message,provider,native_session_id,model_reported,usage_source,usage_reason,cost_reason FROM team_chat_log ORDER BY created_at,rowid').all();
    inspect.close();
    assert.equal(rows.length,2);
    assert.deepEqual(rows.map(row=>({origin:row.origin,status:row.status,message:row.message,provider:row.provider,model:row.model_reported,usageSource:row.usage_source,usageReason:row.usage_reason,costReason:row.cost_reason})),[
      {origin:'operator',status:'ok',message:'',provider:'ClaudeMock',model:null,usageSource:null,usageReason:'mock_estimate',costReason:'usage_unavailable'},
      {origin:'operator',status:'ok',message:'--- new prompt (from operator) ---\nusage recording smoke prompt',provider:'ClaudeMock',model:null,usageSource:null,usageReason:'mock_estimate',costReason:'usage_unavailable'},
    ]);
    const sessionId=rows[0].native_session_id;assert.ok(sessionId.startsWith('mock-mock-turn-'));assert.equal(rows[1].native_session_id,sessionId);
    for(const by of ['session','model']){
      const report=run(['usage','--since','2000-01-01','--until','2100-01-01','--by',by,'--json'],mockEnv);assert.equal(report.code,0,report.err);
      const payload=JSON.parse(report.out);assertSeedPromptUsage(payload,by,sessionId);
      const broken=structuredClone(payload);broken.total.turns=3;
      assert.throws(()=>assertSeedPromptUsage(broken,by,sessionId),`${by} row-count mutation must fail the seed-plus-prompt contract`);
    }
  });
  check('cost and usage agree on the same seeded Claude session and exact stored bill',()=>{
    const sid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const project=join(env.HOME,'.claude','projects','agreement');mkdirSync(project,{recursive:true});
    writeFileSync(join(project,sid+'.jsonl'),JSON.stringify({type:'assistant',cwd:'/work',timestamp:'2026-10-04T12:00:00Z',message:{id:'agreement-1',model:'claude-haiku-4-5',content:[{type:'text',text:'x'}],usage:{input_tokens:100,cache_read_input_tokens:20,cache_creation_input_tokens:30,output_tokens:40,cache_creation:{ephemeral_5m_input_tokens:30,ephemeral_1h_input_tokens:0}}}})+'\n');
    const cost=run(['cost',sid,'--provider','claude','--json']);assert.equal(cost.code,0,cost.err);
    const p=JSON.parse(cost.out);assert.deepEqual(p.tokens,{input:150,output:40,cachedInput:20});assert.equal(p.costUsd,.000649);assert.equal(p.priceDataSource,'pinned');
    const usage=run(['usage','--since','2026-10-04','--until','2026-10-06','--by','session','--json']);assert.equal(usage.code,0,usage.err);
    const row=JSON.parse(usage.out).groups.find(g=>g.key===sid);assert.ok(row);assert.equal(row.turns,1);assert.equal(row.costUsd,p.costUsd);
    const boundary=run(['usage','--since','2026-10-04','--until','2026-10-05','--json']);assert.equal(boundary.code,0,boundary.err);assert.equal(JSON.parse(boundary.out).total.turns,1);
  });
  // Failing controls: remove the unknown-reason row, or corrupt the expected bucket.
  check('fixture mutation controls detect missing unknown rows and wrong arithmetic',()=>{
    const control=run(['usage','--since','2026-10-04','--until','2026-10-06','--by','model','--json']);
    const payload=JSON.parse(control.out);
    const broken=structuredClone(payload);broken.total.unknownUsageCount=0;
    assert.throws(()=>assertUsageContract(broken),'control catches a dropped unknown usage row');
    const badArithmetic=structuredClone(payload);badArithmetic.total.input=101;
    assert.throws(()=>assertUsageContract(badArithmetic),'control catches wrong input arithmetic');
  });
  check('Claude content-block duplicates count once and cache-write tiers price once',()=>{
    const {result}=nativeClaudeFixture();assert.equal(result.code,0,result.err);const p=JSON.parse(result.out);
    assert.deepEqual(p.tokens,{input:68719,output:268,cachedInput:58896});
    // (28*2 + 58,896*.2 + 5,795*2.5 + 4,000*2 + 268*10) / 1,000,000.
    assert.equal(p.costUsd,.0370027);assert.equal(p.priceDataSource,'pinned');
    const broken={...p,tokens:{...p.tokens,input:p.tokens.input+68719}};
    assert.throws(()=>assert.equal(broken.tokens.input,68719),'duplicate block control must fail the token-total assertion');
  });
  check('Codex restarted totals and Gemini/Qwen inclusive cache counters price cached tokens once',()=>{
    const fixtures=inclusiveReaderFixtures();assert.equal(fixtures.length,3);
    for(const fixture of fixtures){
      assert.equal(fixture.result.code,0,`${fixture.provider}: ${fixture.result.err}`);
      const p=JSON.parse(fixture.result.out);assert.equal(p.tokens.input,fixture.provider==='codex'?120:100,fixture.provider);
      assert.equal(p.tokens.cachedInput,fixture.provider==='codex'?90:80,fixture.provider);
      assert.equal(p.costUsd,fixture.provider==='codex' ? .000074 : fixture.provider==='gemini' ? .000068 : .000053,fixture.provider);
      assert.equal(p.priceDataSource,'pinned');
      const broken={...p,costUsd:p.costUsd+((p.tokens.cachedInput*1)/1_000_000)};
      assert.throws(()=>assert.equal(broken.costUsd,p.costUsd),`${fixture.provider} inclusive-cache mutation must fail`);
    }
  });
  check('recorded Codex reset excerpt suppresses mirrored events and prices request totals',()=>{
    const sid='33333333-4444-5555-6666-777777777777';
    const dir=join(env.HOME,'.codex','sessions','2026','10','04');mkdirSync(dir,{recursive:true});
    const recorded=readFileSync(new URL('./fixtures/codex-reset-excerpt.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(recorded.length,4);
    const rows=[{type:'session_meta',payload:{id:sid,cwd:'/fixture/work'}},{type:'turn_context',payload:{model:'gpt-5.6-luna'}},...recorded.flatMap(r=>[r,r])];
    writeFileSync(join(dir,`rollout-2026-10-04T00-00-00-${sid}.jsonl`),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
    const prices=join(root,'reset-prices');mkdirSync(prices);
    writeFileSync(join(prices,'model_list.json'),JSON.stringify({schema_version:1,generated_at:'2026-10-05T00:00:00Z',records:[{record_id:'fixture-reset',source:'litellm',source_model_id:'gpt-5.6-luna',provider:'openai',mode:'chat',pricing:{input_per_1m_tokens:.2,output_per_1m_tokens:1.2,input_cache_read_per_1m_tokens:.02}}]}));
    writeFileSync(join(prices,'aliases.json'),JSON.stringify({schema_version:1,standards:[],aliases:[]}));
    const r=run(['cost',sid,'--provider','codex','--json'],{LMCTL_PRICE_DATA:prices});assert.equal(r.code,0,r.err);
    const p=JSON.parse(r.out);assert.deepEqual(p.tokens,{input:529725,output:1804,cachedInput:521088});assert.equal(p.costUsd,.01431396);assert.equal(p.priceDataSource,'pinned');
  });
  check('positive cache reads without a read rate remain unknown in cost and usage',()=>{
    const sid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const prices=join(root,'missing-read-prices');mkdirSync(prices);
    const catalog=JSON.parse(readFileSync(join(env.LMCTL_PRICE_DATA,'model_list.json'),'utf8'));
    catalog.records[0].pricing.input_cache_read_per_1m_tokens=null;
    writeFileSync(join(prices,'model_list.json'),JSON.stringify(catalog));writeFileSync(join(prices,'aliases.json'),JSON.stringify({schema_version:1,standards:[],aliases:[]}));
    const cost=run(['cost',sid,'--provider','claude','--json'],{LMCTL_PRICE_DATA:prices});assert.equal(cost.code,0,cost.err);
    const p=JSON.parse(cost.out);assert.equal(p.costUsd,null);assert.match(p.costUnavailableReason,/cache-read price rate/);assert.equal(p.priceDataSource,'pinned');
    const db=new DatabaseSync(env.LMCTL_DB);try{db.prepare("UPDATE team_chat_log SET rate_cache_read_1m=NULL,cost_reason='rate_missing' WHERE attempt_key='turn-known'").run();}finally{db.close();}
    const report=run(['usage','--since','2026-10-04','--until','2026-10-05','--json']);assert.equal(report.code,0,report.err);
    const u=JSON.parse(report.out);assert.equal(u.total.costUsd,null);assert.equal(u.total.unknownCostCount,1);assert.equal(u.reasons.cost.rate_missing,1);assert.equal(u.total.cacheRead,20);
  });
  check('real Codex wire recorder marks positive cached usage rate_missing',()=>{
    const work=join(root,'wire-missing-rate');const home=join(work,'home');const state=join(home,'.lmctl');const tools=join(work,'bin');mkdirSync(state,{recursive:true});mkdirSync(tools);
    const fake=join(tools,'codex');copyFileSync(new URL('./fixtures/codex-usage-app-server.mjs',import.meta.url),fake);chmodSync(fake,0o755);
    const prices=join(work,'prices');mkdirSync(prices);
    writeFileSync(join(prices,'model_list.json'),JSON.stringify({schema_version:1,generated_at:'2026-10-05T00:00:00Z',records:[{record_id:'fixture-wire',source:'litellm',source_model_id:'gpt-5.6-luna',provider:'openai',mode:'chat',pricing:{input_per_1m_tokens:.2,output_per_1m_tokens:1.2,input_cache_read_per_1m_tokens:null}}]}));
    writeFileSync(join(prices,'aliases.json'),JSON.stringify({schema_version:1,standards:[],aliases:[]}));
    writeFileSync(join(state,'init.toml'),[1,2,3].map(i=>`[Provider${i}]\nprovider = "codex"\nmodel1 = "gpt-5.6-luna"\nmodel2 = "gpt-5.6-luna"\nmodel3 = "gpt-5.6-luna"\n`).join('\n'));
    const team=join(work,'wire.lmctl');writeFileSync(team,`_TEAM_ name=wire-missing-rate\n_MEMBER_ alias=Lead provider=codex model=gpt-5.6-luna sessionid=s sessiondir=${work}\n`);
    const privateEnv={HOME:home,LMCTL_HOME:state,LMCTL_DB:join(work,'state.db'),CODEX_HOME:join(home,'.codex'),PATH:tools+':'+env.PATH,LMCTL_PRICE_DATA:prices};
    const prompt=run(['prompt',team,'Lead','one','--json'],privateEnv);assert.equal(prompt.code,0,prompt.err);
    const r=run(['usage','--since','2000-01-01','--until','2100-01-01','--json'],privateEnv);assert.equal(r.code,0,r.err);const u=JSON.parse(r.out);
    assert.equal(u.total.turns,1);assert.equal(u.total.unknownUsageCount,0);assert.equal(u.total.input,80);assert.equal(u.total.cacheRead,120);assert.equal(u.total.output,10);assert.equal(u.total.costUsd,null);assert.equal(u.reasons.cost.rate_missing,1);
  });
  console.log(`${ok.length} assertions: ${ok.length} pass, 0 fail`);
} finally { rmSync(root,{recursive:true,force:true}); }
