// Import the light renderer directly. The package root is a CommonJS barrel
// that also pulls in the full renderer, every bundled language and all themes.
import PrismLight from "react-syntax-highlighter/dist/cjs/prism-light";
import bash from "react-syntax-highlighter/dist/cjs/languages/prism/bash";
import c from "react-syntax-highlighter/dist/cjs/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/cjs/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/cjs/languages/prism/csharp";
import css from "react-syntax-highlighter/dist/cjs/languages/prism/css";
import docker from "react-syntax-highlighter/dist/cjs/languages/prism/docker";
import go from "react-syntax-highlighter/dist/cjs/languages/prism/go";
import java from "react-syntax-highlighter/dist/cjs/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/cjs/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/cjs/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/cjs/languages/prism/jsx";
import kotlin from "react-syntax-highlighter/dist/cjs/languages/prism/kotlin";
import markup from "react-syntax-highlighter/dist/cjs/languages/prism/markup";
import markdown from "react-syntax-highlighter/dist/cjs/languages/prism/markdown";
import php from "react-syntax-highlighter/dist/cjs/languages/prism/php";
import powershell from "react-syntax-highlighter/dist/cjs/languages/prism/powershell";
import python from "react-syntax-highlighter/dist/cjs/languages/prism/python";
import ruby from "react-syntax-highlighter/dist/cjs/languages/prism/ruby";
import rust from "react-syntax-highlighter/dist/cjs/languages/prism/rust";
import sql from "react-syntax-highlighter/dist/cjs/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/cjs/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/cjs/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/cjs/languages/prism/yaml";
import vsTheme from "react-syntax-highlighter/dist/cjs/styles/prism/vs";
import vscDarkPlusTheme from "react-syntax-highlighter/dist/cjs/styles/prism/vsc-dark-plus";

const languages = {
  bash,
  c,
  cpp,
  csharp,
  css,
  docker,
  go,
  java,
  javascript,
  json,
  jsx,
  kotlin,
  markup,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  sql,
  tsx,
  typescript,
  yaml,
};

for (const [name, language] of Object.entries(languages)) {
  PrismLight.registerLanguage(name, language);
}

PrismLight.registerLanguage("html", markup);
PrismLight.registerLanguage("dockerfile", docker);
PrismLight.registerLanguage("py", python);
PrismLight.registerLanguage("shell", bash);
PrismLight.registerLanguage("sh", bash);
PrismLight.registerLanguage("ts", typescript);
PrismLight.registerLanguage("js", javascript);

export const SyntaxHighlighter = PrismLight;
export const vs = vsTheme;
export const vscDarkPlus = vscDarkPlusTheme;
