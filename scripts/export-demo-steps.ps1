# Re-export the 13 robot-arm assemblies from SolidWorks as self-contained AP214
# STEP files (with appearances/colors embedded). The default SaveAs UI exports
# multi-file (one STEP per component) which leaves assemblies as reference-only
# shells with no geometry; toggling swSTEPApMultipleFiles=0 produces a single
# self-contained STEP per assembly.
#
# One-time tooling. Spawns SOLIDWORKS, opens each .SLDASM, exports STEP with
# the right options, closes. Output filenames match the demo manifest's
# cadFileBase entries (so the seed picks them up unchanged).
#
# Usage:
#   pwsh ./scripts/export-demo-steps.ps1
#   pwsh ./scripts/export-demo-steps.ps1 -OnlyMain   # just MAIN-ASSEMBLY for a quick test
#
# Prereqs:
#   - SOLIDWORKS 2026 installed at the default path
#   - All ~$ lockfiles cleared (close any SLDASM that's currently open in SW)

[CmdletBinding()]
param(
    [string]$SourceDir = "C:\Users\tamak\Downloads\robot-arm-234.snapshot.8",
    [string]$OutDir = "C:\Users\tamak\repos\Cascadia\Cascadia-App\demo-data\robot-arm\step-merged",
    [switch]$OnlyMain
)

$ErrorActionPreference = "Stop"

# ----------------------------------------------------------------------------
# Manifest cadFileBase  ->  SLDASM filename (relative to $SourceDir)
# ----------------------------------------------------------------------------
# 13 entries; matches the 13 assemblies in demo-data/robot-arm/manifest.json.
# "Configuration 1" is the SolidWorks-internal name for what the demo calls
# TDJ-25-A-10000-BASE-ASSEMBLY (per scripts/build-demo-manifest.ts).

$assemblies = [ordered]@{
    "TDJ-25-A-00000-MAIN-ASSEMBLY"             = "TDJ-25-A-00000-MAIN-ASSEMBLY.SLDASM"
    "TDJ-25-A-10000-BASE-ASSEMBLY"             = "Configuration 1.SLDASM.SLDASM"
    "TDJ-25-A-20000-SHOULDER-ASSEMBLY"         = "TDJ-25-A-20000-SHOULDER-ASSEMBLY.SLDASM.SLDASM"
    "TDJ-25-A-30000-ELBOW-ASSEMBLY"            = "TDJ-25-A-30000-ELBOW-ASSEMBLY.SLDASM.SLDASM"
    "TDJ-25-A-40000-WRIST-ASSEMBLY"            = "TDJ-25-A-40000-WRIST-ASSEMBLY.SLDASM.SLDASM"
    "TDJ-25-A-50000-EE-ASSEMBLY"               = "TDJ-25-A-50000-EE-ASSEMBLY.SLDASM.SLDASM"
    "TDJ-25-P-40005-HTD-CUSTOM-PULLEY"         = "TDJ-25-P-40005-HTD-CUSTOM-PULLEY.SLDASM.SLDASM"
    "TDJ-25-P-40007-HTD-STEPPER-PULLEY"        = "TDJ-25-P-40007-HTD-STEPPER-PULLEY.SLDASM.SLDASM"
    "217-3199-STEP"                            = "217-3199-STEP.SLDASM.SLDASM"
    "FALCON-MAX-PLANETARY-ASSY"                = "FALCON-MAX-PLANETARY-ASSY.SLDASM.SLDASM"
    "MAXPlanetary 1-Stage"                     = "MAXPlanetary 1-Stage.SLDASM.SLDASM"
    "REV-25-2107_1-Stage"                      = "REV-25-2107_1-Stage.SLDASM.SLDASM"
    "REV-25-2109_1-Stage (No Shaft, For NEO)"  = "REV-25-2109_1-Stage (No Shaft, For NEO).SLDASM.SLDASM"
}

