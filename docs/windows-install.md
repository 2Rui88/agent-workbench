# Windows 安装与一键部署

安装脚本会准备项目所需的便携版 Node.js、Windows Terminal，并完成依赖安装和构建。脚本不会发起模型调用。

在仓库根目录打开 PowerShell，执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1
```

安装完成后，使用生成的启动器：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AgentWorkbench\agent-workbench.ps1" init
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AgentWorkbench\agent-workbench.ps1" start
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AgentWorkbench\agent-workbench.ps1" status
```

`init` 只创建本机配置，不会调用模型。完成 Coordinator 的凭据初始化和人工审批配置后，再启动 Coordinator 服务。

安装器使用固定版本的便携 Node.js `24.22.0` 和 Windows Terminal `1.25.2733.0`，也可以通过 `-NodeVersion`、`-WindowsTerminalVersion` 覆盖。若运行环境已经准备好依赖，可使用 `-SkipNodeDownload`、`-SkipWindowsTerminalDownload` 或 `-SkipNpmInstall`。

生成可交付 ZIP：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\package.ps1
```

ZIP 解压后仍需在解压目录执行 `scripts\windows\install.ps1`，由安装器在目标机器上准备运行时和依赖。

## Windows Terminal 分屏

`windows-terminal:start` 现在只创建一个 Windows Terminal 标签页，然后建立五个 pane：上方一行为 Coordinator overview，下方一行横向均分为 frontend、backend、audit、advisor 四列。它保留 Dashboard、Herdr 和 Kitty 的职责分工，同时用 Windows Terminal pane 取代 Kitty pane。

启动和停止：

```powershell
node packages\coordinator\dist\scripts\windows-terminal-start.js <runtime.json>
node packages\coordinator\dist\scripts\windows-terminal-stop.js <runtime.json>
```
