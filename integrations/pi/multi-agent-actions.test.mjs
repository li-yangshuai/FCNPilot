import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Read the real adapter and replace only SDK types and spawn with in-process mocks.
// No Python process, native circuit tool or provider transport is launched.
const directory=await mkdtemp(join(tmpdir(),"ifcn-runtime-offline-"));
const calls=[];
globalThis.__ifcnOfflineSpawn=(_exe,args)=>{
  calls.push(args);const child=new EventEmitter();
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
  queueMicrotask(()=>{child.stdout.emit("data",JSON.stringify({run_id:"a".repeat(32)}));child.emit("close",0);});
  return child;
};
const source=await readFile(new URL("./extension.ts",import.meta.url),"utf8");
const stripped=stripTypeScriptTypes(source,{mode:"strip"})
  .replace('import { spawn } from "node:child_process";', 'const spawn=globalThis.__ifcnOfflineSpawn;')
  .replace('import { Type, StringEnum } from "@earendil-works/pi-ai";',
    'const Type=new Proxy({}, {get:()=>value=>value}); const StringEnum=values=>values;');
const file=join(directory,"extension.mock.mjs");await writeFile(file,stripped);
const adapter=await import(pathToFileURL(file));
const tools=new Map();adapter.default({registerTool:tool=>tools.set(tool.name,tool)});
const tool=tools.get("ifcn_run");
const ctx={model:{provider:"deepseek",id:"deepseek-flash"}};
const invoke=params=>tool.execute("offline",params,undefined,()=>{},ctx);
const value=(args,flag)=>args[args.indexOf(flag)+1];

try {
  await test("Construction is offline unless model calls are enabled",async()=>{
    await invoke({action:"multi_agent",input:"/circuit.v",research_budget_s:20,max_attempts:16,max_nodes:149});
    const args=calls.at(-1);assert.ok(args.includes("multi_agent"));assert.equal(value(args,"--attempts"),"16");
    assert.equal(args.includes("--provider"),false);assert.equal(args.includes("--model-id"),false);
    await invoke({action:"multi_agent",input:"/circuit.v",max_model_calls:3});
    assert.equal(value(calls.at(-1),"--provider"),"deepseek");assert.equal(value(calls.at(-1),"--max-model-calls"),"3");
  });
  await test("Repair freezes explicit inputs and passes bounded settings",async()=>{
    await invoke({action:"clock_repair",input:"/circuit.v",snapshot:"/failed.json",reference:"/legal.json",max_contracts:4});
    const args=calls.at(-1);assert.equal(value(args,"--snapshot"),"/failed.json");assert.equal(value(args,"--reference"),"/legal.json");
    assert.equal(value(args,"--condition"),"clock_window");assert.equal(value(args,"--max-contracts"),"4");
  });
  await test("Ambiguous cross-mode options and implicit model repair are rejected",async()=>{
    const rejected=[{action:"clock_repair",input:"/c.v"},
      {action:"clock_repair",input:"/c.v",snapshot:"/s.json",repair_condition:"llm_negotiated"},
      {action:"clock_repair",input:"/c.v",snapshot:"/s.json",max_model_calls:3},
      {action:"multi_agent",input:"/c.v",until:"map"},
      {action:"multi_agent",input:"/c.v",snapshot:"/s.json"},
      {action:"start",input:"/c.v",max_model_calls:0}];
    const before=calls.length;for(const params of rejected)await assert.rejects(invoke(params));
    assert.equal(calls.length,before);
  });
} finally {await rm(directory,{recursive:true,force:true});delete globalThis.__ifcnOfflineSpawn;}
