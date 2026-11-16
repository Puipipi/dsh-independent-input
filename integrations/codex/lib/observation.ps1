# Policy comes from startup settings/env, never from per-action tool arguments.
function Get-FocusPolicyBlock($req) {
  if($req.mode -eq 'uia' -and $script:focusPolicy -cne 'allow-activation') {
    return @{ok=$false;reason='focus-policy-preserve';focusPolicy='preserve';inputSent=$false;providerCalled=$false;note='保焦点策略已拒绝UIA provider输入；未调用provider、未发送输入。只读observe仍可用；使用受支持的auto/message后台路径，不支持则报告限制。'}
  }
  return $null
}

# One process-local observation; IDs are locators, never permissions.
$script:CurrentObservation = $null

function Get-ObservationRoot([long]$hwnd) {
  return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
}

function Get-ElementSnapshot($element) {
  $current = $element.Current
  $bounds = $current.BoundingRectangle
  $nativeHandle=0L; $nativeClass=''; $nativeRoot=0L; $nativePid=0; $nativeStyle=0L
  try {
    $nativeHandle=([long]$current.NativeWindowHandle -band 4294967295L)
    if($nativeHandle -and [DshInput]::IsWindow([IntPtr]$nativeHandle)) {
      $nativeClass=[DshInput]::WindowClass([IntPtr]$nativeHandle)
      $nativeRoot=[long][DshInput]::RootOf([IntPtr]$nativeHandle)
      $nativePid=[DshInput]::WindowPid([IntPtr]$nativeHandle)
      $nativeStyle=[DshInput]::GetWindowLongPtrW([IntPtr]$nativeHandle,-16).ToInt64()
    }
  } catch { $nativeHandle=0L }
  $nativeIsEdit=$nativeClass -match '^(Edit|WindowsForms10\.EDIT\..+)$'
  $nativePassword=$nativeIsEdit -and (($nativeStyle -band 0x0020) -ne 0)
  $nativeReadOnly=$nativeIsEdit -and (($nativeStyle -band 0x0800) -ne 0)
  $patterns = @()
  $state = [ordered]@{}
  $value = $null
  foreach ($name in @('Invoke', 'Toggle', 'SelectionItem', 'Value')) {
    try {
      $type = switch ($name) {
        'Invoke' { [System.Windows.Automation.InvokePattern]::Pattern }
        'Toggle' { [System.Windows.Automation.TogglePattern]::Pattern }
        'SelectionItem' { [System.Windows.Automation.SelectionItemPattern]::Pattern }
        'Value' { [System.Windows.Automation.ValuePattern]::Pattern }
      }
      $pattern = $element.GetCurrentPattern($type)
      $patterns += $name
      if ($name -eq 'Value' -and -not $current.IsPassword -and -not $nativePassword) { $value = [string]$pattern.Current.Value }
      if ($name -eq 'Value') { $state['readonly'] = [bool]$pattern.Current.IsReadOnly }
      if ($name -eq 'Toggle') { $state['toggle'] = [string]$pattern.Current.ToggleState }
      if ($name -eq 'SelectionItem') { $state['selected'] = [bool]$pattern.Current.IsSelected }
    } catch { }
  }
  return [ordered]@{
    nativeWindowHandle=$nativeHandle; nativeClass=$nativeClass; nativeRoot=$nativeRoot; nativePid=$nativePid
    nativeReadOnly=$nativeReadOnly; nativePassword=$nativePassword
    runtimeId = ($element.GetRuntimeId() -join ',')
    name = [string]$current.Name
    automationId = [string]$current.AutomationId
    type = [string]$current.ControlType.ProgrammaticName
    enabled = [bool]$current.IsEnabled
    offscreen = [bool]$current.IsOffscreen
    password = ([bool]$current.IsPassword -or $nativePassword)
    rect = [ordered]@{ x = [int]$bounds.X; y = [int]$bounds.Y; width = [int]$bounds.Width; height = [int]$bounds.Height }
    patterns = @($patterns)
    state = $state
    value = $value
  }
}

function Get-ElementParentKey($element) {
  try {
    $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element)
    if ($null -ne $parent) { return ($parent.GetRuntimeId() -join ',') }
  } catch { }
  return $null
}

