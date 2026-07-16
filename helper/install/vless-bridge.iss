; ============================================================
; VLESS Bridge — установщик для Windows (Inno Setup 6.3+).
;
; Ставит helper.exe / xray.exe / geoip.dat / geosite.dat в
; %LOCALAPPDATA%\VLESSBridge и регистрирует Native Messaging host
; для Chrome. БЕЗ прав администратора (PrivilegesRequired=lowest).
;
; Компилировать в папке, где рядом лежат helper.exe, xray.exe,
; geoip.dat, geosite.dat (т.е. содержимое dist\win\).
; Результат: VLESSBridge-Setup.exe (не подписан — SmartScreen предупредит).
; ============================================================

; --- ID расширения: подставьте свой из chrome://extensions ---
#define ExtensionId "dmknghlolgcdlhfeojipkbdlphapeeil"

#define AppName    "VLESS Bridge"
#define AppVersion "1.0.0"
#define HostName   "com.vlessbridge.helper"

[Setup]
AppId={{B7E4C2A1-3F5D-4A6E-9C8B-1D2E3F4A5B6C}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=VLESS Bridge
; Домашняя папка пользователя — без прав администратора
PrivilegesRequired=lowest
DefaultDirName={localappdata}\VLESSBridge
DisableDirPage=yes
DisableProgramGroupPage=yes
; Бинарники 64-битные
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=.
OutputBaseFilename=VLESSBridge-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
Source: "helper.exe";  DestDir: "{app}"; Flags: ignoreversion
Source: "xray.exe";    DestDir: "{app}"; Flags: ignoreversion
Source: "geoip.dat";   DestDir: "{app}"; Flags: ignoreversion
Source: "geosite.dat"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; Native Messaging host для Chrome. HKCU — без прав администратора.
; Значение по умолчанию = путь к манифесту. Ключ удаляется при деинсталляции.
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#HostName}"; \
  ValueType: string; ValueName: ""; ValueData: "{app}\{#HostName}.json"; \
  Flags: uninsdeletekey

[Code]
// Пишем манифест Native Messaging с реальным путём к helper.exe и ID расширения.
// Путь в JSON требует экранирования обратных слэшей (\  ->  \\).
procedure WriteNativeManifest();
var
  ManifestPath, HelperPath, Json: string;
begin
  ManifestPath := ExpandConstant('{app}\{#HostName}.json');
  HelperPath := ExpandConstant('{app}\helper.exe');
  StringChangeEx(HelperPath, '\', '\\', True);
  Json :=
    '{' + #13#10 +
    '  "name": "{#HostName}",' + #13#10 +
    '  "description": "VLESS Bridge helper",' + #13#10 +
    '  "path": "' + HelperPath + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": ["chrome-extension://{#ExtensionId}/"]' + #13#10 +
    '}' + #13#10;
  SaveStringToFile(ManifestPath, Json, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteNativeManifest();
end;

// При деинсталляции удаляем сгенерированный манифест (файлы из [Files] и ключ
// реестра Inno удалит сам).
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    DeleteFile(ExpandConstant('{app}\{#HostName}.json'));
end;
