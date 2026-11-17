$ErrorActionPreference='Stop'
. "$PSScriptRoot/../lib/auth-privacy.ps1"
$secret='fixture-credential-123';$url="https://qa.test/auth/login?key=$secret"
if((Protect-AuthUrlText $url) -match $secret){throw 'auth URL leaked'}
if((Protect-AuthUrlText 'https://shop.test/products?key=sku') -cne 'https://shop.test/products?key=sku'){throw 'ordinary URL altered'}
$source=Get-Content -LiteralPath "$PSScriptRoot/../sidecar.ps1" -Raw
$start=$source.IndexOf("    'capture' {")
$end=$source.IndexOf('      $path = [string]$req.path',$start)
$gate=$source.Substring($start+16,$end-($start+16))
Add-Type 'public class DshInput {public static System.IntPtr GetForegroundWindow(){return new System.IntPtr(1);}}'
function Get-CaptureAuthPrivacy {return @{checked=$true;sensitive=$script:sensitive}}
function Test-Gate {Invoke-Expression $gate;return @{passed=$true}}
$script:sensitive=$true;$r=Test-Gate
if($r.reason -ne 'authentication-url-screenshot-suppressed'){throw 'capture gate failed'}
$script:sensitive=$false;if(-not (Test-Gate).passed){throw 'ordinary capture blocked'}
Write-Output 'PASS upstream actual capture command gate blocks sensitive before path/write; ordinary passes (scanner result fixture)'
