; Force-reinstall contract: the installer owns the wipe, the app never manages
; old folders at launch. electron-builder's assisted installer already
; uninstalls the previous app version before copying (so the TDEaseNexus install
; dir is clean by construction); an INTERACTIVE install additionally removes
; the writable data root beside the install dir — current `TDEaseNexus-Data` and
; the pre-rebrand `TDEase-Data` — so every manual reinstall starts from
; first-launch state. The data root is derived state (settings are re-seeded,
; the venv and caches are re-provisioned offline); the user's Workspace
; folders live outside it.
;
; A SILENT install is the UPDATE channel (electron-updater replays this
; installer with /S). It must NOT wipe: settings.json holds the user's provider
; keys and auth.json their tokens, so an update that wiped the data root would
; destroy credentials on every version. Silent = replace the application,
; preserve the data root.

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!macro customInstall
  ${IfNot} ${Silent}
    Push $R0
    Push $R1
    ${GetParent} "$INSTDIR" $R0
    StrCpy $R1 "$R0\TDEaseNexus-Data"
    IfFileExists "$R1\*.*" 0 +3
      DetailPrint "Force reinstall: removing $R1"
      RMDir /r "$R1"
    StrCpy $R1 "$R0\TDEase-Data"
    IfFileExists "$R1\*.*" 0 +3
      DetailPrint "Force reinstall: removing legacy $R1"
      RMDir /r "$R1"
    Pop $R1
    Pop $R0
  ${EndIf}
!macroend
