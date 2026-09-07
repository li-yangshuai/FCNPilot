import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function fileContentBlock() {
  const start = source.indexOf("{/* Only the active viewer in each split group");
  const end = source.indexOf("</section>", start);
  assert.notEqual(start, -1, "file content comment not found");
  assert.notEqual(end, -1, "end of file content block not found");
  return source.slice(start, end);
}

test("only the active file tab in each split group mounts a FileViewer", () => {
  const block = fileContentBlock();
  assert.match(source, /const groupActiveTab = group\.tabs\.find\(\(tab\) => tab\.id === groupActiveId\) \?\? null/);
  assert.match(block, /groupActiveTab && groupActiveTab\.view !== "terminal"/);
  assert.doesNotMatch(block, /group\.tabs\.map\(/);
  assert.equal(block.match(/<FileViewer/g)?.length, 1);
});

test("each active viewer restores tab state and saves it with a revision", () => {
  const block = fileContentBlock();
  assert.match(block, /key=\{`\$\{groupActiveTab\.id\}:\$\{groupActiveTab\.viewerRevision \?\? 0\}`\}/);
  assert.match(block, /initialState=\{groupActiveTab\.viewerState\}/);
  assert.match(block, /handleFileViewerStateChange\(\s*groupActiveTab\.id,\s*groupActiveTab\.viewerRevision \?\? 0,/);
});

test("closing the file panel pauses the active viewer watcher", () => {
  assert.match(fileContentBlock(), /watchEnabled=\{rightPanelOpen\}/);
});
