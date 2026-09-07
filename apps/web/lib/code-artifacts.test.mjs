import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { extractLatestCodeArtifacts } = await jiti.import("./code-artifacts.ts");

function user(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(content) {
  return {
    role: "assistant",
    content,
    model: "test-model",
    provider: "test-provider",
  };
}

const cpp = [
  "#include <condition_variable>",
  "#include <functional>",
  "#include <mutex>",
  "#include <queue>",
  "#include <thread>",
  "#include <vector>",
  "class ThreadPool {",
  "public:",
  "  explicit ThreadPool(size_t count) {",
  "    for (size_t i = 0; i < count; ++i) {",
  "      workers.emplace_back([this] {",
  "        while (true) {",
  "          std::function<void()> task;",
  "          {",
  "            std::unique_lock<std::mutex> lock(mutex);",
  "            ready.wait(lock, [this] { return stopping || !tasks.empty(); });",
  "            if (stopping && tasks.empty()) return;",
  "            task = std::move(tasks.front());",
  "            tasks.pop();",
  "          }",
  "          task();",
  "        }",
  "      });",
  "    }",
  "  }",
  "private:",
  "  std::vector<std::thread> workers;",
  "  std::queue<std::function<void()>> tasks;",
  "  std::mutex mutex;",
  "  std::condition_variable ready;",
  "  bool stopping = false;",
  "};",
].join("\n");

test("restores a generated file when the final assistant summary follows its write", () => {
  const messages = [
    user("帮我写个200行c++多线程的代码"),
    assistant([{
      type: "toolCall",
      toolCallId: "call-write-cpp",
      toolName: "write",
      input: { path: "thread_pool_example.cpp", content: cpp },
    }]),
    {
      role: "toolResult",
      toolCallId: "call-write-cpp",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote the file" }],
    },
    assistant([{ type: "text", text: "代码已写入 thread_pool_example.cpp。" }]),
  ];

  const [artifact] = extractLatestCodeArtifacts(messages, null, "saved-session", { includeAll: true });
  assert.ok(artifact, "the saved conversation should restore its code pane");
  assert.equal(artifact.suggestedFileName, "thread_pool_example.cpp");
  assert.equal(artifact.language, "cpp");
  assert.equal(artifact.code, cpp);
  assert.equal(artifact.complete, true);
});

test("keeps the generated file while the final assistant summary is still streaming", () => {
  const messages = [
    user("帮我写个200行c++多线程的代码"),
    assistant([{
      type: "toolCall",
      toolCallId: "call-write-cpp-live-summary",
      toolName: "write",
      input: { path: "thread_pool_example.cpp", content: cpp },
    }]),
    {
      role: "toolResult",
      toolCallId: "call-write-cpp-live-summary",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote the file" }],
    },
  ];
  const streamingSummary = assistant([{ type: "text", text: "代码已经写入，接下来说明" }]);

  const [artifact] = extractLatestCodeArtifacts(messages, streamingSummary, "live-summary", { includeAll: true });
  assert.ok(artifact, "a streamed final summary must not close the generated-code pane");
  assert.equal(artifact.suggestedFileName, "thread_pool_example.cpp");
  assert.equal(artifact.code, cpp);
});

test("normalizes c++ fenced blocks to the cpp editor and file extension", () => {
  const messages = [
    user("写一个 C++ 多线程示例"),
    assistant([{ type: "text", text: `\`\`\`c++\n${cpp}\n\`\`\`` }]),
  ];

  const [artifact] = extractLatestCodeArtifacts(messages, null, "cpp-fence", { includeAll: true });
  assert.ok(artifact);
  assert.equal(artifact.language, "cpp");
  assert.equal(artifact.suggestedFileName, "amedac-artifact-1.cpp");
});

test("recognizes common Python and Shell scripts as generated code", () => {
  const python = Array.from({ length: 30 }, (_, index) => (
    `def worker_${index}(queue):\n    return queue.get()`
  )).join("\n\n");
  const shell = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ...Array.from({ length: 28 }, (_, index) => `run_step_${index}() { printf '%s\\n' '${index}'; }`),
  ].join("\n");

  for (const expected of [
    { info: "python3", code: python, language: "python", suffix: ".py" },
    { info: "shell", code: shell, language: "bash", suffix: ".sh" },
  ]) {
    const [artifact] = extractLatestCodeArtifacts([
      user("生成一个常见语言示例"),
      assistant([{ type: "text", text: `\`\`\`${expected.info}\n${expected.code}\n\`\`\`` }]),
    ], null, `common-${expected.language}`, { includeAll: true });

    assert.ok(artifact, `${expected.language} should open the generated-code pane`);
    assert.equal(artifact.language, expected.language);
    assert.ok(artifact.suggestedFileName.endsWith(expected.suffix));
  }
});

test("maps Python and Shell write tools into their side-panel editors", () => {
  const python = Array.from({ length: 30 }, (_, index) => `print("worker ${index}")`).join("\n");
  const shell = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ...Array.from({ length: 28 }, (_, index) => `printf '%s\\n' 'step ${index}'`),
  ].join("\n");

  for (const expected of [
    { file: "workers.py", code: python, language: "python" },
    { file: "build.sh", code: shell, language: "bash" },
  ]) {
    const [artifact] = extractLatestCodeArtifacts([
      user(`生成 ${expected.file}`),
      assistant([{
        type: "toolCall",
        toolCallId: `write-${expected.language}`,
        toolName: "write",
        input: { path: expected.file, content: expected.code },
      }]),
    ], null, `write-${expected.language}`, { includeAll: true });

    assert.ok(artifact, `${expected.file} should open the generated-code pane`);
    assert.equal(artifact.suggestedFileName, expected.file);
    assert.equal(artifact.language, expected.language);
    assert.equal(artifact.code, expected.code);
  }
});

test("does not restore an older code artifact after a new user turn starts", () => {
  const messages = [
    user("写一个 C++ 示例"),
    assistant([{ type: "text", text: `\`\`\`cpp\n${cpp}\n\`\`\`` }]),
    user("解释一下线程安全"),
  ];

  assert.deepEqual(
    extractLatestCodeArtifacts(messages, null, "new-turn", { includeAll: true }),
    [],
  );
});
