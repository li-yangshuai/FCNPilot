import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getLocalePlugin } = await jiti.import("./registry.ts");
const { interpolateMessage } = await jiti.import("./format.ts");
const en = getLocalePlugin("en").messages;
const zh = getLocalePlugin("zh-CN").messages;
const fcnKeys = (messages) => Object.keys(messages).filter((key) => key.startsWith("fcn.")).sort();
const placeholders = (message) => [...new Set([...message.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]))].sort();

test("FCN workspace messages exist in both registered languages", () => {
  assert.ok(fcnKeys(en).length > 0, "FCN messages must be registered");
  assert.deepEqual(fcnKeys(en), fcnKeys(zh));
  for (const key of fcnKeys(en)) {
    // English does not need the Chinese generic counter “个”.
    if (key !== "fcn.results.count.unit") assert.ok(en[key].trim(), `${key}: empty English message`);
    assert.ok(zh[key].trim(), `${key}: empty Chinese message`);
  }
});

test("FCN translations retain the same interpolation parameters", () => {
  for (const key of fcnKeys(en)) {
    const names = placeholders(en[key]);
    assert.deepEqual(names, placeholders(zh[key]), `${key}: translated parameters differ`);
    const params = Object.fromEntries(names.map((name) => [name, "42"]));
    for (const message of [en[key], zh[key]]) {
      assert.equal(placeholders(interpolateMessage(message, params)).length, 0, key);
    }
  }
});
