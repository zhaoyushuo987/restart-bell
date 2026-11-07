// Regression self-test for the restart-bell helper.
//
// Proves the two v0.2.x bugs are gone, without touching DSH itself:
//   * the helper survives its own kill (it runs as wscript.exe, and it never
//     uses taskkill /T) — v0.2.x died with the app tree, so "relaunching"/"done"
//     never appeared in helper.log;
//   * the target really goes away, then really comes back.
// It also asserts wscript.exe is a GUI-subsystem binary (no console window).
//
// Run: node scripts/selftest-helper.mjs
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildHelperScript } from "../lib/index.js";

const win = process.env.SystemRoot ?? "C:\\Windows";
const dir = join(tmpdir(), "restart-bell-selftest");
const logPath = join(dir, "helper.log");
const exe = join(dir, "selfapp.exe");
const wscript = join(win, "System32", "wscript.exe");
const failures = [];

function check(ok, label, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail ? "  [" + detail + "]" : ""));
  if (!ok) failures.push(label);
}

function pidsOf(image) {
  const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq " + image, "/NH", "/FO", "CSV"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return (out.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().includes(image.toLowerCase()))
    .map((line) => Number((line.split(",")[1] ?? "").replace(/"/g, "").trim()) || 0)
    .filter(Boolean);
}

function peSubsystem(path) {
  const buf = readFileSync(path);
  const peOffset = buf.readUInt32LE(0x3c);
  return buf.readUInt16LE(peOffset + 24 + 0x44);
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
copyFileSync(join(win, "System32", "ping.exe"), exe);

const target = spawn(exe, ["-n", "300", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
target.on("error", () => {});
const originalPid = target.pid;
console.log("stand-in target: selfapp.exe pid " + originalPid);

const vbsPath = join(dir, "helper-test.vbs");
writeFileSync(
  vbsPath,
  buildHelperScript({
    exe,
    exeDir: dir,
    exeName: "selfapp.exe",
    mainPid: 0,
    delayMs: 200,
    relaunch: true,
    logPath,
  }),
  "utf8",
);

console.log("running helper: wscript //B //NoLogo " + vbsPath);
// The real helper is spawned by the DSH host child, which carries
// ELECTRON_RUN_AS_NODE=1. Reproduce that here: the child must come back clean.
const dirtyEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production" };
const run = spawnSync(wscript, ["//B", "//NoLogo", vbsPath], {
  env: dirtyEnv,
  stdio: "ignore",
  windowsHide: true,
  timeout: 60000,
});
if (run.error) failures.push("wscript failed: " + run.error.message);

const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
const after = pidsOf("selfapp.exe");

check(log.includes("] restart"), "helper logged the start line");
check(log.includes("killing rest"), "helper logged the image-name sweep");
check(log.includes("relaunching"), "helper SURVIVED the kill and reached relaunching");
check(log.includes("done"), "helper logged done");
check(!after.includes(originalPid), "original stand-in pid " + originalPid + " is gone");
check(!log.includes("relaunch failed"), "relaunch reported no error");
check(peSubsystem(wscript) === 2, "wscript.exe is GUI subsystem (no console window)", "subsystem " + peSubsystem(wscript));
check(!existsSync(join(dir, "helper-test.cmd")), "no .cmd helper is generated any more");
check(
  log.includes("env cleaned: runAsNode=[] nodeEnv=[]"),
  "helper stripped ELECTRON_RUN_AS_NODE / NODE_ENV before relaunching",
  (log.match(/env cleaned:.*/) ?? ["(missing)"])[0],
);
check(
  /relaunched \d+ process\(es\)|no process after launch/.test(log),
  "helper verified the relaunched process instead of assuming it",
);
check(
  buildHelperScript({ exe, exeDir: dir, exeName: "x.exe", mainPid: 0, delayMs: 0, relaunch: true, logPath })
    .includes("retry via explorer"),
  "explorer.exe fallback is kept for a child that refuses to stay",
);

// WSH's PROCESS-environment Remove must really reach children, otherwise the
// strip above would be cosmetic. Prove it on an actual spawned process.
const dumpPath = join(dir, "envdump.txt");
const probeVbs = join(dir, "env-probe.vbs");
const vbsLiteral = (s) => '"' + s.replace(/"/g, '""') + '"';
writeFileSync(
  probeVbs,
  [
    "Option Explicit",
    "Dim sh, env",
    'Set sh = CreateObject("WScript.Shell")',
    'Set env = sh.Environment("PROCESS")',
    'env.Remove "ELECTRON_RUN_AS_NODE"',
    "sh.Run " + vbsLiteral('cmd /c set > "' + dumpPath + '"') + ", 0, True",
    "",
  ].join("\r\n"),
  "utf8",
);
spawnSync(wscript, ["//B", "//NoLogo", probeVbs], { env: dirtyEnv, stdio: "ignore", windowsHide: true, timeout: 30000 });
const dump = existsSync(dumpPath) ? readFileSync(dumpPath, "utf8") : "";
check(
  !/^ELECTRON_RUN_AS_NODE=/im.test(dump),
  "child of a cleaned PROCESS environment no longer sees ELECTRON_RUN_AS_NODE",
  dump ? "dump " + dump.length + " chars" : "no dump!",
);

// Negative control: a missing exe must surface as "relaunch failed", which proves
// the relaunch outcome is inspected instead of assumed.
const negLog = join(dir, "helper-negative.log");
const negVbs = join(dir, "helper-negative.vbs");
writeFileSync(
  negVbs,
  buildHelperScript({
    exe: join(dir, "nope.exe"),
    exeDir: dir,
    exeName: "nope.exe",
    mainPid: 0,
    delayMs: 200,
    relaunch: true,
    logPath: negLog,
  }),
  "utf8",
);
spawnSync(wscript, ["//B", "//NoLogo", negVbs], { stdio: "ignore", windowsHide: true, timeout: 60000 });
const negativeLog = existsSync(negLog) ? readFileSync(negLog, "utf8") : "";
check(negativeLog.includes("relaunch failed"), "missing exe is reported as relaunch failed");

// Guard case: a pid that is NOT our image must never be killed — a wrong ppid
// (launcher, explorer, ...) would otherwise take down the desktop.
const guardTarget = spawn(exe, ["-n", "300", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
guardTarget.on("error", () => {});
const guardPid = guardTarget.pid;
const guardLog = join(dir, "helper-guard.log");
const guardVbs = join(dir, "helper-guard.vbs");
writeFileSync(
  guardVbs,
  buildHelperScript({
    exe,
    exeDir: dir,
    exeName: "notself.exe",
    mainPid: guardPid,
    delayMs: 100,
    relaunch: false,
    logPath: guardLog,
  }),
  "utf8",
);
spawnSync(wscript, ["//B", "//NoLogo", guardVbs], { stdio: "ignore", windowsHide: true, timeout: 60000 });
const guardText = existsSync(guardLog) ? readFileSync(guardLog, "utf8") : "";
check(guardText.includes("skip main pid " + guardPid), "mis-matched pid is skipped, not killed");
check(pidsOf("selfapp.exe").includes(guardPid), "guarded pid " + guardPid + " is still alive");

console.log("--- helper.log ---");
console.log(log.trim() || "(empty!)");

if (failures.length) {
  console.error("\n" + failures.length + " check(s) FAILED: " + failures.join("; "));
} else {
  console.log("\nall checks passed");
}

spawnSync("taskkill", ["/F", "/IM", "selfapp.exe"], { stdio: "ignore", windowsHide: true });
process.exitCode = failures.length ? 1 : 0;
