#!/usr/bin/env node
// Explicit live E2E: real lead, three real worker runtimes, independent fixture acceptance.
// Raw sessions stay in a private temporary run directory; publish only the sanitized summary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimeBinary } from '../lib/runtimes.mjs';
import { parseLine } from '../lib/events.mjs';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.dirname(scripts);
const options = process.argv.slice(2), lead = options[options.indexOf('--lead') + 1];
if (!['codex', 'claude', 'opencode'].includes(lead)) throw Error('usage: live.mjs --lead codex|claude|opencode [--prepare-only]');
const root = fs.mkdtempSync(path.join(os.tmpdir(), `agent-workpacks-live-${lead}-`));
const repo = path.join(root, 'repo'); fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const run = (file, args, cwd = root) => {
  const r = spawnSync(file, args, { cwd, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw Error(`${path.basename(file)} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const node = process.execPath;
for (const args of [['init','-q','-b','main'], ['config','user.name','Acceptance Fixture'], ['config','user.email','fixture@example.invalid']]) run('git',args,repo);
fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'This is an isolated acceptance fixture. Implement only the assigned brief. Do not write unit tests, change the acceptance specification, use external services, or push. Retain the observed acceptance output in the task report.\n');
fs.writeFileSync(path.join(repo, 'src', 'placeholder.txt'), 'Fixture modules are assigned separately.\n');
run('git',['add','.'],repo); run('git',['commit','-qm','Initialize acceptance fixture'],repo);
run(node,[path.join(scripts,'pack-init.mjs'),'exercise','--root',root,'--pfx','AC','--max-workers','2']);
const pack = path.join(root,'exercise-pack-v1');
const tools = lead === 'codex' ? ['opencode','claude','codex'] : lead === 'claude' ? ['claude','codex','opencode'] : ['codex','claude','opencode'];
const cases = [
  ['parser','parse',`Export parse(source). Split newline-delimited JSON, skip blank lines, and return {records, errors}. Each records item is {line, value}, preserving its one-based source line. Collect invalid JSON as {line, code:"invalid_json"} and continue. Do not validate record fields here.`],
  ['validator','validate',`Export validate(records). Input items are {line,value}. A valid value is a non-null object with nonempty string id and category, plus an integer quantity >= 0. Trim and lowercase id and category. Keep the first valid record for each normalized ID. Return {records:[{id,category,quantity}], errors:[{line,code}]}; use invalid_record for invalid values and duplicate_id for later valid duplicates, in source order.`],
  ['summary','summarize',`Export summarize(records). Return {count,totalQuantity,byCategory}. Sum valid quantities and group by category. Insert byCategory keys in sorted category order, and produce {count:0,totalQuantity:0,byCategory:{}} for no records.`],
];
const fixture = ['{"id":" A ","category":"Tools","quantity":2}', '', '{"id":"B","category":"tools","quantity":3}', '{"id":"a","category":"TOOLS","quantity":7}', '{broken', '{"id":"C","category":" books ","quantity":4}', '{"id":"bad","category":"books","quantity":-1}', '{"id":"D","category":"tools","quantity":0}', '{"id":"","category":"books","quantity":5}', 'null', '{"id":"E","category":"books","quantity":1.5}', '{"id":"F","category":" books","quantity":1}'].join('\n');
const expectedRecords = [{id:'a',category:'tools',quantity:2},{id:'b',category:'tools',quantity:3},{id:'c',category:'books',quantity:4},{id:'d',category:'tools',quantity:0},{id:'f',category:'books',quantity:1}];
fs.writeFileSync(path.join(root,'input.ndjson'),fixture);
const acceptance = `import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const root=${JSON.stringify(root)};const stage=process.argv[2]||'all';
const load=async(n,s)=>(await import(pathToFileURL(path.join(root,'worktrees',n,'src',s+'.mjs')).href));
const source=fs.readFileSync(path.join(root,'input.ndjson'),'utf8');
if(stage==='parser'||stage==='all'){const {parse}=await load('T1','parser');const p=parse(source);assert.deepEqual(p.errors,[{line:5,code:'invalid_json'}]);assert.deepEqual(p.records.map(x=>x.line),[1,3,4,6,7,8,9,10,11,12]);assert.deepEqual(parse('\\n \\n'),{records:[],errors:[]});}
if(stage==='validator'||stage==='all'){const {validate}=await load('T2','validator');const items=source.split('\\n').flatMap((line,i)=>{try{return line.trim()?[{line:i+1,value:JSON.parse(line)}]:[];}catch{return[];}});const v=validate(items);assert.deepEqual(v.records,${JSON.stringify(expectedRecords)});assert.deepEqual(v.errors,[{line:4,code:'duplicate_id'},{line:7,code:'invalid_record'},{line:9,code:'invalid_record'},{line:10,code:'invalid_record'},{line:11,code:'invalid_record'}]);}
if(stage==='summary'||stage==='all'){const {summarize}=await load('T3','summary');assert.deepEqual(summarize(${JSON.stringify(expectedRecords)}),{count:5,totalQuantity:10,byCategory:{books:5,tools:5}});assert.deepEqual(Object.keys(summarize(${JSON.stringify(expectedRecords)}).byCategory),['books','tools']);assert.deepEqual(summarize([]),{count:0,totalQuantity:0,byCategory:{}});}
if(stage==='all'){const {parse}=await load('T1','parser');const {validate}=await load('T2','validator');const {summarize}=await load('T3','summary');assert.deepEqual(summarize(validate(parse(source).records).records),{count:5,totalQuantity:10,byCategory:{books:5,tools:5}});}
console.log('PASS '+stage+' fixture acceptance');
`;
fs.writeFileSync(path.join(root,'acceptance.mjs'),acceptance);
const specHash = crypto.createHash('sha256').update(acceptance).digest('hex');
fs.writeFileSync(path.join(pack,'GOAL.md'),'# Goal\nDeliver the three bounded JSON import modules and prove the integrated malformed-input and duplicate cases.\n');
fs.writeFileSync(path.join(pack,'RULES.md'),'# Rules\nThe sole lead dispatches and reviews; only workers edit assigned source. Local commits only. No PRs, pushes or external services. The acceptance script is read-only. The lead may answer fixture questions, integrate if necessary, and acknowledge escalation items.\n');
fs.writeFileSync(path.join(pack,'PLAN.md'),'# Plan\n| ID | Needs first | Runtime |\n|---|---|---|\n'+tools.map((t,i)=>`| T${i+1} | ${i===2?'T1 T2':'none'} | ${t} |`).join('\n')+'\n');
for (const [i,[module,exportName,assignment]] of cases.entries()) {
  const id='T'+(i+1), taskDir=path.join(pack,'tasks',id);fs.mkdirSync(taskDir,{recursive:true});
  const question = i===0 ? '1. Before implementing, write Q-AC-T1-001 in QUESTIONS.md asking whether blank lines should count as invalid JSON. Set STATUS to needs-review, write a report saying the answer is needed, and stop. This deliberate fixture handback tests same-session correction. On the next turn, read the lead answer and implement.\n2. ' : '1. ';
  fs.writeFileSync(path.join(taskDir,'BRIEF.md'),`# ${id} — ${module} for JSON import
Read RULES.md first. BINDING: the numbered Tasks and Tests below.
OUT OF SCOPE: other modules, the acceptance specification, dependencies and external services
BOUNDARIES TOUCHED: fixture only
STOP CONDITION: hand back at needs-review; a fixture question also hands back and stops
Lock: none
Needs first: ${i===2?'T1 T2':'none'}    Size: S    Role: coder

## Owns
| Repo | Worktree | Branch (from base) | Files / dirs |
|---|---|---|---|
| repo | worktrees/${id} | acceptance/${id} (main) | src/${module}.mjs (new) |

## Tasks
${question}${assignment} Use named export ${exportName} in src/${module}.mjs. No dependencies.

## Tests
- Run \`${node} "${root}/acceptance.mjs" ${module}\`; retain its output and exit code in REPORT.md. Do not edit it or add unit tests.

## Hand back
- Keep any commit local, write a three-line REPORT.md summary plus observed acceptance output, set STATUS needs-review, and stop.

## Ask first if
- The assigned API is unclear or another file is needed.
`);
}
const worker = path.join(scripts,'pack-worker.mjs'), watch=path.join(scripts,'pack-watch.mjs');
const selection = tools.map((t,i)=>`T${i+1}: --tool ${t}${t==='opencode'?' --model opencode-go/deepseek-v4.1-flash --variant high --agent none':t==='claude'?' --model sonnet --variant high':''}`).join('\n');
const prompt = `Use the Agent Workpacks skill at ${path.join(skill,'SKILL.md')} as the ONE ${lead} lead for the prepared fixture pack ${pack}. This is an explicit end-to-end acceptance exercise, with its scope approved. Do not ask the user or edit any src module yourself. Read the skill and pack files. Never run git push or gh.
Worker runtime selections are mandatory and independent of your own tool:
${selection}
Use ${node} ${worker} for every worker launch/resume/stop and ${watch} for monitoring. Use an explicit --max-minutes 8 on launches and corrections. The pack permits two concurrent workers. Start T1 and T2, answer and resume T1 in its SAME saved session, run each independent acceptance stage, record review pass, and mark each done only after it passes. Then start T3 after its prerequisites. The answer to the deliberate T1 question is already approved: blank lines are skipped and malformed nonblank lines are collected as errors while processing continues. Answer in QUESTIONS.md with an **A (senior):** line and send instruct; do not create a new worker.
Your native session identity is in ${path.join(root,'lead-identity.json')}; read it before binding. Bind --host ${lead} --session that ID, using --no-install so this fixture does not register an OS scheduler. For Claude, arm wait via Bash run_in_background:true; for OpenCode, arm wait via shell background:true. Use --host ${lead} --interval-sec 2 --timeout-min 2. A completion notification with exit 10 is an expected wake, not a failed product test. Handle and acknowledge new actions, then re-arm until done. Codex should use tick to exercise queued delivery to this same lead, and continue handling the fixture. Do not busy-poll or sleep when native background notification is available.
Do not change task ownership, the selected runtime, the acceptance script, or any global config. You may inspect source and accept surviving uncommitted work if a CLI prevents local commits; report that limitation honestly. Use the independent acceptance output to review.
At the end run ${node} ${path.join(root,'acceptance.mjs')} all. Record the output in ${path.join(root,'lead-result.md')}, disable monitoring for this pack, and finish with a short outcome. If an actual auth or runtime problem blocks progress, record it and stop instead of switching tools or bypassing permissions. All raw evidence remains in this temporary directory.`;
fs.writeFileSync(path.join(root,'LEAD-PROMPT.txt'),prompt);
fs.writeFileSync(path.join(root,'run.json'),JSON.stringify({lead,root,pack,tools,specHash,created_at:new Date().toISOString()},null,2));
console.log(JSON.stringify({event:'prepared',lead,run:root,pack,tools}));
if(options.includes('--prepare-only'))process.exit(0);

const env={...process.env};delete env.CLAUDECODE;delete env.CLAUDE_CODE_ENTRYPOINT;delete env.CLAUDE_SESSION_ID;
let argv;
if(lead==='claude')argv=['--print','--allowedTools','Bash,Read,Edit,Write,Glob,Grep','--permission-mode','dontAsk','--output-format','stream-json','--verbose','--model','sonnet','--effort','high',prompt];
if(lead==='codex')argv=['exec','--json','--approve-for-me','-C',root,prompt];
if(lead==='opencode'){
  argv=['run','--model','opencode-go/deepseek-v4.1-flash#high','--format','json','--auto',prompt];
  env.OPENCODE_CONFIG_CONTENT=JSON.stringify({permissions:[{action:'read',resource:'*',effect:'allow'},{action:'edit',resource:root+'/**',effect:'allow'},{action:'shell',resource:'*',effect:'allow'},{action:'external_directory',resource:'*',effect:'allow'},{action:'subagent',resource:'*',effect:'deny'}]});
}
const stdout=fs.openSync(path.join(root,'lead.jsonl'),'a'),stderr=fs.openSync(path.join(root,'lead.stderr.log'),'a');
const child=spawn(runtimeBinary(lead),argv,{cwd:root,env,detached:true,stdio:['ignore','pipe',stderr]});fs.closeSync(stderr);
let pending='',nativeSession=null;
child.stdout.on('data',chunk=>{
 fs.writeSync(stdout,chunk);pending+=chunk.toString();
 for(;;){const i=pending.indexOf('\n');if(i<0)break;const line=pending.slice(0,i);pending=pending.slice(i+1);const ev=parseLine(line);if(!nativeSession&&ev?.sessionID){nativeSession=ev.sessionID;fs.writeFileSync(path.join(root,'lead-identity.json'),JSON.stringify({host:lead,session_id:nativeSession}));}}
});
const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}},20*60000);
const code=await new Promise(resolve=>{child.on('exit',resolve);child.on('error',error=>{fs.appendFileSync(path.join(root,'lead.stderr.log'),error.message);resolve(127);});});clearTimeout(timer);fs.closeSync(stdout);
let acceptanceResult={code:1,output:'not run'},tasks=[],errors=[];
try{
 const r=spawnSync(node,[path.join(root,'acceptance.mjs'),'all'],{cwd:root,encoding:'utf8',timeout:30000});acceptanceResult={code:r.status,output:(r.stdout||'')+(r.stderr||'')};
 const roster=JSON.parse(fs.readFileSync(path.join(pack,'control/roster.json'),'utf8'));
 tasks=roster.tasks.map(t=>({id:t.id,tool:t.tool,state:t.state,attempts:t.attempts,has_session:!!t.session_id,same_session_followup:t.id==='T1'?t.history?.length>=2&&!(t.previous_sessions||[]).length:null}));
 if(tasks.length!==3||tasks.some(t=>t.state!=='done'||!t.has_session))errors.push('not all three worker handbacks were accepted');
 if(!tasks.find(t=>t.id==='T1')?.same_session_followup)errors.push('same-session question/correction not demonstrated');
 const nowHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'acceptance.mjs'))).digest('hex');if(nowHash!==specHash)errors.push('acceptance specification changed');
}catch(error){errors.push(error.message);}
// Stop only processes belonging to this isolated fixture; preserve all evidence.
try{const r=JSON.parse(fs.readFileSync(path.join(pack,'control/roster.json'),'utf8'));for(const t of r.tasks)if(t.pid){try{process.kill(t.pid,0);spawnSync(node,[worker,'stop','--pack',pack,'--task',t.id,'--grace','1'],{encoding:'utf8',timeout:15000});}catch{}}}catch{}
spawnSync(node,[watch,'disable','--pack',pack,'--no-install'],{encoding:'utf8',timeout:15000});
const summary={kind:'live-lead-worker-harness',lead,platform:process.platform,node:process.version,lead_session_recorded:!!nativeSession,lead_exit:code,tasks,acceptance:acceptanceResult,errors,passed:code===0&&acceptanceResult.code===0&&!errors.length};
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({run:root,...summary},null,2));process.exitCode=summary.passed?0:1;
