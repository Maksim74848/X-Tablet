#define MyAppName "X-Tablet"
#define MyAppVersion "1.0.0"
#define MyPublisher "X-Tablet"
#define MyExeName "X-Tablet.exe"

[Setup]
AppId={{8C6BEB6D-6B2A-4E0E-94A8-1D4D1A8C7F20}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyPublisher}
DefaultDirName={autopf}\X-Tablet
DefaultGroupName=X-Tablet
OutputDir=dist
OutputBaseFilename=X-Tablet-Windows-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
DisableProgramGroupPage=yes

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; Flags: unchecked
Name: "startup"; Description: "Запускать X-Tablet вместе с Windows"; Flags: unchecked

[Files]
Source: "..\..\client\dist\windows\X-Tablet.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\client\license-server.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\X-Tablet"; Filename: "{app}\{#MyExeName}"
Name: "{autodesktop}\X-Tablet"; Filename: "{app}\{#MyExeName}"; Tasks: desktopicon
Name: "{userstartup}\X-Tablet"; Filename: "{app}\{#MyExeName}"; Tasks: startup

[Run]
Filename: "{app}\{#MyExeName}"; Description: "Запустить X-Tablet"; Flags: nowait postinstall skipifsilent
