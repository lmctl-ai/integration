// Provider identity check. Routine execution probes ONLY the cheapest listed Claude id daily.
// On-demand full sweep: node lmctl-test/tests/models-validity.mjs --all-models (never run in automation).
// LMCTL_PERIODIC_DIR isolates the probe cache; HOME remains the login home for provider auth.
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {readFile,writeFile,mkdir,rename,readdir,realpath,access,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname,resolve,delimiter} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {classifyTextForModelsValidity,isModelRefusal,isRefusalShaped,isStallOrTimeout,isRejectFirst} from './rate-limit-classifier.mjs';

export const CONTROL_IDS={codex:'gpt-9-nova',agy:'gemini-9-test-low',kimi:'kimi-code/bogus-9',claude:'claude-bogus-9-9'};
const PROVIDERS=Object.keys(CONTROL_IDS);
// A probe that failed for one of these reasons says nothing about the id: report it INCONCLUSIVE, do not fail the run.
export const INCONCLUSIVE_CLASSES=['quota_exhausted','upstream_throttled'];
// The installed lmctl classifies failure text (api classifyFailure or shared rate-limit classifier); null = classification unavailable, so an error stays an error.
export async function loadClassifier(bin,env=process.env){
 try{
  if(!bin.includes('/')&&!bin.includes('\\')){
   let executable;
   for(const directory of (env.PATH??'').split(delimiter)){
    const candidate=resolve(directory,bin);
    try{await access(candidate,constants.X_OK);if(!(await stat(candidate)).isFile())continue;executable=candidate;break;}catch{/* Try the next executable search path. */}
   }
   if(!executable)return null;
   bin=executable;
  }
  const root=dirname(dirname(await realpath(bin)));
  try{
   const api=await import(pathToFileURL(join(root,'dist/api/index.js')).href);
   if(typeof api.classifyFailure==='function') return text=>{const found=api.classifyFailure(text);return found.status==='ok'?found.class:null;};
  }catch{}
  try{
   const apiDir=await stat(join(root,'dist/api'));
   if(apiDir.isDirectory()) return null;
  }catch{}
  try{
   await stat(join(root,'package.json'));
   return text=>classifyTextForModelsValidity(text);
  }catch{}
  return null;
 }catch{return null;}
}
const DAY=24*3600*1000;
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const FLEET_ROOTS=[join(homedir(),'repos/skills-scripts'),repo,join(homedir(),'repos/lmctl-website/quickrun')];

export function cheapestModelId(models){
 if(!models||models.length===0) return null;
 const eligible=models.filter(m=>!/fable|opus/i.test(m.id));
 if(eligible.length===0) return null;
 for(const m of eligible){
  const inp=m.pricing?.input_per_1m_tokens;
  const out=m.pricing?.output_per_1m_tokens;
  if(typeof inp!=='number'||typeof out!=='number'||!Number.isFinite(inp+out)) return null;
 }
 let cheapest=null, lowest=Infinity;
 for(const m of eligible){
  const price=m.pricing.input_per_1m_tokens + m.pricing.output_per_1m_tokens;
  if(price < lowest){
   lowest = price;
   cheapest = m.id;
  }
 }
 return cheapest;
}

