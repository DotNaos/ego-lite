#!/usr/bin/env node
// Temporary, observation-only desktop. No public TCP listener or personal profile.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist/out/index.js");

export function optionsFrom(args) {
  const { values } = parseArgs({
    args,
    options: {
      "password-file": { type: "string" },
      display: { type: "string", default: "99" },
      geometry: { type: "string", default: "1280x800" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return values;
  if (!values["password-file"]) throw new Error("--password-file is required");
  if (!/^(0|[1-9]\d{0,3})$/.test(values.display))
    throw new Error("--display must be an integer between 0 and 9999");
  const size = /^(\d+)x(\d+)$/.exec(values.geometry);
  if (
    !size ||
    +size[1] < 320 ||
    +size[1] > 7680 ||
    +size[2] < 240 ||
    +size[2] > 4320
  )
    throw new Error(
      "--geometry must be WIDTHxHEIGHT between 320x240 and 7680x4320",
    );
  return { ...values, "password-file": resolve(values["password-file"]) };
}

export async function readPassword(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o077 ||
      ![8, 16].includes(stat.size)
    )
      throw new Error(
        "VNC password file must be owned by this user, private (0600), and created by vncpasswd",
      );
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export function vncArguments(options, directory) {
  return [
    `:${options.display}`,
    "-geometry",
    options.geometry,
    "-depth",
    "24",
    "-nolisten",
    "tcp",
    "-auth",
    join(directory, "Xauthority"),
    "-rfbport",
    "-1",
    "-rfbunixpath",
    join(directory, "vnc.sock"),
    "-rfbunixmode",
    "0600",
    "-SecurityTypes",
    "VncAuth",
    "-PasswordFile",
    join(directory, "passwd"),
    "-AcceptKeyEvents=0",
    "-AcceptPointerEvents=0",
    "-AcceptCutText=0",
    "-SendCutText=0",
  ];
}

export function shellEnvironment(env) {
  return (
    Object.entries(env)
      .map(([key, value]) => {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key))
          throw new Error("Invalid environment key");
        return `export ${key}='${String(value).replaceAll("'", "'\"'\"'")}'`;
      })
      .join("\n") + "\n"
  );
}

export function runCommand(
  file,
  args,
  { input = "", env = process.env, cwd = root, signal, timeout = 10000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { env, cwd, signal, timeout, killSignal: "SIGKILL", maxBuffer: 65536 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(`${file}: ${error.message}\n${stderr.slice(-2000)}`, {
              cause: error,
            }),
          );
        else resolve(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function hostSocket(directory) {
  const entries = await readdir(join(directory, "sdk")).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const sockets = [];
  for (const entry of entries.filter((name) => /^[a-f0-9]{16}$/.test(name))) {
    const path = join(directory, "sdk", entry, "host.sock");
    if ((await lstat(path).catch(() => null))?.isSocket()) sockets.push(path);
  }
  if (sockets.length > 1)
    throw new Error("Ambiguous SDK host in private runtime directory");
  return sockets[0];
}

export async function startDesktop(options) {
  if (process.platform !== "linux" || process.getuid() === 0)
    throw new Error(
      "Run as an unprivileged Linux user; the Chrome sandbox is required",
    );
  await lstat(cli); // Fail before starting a desktop when the checkout is not built.
  const password = await readPassword(options["password-file"]);
  for (const path of [
    `/tmp/.X${options.display}-lock`,
    `/tmp/.X11-unix/X${options.display}`,
  ]) {
    if (
      await lstat(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      })
    )
      throw new Error(
        `Display :${options.display} is already occupied; choose another --display`,
      );
  }
  const directory = await mkdtemp(join(tmpdir(), "ego-remote-"));
  const ownedEnv = {
    DISPLAY: `:${options.display}`,
    XAUTHORITY: join(directory, "Xauthority"),
    EGO_LINUX: "1",
    EGO_LINUX_HEADLESS: "0",
    EGO_LINUX_STATE_DIR: join(directory, "sdk"),
    EGO_BROWSER_STATE_DIR: join(directory, "pages"),
    EGO_BROWSER_AGENT_WORKSPACE: join(directory, "workspace"),
    ...(process.env.EGO_CHROME_BIN
      ? { EGO_CHROME_BIN: process.env.EGO_CHROME_BIN }
      : {}),
  };
  const env = { ...process.env, ...ownedEnv };
  delete env.WAYLAND_DISPLAY;
  delete env.EGO_LINUX_PORT;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let vnc,
    vncEnded,
    monitor,
    cleanupFailed = false;
  let vncError = "";
  try {
    if (
      Buffer.byteLength(join(directory, "sdk", "0".repeat(16), "host.sock")) >
      100
    )
      throw new Error("TMPDIR is too long for private Unix sockets");
    await mkdir(ownedEnv.EGO_BROWSER_AGENT_WORKSPACE, { mode: 0o700 });
    await writeFile(join(directory, "passwd"), password, { mode: 0o600 });
    await writeFile(ownedEnv.XAUTHORITY, "", { mode: 0o600 });
    await runCommand("xauth", ["-f", ownedEnv.XAUTHORITY, "source", "-"], {
      input: `add ${ownedEnv.DISPLAY} MIT-MAGIC-COOKIE-1 ${randomBytes(16).toString("hex")}\n`,
      signal: controller.signal,
    });
    vnc = spawn(
      process.env.EGO_VNC_BIN || "Xtigervnc",
      vncArguments(options, directory),
      {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    vnc.stderr.on("data", (data) => {
      vncError = (vncError + data).slice(-2000);
    });
    vncEnded = new Promise((resolve) => {
      vnc.once("error", (error) => resolve(error));
      vnc.once("exit", (code, signal) =>
        resolve(new Error(`VNC exited (${code ?? signal}). ${vncError}`)),
      );
    });
    const displayReady = async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        controller.signal.throwIfAborted();
        try {
          await runCommand("xdpyinfo", [], {
            env,
            signal: controller.signal,
            timeout: 500,
          });
          return;
        } catch {}
        await sleep(100, undefined, { signal: controller.signal });
      }
      throw new Error(`VNC display did not become ready. ${vncError}`);
    };
    await Promise.race([
      displayReady(),
      vncEnded.then((error) => {
        throw error;
      }),
    ]);
    await runCommand(process.execPath, [cli, "nodejs"], {
      env,
      cwd: directory,
      signal: controller.signal,
      timeout: 30000,
      input:
        'const task = await taskSpace("remote-prototype"); await task.page("p1").goto("about:blank"); console.log("ready");',
    });
    const socket = await hostSocket(directory);
    if (!socket) throw new Error("SDK host did not leave a private socket");
    monitor = createConnection(socket);
    monitor.resume(); // Hold the owned host alive and detect a browser/host crash.
    const hostEnded = new Promise((resolve) => {
      monitor.once("error", resolve);
      monitor.once("close", () => resolve(new Error("SDK host disconnected")));
    });
    await Promise.race([
      new Promise((resolve) => monitor.once("connect", resolve)),
      hostEnded.then((error) => {
        throw error;
      }),
    ]);
    const envFile = join(directory, "session.env");
    await writeFile(
      envFile,
      "unset WAYLAND_DISPLAY EGO_LINUX_PORT\n" + shellEnvironment(ownedEnv),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        status: "ready",
        display: env.DISPLAY,
        socket: join(directory, "vnc.sock"),
        envFile,
        viewOnly: true,
        task: "remote-prototype",
      }),
    );
    await Promise.race([
      new Promise((resolve) => {
        if (controller.signal.aborted) resolve();
        else
          controller.signal.addEventListener("abort", resolve, { once: true });
      }),
      vncEnded.then((error) => {
        throw error;
      }),
      hostEnded.then((error) => {
        throw error;
      }),
    ]);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    controller.abort();
    monitor?.destroy();
    try {
      if (await hostSocket(directory))
        await runCommand(process.execPath, [cli, "stop"], {
          env,
          cwd: directory,
          timeout: 8000,
        });
    } catch (error) {
      cleanupFailed = true;
      console.error(
        `SDK cleanup failed; private runtime retained at ${directory}: ${error.message}`,
      );
      process.exitCode = 1;
    }
    if (vnc?.pid && vnc.exitCode === null && vnc.signalCode === null) {
      vnc.kill("SIGTERM");
      await Promise.race([vncEnded, sleep(2000)]);
      if (vnc.exitCode === null && vnc.signalCode === null) {
        vnc.kill("SIGKILL");
        await vncEnded;
      }
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (!cleanupFailed) await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const options = optionsFrom(process.argv.slice(2));
    if (options.help)
      console.log(
        "Usage: node scripts/remote-desktop.mjs --password-file FILE [--display 99] [--geometry 1280x800]\nRequires a built SDK, sandboxed Chrome, Xtigervnc, xauth and xdpyinfo. Native VNC via SSH to the printed Unix socket; observation only.",
      );
    else await startDesktop(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
