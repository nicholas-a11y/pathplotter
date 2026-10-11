Option Explicit
Dim shell, fso, root, command, result
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
command = """" & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoLogo -NoProfile -STA -File """ & root & "\GUI.ps1"""
result = shell.Run(command, 0, True)
If result <> 0 Then
    MsgBox "RAP stopped or Windows blocked startup. Use Start RAP diagnostics.cmd for details. Verify the portable files and your organization's signed-script policy; RAP does not change it.", vbExclamation, "PathPlotter RAP"
End If
