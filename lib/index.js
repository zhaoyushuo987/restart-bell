/**
 * restart-bell — host side (v0.3.1).
 *
 * Registers three same-origin JSON routes on the DSH web server:
 *   GET  /api/restart-bell/ping     liveness probe (client polls it after a restart)
 *   POST /api/restart-bell/restart  arms a detached helper that relaunches the app
 *   POST /api/restart-bell/quit     arms the same helper WITHOUT the relaunch
 *
 * Both actions answer 200 IMMEDIATELY, then run a detached **wscript.exe**
 * helper (a real .vbs file in %TEMP%\restart-bell) that, after a short grace
 * delay:
 *   1. force-kills the Electron main process by PID (no /T — see below),
 *   2. force-kills every remaining "DeepSeek Harness.exe" process (host child,
 *      gpu, renderers, utility) by image name,
 *   3. polls until all of them are really gone (single-instance lock released),
 *   4. restart: relaunches the same executable with no arguments — exactly how
 *      the user's own shortcut starts it; quit: stops there.
 *
 * Why wscript.exe and not cmd.exe (v0.2.x): cmd.exe is a console program, and a
 * detached console child gets a VISIBLE console window — CREATE_NO_WINDOW
 * (Node's windowsHide) is documented as ignored when combined with
 * DETACHED_PROCESS. wscript.exe is a GUI-subsystem process, so there is no
 * console to show, and its taskkill calls run through WshShell.Run(0, True)
 * (SW_HIDE). No black window, structurally.
 *
 * Why the helper strips environment variables (v0.3.1): the helper inherits the
 * env of the DSH host child, which includes ELECTRON_RUN_AS_NODE=1. A child
 * started with that variable runs the Electron binary as bare Node.js — no
 * window, no app, immediate exit — so every v0.3.0 relaunch was a silent no-op
 * (helper.log still showed "relaunching ... done"). The env is cleaned twice: on
 * spawn here, and again inside the .vbs before WshShell.Run.
 *
 * Why no /T (v0.2.x killed itself): the helper is spawned by the HOST CHILD,
 * which runs under the same image name ("DeepSeek Harness.exe"). taskkill /T
 * killed the whole tree of every matching process — including the helper — so
 * the relaunch line never ran and 重启 only ever closed DSH. v0.2.x's helper.log
 * stopped after "killing" in every single run. The helper now runs as
 * wscript.exe (a different image name), kills the main PID first (so the
 * DesktopFatalRecovery dialog never appears) and then sweeps the rest by image
 * name, all without /T.
 *
 * Why force-kill instead of a graceful exit: the Electron main treats ANY
 * unrequested host-child exit as fatal and pops a recovery dialog
 * (electron-main.js DesktopHostProcess → DesktopFatalRecovery), so there is no
 * dialog-free graceful path from inside the host. DSH state (sessions, ledgers,
 * SQLite) is written per-turn and survives this.
 *
 * Every step is appended to %TEMP%\restart-bell\helper.log, so a failed kill or
 * relaunch can be diagnosed after the fact instead of being a silent no-op.
 *
 * Guard: both action routes require the custom header "x-restart-bell" whose
 * value names the action; a cross-origin page cannot send it without passing a
 * CORS preflight we never grant — a random website cannot drive-by kill the app.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
};

/** Generated helper scripts older than this are pruned on every arm. */
const HELPER_TTL_MS = 24 * 60 * 60 * 1000;
// Variables the relaunched app must not inherit from the host child.
const STRIP_ENV = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ELECTRON_ENABLE_LOGGING",
  "ELECTRON_ENABLE_STACK_DUMPING",
  "NODE_OPTIONS",
  "NODE_ENV",
  "DSH_SESSION_ID",
  "DSH_SHELL",
  "DSH_WEB_URL",
];

function cleanHelperEnv() {
  const env = { ...process.env };
  for (const key of STRIP_ENV) delete env[key];
  return env;
}

const DEFAULT_DELAY_MS = 1200;

/**
 * VBScript source of the kill helper, with @@PLACEHOLDERS@@ filled in by
 * buildHelperScript(). Inlined at build time (see scripts/embed-helper.mjs) so
 * a published plugin carries no extra runtime file.
 */
