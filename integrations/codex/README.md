0.6.2：会话名tooltip按实际文字测量行高保留原padding，并在首次显示/字体/DPI变化后重排，避免高DPI中文笔画裁切；Ctrl+Esc规则不变。

0.6.1：本插件active停止手势改为Ctrl+Esc（左右Ctrl，排除Shift/Alt/Win）；单Esc不暂停本插件。宿主Esc/停止/拒绝规则不变，Ctrl+Alt+Q兼容保留。

# Codex integration

Independent Codex MCP/plugin runtime for Windows. This directory preserves the accepted 0.6.0 control, observation and input implementation separately from the original DSH entry points. It duplicates the runtime deliberately: no unverified DSH identity adapter or input policy change is imposed on the original plugin.

- Read-only UIA observation plus optional WGC image attachment; provider visibility and content freshness are not visual verification.
- Trusted execution identities, shared desktop lease, FIFO request/wait/cancel, cancellable waits, one reminder per hold, and persistent Esc/host-stop provenance. Old clients and official computer-use are outside this lock; official activity remains unknown.
- Native window messages; fresh observed writable ValuePattern elements support explicit `type` `mode:value` with a single setter and bounded exact readback. This verifies the value only, not every DOM framework or unchanged foreground focus.
- Live monitor enumeration, target-screen feedback, cursor animation continuity and optional window placement. Physical input and automatic official-CU fallback remain disabled.

See [verification](docs/verification.md) for isolated tests and the limits of prior live evidence. Run `npm test` here on Windows with Node 24. No dependency install is required for the automatic checks. No automatic test opens a GUI or sends application input.

## Build and package

Run the following from this directory using installed Visual Studio C++ tools and Windows SDK. Use a new output directory of your choice:

```powershell
cmd /c native\window-capture\build.cmd
$out = Join-Path $env:TEMP 'independent-input-package'
powershell.exe -NoProfile -File scripts/package-codex.ps1 -OutputDirectory $out
Expand-Archive -LiteralPath (Join-Path $out 'dsh-independent-input-codex-0.6.2.zip') -DestinationPath (Join-Path $out 'marketplace')
codex plugin marketplace add (Join-Path $out 'marketplace/dsh-independent-input') --json
codex plugin add dsh-independent-input@dsh-independent-input-local --json
codex plugin list --marketplace dsh-independent-input-local --json
```

The generated extracted plugin contains its own assets and native helper. **Do not install this unstaged development directory directly:** its repository-relative assets will not exist in an isolated cache. The commands install a plugin; they are not part of automatic verification. Generated binaries/ZIPs are ignored and not committed.

The development checkout resolves assets from the repository root. Packaging copies those unchanged upstream assets into the standalone stage; no personal video-frame artwork or metadata is required. Root DSH runtime/assets are unchanged. Their existing artwork attribution/terms remain in the root NOTICE; no additional art license is asserted. Local personal skins are not included or required.

The queue workflow keeps the original authorized CU executor active while waiting, renews waits up to 45 seconds each, and cancels its own ticket on stop. Idle chats cannot be proactively awakened. A parent with independent work may let the same CU child wait and report through its existing parent-child channel; no new background model or cross-project dispatcher is created.
