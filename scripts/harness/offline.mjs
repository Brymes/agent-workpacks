#!/usr/bin/env node
// Process-and-file acceptance for native CLI lifecycle contracts. No provider requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills/agent-workpacks/scripts');
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workpacks-harness-'));
const root = path.join(runDir, 'project with spaces');
fs.mkdirSync(root, { recursive: true });
const bin = path.join(runDir, 'bin'); fs.mkdirSync(bin);
const stub = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const tool=path.basename(process.argv[1]); const a=process.argv.slice(2);
if(a.includes('--version')) { console.log(tool==='opencode'?'opencode v2.2.0':tool==='claude'?'2.1.316':'codex-cli 0.166.0');process.exit(0); }
if(a.includes('--help')) {console.log('--json --session --resume --output-format --model --variant --auto --print --sandbox --session-id --permission-mode');process.exit(0);}
if(tool==='codex' && a[0]==='queue'){fs.appendFileSync(process.env.AWP_QUEUE_LOG,JSON.stringify(a)+'\\n');process.exit(process.env.AWP_QUEUE_FAIL==='1'?1:0);}
if(process.env.AWP_STUB_MODE==='auth'){console.error('Unauthorized: invalid API key');process.exit(1);}
const get=k=>a[a.indexOf(k)+1];
let sid=tool==='opencode'&&a.includes('--session')?get('--session'):tool==='claude'&&a.includes('--resume')?get('--resume'):tool==='codex'&&a.includes('resume')?a[a.indexOf('resume')+1]:null;
const resumed=!!sid;sid ||= tool==='claude'&&a.includes('--session-id')?get('--session-id'):(tool==='opencode'?'ses_':'')+crypto.randomUUID();
const emit=x=>console.log(JSON.stringify(x));
if(tool==='opencode')emit({type:'step_start',timestamp:Date.now(),sessionID:sid,part:{type:'step-start'}});
if(tool==='claude')emit({type:'system',subtype:'init',session_id:sid});
if(tool==='codex'){emit({type:'thread.started',thread_id:sid});emit({type:'turn.started'});}
if(process.env.AWP_STUB_MODE==='wait'){setInterval(()=>{},1000);}else{
const dir=process.env.AWP_TASK_DIR;const out=path.join(dir,'result.json');
const prev=fs.existsSync(out)?JSON.parse(fs.readFileSync(out,'utf8')):null;
fs.writeFileSync(out,JSON.stringify({tool,session:sid,resumed,previous_session:prev?.session??null}));
fs.writeFileSync(path.join(dir,'STATUS.md'),'---\\nstate: needs-review\\nupdated: '+new Date().toISOString()+'\\nblocker: none\\nnext_action: senior review\\n---\\n');
fs.writeFileSync(path.join(dir,'REPORT.md'),'# Result\\n\\n1. Process completed.\\n2. Output retained.\\n3. Ready for review.\\n\\n## Tests\\n\\nResult file written.\\n\\n'+String.fromCharCode(96).repeat(3)+'text\\nPASS\\n'+String.fromCharCode(96).repeat(3)+'\\n');
if(tool==='opencode')emit({type:'step_finish',timestamp:Date.now(),sessionID:sid,part:{reason:'stop'}});
if(tool==='claude')emit({type:'result',subtype:'success',session_id:sid,result:'handback',is_error:false});
if(tool==='codex'){emit({type:'item.completed',item:{type:'agent_message',text:'handback'}});emit({type:'turn.completed'});}
setTimeout(()=>{},100);
}
`;
for (const tool of ['opencode','claude','codex']) { const f=path.join(bin,tool);fs.writeFileSync(f,stub);fs.chmodSync(f,0o755); }
const env={...process.env,OC_BIN:path.join(bin,'opencode'),CLAUDE_BIN:path.join(bin,'claude'),CODEX_BIN:path.join(bin,'codex'),DP_NO_DB:'1',DP_NO_NOTIFY:'1',DP_WATCH_NO_INSTALL:'1',OC_FAKE_MEM_FREE:'50',AWP_QUEUE_LOG:path.join(runDir,'queue.jsonl')};
const results=[];
function run(script,args,extra={}) {const r=spawnSync(process.execPath,[path.join(scripts,script),...args],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:20000});return {code:r.status,stdout:r.stdout||'',stderr:r.stderr||''};}
function check(ok,label,details='') {results.push({label,ok,details});if(!ok)throw Error(label+': '+details);}
function json(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function waitFor(fn){const until=Date.now()+12000;while(Date.now()<until){if(fn())return;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}throw Error('process did not finish');}
const pack=path.join(root,'acceptance-pack-v1');
function brief(id,needs='none') {return `# ${id} — native lifecycle handback
Read RULES.md first. BINDING: the numbered Tasks and Tests below.
OUT OF SCOPE: every other task and product source
BOUNDARIES TOUCHED: none
STOP CONDITION: write the report and stop at needs-review
Lock: none
Needs first: ${needs}    Size: S    Role: researcher

