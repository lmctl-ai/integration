// Offline black-box checks for lmctl usage's empty-state, validation, and grouping boundaries.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=realpathSync(mkdtempSync(join(tmpdir(),'lmctl-usage-boundary-')));
const bin=process.env.LMCTL_BIN||'lmctl';
const baseEnv={PATH:process.env.PATH,HOME:join(root,'home'),LMCTL_HOME:join(root,'home','.lmctl'),LMCTL_DB:join(root,'state.db'),LMCTL_NO_UPDATE_NOTIFIER:'1',TZ:'UTC',LC_ALL:'C',XDG_CACHE_HOME:join(root,'home','.cache'),XDG_CONFIG_HOME:join(root,'home','.config'),XDG_DATA_HOME:join(root,'home','.local','share')};
for(const key of Object.keys(process.env).filter(k=>k.startsWith('FEATURE_')))baseEnv[key]=process.env[key];
const selected=process.env.CASE_ID ? new Set(process.env.CASE_ID.split(',').map(x=>x.trim()).filter(Boolean)) : null;
const passed=[];

function run(args,extra={}){const result=spawnSync(bin,args,{env:{...baseEnv,...extra},encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});if(result.error)throw result.error;return {code:result.status,out:result.stdout||'',err:result.stderr||''};}
function check(id,name,fn){if(selected&&!selected.has(id))return;try{fn();passed.push(id);console.log('PASS '+id+' '+name);}catch(error){console.error('FAIL '+id+' '+name);throw error;}}
function json(result){assert.equal(result.code,0,result.out+result.err);return JSON.parse(result.out);}
function bootstrapDb(){
  mkdirSync(baseEnv.LMCTL_HOME,{recursive:true});
  const team=join(root,'bootstrap.lmctl');
  writeFileSync(join(baseEnv.LMCTL_HOME,'init.toml'),[1,2,3].map(i=>`[Provider${i}]\nprovider = "ClaudeMock"\nmodel1 = "mock-default"\nmodel2 = "mock-default"\nmodel3 = "mock-default"\n`).join('\n'));
  writeFileSync(team,'_TEAM_ name=usage-boundary\n_MEMBER_ alias=Lead provider=ClaudeMock model=mock-default\n');
  const seeded=run(['seed',team],{LMCTL_ENABLE_MOCK_PROVIDER:'1',LMCTL_CLAUDE_MOCK_STORE:join(root,'mock-store.json')});
  assert.equal(seeded.code,0,seeded.out+seeded.err);
  const db=new DatabaseSync(baseEnv.LMCTL_DB);
  const insert=db.prepare(`INSERT INTO team_chat_log(root_teamfile,receiver_teamfile,receiver_alias,message,origin,status,created_at,attempt_key,provider,native_session_id,cwd,model_reported,tok_input_uncached,tok_cache_read,tok_cache_write,tok_output,usage_source,usage_reason,rate_input_1m,rate_output_1m,rate_cache_read_1m,rate_cache_write_1m,cost_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const row=(teamfile,date,key,input,output)=>insert.run(teamfile,teamfile,'Lead','fixture','operator','ok',date,key,'claude','session-'+key,'/fixture','claude-haiku-4-5',input,0,0,output,'wire',null,1,2,0,1,null);
  row('/teams/alpha.lmctl','2026-10-04T12:00:00.000Z','u-alpha-1',10,5);
  row('/teams/alpha.lmctl','2026-10-05T12:00:00.000Z','u-alpha-2',20,10);
  row('/teams/beta.lmctl','2026-10-05T13:00:00.000Z','u-beta-1',30,15);
  db.close();
}

try {
  if(selected)for(const id of selected)assert.ok(['U01','U02','U03','U04'].includes(id),'unknown CASE_ID: '+id);
  check('U01','usage is read-only when the database is absent',()=>{
    const absent=join(root,'missing','state.db');
    const result=run(['usage','--since','2026-10-04','--until','2026-10-05','--json'],{LMCTL_DB:absent,LMCTL_HOME:join(root,'missing','.lmctl')});
    const payload=json(result);
    assert.deepEqual(payload.groups,[]);
    assert.deepEqual(payload.total,{key:'total',turns:0,input:0,cacheRead:0,cacheWrite:0,output:0,costUsd:null,cacheHitPercent:null,unknownUsageCount:0,unknownCostCount:0});
    assert.deepEqual(payload.reasons,{usage:{},cost:{}});
    assert.equal(existsSync(absent),false,'usage must not create a missing database');
    assert.equal(existsSync(join(root,'missing')),false,'usage must not create its parent state directory');
  });

  check('U02','usage rejects invalid periods/groupings and normalizes offsets independently of timezone',()=>{
    const reversed=run(['usage','--since','2026-10-06','--until','2026-10-05','--json'],{LMCTL_DB:join(root,'no-db-2')});
    assert.equal(reversed.code,2,reversed.out+reversed.err);assert.match(reversed.err,/--since must be earlier than --until/);
    const unknown=run(['usage','--since','2026-10-04','--until','2026-10-05','--by','bogus','--json'],{LMCTL_DB:join(root,'no-db-2')});
    assert.equal(unknown.code,2,unknown.out+unknown.err);assert.match(unknown.err,/invalid --by: bogus/);
    const invalid=run(['usage','--since','2026-02-30','--until','2026-10-05','--json']);
    assert.equal(invalid.code,2,invalid.err);assert.match(invalid.err,/invalid ISO date/);
    for(const zone of ['Pacific/Honolulu','Europe/Paris']){
      const p=json(run(['usage','--since','2026-10-04T02:00:00+02:00','--until','2026-10-05','--json'],{TZ:zone}));
      assert.equal(p.since,'2026-10-04T00:00:00.000Z');assert.equal(p.until,'2026-10-05T00:00:00.000Z');
    }
  });

  check('U03','usage groups seeded rows by UTC day and team',()=>{
    bootstrapDb();
    const day=json(run(['usage','--since','2026-10-04','--until','2026-10-06','--by','day','--json']));
    assert.deepEqual(day.groups.map(g=>g.key),['2026-10-04','2026-10-05']);
    assert.deepEqual(day.groups.map(g=>[g.turns,g.input,g.output,g.costUsd]),[[1,10,5,.00002],[2,50,25,.0001]]);
    assert.deepEqual([day.total.turns,day.total.input,day.total.output,day.total.costUsd],[3,60,30,.00012]);
    const team=json(run(['usage','--since','2026-10-04','--until','2026-10-06','--by','team','--json']));
    assert.deepEqual(team.groups.map(g=>g.key),['/teams/alpha.lmctl','/teams/beta.lmctl']);
    assert.deepEqual(team.groups.map(g=>[g.turns,g.input,g.output]),[[2,30,15],[1,30,15]]);
    // A few relative machine epsilons cover summing two independently rounded terms.
    for(const group of team.groups){assert.equal(typeof group.costUsd,'number');assert.ok(Number.isFinite(group.costUsd));assert.ok(Math.abs(group.costUsd-.00006)<=4*Number.EPSILON*.00006,'team bill must be 60 microdollars');}
    assert.equal(team.total.cacheHitPercent,0);
  });

  check('U04','legacy Copilot cost estimates use the last reported snapshot and price buckets once',()=>{
    const sid='44444444-5555-6666-7777-888888888888';
    const dir=join(baseEnv.HOME,'.copilot','session-state',sid);mkdirSync(dir,{recursive:true});
    copyFileSync(new URL('./fixtures/copilot-shutdown.jsonl',import.meta.url),join(dir,'events.jsonl'));
    const prices=join(root,'prices');mkdirSync(prices);
    writeFileSync(join(prices,'model_list.json'),JSON.stringify({schema_version:1,generated_at:'2026-10-05T00:00:00Z',records:[{record_id:'fixture-copilot',source:'litellm',source_model_id:'copilot-probe',provider:'copilot',mode:'chat',pricing:{input_per_1m_tokens:2,output_per_1m_tokens:10,input_cache_read_per_1m_tokens:.2,input_cache_write_per_1m_tokens:3}}]}));
    writeFileSync(join(prices,'aliases.json'),JSON.stringify({schema_version:1,standards:[{standard_slug:'fixture-copilot',catalog_record_id:'fixture-copilot'}],aliases:[{alias:'copilot/copilot-probe',standard_slug:'fixture-copilot',evidence:'established'}]}));
    const p=json(run(['cost',sid,'--provider','copilot','--json'],{LMCTL_PRICE_DATA:prices}));
    assert.deepEqual(p.tokens,{input:200,output:30,cachedInput:60});
    // Last snapshot: (200 - 60 - 40)*2 + 60*.2 + 40*3 + 30*10 = 632 microdollars.
    assert.equal(p.costUsd,.000632);assert.equal(p.priceDataSource,'pinned');
    const nativeSid='55555555-6666-7777-8888-999999999999';
    const nativeDir=join(baseEnv.HOME,'.copilot','session-state',nativeSid);mkdirSync(nativeDir);
    copyFileSync(new URL('./fixtures/copilot-native-shape.jsonl',import.meta.url),join(nativeDir,'events.jsonl'));
    const native=json(run(['cost',nativeSid,'--provider','copilot','--json'],{LMCTL_PRICE_DATA:prices}));
    assert.deepEqual(native.tokens,{input:229413,output:1053,cachedInput:199996});
    assert.equal(native.costUsd,.1387642);assert.equal(native.priceDataSource,'pinned');
    // No shutdown means no input/cache bill, even though per-message output is known.
    const events=readFileSync(join(dir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    writeFileSync(join(dir,'events.jsonl'),events.filter(e=>e.type!=='session.shutdown').map(JSON.stringify).join('\n')+'\n');
    const live=json(run(['cost',sid,'--provider','copilot','--json'],{LMCTL_PRICE_DATA:prices}));
    assert.equal(live.tokens.input,null);assert.equal(live.tokens.output,999);assert.equal(live.costUsd,null);
  });

  if(selected&&!['U01','U02','U03','U04'].some(id=>selected.has(id)))throw new Error('CASE_ID selected no known usage cases');
  console.log(`${passed.length} assertions: ${passed.length} pass, 0 fail`);
} finally {rmSync(root,{recursive:true,force:true});}
