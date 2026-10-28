import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
const workflows = new URL("../../../.github/workflows/", import.meta.url);
const read = (name) => readFile(new URL(name, workflows), "utf8");
test("fork workflows default to the explicit self-hosted label without hosted fallback", async () => {
  for (const name of await readdir(workflows)) {
    const text = await read(name);
    assert.doesNotMatch(text, /runs-on:\s*ubuntu/);
    assert.match(
      text,
      /runs-on: \$\{\{ fromJSON\(vars\.EGO_LITE_RUNS_ON \|\| '\["arc-ego-lite"\]'\) \}\}/,
    );
    assert.doesNotMatch(text, /pull_request_target:/);
  }
});
test("self-hosted tests do not automatically run external-fork PR code", async () => {
  assert.match(
    await read("ci.yml"),
    /if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
});
test("upstream promotion, release and maintenance remain upstream-only", async () => {
  for (const name of [
    "main-pr-source.yml",
    "purge-camo-cache.yml",
    "star-history.yml",
  ])
    assert.match(
      await read(name),
      /if: github\.repository == 'citrolabs\/ego-lite'/,
    );
  assert.match(
    await read("ci.yml"),
    /release:\n\s+if: github\.repository == 'citrolabs\/ego-lite'/,
  );
});
