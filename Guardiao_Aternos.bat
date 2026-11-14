@echo off
chcp 65001 >nul
title Guardião do Servidor Aternos v2.0
cd /d "C:\Users\eduar\Otimizacoes\AternosKeeper"

where node >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js não encontrado no PATH do sistema!
    echo Verifique a instalação em C:\Program Files\nodejs\
    pause
    exit /b 1
)

node guardiao.js %*
if errorlevel 1 (
    echo.
    echo [AVISO] O Guardião encerrou com erro. Veja a mensagem acima.
    pause
)
