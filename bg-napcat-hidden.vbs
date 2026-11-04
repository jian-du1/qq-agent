' Hidden launcher for NapCat (window style 0 = no console window at all).
' The watchdog and the control panel call this instead of spawning cmd.exe
' directly, because a bare `cmd /c bg-napcat.cmd` keeps a visible console
' window for as long as NapCat runs -- every restart added one more window.
Option Explicit
Dim sh, fso, base
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
sh.Run "cmd /c """ & base & "\bg-napcat.cmd""", 0, False
