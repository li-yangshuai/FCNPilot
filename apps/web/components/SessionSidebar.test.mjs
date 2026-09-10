import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sidebarModule = { exports: {} };
vm.runInNewContext(compiled, { exports: sidebarModule.exports, require(name) {
  if (name === "react") return React;
  if (name === "react/jsx-runtime") return jsxRuntime;
  if (name === "./FcnPilotIcon") return { FcnPilotIcon: () => null };
  if (name === "./FileExplorer") return { FileExplorer: () => null };
  if (name === "./AppDialogProvider") return { useAppDialog: () => ({}) };
  if (name === "@/lib/shared-workspace") return { SHARED_ACCOUNT_IDENTITY: { uid: "test" } };
  throw new Error(`Unexpected sidebar dependency: ${name}`);
} });
const session = { id: "xor-run", cwd: "/fcn/engine", path: "/fcn/session.jsonl", name: "XOR 四相布局", created: "2026-09-07T00:00:00Z", modified: "2026-09-07T00:00:00Z", messageCount: 4, firstMessage: "XOR" };
const base = { cwd: "/fcn/engine", sessions: [session], selectedId: session.id, runningIds: new Set(), onSelect() {}, onNew() {}, onRefresh() {}, onSessionChanged() {}, onOpenFile() {}, onAtMention() {}, onAtMentions() {}, onFileDeleted() {}, onFileMoved() {}, fileRefresh: 0, beforeFileMutation: async () => true };
const render = (props = {}) => renderToStaticMarkup(React.createElement(sidebarModule.exports.SessionSidebar, { ...base, ...props }));
const control = (html, label) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] || "";

test("FCN sidebar shows circuit records and file navigation without generic management controls", () => {
  const html = render();
  assert.match(html, /XOR 四相布局/);
  assert.match(html, /设计记录/);
  assert.match(html, /电路文件/);
  assert.doesNotMatch(html, /worktree|MCP|插件|技能市场|Git/i);
});

test("a running design cannot be deleted through the sidebar", () => {
  assert.match(control(render({ runningIds: new Set([session.id]) }), "删除 XOR 四相布局"), /disabled/);
  assert.doesNotMatch(control(render(), "删除 XOR 四相布局"), /disabled/);
});

test("a transient design cannot invoke disk-backed rename or delete actions", () => {
  const html = render({ sessions: [{ ...session, transient: true }] });
  assert.match(control(html, "重命名 XOR 四相布局"), /disabled/);
  assert.match(control(html, "删除 XOR 四相布局"), /disabled/);
});

test("an unconfigured circuit workspace disables new design creation", () => {
  const html = render({ cwd: null, sessions: [] });
  assert.match(html, /<button[^>]*class="fcn-new-design"[^>]*disabled/);
  assert.doesNotMatch(html, /XOR 四相布局/);
});