if ($OnlyMain) {
    $first = [ordered]@{}
    $key = "TDJ-25-A-00000-MAIN-ASSEMBLY"
    $first[$key] = $assemblies[$key]
    $assemblies = $first
}

# ----------------------------------------------------------------------------
# Load the SOLIDWORKS interop assemblies so we can use named enum constants
# rather than guessing magic ints (which shift between SW versions).
# ----------------------------------------------------------------------------

# SOLIDWORKS install path varies between SW Corp (legacy) and Dassault Systemes
# (3DEXPERIENCE branding, R2026x onward). Resolve via the registry, then look in
# both api/redist (legacy) and the SOLIDWORKS root (2026).
$swSetupKey = Get-ItemProperty -Path "HKLM:\SOFTWARE\SolidWorks\SOLIDWORKS 2026\Setup" -ErrorAction SilentlyContinue
if (-not $swSetupKey) {
    $swSetupKey = Get-ChildItem -Path "HKLM:\SOFTWARE\SolidWorks" -ErrorAction SilentlyContinue |
        Where-Object { $_.PSChildName -like "SOLIDWORKS *" } |
        ForEach-Object { Get-ItemProperty -Path "$($_.PSPath)\Setup" -ErrorAction SilentlyContinue } |
        Select-Object -First 1
}
$swInstallDir = $null
if ($swSetupKey) { $swInstallDir = $swSetupKey.'SolidWorks Folder' }

$swConstDll = $null
$swInteropDll = $null
$searchRoots = @()
if ($swInstallDir) {
    $searchRoots += $swInstallDir
    $searchRoots += (Join-Path $swInstallDir "api\redist")
}
$searchRoots += "C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\api\redist"
foreach ($root in $searchRoots) {
    $c = Join-Path $root "SolidWorks.Interop.swconst.dll"
    $i = Join-Path $root "SolidWorks.Interop.sldworks.dll"
    if ((Test-Path $c) -and (Test-Path $i)) {
        $swConstDll = $c
        $swInteropDll = $i
        break
    }
}
if (-not $swConstDll) {
    throw "SOLIDWORKS interop DLLs not found. Searched: $($searchRoots -join '; ')"
}
Write-Host "[sw] interop DLLs: $swConstDll"

Add-Type -Path $swConstDll
Add-Type -Path $swInteropDll

$swApp = $null
function Get-OrStartSW {
    # Try to attach to a running SW instance first; otherwise launch one.
    try {
        $existing = [System.Runtime.InteropServices.Marshal]::GetActiveObject("SldWorks.Application")
        Write-Host "[sw] attached to running SOLIDWORKS"
        return $existing
    } catch {
        Write-Host "[sw] starting SOLIDWORKS..."
        $progID = [Type]::GetTypeFromProgID("SldWorks.Application")
        $app = [Activator]::CreateInstance($progID)
        $app.Visible = $true
        return $app
    }
}

$swApp = Get-OrStartSW

# ----------------------------------------------------------------------------
# Set the STEP export user preferences ONCE before the loop.
# The Save As dialog persists these so subsequent SaveAs3 calls honor them.
# ----------------------------------------------------------------------------
#   - swSTEPApMultipleFiles = FALSE       (critical fix - single self-contained STEP)
#   - swStepAP              = 214         (AP214 carries colors)
#   - swSTEPExportFaceEdgeProps = TRUE
#   - swSTEPExportAppearance    = TRUE    (writes the colors we care about)
#   - swSTEPSplitPeriodicFaces  = TRUE    (matches the dialog defaults)
#   - swSTEPExport3DCurveFeatures = TRUE

$ints = [SolidWorks.Interop.swconst.swUserPreferenceIntegerValue_e]
$togs = [SolidWorks.Interop.swconst.swUserPreferenceToggle_e]

