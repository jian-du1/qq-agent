' QQ 机器人启动器（桌面快捷方式指向这里）
' 实际逻辑在 launch-qqbot.ps1：起控制台 + 起协议端 + 打开页面 + 提示是否要扫码
Option Explicit
Dim sh, fso, base, ps1, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = base & "\launch-qqbot.ps1"
If Not fso.FileExists(ps1) Then
  MsgBox "launch-qqbot.ps1 not found:" & vbCrLf & ps1, 16, "QQ Agent"
  WScript.Quit 1
End If
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
sh.Run cmd, 0, False
