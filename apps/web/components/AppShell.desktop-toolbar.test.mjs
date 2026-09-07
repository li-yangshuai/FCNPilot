import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const appShellFile = new URL("./AppShell.tsx", import.meta.url);
const globalsFile = new URL("../app/globals.css", import.meta.url);

function getStaticClassName(node, sourceFile) {
  const attribute = node.openingElement.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "className",
  );
  return attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isStringLiteral(attribute.initializer)
    ? attribute.initializer.text
    : null;
}

function findJsxElementsByClass(sourceFile, className) {
  const matches = [];
  const visit = (node) => {
    if (ts.isJsxElement(node) && getStaticClassName(node, sourceFile) === className) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

function closestJsxElementAncestor(node) {
  let current = node.parent;
  while (current) {
    if (ts.isJsxElement(current)) return current;
    current = current.parent;
  }
  return null;
}

test("desktop removes the legacy chat toolbar while mobile keeps its compact controls", async () => {
  const [appShell, globals] = await Promise.all([
    readFile(appShellFile, "utf8"),
    readFile(globalsFile, "utf8"),
  ]);

  assert.match(appShell, /className="legacy-chat-topbar"[^>]*ref=\{topBarRef\}/);
  assert.match(
    globals,
    /@media \(min-width: 641px\)[\s\S]*?\.legacy-chat-topbar > :not\(\.top-panel-host\)\s*\{\s*display: none !important;/,
  );
  assert.match(appShell, /data-mobile-toolbar="true"/);

  const sourceFile = ts.createSourceFile(
    appShellFile.pathname,
    appShell,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const [legacyTopbar] = findJsxElementsByClass(sourceFile, "legacy-chat-topbar");
  const topPanelHosts = findJsxElementsByClass(sourceFile, "top-panel-host");
  assert.ok(legacyTopbar, "expected one legacy chat toolbar wrapper");
  assert.equal(topPanelHosts.length, 1, "expected one shared top-panel host");
  assert.equal(
    closestJsxElementAncestor(topPanelHosts[0]),
    legacyTopbar,
    "top-panel host must be a direct JSX child so desktop CSS does not hide it with the toolbar row",
  );
});