$swApp.SetUserPreferenceToggle($togs::swSTEPApMultipleFiles, $false)
$swApp.SetUserPreferenceIntegerValue($ints::swStepAP, 214)
$swApp.SetUserPreferenceToggle($togs::swSTEPExportFaceEdgeProps, $true)
$swApp.SetUserPreferenceToggle($togs::swSTEPExportAppearance, $true)
$swApp.SetUserPreferenceToggle($togs::swSTEPSplitPeriodicFaces, $true)
$swApp.SetUserPreferenceToggle($togs::swSTEPExport3DCurveFeatures, $true)

Write-Host "[sw] STEP prefs set: AP214, single file, appearances ON"

# ----------------------------------------------------------------------------
# Output dir
# ----------------------------------------------------------------------------

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

# ----------------------------------------------------------------------------
# Open each assembly, SaveAs3 to STEP, close.
# ----------------------------------------------------------------------------

$docTypeAsm  = [SolidWorks.Interop.swconst.swDocumentTypes_e]::swDocASSEMBLY
$openSilent  = [SolidWorks.Interop.swconst.swOpenDocOptions_e]::swOpenDocOptions_Silent
$saveCurrent = [SolidWorks.Interop.swconst.swSaveAsVersion_e]::swSaveAsCurrentVersion
$saveCopy    = [SolidWorks.Interop.swconst.swSaveAsOptions_e]::swSaveAsOptions_Copy

$ok = 0
$failed = @()
$t0 = Get-Date

foreach ($entry in $assemblies.GetEnumerator()) {
    $cadFileBase = $entry.Key
    $sldasm = Join-Path $SourceDir $entry.Value
    $outStep = Join-Path $OutDir ("{0}.STEP" -f $cadFileBase)

    Write-Host ""
    Write-Host "[$($ok + $failed.Count + 1)/$($assemblies.Count)] $cadFileBase"
    Write-Host "  src: $sldasm"
    Write-Host "  out: $outStep"

    if (-not (Test-Path $sldasm)) {
        Write-Warning "  source SLDASM not found, skipping"
        $failed += $cadFileBase
        continue
    }

    # Bail if a SOLIDWORKS lockfile is present - SW would silently open in
    # read-only mode otherwise, but that still works for export. We just warn.
    $lockfile = Join-Path (Split-Path $sldasm) ('~$' + (Split-Path $sldasm -Leaf))
    if (Test-Path $lockfile) {
        Write-Warning "  lockfile present ($lockfile) - file may be open in SW. Continuing."
    }

    $errs = 0
    $warns = 0
    $model = $swApp.OpenDoc6($sldasm, [int]$docTypeAsm, [int]$openSilent, "", [ref]$errs, [ref]$warns)
    if ($null -eq $model) {
        Write-Warning "  OpenDoc6 returned null (errors=$errs warnings=$warns)"
        $failed += $cadFileBase
        continue
    }

    # SaveAs3(filename, version, options) - version=current, options=copy
    $saveOk = $model.SaveAs3($outStep, [int]$saveCurrent, [int]$saveCopy)

    if ($saveOk -ne 0) {
        # SW returns 0 on success; non-zero is a bitmask of errors.
        Write-Warning "  SaveAs3 returned $saveOk (non-zero = error)"
    }

    if (Test-Path $outStep) {
        $size = (Get-Item $outStep).Length
        $sizeMB = [Math]::Round($size / 1MB, 2)
        Write-Host "  OK wrote $sizeMB MB"
        $ok++
    } else {
        Write-Warning "  output file not produced"
        $failed += $cadFileBase
    }

    # Close the doc to free RAM before the next one (these can be huge).
    $swApp.CloseDoc($model.GetTitle())
}

$elapsed = (Get-Date) - $t0
Write-Host ""
Write-Host "[done] $ok/$($assemblies.Count) succeeded in $([Math]::Round($elapsed.TotalMinutes, 1)) min"
if ($failed.Count -gt 0) {
    Write-Host "[done] failed: $($failed -join ', ')"
}
Write-Host "[done] output: $OutDir"
