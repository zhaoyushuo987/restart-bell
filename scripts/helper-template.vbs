Option Explicit
' restart-bell v0.3.1 helper — generated, rewritten on every action.
' Host is wscript.exe (GUI subsystem): no console window can ever appear.
Dim sh, fso, logPath, exePath, exeDir, exeName, mainPid, relaunch
Dim wmi, col, alive, waited, wmiOk, env, mainName, mpSet, mp, fresh

Sub Log(msg)
  On Error Resume Next
  Dim f
  Set f = fso.OpenTextFile(logPath, 8, True)
  If Err.Number = 0 Then
    f.WriteLine "[" & Now & "] " & msg
    f.Close
  End If
  Err.Clear
End Sub

' Reading an absent PROCESS variable may raise on some WSH builds.
Function EnvGet(nm)
  On Error Resume Next
  EnvGet = env(nm)
  If Err.Number <> 0 Then EnvGet = "<err>"
  Err.Clear
End Function

' Live process count for the target image; -1 = WMI unavailable.
Function ProcCount()
  ProcCount = -1
  If Not wmiOk Then Exit Function
  On Error Resume Next
  Set col = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='" & @@SQLNAME@@ & "'")
  If Err.Number = 0 Then ProcCount = col.Count Else ProcCount = -1
  Err.Clear
End Function

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
logPath = @@LOG@@
exePath = @@EXE@@
exeDir = @@DIR@@
exeName = @@NAME@@
mainPid = @@PID@@
relaunch = @@RELAUNCH@@

Log "@@START@@"
WScript.Sleep @@DELAY@@

wmiOk = False
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
If Err.Number = 0 Then wmiOk = True
Err.Clear
On Error GoTo 0

' Kill the Electron main FIRST, and without /T: this helper is itself a
' descendant of the host child, so /T would kill the helper too (the v0.2.x bug).
' The image name is verified first: a stale or wrong pid here would otherwise
' kill something unrelated (the launcher, explorer, ...).
If mainPid > 0 Then
  mainName = ""
  If wmiOk Then
    On Error Resume Next
    Set mpSet = wmi.ExecQuery("SELECT Name FROM Win32_Process WHERE ProcessId=" & mainPid)
    If Err.Number = 0 Then
      For Each mp In mpSet
        mainName = LCase(mp.Name)
      Next
    End If
    Err.Clear
    On Error GoTo 0
  End If

  If mainName = "" Or mainName = LCase(exeName) Then
    Log "killing main pid " & mainPid
    sh.Run "taskkill /F /PID " & mainPid, 0, True
    WScript.Sleep 300
  Else
    Log "skip main pid " & mainPid & " (image " & mainName & ")"
  End If
End If

' Sweep the rest by image name. No /T, and this helper is wscript.exe, so
' /IM cannot hit it.
Log "killing rest"
sh.Run "taskkill /F /IM """ & exeName & """", 0, True

Log "waiting processes gone"
waited = 0
alive = -1
If wmiOk Then
  Do
    On Error Resume Next
    Set col = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='" & @@SQLNAME@@ & "'")
    If Err.Number <> 0 Then
      Err.Clear
      alive = 0
      Exit Do
    End If
    alive = col.Count
    On Error GoTo 0
    If alive = 0 Then Exit Do
    If waited = 8000 Then
      Log "still " & alive & " process(es); killing again"
      sh.Run "taskkill /F /IM """ & exeName & """", 0, True
    End If
    WScript.Sleep 250
    waited = waited + 250
    If waited > 15000 Then Exit Do
  Loop
Else
  WScript.Sleep 2000
  alive = 0
End If
If alive = 0 Then
  Log "gone after " & waited & "ms"
Else
  Log "still-running " & alive
End If

' The relaunched app must be started exactly like a desktop double-click. This
' helper inherits the environment of the DSH host child, which carries
' ELECTRON_RUN_AS_NODE=1 — with it the exe boots as bare Node.js, runs no app,
' and exits silently. That was the "restart does nothing" bug in v0.3.0.
On Error Resume Next
Set env = sh.Environment("PROCESS")
env.Remove "ELECTRON_RUN_AS_NODE"
env.Remove "ELECTRON_NO_ATTACH_CONSOLE"
env.Remove "ELECTRON_ENABLE_LOGGING"
env.Remove "NODE_OPTIONS"
env.Remove "NODE_ENV"
env.Remove "DSH_SESSION_ID"
env.Remove "DSH_SHELL"
env.Remove "DSH_WEB_URL"
Err.Clear
On Error GoTo 0
On Error Resume Next
Log "env cleaned: runAsNode=[" & EnvGet("ELECTRON_RUN_AS_NODE") & "] nodeEnv=[" & EnvGet("NODE_ENV") & "]"
Err.Clear
On Error GoTo 0

WScript.Sleep 800

If relaunch Then
  Log "relaunching " & exePath
  On Error Resume Next
  sh.CurrentDirectory = exeDir
  Err.Clear
  sh.Run """" & exePath & """", 1, False
  If Err.Number <> 0 Then
    Log "relaunch failed: " & Err.Description
    Err.Clear
  End If
  On Error GoTo 0

  ' Verify the child actually stayed up. If it did not, hand the launch to
  ' explorer.exe, which starts it with its own environment.
  fresh = 0
  waited = 0
  If wmiOk Then
    Do
      WScript.Sleep 250
      waited = waited + 250
      fresh = ProcCount()
      If fresh > 0 Then Exit Do
      If waited >= 3000 Then Exit Do
    Loop
  End If

  If Not wmiOk Then
    Log "relaunch sent (wmi unavailable, cannot verify)"
  ElseIf fresh > 0 Then
    Log "relaunched " & fresh & " process(es) after " & waited & "ms"
  Else
    Log "no process after launch; retry via explorer"
    On Error Resume Next
    sh.Run "explorer.exe """ & exePath & """", 0, False
    If Err.Number <> 0 Then
      Log "explorer relaunch failed: " & Err.Description
      Err.Clear
    End If
    On Error GoTo 0
    WScript.Sleep 2000
    fresh = ProcCount()
    If fresh > 0 Then
      Log "explorer relaunch ok (" & fresh & " process(es))"
    Else
      Log "explorer relaunch produced nothing either"
    End If
  End If
End If
Log "done"
