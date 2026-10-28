# Linux remote prototype

This fork runs the open-source **Ego SDK against a separate Chrome/Chromium**.
It is not the closed-source Ego Lite application or its native Spaces UI.
The first increment is a Linux process/desktop prototype, suitable for testing
inside a dedicated Linux VM. It does **not** create a VM, ship a validated
container image, deploy a service, or replace an existing browser provider.

## What works, and what does not

- The imported Linux SDK owns its Chrome process through a private DevTools
  pipe and a private Unix socket. Task contexts are separated during that
  process's lifetime. The browser sandbox is not disabled.
- `scripts/remote-desktop.mjs` starts a separate TigerVNC X display, a fresh
  browser, and a task named `remote-prototype`. It refuses an occupied display.
- The VNC server has **no TCP listener**. Its Unix socket and authentication
  files are owner-private. Use an authenticated SSH tunnel to that socket.
- **Observation only:** keyboard, pointer and clipboard input are disabled on
  the VNC server, not just in the viewer. The SDK can operate the browser;
  concurrent human input is not enabled until the ownership gate in [#3] is
  implemented. There is no automatic takeover merely by connecting a viewer.
- Disconnecting/reconnecting the viewer retains the running session. Stopping
  the launcher stops the SDK host and X display and removes its temporary state.
- **Task cookies, storage and tabs are ephemeral.** A restart is not persistent
  login recovery, and mounting the current state directory would not fix that.
  Durable profiles are tracked in [#2].
- VNC is replaceable scaffolding. No WAN latency comparison, RDP evaluation,
  WebRTC integration, mobile acceptance or production acceptance is claimed.
  Those belong to [#4].

The VM/container boundary must be provided separately. A separate X display
and Unix permissions do not isolate mutually untrusted agents running as the
same OS user. Use only harmless fixtures at this stage; do not import a personal
browser profile or log in to sensitive accounts.

## Prerequisites

Use an unprivileged Linux user, Node.js 22+, npm, sandbox-capable Chrome or
Chromium, TigerVNC's `Xtigervnc` and `tigervncpasswd`, `xauth`, and `xdpyinfo`.
On Debian/Ubuntu the desktop tools are normally provided by
`tigervnc-standalone-server`, `tigervnc-tools`, `xauth`, and `x11-utils`.
Install prerequisites through the host's approved setup process; this launcher
never installs packages or changes host permissions.

From `package/ego-browser`:

```sh
npm ci
npm run build
```

For a nonstandard Chrome location set `EGO_CHROME_BIN` to its executable.
`EGO_VNC_BIN` can select a nonstandard `Xtigervnc` executable. These are executable
paths, not shell commands. Do not add `--no-sandbox` or run as root to work around
an unsupported environment.

## Start and view

Create a private password file using TigerVNC's interactive password tool;
never put its plaintext password in a command line or commit it:

```sh
install -d -m 700 "$HOME/.config/ego-remote"
umask 077
tigervncpasswd "$HOME/.config/ego-remote/passwd"
chmod 600 "$HOME/.config/ego-remote/passwd"

npm run remote:desktop -- \
  --password-file "$HOME/.config/ego-remote/passwd" \
  --display 99 --geometry 1280x800
```

The launcher stays in the foreground. Use a free X display number; it will never
attach to an existing display. Its JSON readiness line reports `socket`,
`envFile`, `display`, and `viewOnly: true`. The paths are unique to that launch.
The runtime defaults to a private directory under `/tmp`; very long `TMPDIR`
paths are rejected because Unix socket paths have a length limit.

On the viewing computer, replace the sample socket path with the exact returned
one and use an existing authorized SSH account on the Linux host:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:15900:/tmp/ego-remote-XXXXXX/vnc.sock user@linux-host
```

Connect a native VNC viewer to `127.0.0.1:15900` and enter the VNC password.
Some viewers use `127.0.0.1::15900` to specify an absolute port. Keep the local
forward bound to loopback. VncAuth is not transport encryption; SSH provides the
encrypted remote connection. Neither CDP nor a VNC TCP port is exposed on the
Linux host. Do not change the server to `SecurityTypes=None`.

In a **second shell on that Linux host**, source only this launcher's returned,
owner-private environment file, then run the built SDK from the same checkout:

```sh
# Replace this path with the exact envFile from the readiness response.
. /tmp/ego-remote-XXXXXX/session.env
node /absolute/path/to/ego-lite/package/ego-browser/dist/out/index.js nodejs <<'JS'
const task = await taskSpace('remote-prototype');
const page = task.page('p1');
console.log(await page.snapshot({scope: 'only_within_viewport'}));
JS
```

The environment selects the **same** SDK host and X display. Do not rebuild or
change the SDK/browser executable while this launcher is running: stop it first.
Ctrl-C (or SIGTERM) stops the launcher and its owned runtime; it does not stop
other browser sessions. If SDK cleanup fails, the launcher reports failure and
retains the private runtime directory for diagnosis rather than pretending it
removed a live host. There is no installed background service.

## Verification

From `package/ego-browser`:

```sh
npm test
npm run style:check
npm run validate:site-skills

# Opt-in: these use fresh local fixtures, never an existing personal browser.
node scripts/linux-smoke.mjs
node scripts/linux-smoke.mjs --headed
npm run test:remote-live
```

The headed Linux smoke also needs Xvfb. The remote-desktop smoke needs the VNC
prerequisites above, and uses display 199 by default; `EGO_TEST_DISPLAY` chooses
another free number. `EGO_VNCPASSWD_BIN` selects a nonstandard `tigervncpasswd`.
It creates a disposable test password, authenticates an RFB viewer, confirms that
an SDK click changes the **same framebuffer**, reconnects, verifies remote
keyboard rejection, then tests SIGTERM cleanup. No real credentials are used.
The default unit suite does not start a desktop.

Initial local validation on 2026-10-28: 553 SDK/workflow tests, six desktop unit tests and three fork-CI checks;
real Chrome headless/Xvfb smoke; native TigerVNC 1.15.0 authentication, matching
SDK/VNC framebuffer, view-only keyboard rejection and cleanup. See the PR for
the final revision and complete results. These are local test results, not a
GitHub Actions or deployed-service certification. Human client usability and
network latency have not been measured.

## Provenance and follow-up

The Linux runtime and its existing tests are adapted from
[citrolabs/ego-lite#291](https://github.com/citrolabs/ego-lite/pull/291), revision
`7bb1545912bf7e7bdf4239a321d36af0e68cb65c`, by Seth Wilson and contributors, under
the repository's MIT license. Only the runtime, build hook, guide note and Linux
smoke/doctor checks were imported. Upstream installer, release workflow and
unrelated README changes were not imported. Existing copyright notices remain.
The fork's source baseline is `aecc5831fc5a9ea01a078b632185992a3a7ac448` on `main`.

- [#1]: initial SDK and remote desktop prototype.
- [#2]: persistent agent profiles and restart recovery.
- [#3]: same-session Remote Space integration and enforced human takeover.
- [#4]: measured VNC/RDP comparison and direct-streaming replacement.
- [#5]: self-hosted CI registration and fork delivery policy.

Fork CI defaults to the proposed repository-specific `arc-ego-lite` label.
`EGO_LITE_RUNS_ON` is an optional **owner-controlled** JSON placement override;
there is no hosted fallback and no variable is set by this prototype. An actual
runner registration and green run still need verification under [#5]. External
fork PR code is not automatically executed by the self-hosted test job. The
upstream main-from-dev promotion guard and upstream maintenance/release jobs are
limited to the upstream repository; this fork's first implementation is reviewed
as a feature PR against its own `main`, without merging or releasing it here.

[#1]: https://github.com/DotNaos/ego-lite/issues/1
[#2]: https://github.com/DotNaos/ego-lite/issues/2
[#3]: https://github.com/DotNaos/ego-lite/issues/3
[#4]: https://github.com/DotNaos/ego-lite/issues/4
[#5]: https://github.com/DotNaos/ego-lite/issues/5

Protocol references: [TigerVNC Xvnc](https://tigervnc.org/doc/Xvnc.html) and
[OpenSSH local forwarding](https://man.openbsd.org/ssh.1#L).
