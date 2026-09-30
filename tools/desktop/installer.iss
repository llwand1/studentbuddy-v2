#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{F276CD79-EBEA-4705-9B31-20CA08B5F1EA}
AppName=StudentBuddy
AppVersion={#AppVersion}
AppPublisher=StudentBuddy
AppPublisherURL=https://github.com/llwand1/studentbuddy-v2
DefaultDirName={localappdata}\Programs\StudentBuddy
DefaultGroupName=StudentBuddy
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDirectory}
OutputBaseFilename=StudentBuddy-{#AppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\StudentBuddy.exe
CloseApplications=yes
RestartApplications=no
LicenseFile={#SourceDirectory}\LICENSE

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#SourceDirectory}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\StudentBuddy"; Filename: "{app}\StudentBuddy.exe"
Name: "{autodesktop}\StudentBuddy"; Filename: "{app}\StudentBuddy.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\StudentBuddy.exe"; Description: "Launch StudentBuddy"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\StudentBuddy.exe"; Parameters: "--stop"; Flags: runhidden waituntilterminated; RunOnceId: StopStudentBuddy

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
  LauncherPath: String;
begin
  Result := '';
  LauncherPath := ExpandConstant('{app}\StudentBuddy.exe');
  if FileExists(LauncherPath) then
    if not Exec(LauncherPath, '--stop', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      Result := 'Please exit StudentBuddy before installing this update.';
end;