const VBS_TEMPLATE = "Option Explicit\n' restart-bell v0.3.1 helper — generated, rewritten on every action.\n' Host is wscript.exe (GUI subsystem): no console window can ever appear.\nDim sh, fso, logPath, exePath, exeDir, exeName, mainPid, relaunch\nDim wmi, col, alive, waited, wmiOk, env, mainName, mpSet, mp, fresh\n\nSub Log(msg)\n  On Error Resume Next\n  Dim f\n  Set f = fso.OpenTextFile(logPath, 8, True)\n  If Err.Number = 0 Then\n    f.WriteLine \"[\" & Now & \"] \" & msg\n    f.Close\n  End If\n  Err.Clear\nEnd Sub\n\n' Reading an absent PROCESS variable may raise on some WSH builds.\nFunction EnvGet(nm)\n  On Error Resume Next\n  EnvGet = env(nm)\n  If Err.Number <> 0 Then EnvGet = \"<err>\"\n  Err.Clear\nEnd Function\n\n' Live process count for the target image; -1 = WMI unavailable.\nFunction ProcCount()\n  ProcCount = -1\n  If Not wmiOk Then Exit Function\n  On Error Resume Next\n  Set col = wmi.ExecQuery(\"SELECT ProcessId FROM Win32_Process WHERE Name='\" & @@SQLNAME@@ & \"'\")\n  If Err.Number = 0 Then ProcCount = col.Count Else ProcCount = -1\n  Err.Clear\nEnd Function\n\nSet sh = CreateObject(\"WScript.Shell\")\nSet fso = CreateObject(\"Scripting.FileSystemObject\")\nlogPath = @@LOG@@\nexePath = @@EXE@@\nexeDir = @@DIR@@\nexeName = @@NAME@@\nmainPid = @@PID@@\nrelaunch = @@RELAUNCH@@\n\nLog \"@@START@@\"\nWScript.Sleep @@DELAY@@\n\nwmiOk = False\nOn Error Resume Next\nSet wmi = GetObject(\"winmgmts:\\\\.\\root\\cimv2\")\nIf Err.Number = 0 Then wmiOk = True\nErr.Clear\nOn Error GoTo 0\n\n' Kill the Electron main FIRST, and without /T: this helper is itself a\n' descendant of the host child, so /T would kill the helper too (the v0.2.x bug).\n' The image name is verified first: a stale or wrong pid here would otherwise\n' kill something unrelated (the launcher, explorer, ...).\nIf mainPid > 0 Then\n  mainName = \"\"\n  If wmiOk Then\n    On Error Resume Next\n    Set mpSet = wmi.ExecQuery(\"SELECT Name FROM Win32_Process WHERE ProcessId=\" & mainPid)\n    If Err.Number = 0 Then\n      For Each mp In mpSet\n        mainName = LCase(mp.Name)\n      Next\n    End If\n    Err.Clear\n    On Error GoTo 0\n  End If\n\n  If mainName = \"\" Or mainName = LCase(exeName) Then\n    Log \"killing main pid \" & mainPid\n    sh.Run \"taskkill /F /PID \" & mainPid, 0, True\n    WScript.Sleep 300\n  Else\n    Log \"skip main pid \" & mainPid & \" (image \" & mainName & \")\"\n  End If\nEnd If\n\n' Sweep the rest by image name. No /T, and this helper is wscript.exe, so\n' /IM cannot hit it.\nLog \"killing rest\"\nsh.Run \"taskkill /F /IM \"\"\" & exeName & \"\"\"\", 0, True\n\nLog \"waiting processes gone\"\nwaited = 0\nalive = -1\nIf wmiOk Then\n  Do\n    On Error Resume Next\n    Set col = wmi.ExecQuery(\"SELECT ProcessId FROM Win32_Process WHERE Name='\" & @@SQLNAME@@ & \"'\")\n    If Err.Number <> 0 Then\n      Err.Clear\n      alive = 0\n      Exit Do\n    End If\n    alive = col.Count\n    On Error GoTo 0\n    If alive = 0 Then Exit Do\n    If waited = 8000 Then\n      Log \"still \" & alive & \" process(es); killing again\"\n      sh.Run \"taskkill /F /IM \"\"\" & exeName & \"\"\"\", 0, True\n    End If\n    WScript.Sleep 250\n    waited = waited + 250\n    If waited > 15000 Then Exit Do\n  Loop\nElse\n  WScript.Sleep 2000\n  alive = 0\nEnd If\nIf alive = 0 Then\n  Log \"gone after \" & waited & \"ms\"\nElse\n  Log \"still-running \" & alive\nEnd If\n\n' The relaunched app must be started exactly like a desktop double-click. This\n' helper inherits the environment of the DSH host child, which carries\n' ELECTRON_RUN_AS_NODE=1 — with it the exe boots as bare Node.js, runs no app,\n' and exits silently. That was the \"restart does nothing\" bug in v0.3.0.\nOn Error Resume Next\nSet env = sh.Environment(\"PROCESS\")\nenv.Remove \"ELECTRON_RUN_AS_NODE\"\nenv.Remove \"ELECTRON_NO_ATTACH_CONSOLE\"\nenv.Remove \"ELECTRON_ENABLE_LOGGING\"\nenv.Remove \"NODE_OPTIONS\"\nenv.Remove \"NODE_ENV\"\nenv.Remove \"DSH_SESSION_ID\"\nenv.Remove \"DSH_SHELL\"\nenv.Remove \"DSH_WEB_URL\"\nErr.Clear\nOn Error GoTo 0\nOn Error Resume Next\nLog \"env cleaned: runAsNode=[\" & EnvGet(\"ELECTRON_RUN_AS_NODE\") & \"] nodeEnv=[\" & EnvGet(\"NODE_ENV\") & \"]\"\nErr.Clear\nOn Error GoTo 0\n\nWScript.Sleep 800\n\nIf relaunch Then\n  Log \"relaunching \" & exePath\n  On Error Resume Next\n  sh.CurrentDirectory = exeDir\n  Err.Clear\n  sh.Run \"\"\"\" & exePath & \"\"\"\", 1, False\n  If Err.Number <> 0 Then\n    Log \"relaunch failed: \" & Err.Description\n    Err.Clear\n  End If\n  On Error GoTo 0\n\n  ' Verify the child actually stayed up. If it did not, hand the launch to\n  ' explorer.exe, which starts it with its own environment.\n  fresh = 0\n  waited = 0\n  If wmiOk Then\n    Do\n      WScript.Sleep 250\n      waited = waited + 250\n      fresh = ProcCount()\n      If fresh > 0 Then Exit Do\n      If waited >= 3000 Then Exit Do\n    Loop\n  End If\n\n  If Not wmiOk Then\n    Log \"relaunch sent (wmi unavailable, cannot verify)\"\n  ElseIf fresh > 0 Then\n    Log \"relaunched \" & fresh & \" process(es) after \" & waited & \"ms\"\n  Else\n    Log \"no process after launch; retry via explorer\"\n    On Error Resume Next\n    sh.Run \"explorer.exe \"\"\" & exePath & \"\"\"\", 0, False\n    If Err.Number <> 0 Then\n      Log \"explorer relaunch failed: \" & Err.Description\n      Err.Clear\n    End If\n    On Error GoTo 0\n    WScript.Sleep 2000\n    fresh = ProcCount()\n    If fresh > 0 Then\n      Log \"explorer relaunch ok (\" & fresh & \" process(es))\"\n    Else\n      Log \"explorer relaunch produced nothing either\"\n    End If\n  End If\nEnd If\nLog \"done\"\n";

