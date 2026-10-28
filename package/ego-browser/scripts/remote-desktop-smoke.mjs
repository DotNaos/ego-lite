#!/usr/bin/env node
// Opt-in real TigerVNC + Chrome fixture. Uses only disposable local data.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { runCommand } from "./remote-desktop.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "ego-vnc-smoke-"));
const password = randomBytes(4).toString("hex");
const passwordFile = join(temporary, "passwd");
const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(
    '<html><body style="background:#123456"><input id="entry"><button id="go" onclick="document.body.style.background=\'#654321\'">Change</button><script>window.keys=0;addEventListener("keydown",()=>window.keys++);</script></body></html>',
  );
});
let desktop, desktopEnded, rfb, ready;
let stderr = "";

// Only the tiny RFB 3.8 / VncAuth / raw-frame subset needed by this fixture.
async function connectViewer(path) {
  const socket = createConnection(path);
  socket.setTimeout(10000, () =>
    socket.destroy(new Error("RFB read timed out")),
  );
  let buffer = Buffer.alloc(0),
    pending,
    failure;
  const drain = () => {
    if (pending && buffer.length >= pending.length) {
      const request = pending;
      pending = undefined;
      const result = buffer.subarray(0, request.length);
      buffer = buffer.subarray(request.length);
      request.resolve(result);
    }
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });
  socket.on("error", (error) => {
    failure = error;
    pending?.reject(error);
  });
  socket.on("close", () => {
    failure ??= new Error("RFB disconnected");
    pending?.reject(failure);
  });
  const read = (length) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      assert.equal(pending, undefined);
      pending = { length, resolve, reject };
      drain();
    });
  try {
    assert.equal((await read(12)).toString(), "RFB 003.008\n");
    socket.write("RFB 003.008\n");
    const count = (await read(1))[0];
    assert.deepEqual(
      [...(await read(count))],
      [2],
      "authentication must not offer None",
    );
    socket.write(Buffer.from([2]));
    const challenge = await read(16);
    const reverse = (value) =>
      parseInt(
        value.toString(2).padStart(8, "0").split("").reverse().join(""),
        2,
      );
    const key = Buffer.from([...Buffer.from(password)].map(reverse));
    // Repeated 3DES keys implement DES without enabling OpenSSL's legacy provider.
    const cipher = createCipheriv(
      "des-ede3",
      Buffer.concat([key, key, key]),
      null,
    );
    cipher.setAutoPadding(false);
    socket.write(Buffer.concat([cipher.update(challenge), cipher.final()]));
    assert.equal(
      (await read(4)).readUInt32BE(),
      0,
      "VNC authentication failed",
    );
    socket.write(Buffer.from([1]));
    const init = await read(24);
    const width = init.readUInt16BE(0),
      height = init.readUInt16BE(2);
    await read(init.readUInt32BE(20));
    const format = Buffer.alloc(20);
    format[4] = 32;
    format[5] = 24;
    format[7] = 1;
    for (const offset of [8, 10, 12]) format.writeUInt16BE(255, offset);
    format[14] = 16;
    format[15] = 8;
    socket.write(format);
    socket.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])); // Raw encoding only.
    return {
      socket,
      async frame() {
        const request = Buffer.alloc(10);
        request[0] = 3;
        request.writeUInt16BE(width, 6);
        request.writeUInt16BE(height, 8);
        socket.write(request);
        assert.equal((await read(1))[0], 0);
        const header = await read(3);
        const rectangles = header.readUInt16BE(1);
        const frames = [];
        for (let i = 0; i < rectangles; i++) {
          const rectangle = await read(12);
          assert.equal(rectangle.readInt32BE(8), 0);
          frames.push(
            await read(
              rectangle.readUInt16BE(4) * rectangle.readUInt16BE(6) * 4,
            ),
          );
        }
        return Buffer.concat(frames);
      },
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

try {
  const encrypted = await new Promise((resolve, reject) => {
    const child = execFile(
      process.env.EGO_VNCPASSWD_BIN || "tigervncpasswd",
      ["-f"],
      { encoding: "buffer", timeout: 5000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin.end(password + "\n");
  });
  await writeFile(passwordFile, encrypted, { mode: 0o600 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  desktop = spawn(
    process.execPath,
    [
      join(root, "scripts/remote-desktop.mjs"),
      "--password-file",
      passwordFile,
      "--display",
      process.env.EGO_TEST_DISPLAY || "199",
      "--geometry",
      "1024x768",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  desktop.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-8000);
  });
  desktopEnded = once(desktop, "exit");
  let output = "";
  ready = await Promise.race([
    new Promise((resolve, reject) => {
      desktop.stdout.on("data", (data) => {
        output += data;
        if (output.includes("\n")) {
          try {
            resolve(JSON.parse(output.split("\n")[0]));
          } catch (error) {
            reject(error);
          }
        }
      });
    }),
    desktopEnded.then(([code]) => {
      throw new Error(`Desktop exited before ready: ${code}\n${stderr}`);
    }),
    sleep(40000, undefined, { ref: false }).then(() => {
      throw new Error(`Desktop startup timeout\n${stderr}`);
    }),
  ]);
  assert.equal(ready.viewOnly, true);
  assert.equal((await lstat(ready.socket)).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(ready.socket))).mode & 0o777, 0o700);
  assert.equal((await lstat(ready.envFile)).mode & 0o777, 0o600);
  // Read only this launcher's freshly generated, owner-private environment.
  const sessionEnv = {};
  for (const line of (await readFile(ready.envFile, "utf8")).split("\n")) {
    const match = /^export ([A-Z_]+)='([^']*)'$/.exec(line);
    if (match) sessionEnv[match[1]] = match[2];
  }
  for (const key of [
    "DISPLAY",
    "XAUTHORITY",
    "EGO_LINUX",
    "EGO_LINUX_HEADLESS",
    "EGO_LINUX_STATE_DIR",
    "EGO_BROWSER_STATE_DIR",
    "EGO_BROWSER_AGENT_WORKSPACE",
  ])
    assert.equal(
      typeof sessionEnv[key],
      "string",
      "Cannot parse private test environment: " + key,
    );
  const env = { ...process.env, ...sessionEnv };
  delete env.WAYLAND_DISPLAY;
  delete env.EGO_LINUX_PORT;
  const run = (input) =>
    runCommand(process.execPath, [join(root, "dist/out/index.js"), "nodejs"], {
      env,
      input,
      cwd: temporary,
      timeout: 15000,
    });
  await run(
    `const task=await taskSpace('remote-prototype');const page=task.page('p1');await page.goto(${JSON.stringify(url)});await page.click('loc=css:#go');await page.evaluate(()=>document.querySelector('#entry').focus());`,
  );
  rfb = await connectViewer(ready.socket);
  let matchingPixels = 0;
  for (let attempt = 0; attempt < 5 && matchingPixels < 10000; attempt++) {
    const frame = await rfb.frame();
    matchingPixels = 0;
    for (let i = 0; i < frame.length; i += 4)
      if (frame[i] === 0x21 && frame[i + 1] === 0x43 && frame[i + 2] === 0x65)
        matchingPixels++;
    if (matchingPixels < 10000) await sleep(200);
  }
  assert.ok(
    matchingPixels > 10000,
    "VNC must show the page changed by this SDK session",
  );
  rfb.socket.destroy();
  rfb = await connectViewer(ready.socket);
  assert.ok((await rfb.frame()).length > 0, "same desktop reconnect");
  const key = Buffer.alloc(8);
  key[0] = 4;
  key[1] = 1;
  key.writeUInt32BE(0x78, 4);
  rfb.socket.write(key);
  rfb.socket.write(Buffer.from([4, 0, 0, 0, 0, 0, 0, 0x78]));
  await sleep(100);
  const value = await run(
    "const task=await taskSpace('remote-prototype');console.log(JSON.stringify(await task.page('p1').evaluate(()=>({keys:window.keys,value:document.querySelector('#entry').value}))));",
  );
  assert.deepEqual(JSON.parse(value.trim()), { keys: 0, value: "" });
  rfb.socket.destroy();
  desktop.kill("SIGTERM");
  const [code] = await desktopEnded;
  assert.equal(code, 0, stderr);
  await assert.rejects(lstat(dirname(ready.socket)), { code: "ENOENT" });
  console.log(
    JSON.stringify({
      status: "passed",
      checks: [
        "sandboxed headed Chrome",
        "private authenticated native VNC",
        "SDK click visible in same framebuffer",
        "same-desktop reconnect",
        "remote keyboard blocked in view-only mode",
        "SIGTERM cleans SDK and display",
      ],
      matchingPixels,
    }),
  );
} finally {
  rfb?.socket.destroy();
  if (
    desktop?.pid &&
    desktop.exitCode === null &&
    desktop.signalCode === null
  ) {
    desktop.kill("SIGTERM");
    await Promise.race([desktopEnded, sleep(12000)]);
    if (desktop.exitCode === null && desktop.signalCode === null)
      desktop.kill("SIGKILL");
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