## Owns
| Repo | Worktree | Branch (from base) | Files / dirs |
|---|---|---|---|
| (pack) | . | acceptance (main) | result.json (new) |

## Tasks
1. Write result.json with the observed runtime and session; retain the prior session on follow-up.

## Tests
- none to run: controller inspects the resulting files and independent CLI events

## Hand back
- Write REPORT.md and set STATUS.md to needs-review.

## Ask first if
- anything requires files outside this task
`;}
try {
 let r=run('pack-init.mjs',['acceptance','--root',root,'--pfx','AC']);check(r.code===0,'clean project initialization',r.stderr);
 fs.writeFileSync(path.join(pack,'PLAN.md'),'# Plan\n| T1 | native |\n| T2 | native |\n| T3 | native |\n| D1 | dependent |\n| A1 | auth |\n| S1 | stop |\n');
 const roster=()=>json(path.join(pack,'control/roster.json'));
 const task=id=>roster().tasks.find(t=>t.id===id);
 const add=(id,needs)=>{const d=path.join(pack,'tasks',id);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'BRIEF.md'),brief(id,needs));};
 for(const [i,tool] of ['opencode','claude','codex'].entries()) {
  const id='T'+(i+1);add(id);
  r=run('pack-worker.mjs',['start','--pack',pack,'--task',id,'--tool',tool,'--json']);check(r.code===0,tool+' starts',r.stderr+r.stdout);
  waitFor(()=>task(id)?.exited_at);
  const first=json(path.join(pack,'tasks',id,'result.json'));check(first.tool===tool && !!task(id).session_id,tool+' records native session');
  r=run('pack-worker.mjs',['instruct','--pack',pack,'--task',id,'Retain the previous session and update the handback.','--json']);check(r.code===0,tool+' follow-up accepted',r.stderr+r.stdout);
  waitFor(()=>task(id)?.attempts===2 && !!task(id)?.exited_at);
  const next=json(path.join(pack,'tasks',id,'result.json'));check(next.resumed && next.session===first.session && next.previous_session===first.session,tool+' resumes the same session');
  r=run('pack-worker.mjs',['start','--pack',pack,'--task',id,'--tool',tool==='claude'?'codex':'claude','--dry-run']);check(r.code===3,tool+' rejects runtime reassignment');
 }
 add('D1','T1');r=run('pack-worker.mjs',['start','--pack',pack,'--task','D1','--tool','claude']);check(r.code===3 && !task('D1'),'unaccepted dependency prevents process creation');
 add('A1');r=run('pack-worker.mjs',['start','--pack',pack,'--task','A1','--tool','claude'],{AWP_STUB_MODE:'auth'});waitFor(()=>task('A1')?.exited_at);check(task('A1').exit_code===1 && !task('A1').session_id,'authentication failure remains a failed attempt');
 add('S1');r=run('pack-worker.mjs',['start','--pack',pack,'--task','S1','--tool','codex'],{AWP_STUB_MODE:'wait'});check(r.code===0,'long worker starts');
 r=run('pack-worker.mjs',['stop','--pack',pack,'--task','S1','--grace','1']);check(r.code===0,'stop terminates the worker');
 const stale=task('S1');waitFor(()=>{try{process.kill(stale.pid,0);return false;}catch{return true;}});
 for(const host of ['codex','claude','opencode']){
  r=run('pack-watch.mjs',['attach','--pack',pack,'--host',host,'--session','lead-'+host,'--takeover','--no-install']);check(r.code===0,host+' lead binding',r.stderr+r.stdout);
  const binding=json(path.join(pack,'control/senior.json'));check(binding.host===host && binding.session_id==='lead-'+host,host+' owns the durable binding');
 }
 r=run('pack-watch.mjs',['attach','--pack',pack,'--host','claude','--session','another','--no-install']);check(r.code!==0,'second lead requires explicit takeover');
 r=run('pack-watch.mjs',['disable','--pack',pack,'--no-install']);check(r.code===0,'monitoring disables cleanly');
} catch(error){results.push({label:'harness completed',ok:false,details:error.stack});}
finally {
 try{const r=json(path.join(pack,'control/roster.json'));for(const t of r.tasks)for(const pid of [t.pid,t.supervisor_pid])if(pid)try{process.kill(-pid,'SIGTERM');}catch{try{process.kill(pid,'SIGTERM');}catch{}}}catch{}
 const summary={kind:'offline-process-harness',platform:process.platform,node:process.version,results,passed:results.every(r=>r.ok)};
 fs.writeFileSync(path.join(runDir,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({run:runDir,...summary},null,2));process.exitCode=summary.passed?0:1;
}
