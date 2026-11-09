@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem ============================================================
rem  headless 启动：桥接的输出全部写入 state\bridge-console.log
rem
rem  为什么要这样跑：
rem  cmd.exe 的「快速编辑模式」下，只要鼠标在窗口里选中了文本，
rem  程序的下一次输出写入就会永久阻塞，整个 Node 进程被冻结
rem  （表现为：CPU 归零、控制台无响应、不再重连、日志停止）。
rem  把 stdout/stderr 重定向到文件后就没有这个风险了。
rem
rem  查看日志：type state\bridge-console.log
rem  停止：直接关掉这个窗口，或在本窗口按 Ctrl+C
rem ============================================================
:loop
echo [%date% %time%] starting bridge >> state\bridge-console.log
node src\bridge.js >> state\bridge-console.log 2>&1
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] another bridge instance is already running, exiting. >> state\bridge-console.log
    echo Bridge already running in another window. Exiting.
    exit /b 2
)
echo [%date% %time%] bridge exited ^(code %code%^), restarting in 5 seconds... >> state\bridge-console.log
timeout /t 5 /nobreak >nul
goto loop
