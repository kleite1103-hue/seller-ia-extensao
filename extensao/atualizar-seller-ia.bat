@echo off
chcp 65001 >nul
echo ============================================
echo   SELLER.IA — Atualizador da extensao
echo ============================================
cd /d "%~dp0"
set BASE=https://raw.githubusercontent.com/kleite1103-hue/seller-ia-extensao/main/extensao
for %%F in (manifest.json coletor.js interceptor.js bg.js icon16.png icon48.png icon128.png) do (
  echo Baixando %%F ...
  curl -sL -o "%%F" "%BASE%/%%F"
)
echo.
echo Pronto! Agora abra chrome://extensions e clique na SETINHA DE RECARREGAR do card Seller.IA.
echo (So precisa remover e carregar de novo quando eu avisar "recarga completa".)
pause
