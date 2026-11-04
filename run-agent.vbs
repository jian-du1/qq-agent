' QQ Agent launcher: starts console (3210), NapCat (6099/3000/3001) and the
' watchdog that restarts NapCat when it drops (quick login restores the session).
' Everything runs with NO visible windows.
'
'   -> double-click this file, or run:  wscript run-agent.vbs
'   -> stop everything with stop-all.cmd / stop-hard.cmd
'   -> console UI:   http://127.0.0.1:3210
'   -> QR/WebUI:     http://127.0.0.1:6099/webui?token=YOUR_WEBUI_TOKEN
'
' Idempotent: before launching, it asks WMI whether the corresponding node
' process is already alive -- so running it twice does not create a second
' NapCat (two NapCats fight over the same QQ account).
Option Explicit
Dim sh, fso, base
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

If Not AnyNode("index-qq-local.js") Then
  sh.Run "cmd /c """ & base & "\bg-napcat.cmd""", 0, False
End If
If Not AnyNode("src\server.js") Then
  sh.Run "cmd /c """ & base & "\bg-console.cmd""", 0, False
End If
If Not AnyNode("watch-napcat.mjs") Then
  sh.Run """" & base & "\runtime\node.exe"" """ & base & "\watch-napcat.mjs""", 0, False
End If


Function AnyNode(needle)
  Dim wmi, procs, p
  AnyNode = False
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number <> 0 Then Exit Function
  Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name='node.exe'")
  If Err.Number <> 0 Then Exit Function
  For Each p In procs
    If Not IsNull(p.CommandLine) Then
      If InStr(1, p.CommandLine, needle, vbTextCompare) > 0 Then
        AnyNode = True
        Exit Function
      End If
    End If
  Next
End Function
