@ECHO ON
call npm run package
echo CODE 1
call code --profile "Obsidian like" --uninstall-extension angelCastro.vault-tool
call code --profile "Obsidian like" --install-extension vault-tool-0.0.1.vsix

cd ..\vscode-tasks\vscode-extension
call npm run package
ECHO CODE 2
call code --profile "Obsidian like" --uninstall-extension angelCastro.obsidian-like-tasks
call code --profile "Obsidian like" --install-extension obsidian-like-tasks-0.1.0.vsix

cd ..\..\obsidianlike
ECHO Matas
taskkill /IM code.exe /F
call code --profile "Obsidian like"