function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Directory holding the generated helper script + its log. */
function helperDir() {
  const dir = join(tmpdir(), "restart-bell");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Delete stale helper scripts; helper.log itself is always kept. */
function pruneHelperDir(dir) {
  try {
    const cutoff = Date.now() - HELPER_TTL_MS;
    for (const name of readdirSync(dir)) {
      if (!/^helper-\d+\.(cmd|vbs)$/.test(name)) continue;
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        // already gone / locked — nothing to do
      }
    }
  } catch {
    // helper dir unreadable — the helper still gets written below
  }
}

/** VBScript string literal: doubling " is the only escape the language has. */
function vbs(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

/**
 * Render the helper script (optionally relaunching).
 * Exported so scripts/selftest-helper.mjs can exercise the real thing against a
 * stand-in executable instead of DSH itself.
 */
export function buildHelperScript({ exe, exeDir, exeName, mainPid = 0, delayMs = DEFAULT_DELAY_MS, relaunch = false, logPath }) {
  const delay = Math.max(0, Math.round(Number(delayMs) || 0));
  const pid = Math.max(0, Math.round(Number(mainPid) || 0));
  const sqlName = String(exeName).replace(/'/g, "''");
  return VBS_TEMPLATE.replaceAll("@@LOG@@", vbs(logPath))
    .replaceAll("@@EXE@@", vbs(exe))
    .replaceAll("@@DIR@@", vbs(exeDir))
    .replaceAll("@@NAME@@", vbs(exeName))
    .replaceAll("@@SQLNAME@@", vbs(sqlName))
    .replaceAll("@@PID@@", String(pid))
    .replaceAll("@@DELAY@@", String(delay))
    .replaceAll("@@RELAUNCH@@", relaunch ? "True" : "False")
    .replaceAll("@@START@@", relaunch ? "restart" : "quit");
}

export const inject = ["webServer"];

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;

  // The host child runs under the Electron executable itself, so
  // process.execPath IS the app the user launched, and process.ppid is the
  // Electron main (the host's parent).
  const exe = process.execPath;
  const exeDir = dirname(exe);
  const exeName = basename(exe); // "DeepSeek Harness.exe"
  const mainPid = Number(process.ppid) || 0;
  const delayMs = Math.max(200, Math.round(Number(config.delayMs ?? DEFAULT_DELAY_MS) || DEFAULT_DELAY_MS));
  const wscript = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  let armed = 0; // timestamp of the last arm — a later action may re-arm

  /** Shared body of the restart / quit routes. */
  function armAction(req, res, action) {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "POST only" });
      return;
    }
    if (req.headers["x-restart-bell"] !== action) {
      writeJson(res, 403, { ok: false, error: "missing x-restart-bell header" });
      return;
    }
    // A double-submit seconds apart is a double-click, not a retry; anything
    // later is an honest retry (e.g. the kill silently failed) and must re-arm.
    if (Date.now() - armed < 1500) {
      writeJson(res, 200, { ok: true, restarting: true, note: "already armed" });
      return;
    }
    armed = Date.now();
    // Answer first, then arm the helper — the client must see success before
    // the app (and this very request's server) disappears.
    writeJson(res, 200, { ok: true, restarting: true });
    const relaunch = action === "restart";
    const dir = helperDir();
    const logPath = join(dir, "helper.log");
    try {
      pruneHelperDir(dir);
      const vbsPath = join(dir, "helper-" + Date.now() + ".vbs");
      writeFileSync(
        vbsPath,
        buildHelperScript({ exe, exeDir, exeName, mainPid, delayMs, relaunch, logPath }),
        "utf8",
      );
      if (!existsSync(wscript)) {
        throw new Error("wscript.exe not found at " + wscript);
      }
      const child = spawn(wscript, ["//B", "//NoLogo", vbsPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: dir,
        // Never let the helper (and therefore the relaunched app) inherit the
        // host child's "run this exe as node" flags.
        env: cleanHelperEnv(),
      });
      child.on("error", (error) => {
        // spawn() reports failures asynchronously; leave a trail for the user.
        try {
          appendFileSync(logPath, "[error] spawn wscript failed: " + (error?.message ?? error) + "\r\n", "utf8");
        } catch {
          // log unavailable — the caller still logs below
        }
        ctx.logger?.error?.("restart-bell: spawn wscript failed: " + (error?.message ?? error));
      });
      child.unref();
      ctx.logger?.info?.(
        "restart-bell: " + (relaunch ? "restart" : "quit") + " helper armed for \"" + exeName +
          "\" (main pid " + mainPid + ", delay " + delayMs + "ms, script " + vbsPath + ")",
      );
    } catch (error) {
      armed = 0;
      try {
        appendFileSync(logPath, "[error] arm failed: " + (error?.message ?? error) + "\r\n", "utf8");
      } catch {
        // log unavailable
      }
      ctx.logger?.error?.("restart-bell: failed to arm helper: " + (error?.message ?? error));
    }
  }

  const routes = [
    {
      kind: "exact",
      path: "/api/restart-bell/ping",
      handler: (_req, res) => {
        writeJson(res, 200, { ok: true, plugin: "restart-bell", pid: process.pid });
      },
    },
    {
      kind: "exact",
      path: "/api/restart-bell/restart",
      handler: (req, res) => armAction(req, res, "restart"),
    },
    {
      kind: "exact",
      path: "/api/restart-bell/quit",
      handler: (req, res) => armAction(req, res, "quit"),
    },
  ];

  const disposers = routes.map((route) => ctx.webServer.register(route));
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
  });
}
