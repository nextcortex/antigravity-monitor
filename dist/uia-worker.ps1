# UIA Auto-Accept Worker for Antigravity IDE
# Uses Windows UI Automation to find and click Accept/Run buttons.
# Runs as a child process, prints "CLICK:<name>" on stdout for each click.
# Exit with Ctrl+C or kill the process.

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$ErrorActionPreference = 'SilentlyContinue'

# Button text patterns to click (case-insensitive, start-anchored)
# Defaults — can be overridden via %TEMP%\agm-uia-config.json
$DefaultAcceptPatterns = @(
    '^Accept',
    '^Allow Once',
    '^Always Allow',
    '^Allow.*Conversation',
    '^Confirm',
    'RunAlt\+',
    'Run Alt\+',
    '^Run command',
    '^Execute'
)

# Button text patterns to NEVER click (defaults)
$DefaultSkipPatterns = @(
    'always run', 'reject', 'cancel', 'skip', 'refine', 'running',
    'run and debug', 'run python', 'run test', 'run file', 'run all',
    'run without', '\.py', '\.md', '\.json', 'git', 'synchronize',
    'checkout', 'auto-accept'
)

# Try loading from config file (written by extension)
$ConfigPath = Join-Path $env:TEMP 'agm-uia-config.json'
$AcceptPatterns = $DefaultAcceptPatterns
$SkipPatterns = $DefaultSkipPatterns

if (Test-Path $ConfigPath) {
    try {
        $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        if ($cfg.acceptPatterns -and $cfg.acceptPatterns.Count -gt 0) {
            $AcceptPatterns = $cfg.acceptPatterns
        }
        if ($cfg.skipPatterns -and $cfg.skipPatterns.Count -gt 0) {
            $SkipPatterns = $cfg.skipPatterns
        }
    } catch {
        # Config file corrupt — use defaults
    }
}

$AcceptRegex = ($AcceptPatterns -join '|')
$SkipRegex = ($SkipPatterns -join '|')

$PollMs = 300
$CooldownMs = 1500

function Find-AntigravityWindow {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        'Chrome_WidgetWin_1'
    )
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    foreach ($w in $windows) {
        $name = $w.Current.Name
        if ($name -match '(?i)antigravity' -and $name -notmatch '(?i)\bcursor\b') {
            return $w
        }
    }
    return $null
}

function Find-AcceptButton {
    param([System.Windows.Automation.AutomationElement]$Window)

    $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
    )

    $buttons = $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
    foreach ($btn in $buttons) {
        $name = $btn.Current.Name
        if (-not $name) { continue }
        $normalized = $name -replace '\s', ''
        if (($name -match $AcceptRegex -or $normalized -match $AcceptRegex) -and $name -notmatch $SkipRegex) {
            return $btn
        }
    }
    return $null
}

function Click-Button {
    param([System.Windows.Automation.AutomationElement]$Button)
    try {
        $invokePattern = $Button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        if ($invokePattern) {
            $invokePattern.Invoke()
            return $true
        }
    } catch {}
    return $false
}

# Main loop
Write-Host "UIA-READY" -NoNewline
[Console]::Out.Flush()
Write-Host ""

$cachedWindow = $null
$lastClick = [DateTime]::MinValue

while ($true) {
    try {
        # Cooldown
        $elapsed = ([DateTime]::Now - $lastClick).TotalMilliseconds
        if ($elapsed -lt $CooldownMs) {
            Start-Sleep -Milliseconds $PollMs
            continue
        }

        # Find window
        if ($null -eq $cachedWindow) {
            $cachedWindow = Find-AntigravityWindow
            if ($null -eq $cachedWindow) {
                Start-Sleep -Milliseconds $PollMs
                continue
            }
        }

        # Verify window still exists
        try {
            $null = $cachedWindow.Current.Name
        } catch {
            $cachedWindow = $null
            Start-Sleep -Milliseconds $PollMs
            continue
        }

        # Find and click
        $btn = Find-AcceptButton -Window $cachedWindow
        if ($null -ne $btn) {
            $btnName = $btn.Current.Name
            if (Click-Button -Button $btn) {
                Write-Host "CLICK:$btnName"
                [Console]::Out.Flush()
                $lastClick = [DateTime]::Now
            }
        }
    } catch {
        # Window may have closed
        $cachedWindow = $null
    }

    Start-Sleep -Milliseconds $PollMs
}