export function codexIds(output){
 const parsed=typeof output==='string'?JSON.parse(output):output;
 if(!Array.isArray(parsed.models)) throw Error('codex debug models: missing models array');
 return parsed.models.filter(r=>r.visibility==='list').map(r=>r.slug);
}
export function agyIds(output){
 return output.split(/\r?\n/).filter(line=>line.trim()).map(line=>{
  if(!line.includes('\t')) throw Error('agy models: expected id TAB display name');
  return line.split('\t')[0].trim();
 });
}
export function kimiIds(output){
 const ids=[];
 for(const line of output.split(/\r?\n/)){
  const match=/^\s*\[\s*models\s*\.\s*("(?:\\.|[^"\\])*"|'[^']*')\s*\]\s*(?:#.*)?$/.exec(line);
  if(match) ids.push(match[1][0]==='"'?JSON.parse(match[1]):match[1].slice(1,-1));
 }
 return ids;
}
export function teamMembers(text,file){
 const members=[];
 for(const [i,line] of text.split(/\r?\n/).entries()){
  if(!/^\s*_MEMBER_\s/.test(line)) continue;
  const fields={};
  for(const match of line.matchAll(/(?:^|\s)([a-z_]+)=("(?:\\.|[^"\\])*"|'[^']*'|[^\s#]+)/g)){
   fields[match[1]]=match[2][0]==='"'?JSON.parse(match[2]):match[2][0]==="'"?match[2].slice(1,-1):match[2];
  }
  members.push({...fields,file: file+':'+(i+1)});
 }
 return members;
}
function eligible(provider,model){return model.status==='valid'||(provider==='claude'&&model.status==='unverified');}
function suggestion(section,id,accepted){
 if(section.provider!=='agy') return '';
 const match=section.models.find(m=>m.display_name===id&&accepted.has(m.id));
 const canonical=match?.id??id.toLowerCase().replace(/[()]/g,'').replace(/\s+/g,'-');
 return accepted.has(canonical)?`; use ${canonical}`:'';
}
export function checkProvider(section,acceptedIds,members,{refusedIds=[],warnings=[],inconclusive={},unprobed=new Set(),notProbedLines=[]}={}){
 const failures=[],accepted=new Set(acceptedIds),refused=new Set(refusedIds),models=section.models??[];
 if(section.status!=='ok') failures.push(`provider ${section.status}: ${section.reason??'no reason'}`);
 const listed=new Set(models.filter(m=>eligible(section.provider,m)).map(m=>m.id));
 const unprobedSet=unprobed instanceof Set?unprobed:new Set(unprobed??[]);
 for(const id of listed) if(!accepted.has(id)) {
  if(unprobedSet.has(id)) continue;
  if(!refused.has(id)&&Object.hasOwn(inconclusive,id)) warnings.push(`INCONCLUSIVE: ${id}: ${inconclusive[id]}`);
  else failures.push(`listed but not accepted: ${id}${suggestion(section,id,accepted)}`);
 }
 for(const id of accepted) if(!listed.has(id)) failures.push(`accepted but not listed: ${id}`);
 for(const member of members.filter(m=>m.provider===section.provider)){
  if(unprobedSet.has(member.model)){
   const ref=member.alias?`${member.file} ${member.alias}`:`${member.file}`;
   notProbedLines.push(`NOT PROBED: ${ref}: ${member.model}`);
   continue;
  }
  if(!refused.has(member.model)&&listed.has(member.model)&&Object.hasOwn(inconclusive,member.model)) continue;
  if(!listed.has(member.model)||!accepted.has(member.model)) failures.push(`${member.file} ${member.alias??''}: ${member.model??'(missing model)'} is not valid${suggestion(section,member.model??'',accepted)}`);
 }
 return failures;
}
export async function probeClaudeIds(ids,{cache,now,probe,cachedOnly=false,notes={}}){
 const accepted=[],refused=[],inconclusive={},probed=[];
 for(const id of new Set(ids.filter(id=>id!==CONTROL_IDS.claude))){
  const entry=cache[id],at=Date.parse(entry?.at),fresh=Number.isFinite(at)&&now>=at&&now-at<DAY&&['accepted','refused','error'].includes(entry?.result);
  let result=entry?.result;
  if(!fresh){
   if(cachedOnly) result='not_probed';
   else {result=await probe(id);probed.push(id);if(result==='inconclusive') delete cache[id];else cache[id]={at:new Date(now).toISOString(),result};}
  }
  if(result==='accepted') accepted.push(id);
  if(result==='refused') refused.push(id);
  if(result==='inconclusive') inconclusive[id]=notes[id]??'probe failed for a reason that says nothing about the id';
 }
 const control=await probe(CONTROL_IDS.claude);probed.push(CONTROL_IDS.claude);
 return {accepted,refused,inconclusive,probed,controlOutcome:control,controlRefused:control==='refused'};
}
export function command(bin,args,{env=process.env,cwd}={}){
 return new Promise(resolveResult=>{
  const child=spawn(bin,args,{env,cwd,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',data=>{out+=data;});child.stderr.on('data',data=>{err+=data;});
  child.on('error',error=>{err+=error.message;});
  child.on('close',code=>resolveResult({code,out,err}));
 });
}
function requireOutput(result,name){if(result.code!==0) throw Error(`${name} exited ${result.code}: ${result.err.trim()}`);return result.out;}
export function claudeProbeArgs(id){
 return ['-p','--model',id,'--max-turns','1','--output-format','json',
  '--system-prompt','Reply with the single word OK','--tools','','--no-session-persistence',
  '--setting-sources','','--strict-mcp-config','--disable-slash-commands','Reply with the single word OK'];
}
export function collectDecodedStrings(val,out=[]){
 if(typeof val==='string') out.push(val);
 else if(Array.isArray(val)){for(const item of val) collectDecodedStrings(item,out);}
 else if(val&&typeof val==='object'){for(const v of Object.values(val)) collectDecodedStrings(v,out);}
 return out;
}
export function judgedTextsForProbe(result){
 const raw=(result.out??'')+'\n'+(result.err??'');
 let parsed;try{parsed=JSON.parse(result.out);}catch{/* failure text can be plain stderr */}
 const decodedStrings=parsed?collectDecodedStrings(parsed):[];
 const decoded=[...decodedStrings,result.err??''].filter(Boolean).join('\n');
 const texts=[raw,decoded].filter(Boolean);
 return {raw,decoded,parsed,texts};
}
export const BENIGN_STRING_TOKENS = new Set([
 'api_error',
 'error_during_execution',
 'success',
 'result',
 'stop_sequence',
 'off',
 'sdk_opt_in_required',
 'standard',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isBenignStringToken(str) {
 if (typeof str !== 'string') return false;
 const trimmed = str.trim();
 if (trimmed === '') return true;
 if (BENIGN_STRING_TOKENS.has(trimmed)) return true;
 if (UUID_RE.test(trimmed)) return true;
 return false;
}

function checkObjectStringFields(obj, topLevel = true) {
 if (typeof obj === 'string') return isBenignStringToken(obj);
 if (Array.isArray(obj)) {
  for (const item of obj) if (!checkObjectStringFields(item, false)) return false;
  return true;
 }
 if (obj && typeof obj === 'object') {
  for (const [key, val] of Object.entries(obj)) {
   if (topLevel && key === 'result') continue;
   if (typeof val === 'string') {
    if (!isBenignStringToken(val)) return false;
   } else if (val && typeof val === 'object') {
    if (!checkObjectStringFields(val, false)) return false;
   }
  }
  return true;
 }
 return true;
}

export const CLAUDE_STDERR_ALLOWED_QUERY_SOURCES = ['sdk'];

export function isClaudeBogusControlRefusal(result, modelId) {
 let parsed;
 try {
  parsed = JSON.parse(result?.out || '');
 } catch {
  return false;
 }
 if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
 if (parsed.is_error !== true || typeof parsed.result !== 'string') return false;

 const trimmedResult = parsed.result.trim();
 const escId = (modelId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const refusalRe = new RegExp(`^There's an issue with the selected model \\(${escId}\\)\\. It may not exist or you may not have access to it\\.(?: Run --model to pick a different model\\.)?$`);
 if (!refusalRe.test(trimmedResult)) return false;

 if (trimmedResult.includes('{') || trimmedResult.includes('[') || trimmedResult.includes('\\')) return false;
 if (!checkObjectStringFields(parsed, true)) return false;

 const rawErr = result?.err ?? '';
 if (rawErr !== '' && rawErr !== '\n' && rawErr !== '\r\n') {
  const allowedSources = CLAUDE_STDERR_ALLOWED_QUERY_SOURCES.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const stderrRe = new RegExp(`^\\[claude-code:unrecognized_model\\] \\{"model":"${escId}","query_source":"(${allowedSources})"\\}\\r?\\n?$`);
  if (!stderrRe.test(rawErr)) return false;
 }

 return true;
}
export function probeResult(result,classify,modelId=null){
 const {raw,decoded,parsed,texts}=judgedTextsForProbe(result);
 if(result.code===0&&parsed?.is_error!==true&&parsed?.subtype==='success'&&typeof parsed?.result==='string'&&parsed.result.trim()==='OK') return 'accepted';
 if(texts.some(t=>isRejectFirst(t)||isStallOrTimeout(t))) return 'error';
 if(modelId===CONTROL_IDS.claude){
  if(isClaudeBogusControlRefusal(result,modelId)) return 'refused';
  if(texts.some(t=>isRefusalShaped(t))) return 'error';
  const failure=(decoded?classify?.(decoded):null)||classify?.(raw);
  if(INCONCLUSIVE_CLASSES.includes(failure)) return 'inconclusive';
  return 'error';
 }
 if(texts.some(t=>isRefusalShaped(t))||(result.code!==0||parsed?.is_error===true||parsed?.subtype==='error')){
  if(modelId&&texts.some(t=>isModelRefusal(t,modelId))) return 'refused';
  if(texts.some(t=>isRefusalShaped(t))) return 'error';
 }
 const failure=(decoded?classify?.(decoded):null)||classify?.(raw);
 if(INCONCLUSIVE_CLASSES.includes(failure)) return 'inconclusive';
 return 'error';
}
function oneLine(result){
 let text=result.err;try{
  const parsed=JSON.parse(result.out);
  const message=parsed?.result??parsed?.error?.message??parsed?.error??parsed?.message;
  if(typeof message==='string')text=message;
 }catch{text=result.out||result.err;}
 return text.trim().split('\n')[0].slice(0,200)||'probe failed without a provider message';
}
async function readCache(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT') return {};throw error;}}
async function fleetMembers(){
 const members=[];
 async function walk(path){
  for(const entry of await readdir(path,{withFileTypes:true})){
   if(entry.name.startsWith('.')||entry.name==='node_modules') continue;
   const target=join(path,entry.name);
   if(entry.isDirectory()) await walk(target);
   else if(entry.isFile()&&/\.lmctl$/.test(entry.name)) members.push(...teamMembers(await readFile(target,'utf8'),target));
  }
 }
 for(const root of FLEET_ROOTS) await walk(root);
 return members;
}
export async function main(argv=process.argv){
 const env={...process.env};
 for(const key of Object.keys(env)) if(/^(LMCTL_SELF_SESSIONID|LMCTL_INVOCATION_ID|LMCTL_LAUNCH_SOURCE|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT)$/.test(key)) delete env[key];
 const allModels=argv.includes('--all-models');
 const state=process.env.LMCTL_PERIODIC_DIR??join(homedir(),'.local/state/lmctl/periodic');
 const cachePath=join(state,'claude-probes.json');
 let listing,members=[],fleetError;
 try{listing=JSON.parse(requireOutput(await command(env.LMCTL_BIN||'lmctl',['models','--json'],{env}),'lmctl models'));if(listing.schema_version!==2||!Array.isArray(listing.providers)) throw Error('expected models schema 2');}
 catch(error){for(const provider of PROVIDERS) console.log(`== models-validity ${provider}: FAIL ${error.message}`);return 1;}
 try{members=await fleetMembers();}catch(error){fleetError='fleet scan: '+error.message;}
 const control=env.LMCTL_MODELS_CONTROL==='1';let failed=false;
 let mvPass=0,mvWarn=0,mvFail=0,mvWarns=[];
 for(const provider of PROVIDERS){
  const source=listing.providers.find(p=>p.provider===provider);
  const section=structuredClone(source??{provider,status:'unavailable',reason:'missing provider section',models:[]});
  if(control) section.models.push({id:CONTROL_IDS[provider],status:provider==='claude'?'unverified':'valid'});
  let accepted=[],refusedIds=[],warnings=[],details=[],failures=[],inconclusive={},unprobed=new Set(),notProbedLines=[];
  let claudeResult=null,claudeReason=null;
  try{
   if(provider==='codex') accepted=codexIds(requireOutput(await command('codex',['debug','models'],{env}),'codex debug models'));
   if(provider==='agy') accepted=agyIds(requireOutput(await command('agy',['models'],{env}),'agy models'));
   if(provider==='kimi'){
    const config=env.KIMI_CODE_CONFIG_PATH||join(env.KIMI_CODE_HOME||join(homedir(),'.kimi-code'),'config.toml');
    accepted=kimiIds(await readFile(config,'utf8'));
   }
   if(provider==='claude'){
    const cache=await readCache(cachePath);
    let reportedCost=0;
    const classify=await loadClassifier(env.LMCTL_BIN||'lmctl',env),notes={};
    const eligibleModels=section.models.filter(m=>eligible(provider,m)).map(m=>m.id);
    let probeCandidates;
    if(allModels){
     probeCandidates=eligibleModels;
     unprobed=new Set();
    }else{
     const cheapest=cheapestModelId(section.models.filter(m=>eligible(provider,m)));
     if(cheapest){
      probeCandidates=[cheapest];
      unprobed=new Set(eligibleModels.filter(id=>id!==cheapest));
     }else{
      probeCandidates=[];
      unprobed=new Set(eligibleModels);
      claudeReason=eligibleModels.length===0?'no eligible candidate':'cannot establish cheapest';
      warnings.push(`NOT PROBED: ${claudeReason}`);
     }
    }
    const probe=async id=>{
     const args=claudeProbeArgs(id);
     const result=await command('claude',args,{env,cwd:repo});
     const outcome=probeResult(result,classify,id);
     if(outcome==='inconclusive') notes[id]=`${oneLine(result)} (${classify(result.out+'\n'+result.err)})`;
     let cost;
     try{cost=JSON.parse(result.out).total_cost_usd;}catch{/* refusal can be plain text */}
     if(typeof cost==='number') reportedCost+=cost;
     console.log(`INFO claude probe ${id}: ${outcome}${typeof cost==='number'?` (USD ${cost})`:''}`);
     if(outcome!=='accepted') details.push(`probe ${outcome}: claude ${args.map(a=>JSON.stringify(a)).join(' ')}`);
     return outcome;
    };
    claudeResult=await probeClaudeIds(probeCandidates,{cache,now:Date.now(),probe,cachedOnly:control,notes});
    accepted=claudeResult.accepted;
    inconclusive=claudeResult.inconclusive;
    refusedIds=claudeResult.refused;
    for(const id of probeCandidates) {
     if(id!==CONTROL_IDS.claude&&!accepted.includes(id)) details.push(`no accepted confirmation (${cache[id]?.result??'not probed'}): claude ${claudeProbeArgs(id).map(a=>JSON.stringify(a)).join(' ')}`);
    }
    if(claudeResult.controlOutcome==='inconclusive'){
     warnings.push(`control inconclusive: ${notes[CONTROL_IDS.claude]??'quota or rate limit'}`);
    }else if(!claudeResult.controlRefused){
     failures.push('Claude refusal control was not refused with a model error');
    }
    details.push(`${claudeResult.probed.length} probes (${claudeResult.probed.join(', ')}); reported cost USD ${reportedCost}`);
    await mkdir(state,{recursive:true});const temporary=cachePath+'.'+process.pid+'.tmp';
    await writeFile(temporary,JSON.stringify(cache,null,2)+'\n');await rename(temporary,cachePath);
   }
   failures.push(...checkProvider(section,accepted,members,{refusedIds,warnings,inconclusive,unprobed,notProbedLines}));
  }catch(error){failures.push(error.message);}
  if(fleetError) failures.push(fleetError);
  if(failures.length) failed=true;
  if(provider==='claude'&&accepted.length===0&&!claudeReason){
   claudeReason=Object.keys(inconclusive).length>0||claudeResult?.controlOutcome==='inconclusive'?'all probes inconclusive':'no eligible candidate';
  }
  if(failures.length){
   mvFail++;
  }else if(warnings.length>0||(provider==='claude'&&accepted.length===0)){
   mvWarn++;
   for(const w of warnings) mvWarns.push(`${provider}: ${w}`);
   if(provider==='claude'&&accepted.length===0&&!warnings.length) mvWarns.push(`claude: 0 ids accepted (${claudeReason??'no eligible candidate'})`);
  }else{
   mvPass++;
  }
  if(provider==='claude'){
   if(failures.length) console.log(`== models-validity claude: FAIL ${accepted.length} ids`);
   else if(accepted.length===0) console.log(`== models-validity claude: WARN 0 ids (${claudeReason??'no eligible candidate'})`);
   else {
    const freshCount=accepted.filter(id=>claudeResult?.probed?.includes(id)).length;
    const cachedCount=accepted.filter(id=>!claudeResult?.probed?.includes(id)).length;
    console.log(`== models-validity claude: PASS ${accepted.length} ids (${freshCount} fresh, ${cachedCount} cached)`);
   }
  }else{
   console.log(`== models-validity ${provider}: ${failures.length?'FAIL':'PASS'} ${accepted.length} ids`);
  }
  if(unprobed.size>0) console.log(`NOT PROBED (cost policy): ${[...unprobed].join(', ')}`);
  for(const line of notProbedLines) console.log(line);
  for(const warning of warnings) console.log(`WARN ${provider}: ${warning}`);
  for(const line of [...failures,...details]) console.log(`  ${provider}: ${line}`);
  if(section.unmatched?.length) console.log(`INFO ${provider}: ${section.unmatched.join(', ')} have no catalog row yet (dataset ${listing.catalog_generated_at??listing.price_data_generated_at??'unknown'})`);
 }
 const mvWarnPart=mvWarns.length?` [warn: ${mvWarns.join('; ')}]`:'';
 console.log(`${PROVIDERS.length} providers: ${mvPass} pass, ${mvWarn} warn, ${mvFail} fail${mvWarnPart}`);
 return failed?1:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) process.exitCode=await main(process.argv);
