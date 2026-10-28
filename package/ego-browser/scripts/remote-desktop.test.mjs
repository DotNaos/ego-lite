import nodeTest from "node:test";
const test = process.platform === "linux" ? nodeTest : nodeTest.skip;
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  optionsFrom,
  readPassword,
  vncArguments,
  shellEnvironment,
  runCommand,
} from "./remote-desktop.mjs";

const base = ["--password-file", "/tmp/password"];
test("explicit private password file is required; unknown options are rejected", () => {
  assert.throws(() => optionsFrom([]), /password-file/);
  assert.throws(() => optionsFrom([...base, "--listen", "0.0.0.0"]));
  assert.equal(optionsFrom(["--help"]).help, true);
  assert.equal(optionsFrom(base).display, "99");
});
test("display and geometry are bounded and cannot become executable arguments", () => {
  for (const display of ["-1", ":2", "1;id", "10000", "abc"])
    assert.throws(() => optionsFrom([...base, `--display=${display}`]));
  for (const geometry of ["20x20", "9000x800", "800x9000", "1280x800;id"])
    assert.throws(() => optionsFrom([...base, "--geometry", geometry]));
  assert.equal(
    optionsFrom([...base, "--display", "9999", "--geometry", "1920x1080"])
      .geometry,
    "1920x1080",
  );
});
test("native VNC is Unix-only, authenticated and server-enforced view-only", () => {
  const args = vncArguments(optionsFrom(base), "/tmp/private desktop");
  for (const [key, value] of [
    ["-rfbport", "-1"],
    ["-rfbunixmode", "0600"],
    ["-SecurityTypes", "VncAuth"],
    ["-nolisten", "tcp"],
  ])
    assert.equal(args[args.indexOf(key) + 1], value);
  assert.ok(args.includes("-AcceptKeyEvents=0"));
  assert.ok(args.includes("-AcceptPointerEvents=0"));
  assert.ok(args.includes("-AcceptCutText=0"));
  assert.ok(args.includes("-SendCutText=0"));
  assert.ok(args.includes("/tmp/private desktop/vnc.sock"));
  assert.ok(!args.includes("None"));
});
test("shell environment preserves special characters without evaluating them", async () => {
  const expected = "one' $HOME $(id)\nend";
  const output = await runCommand("sh", [
    "-c",
    shellEnvironment({ TEST_VALUE: expected }) + 'printf "%s" "$TEST_VALUE"',
  ]);
  assert.equal(output, expected);
  assert.throws(() => shellEnvironment({ "BAD;id": "x" }));
});
test("password files reject permissive access, symlinks and wrong format", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-vnc-test-"));
  const password = join(dir, "passwd");
  try {
    await writeFile(password, Buffer.alloc(8, 7), { mode: 0o600 });
    assert.deepEqual(await readPassword(password), Buffer.alloc(8, 7));
    await chmod(password, 0o644);
    await assert.rejects(readPassword(password), /private/);
    await chmod(password, 0o600);
    await symlink(password, join(dir, "link"));
    await assert.rejects(readPassword(join(dir, "link")));
    await writeFile(password, "wrong");
    await assert.rejects(readPassword(password), /vncpasswd/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("child execution has an enforced deadline and propagates failure", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeout: 100,
    }),
    (error) =>
      error.cause?.signal === "SIGKILL" && error.cause?.killed === true,
  );
  await assert.rejects(runCommand(process.execPath, ["-e", "process.exit(7)"]));
});
