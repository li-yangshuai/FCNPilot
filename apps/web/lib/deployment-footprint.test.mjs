import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const projectFile = (name) => new URL(`../${name}`, import.meta.url);

async function sourceFiles(directory) {
  const names = await readdir(projectFile(directory), { recursive: true });
  return names
    .filter((name) => /\.[cm]?[jt]sx?$/.test(name))
    .map((name) => new URL(name, projectFile(`${directory}/`)));
}

test("keeps Sharp out of deployment bundles while next/image is unused", async () => {
  const files = [
    ...(await sourceFiles("app")),
    ...(await sourceFiles("components")),
  ];
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));

  assert.equal(sources.some((source) => /(?:from|require\()\s*["']next\/image/.test(source)), false);

  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });
  assert.equal(config.images?.unoptimized, true);
});

test("ships only modern WOFF2 KaTeX fonts", async () => {
  const css = await readFile(projectFile("app/katex-woff2.css"), "utf8");
  const katexPackage = JSON.parse(await readFile(projectFile("node_modules/katex/package.json"), "utf8"));

  assert.equal((css.match(/\.woff2\)/g) ?? []).length, 20);
  assert.doesNotMatch(css, /\.(?:woff|ttf)\)/);
  assert.match(css, new RegExp(`KaTeX ${katexPackage.version.replaceAll(".", "\\.")} CSS`));
});

test("keeps local editor tokenizers for circuit sources and supporting files", async () => {
  const editor = await readFile(projectFile("components/MonacoCodeEditor.tsx"), "utf8");
  const contributions = [...editor.matchAll(/basic-languages\/([^/]+)\/\1\.contribution\.js/g)]
    .map((match) => match[1]);

  assert.deepEqual(contributions, [
    "cpp", "css", "html", "javascript", "markdown", "python", "shell", "typescript", "xml", "yaml",
  ]);
  assert.match(editor, /id: "verilog", extensions: \["\.v", "\.vh", "\.sv", "\.svh"\]/);
  assert.doesNotMatch(editor, /fetch\(|code-intelligence|registerInlineCompletionsProvider/);
});

test("loads the browser-only workspace shell without duplicating it in SSR", async () => {
  const clientApp = await readFile(projectFile("components/ClientApp.tsx"), "utf8");

  assert.match(clientApp, /dynamic\([\s\S]*import\("\.\/AppShell"\)/);
  assert.match(clientApp, /ssr: false/);
  assert.doesNotMatch(clientApp, /import \{ AppShell \} from "\.\/AppShell"/);
});
