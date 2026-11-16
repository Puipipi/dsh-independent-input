param([string]$SourceRoot=(Join-Path $PSScriptRoot '..'))
# Compile actual C#; call the exact hook-filter/record method without any hook,
# SendInput, Form, or keyboard event. Non-stop keys leave no record.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$source=[IO.File]::ReadAllText((Join-Path $SourceRoot 'sidecar.ps1')).Replace("`r`n","`n")
$start=$source.IndexOf('$cs = @'+"'`n")+9;$end=$source.IndexOf("`n'@",$start)
Add-Type -TypeDefinition $source.Substring($start,$end-$start) -ReferencedAssemblies @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[System.Windows.Forms.Form].Assembly.Location,[Drawing.Point].Assembly.Location)
[DshInput]::SetStopOwner('{"executionId":"fixture-execution","rootId":"fixture-root","name":"测试主聊天"}')
[DshInput]::SessionActive=$true
foreach($case in @(@(65,30,0,256),@(27,1,16,256),@(27,1,0,257))){if([DshInput]::RecordKeyStop($case[0],$case[1],$case[2],$case[3])){throw 'non-stopping keyboard event recorded'}}
if([DshInput]::StopInfo){throw 'keyboard history must not be created'}
if(-not [DshInput]::RecordKeyStop(27,1,0,256)){throw 'Esc did not create stop record'}
$first=[DshInput]::StopInfo
if($first.source -ne 'keyboard-hook' -or $first.reason -ne 'escape' -or $first.keyboard.vkCode -ne 27 -or $first.keyboard.scanCode -ne 1 -or $first.keyboard.injected -ne $false -or -not $first.utcTimestamp -or $first.ownerName -ne '测试主聊天'){throw 'actual Esc metadata incomplete'}
if([DshInput]::RecordStop('transport-eof','transport-eof',$null)){throw 'EOF replaced the original stop'}
if([DshInput]::StopInfo.utcTimestamp -ne $first.utcTimestamp -or [DshInput]::StopInfo.source -ne 'keyboard-hook'){throw 'original Esc source/time changed'}
[DshInput]::Resume()
if([DshInput]::Paused -or [DshInput]::StopInfo -or [DshInput]::LastStop.source -ne 'keyboard-hook'){throw 'resume/current versus history mismatch'}
if(-not [DshInput]::RecordKeyStop(27,1,0,260)){throw 'second Esc event missing'}
if([DshInput]::StopInfo.sequence -le $first.sequence){throw 'new independent stop reused old event'}
if([DshOverlay]::HeaderVisible()){throw 'stop-record test initialized UI'}
'PASS actual C# Esc filter/record: no other key/injected/key-up history; trigger fields+UTC+owner; EOF preserves original; resume retains historical stop; second event increments; no hooks/windows/input'
