// Fake Agy print executable: no network, history emulation or test assertions.
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
const log=value=>appendFileSync(process.env.CONVERSATION_TRACE,JSON.stringify({pid:process.pid,...value})+'\n');
log({event:'spawn',args});
const prompt=args[args.indexOf('-p')+1];
const sessionId=args[args.indexOf('--conversation')+1];
log({event:'prompt',prompt,sessionId});
console.log('reply:'+prompt);