function Get-ObservationFirstChild($element) {
  return [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetFirstChild($element)
}

function Get-ObservationNextSibling($element) {
  return [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetNextSibling($element)
}

function New-InputObservation([long]$hwnd, [int]$limit = 150) {
  $script:CurrentObservation = $null
  if ($limit -lt 1 -or $limit -gt 500) { return @{ ok = $false; reason = 'invalid-elements-limit' } }
  if (-not $script:uia) { return @{ ok = $false; reason = 'uia-unavailable' } }
  if (-not [DshInput]::IsWindow([IntPtr]$hwnd)) { return @{ ok = $false; reason = 'target-hwnd-invalid' } }
  $root = Get-ObservationRoot $hwnd
  if ($null -eq $root) { return @{ ok = $false; reason = 'uia-no-window' } }
  $elements = @()
  $pending = New-Object 'System.Collections.Generic.Queue[object]'
  $pending.Enqueue($root)
  $truncated = $false
  while ($pending.Count -gt 0) {
    $element = $pending.Dequeue()
    $elements += $element
    try {
      $child = Get-ObservationFirstChild $element
      while ($null -ne $child) {
        if ($elements.Count + $pending.Count -ge $limit) { $truncated = $true; break }
        $pending.Enqueue($child)
        $child = Get-ObservationNextSibling $child
      }
    } catch { }
  }
  $entries = @{}
  $runtimeIds = @{}
  $nodes = @()
  foreach ($element in $elements) {
    try {
      $snapshot = Get-ElementSnapshot $element
      $id = 'e' + $nodes.Count
      $entries[$id] = @{ element = $element; signature = ($snapshot | ConvertTo-Json -Depth 6 -Compress) }
      $runtimeIds[$snapshot.runtimeId] = $id
      $node = [ordered]@{ elementId = $id; parentId = $null }
      foreach ($key in @('nativeWindowHandle','nativeClass','nativeRoot','nativePid','nativeReadOnly','nativePassword','name','automationId','type','enabled','offscreen','password','rect','patterns','state','value')) { $node[$key] = $snapshot[$key] }
      $nodes += $node
    } catch { }
  }
  foreach ($node in $nodes) {
    $parentKey = Get-ElementParentKey $entries[$node.elementId].element
    if ($parentKey -and $runtimeIds.ContainsKey($parentKey)) { $node.parentId = $runtimeIds[$parentKey] }
  }
  $observationId = [Guid]::NewGuid().ToString('N')
  $script:CurrentObservation = @{
    id = $observationId; hwnd = $hwnd; root = $root
    rootRuntimeId = ($root.GetRuntimeId() -join ',')
    windowRect = ([DshInput]::WindowRect([IntPtr]$hwnd) -join ',')
    entries = $entries
  }
  $rect = [DshInput]::WindowRect([IntPtr]$hwnd)
  return @{ ok = $true; observationId = $observationId; hwnd = $hwnd; window = @{ hwnd = $hwnd; title = [DshInput]::WindowTitle([IntPtr]$hwnd); rect = @{ x = $rect[0]; y = $rect[1]; width = $rect[2]; height = $rect[3] } }; coordinateSystem = 'screen-physical-pixels'; elements = @($nodes); truncated = $truncated; note = '元素ID仅属于本次观察；动作后重新observe。普通状态变化返回stale，不代表用户停止。' }
}

function Invoke-ObservedValue($req,$entry,$snapshot,$observation) {
  $attempted=$false
  try {
    if([string]$req.cmd -ne 'type' -or $snapshot.type -notin @('ControlType.Edit','ControlType.ComboBox') -or $snapshot.patterns -notcontains 'Value'){return @{ok=$false;verified=$false;reason='value-pattern-unsupported';attempted=$false}}
    if($snapshot.password -or $snapshot.nativePassword){return @{ok=$false;verified=$false;reason='element-password';attempted=$false}}
    if($snapshot.nativeReadOnly -or $snapshot.state.readonly){return @{ok=$false;verified=$false;reason='element-readonly';attempted=$false}}
    $pattern=$entry.element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if($pattern.Current.IsReadOnly){return @{ok=$false;verified=$false;reason='element-readonly';attempted=$false}}
    $current=[string]$pattern.Current.Value
    if($current -cne [string]$snapshot.value){return @{ok=$false;verified=$false;reason='stale-observation';refresh='observe';attempted=$false}}
    $want=if($req.replace){[string]$req.text}else{$current+[string]$req.text}
    $x=[int]($snapshot.rect.x+$snapshot.rect.width/2);$y=[int]($snapshot.rect.y+$snapshot.rect.height/2)
    if($current -ceq $want){return @{ok=$true;verified=$true;via='uia-value-element';attempted=$false;noOp=$true;hwnd=[long]$req.hwnd;targetRect=$snapshot.rect;x=$x;y=$y;verification='value-readback-only';focusRequested=$false;focusEffect='unverified';mayActivate=$true;note='当前Value已精确相同；未调用setter，也不声称触发DOM事件。'}}
    Commit-InputSource $req;Show-InputIndicator $x $y
    # Header preparation may take time: revalidate the guarded element/value
    # before one setter call, never append to an unguarded later value.
    if(-not [DshInput]::IsWindow([IntPtr]$req.hwnd) -or ($observation.root.GetRuntimeId() -join ',') -cne $observation.rootRuntimeId -or ([DshInput]::WindowRect([IntPtr]$req.hwnd) -join ',') -cne $observation.windowRect -or ((Get-ElementSnapshot $entry.element) | ConvertTo-Json -Depth 6 -Compress) -cne $entry.signature){return @{ok=$false;verified=$false;reason='stale-observation';refresh='observe';attempted=$false}}
    [DshInput]::CheckNotPaused()
    $attempted=$true
    $pattern.SetValue($want)
    $readback=[Diagnostics.Stopwatch]::StartNew();$matched=$false
    do {
      [DshInput]::CheckNotPaused()
      $probe=Get-ElementSnapshot $entry.element
      if(-not [DshInput]::IsWindow([IntPtr]$req.hwnd) -or ($observation.root.GetRuntimeId() -join ',') -cne $observation.rootRuntimeId -or ([DshInput]::WindowRect([IntPtr]$req.hwnd) -join ',') -cne $observation.windowRect -or $probe.runtimeId -cne $snapshot.runtimeId -or $probe.type -cne $snapshot.type -or $probe.patterns -notcontains 'Value' -or -not $probe.enabled -or $probe.password -or $probe.nativePassword -or $probe.nativeReadOnly -or $probe.state.readonly -or $pattern.Current.IsReadOnly){return @{ok=$false;verified=$false;reason='value-target-changed-after-write';attempted=$true;partial='possible';verification='value-readback-unconfirmed';focusRequested=$false;focusEffect='unverified';mayActivate=$true}}
      # Direct getter must succeed: a missing snapshot value is not proof of empty.
      $actual=[string]$pattern.Current.Value
      [DshInput]::CheckNotPaused()
      if($actual -ceq $want){$matched=$true;break}
      $remaining=800-$readback.ElapsedMilliseconds
      if($remaining -le 0){break}
      Start-Sleep -Milliseconds ([int][Math]::Min(50,$remaining))
    } while($readback.ElapsedMilliseconds -lt 800)
    if(-not $matched){return @{ok=$false;verified=$false;reason='value-write-uncertain';attempted=$true;partial='possible';verification='value-readback-unconfirmed';focusRequested=$false;focusEffect='unverified';mayActivate=$true;note='单次setter后的只读轮询预算已到；未确认，不自动重写或回退。'}}
    return @{ok=$true;verified=$true;via='uia-value-element';attempted=$true;hwnd=[long]$req.hwnd;targetRect=$snapshot.rect;x=$x;y=$y;verification='value-readback-only';focusRequested=$false;focusEffect='unverified';mayActivate=$true;note='仅ValuePattern.SetValue与精确回读；未请求SetFocus，不确认input/change/React或CSS控件类型，provider/应用仍可能激活。'}
  } catch {
    return @{ok=$false;verified=$false;reason=if($attempted){'value-write-uncertain'}else{'value-not-applied'};attempted=$attempted;partial=if($attempted){'possible'}else{$null};paused=[DshInput]::Paused;focusRequested=$false;focusEffect='unverified';mayActivate=$attempted;error=$_.Exception.Message;note='未使用其他provider/坐标/键盘回退；写后不确定不得自动重发。'}
  }
}

function Invoke-ObservedElement($req) {
  $observation = $script:CurrentObservation
  # Consume the observation before any side effect, including uncertain failures.
  $script:CurrentObservation = $null
  if ($null -eq $observation -or $observation.id -cne [string]$req.observationId -or $observation.hwnd -ne [long]$req.hwnd -or -not $observation.entries.ContainsKey([string]$req.elementId)) {
    return @{ ok = $false; reason = 'stale-observation'; refresh = 'observe'; note = '观察ID/元素ID已失效或不属于目标窗口；fresh observe后仅重试原动作一次。' }
  }
  $entry = $observation.entries[[string]$req.elementId]
  try {
    $snapshot = Get-ElementSnapshot $entry.element
    if (-not [DshInput]::IsWindow([IntPtr]$req.hwnd) -or ($observation.root.GetRuntimeId() -join ',') -cne $observation.rootRuntimeId -or ([DshInput]::WindowRect([IntPtr]$req.hwnd) -join ',') -cne $observation.windowRect -or ($snapshot | ConvertTo-Json -Depth 6 -Compress) -cne $entry.signature) {
      return @{ ok = $false; reason = 'stale-observation'; refresh = 'observe'; note = '窗口/元素状态已变化；fresh observe后仅重试原动作一次，不清除暂停。' }
    }
  } catch { return @{ ok = $false; reason = 'stale-observation'; refresh = 'observe'; note = '原元素已不可读；重新观察，不发出动作。' } }
  try {
    $focusBlock=Get-FocusPolicyBlock $req
    if($null -ne $focusBlock){return $focusBlock}
    if (-not $snapshot.enabled -or $snapshot.offscreen) { return @{ ok = $false; reason = 'element-unavailable' } }
    if($req.mode -eq 'value'){return Invoke-ObservedValue $req $entry $snapshot $observation}
    if ($req.mode -ne 'uia') {
      $h=[IntPtr][long]$snapshot.nativeWindowHandle
      $owned=$snapshot.nativeWindowHandle -and [DshInput]::IsWindow($h) -and $snapshot.nativeRoot -eq [long][DshInput]::RootOf([IntPtr]$req.hwnd) -and $snapshot.nativePid -eq [DshInput]::WindowPid([IntPtr]$req.hwnd)
      $x=[int]($snapshot.rect.x+$snapshot.rect.width/2); $y=[int]($snapshot.rect.y+$snapshot.rect.height/2)
      $button=$snapshot.type -eq 'ControlType.Button' -and $snapshot.nativeClass -match '^(Button|WindowsForms10\.BUTTON\..+)$'
      $edit=$snapshot.type -eq 'ControlType.Edit' -and $snapshot.nativeClass -match '^(Edit|WindowsForms10\.EDIT\..+)$'
      if(-not $owned -or ([string]$req.cmd -eq 'click' -and -not $button) -or ([string]$req.cmd -eq 'type' -and -not $edit)) {
        return @{ok=$false;reason='focus-preserving-unsupported';note='该元素无已核实标准native后台路径；未调用UIA副作用或坐标回退。仅允许目标激活时显式选择mode:uia。'}
      }
      if([string]$req.cmd -eq 'click') {
        $n=1
        if($req -is [System.Collections.IDictionary]) {if($req.Contains('count')){$n=[int]$req['count']}} elseif($req.PSObject.Properties['count']){$n=[int]$req.count}
        if(($req.button -and $req.button -ne 'left') -or $n -ne 1){return @{ok=$false;reason='semantic-click-left-single-only'}}
        Commit-InputSource $req
        Show-InputIndicator $x $y
        $sent=[DshInput]::PostMessage($h,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)
        [DshInput]::CheckNotPaused()
        return @{ok=$sent;via='bm_click-element';hwnd=[long]$h;target=[long]$req.hwnd;verified=$false;targetRect=$snapshot.rect;x=$x;y=$y;note='仅一次目标Button BM_CLICK投递，未调用provider Invoke；效果须重观察，应用仍可能自行激活。'}
      }
      if($snapshot.password -or $snapshot.nativePassword){return @{ok=$false;reason='element-value-unsupported'}}
      if($snapshot.nativeReadOnly -or $snapshot.state.readonly){return @{ok=$false;reason='element-readonly'}}
      [DshInput]::CheckNotPaused()
      $want=if($req.replace){[string]$req.text}else{[DshInput]::GetTextMessage($h)+[string]$req.text}
      Commit-InputSource $req
        Show-InputIndicator $x $y
      $accepted=[DshInput]::SetTextMessage($h,$want)
      $actual=[DshInput]::GetTextMessage($h)
      [DshInput]::CheckNotPaused()
      if(-not $accepted -or $actual -cne $want){return @{ok=$false;reason='element-write-unverified';attempted=$true;note='已尝试一次WM_SETTEXT，禁止重发或provider回退；fresh观察。'}}
      return @{ok=$true;via='wm_settext-element';hwnd=[long]$h;target=[long]$req.hwnd;verified=$true;targetRect=$snapshot.rect;x=$x;y=$y;note='目标Edit单次WM_SETTEXT+精确回读；未调用provider SetValue，应用仍可能自行激活。'}
    }
    if ([string]$req.cmd -eq 'click') {
      [DshInput]::CheckNotPaused()
      $clickCount = 1
      if ($req -is [System.Collections.IDictionary]) { if ($req.Contains('count')) { $clickCount = [int]$req['count'] } }
      elseif ($req.PSObject.Properties['count']) { $clickCount = [int]$req.count }
      if (($req.button -and $req.button -ne 'left') -or $clickCount -ne 1) { return @{ ok = $false; reason = 'semantic-click-left-single-only'; note = '右键/双击请fresh capture后明确使用hwnd+坐标消息接口。' } }
      if(-not (@('Invoke','Toggle','SelectionItem') | Where-Object { $snapshot.patterns -contains $_ })) {return @{ok=$false;reason='element-click-unsupported'}}
      Commit-InputSource $req
        Show-InputIndicator ([int]($snapshot.rect.x+$snapshot.rect.width/2)) ([int]($snapshot.rect.y+$snapshot.rect.height/2))
      if ($snapshot.patterns -contains 'Invoke') { $entry.element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
      elseif ($snapshot.patterns -contains 'Toggle') { $entry.element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle() }
      elseif ($snapshot.patterns -contains 'SelectionItem') { $entry.element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }
      else { return @{ ok = $false; reason = 'element-click-unsupported'; note = '未调用SetFocus或物理输入；可观察后使用显式hwnd消息接口，或报告应用不支持。' } }
      return @{ ok = $true; via = 'uia-element'; mayActivate = $true; hwnd = [long]$req.hwnd; verified = $false; targetRect = $snapshot.rect; x = [int]($snapshot.rect.x + $snapshot.rect.width / 2); y = [int]($snapshot.rect.y + $snapshot.rect.height / 2); note = '语义动作已调用，应用结果仍需重新观察确认。' }
    }
    if ($snapshot.password -or $snapshot.patterns -notcontains 'Value') { return @{ ok = $false; reason = 'element-value-unsupported' } }
    $pattern = $entry.element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($pattern.Current.IsReadOnly) { return @{ ok = $false; reason = 'element-readonly' } }
    $want = if ($req.replace) { [string]$req.text } else { [string]$pattern.Current.Value + [string]$req.text }
    [DshInput]::CheckNotPaused()
    Commit-InputSource $req
        Show-InputIndicator ([int]($snapshot.rect.x+$snapshot.rect.width/2)) ([int]($snapshot.rect.y+$snapshot.rect.height/2))
    $pattern.SetValue($want)
    if ([string]$pattern.Current.Value -cne $want) { return @{ ok = $false; reason = 'element-write-unverified'; note = '已尝试写入，不自动发送第二份文字；重新观察。' } }
    return @{ ok = $true; via = 'uia-element'; mayActivate = $true; hwnd = [long]$req.hwnd; verified = $true; targetRect = $snapshot.rect; x = [int]($snapshot.rect.x + $snapshot.rect.width / 2); y = [int]($snapshot.rect.y + $snapshot.rect.height / 2); note = '显式provider Value写入并回读一致；provider/应用可能激活目标。' }
  } catch {
    if ([DshInput]::Paused) { return @{ ok = $false; paused = $true; reason = 'paused-partial'; partial = 'possible' } }
    return @{ ok = $false; reason = 'element-operation-failed'; note = '元素可能失效或动作结果不确定；重新observe，不盲重发。'; error = $_.Exception.Message }
  }
}

function Get-InputObservationStatus([string]$id, [long]$hwnd) {
  try {
    $observation = $script:CurrentObservation
    if ($null -eq $observation -or $observation.id -cne $id -or $observation.hwnd -ne $hwnd -or -not [DshInput]::IsWindow([IntPtr]$hwnd) -or ($observation.root.GetRuntimeId() -join ',') -cne $observation.rootRuntimeId -or ([DshInput]::WindowRect([IntPtr]$hwnd) -join ',') -cne $observation.windowRect) {
      $script:CurrentObservation = $null
      return @{ ok = $false; reason = 'stale-observation'; refresh = 'observe' }
    }
    return @{ ok = $true; observationId = $id; hwnd = $hwnd }
  } catch { $script:CurrentObservation = $null; return @{ ok = $false; reason = 'stale-observation'; refresh = 'observe' } }
}

# Update only the non-interactive header before a validated side effect. Failure
# blocks dispatch; never retry input automatically. Recheck Esc afterwards.
function Show-InputIndicator([int]$x, [int]$y) {
  [DshInput]::CheckNotPaused()
  if (-not [DshOverlay]::ShowIndicatorAt($x, $y)) { throw 'target-screen-indicator-failed: 未发送输入，屏幕提示未确认可见' }
  [DshInput]::CheckNotPaused()
}
