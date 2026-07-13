@ECHO ON
chcp 65001 >nul
call npm run package
echo CODE 1
call code --profile "Obsidian like" --uninstall-extension angelCastro.obsidian-like
call code --profile "Obsidian like" --install-extension obsidian-like-0.0.1.vsix

cd ..\obsidianlike_tasks
call npm run package
ECHO CODE 2
call code --profile "Obsidian like" --uninstall-extension angelCastro.obsidian-like-tasks
call code --profile "Obsidian like" --install-extension obsidian-like-tasks-0.1.0.vsix

cd ..\obsidianlike_clearunusedimages
call npm run package
ECHO CODE 3
call code --profile "Obsidian like" --uninstall-extension angelCastro.clear-unused-images
call code --profile "Obsidian like" --install-extension clear-unused-images-0.1.0.vsix

cd ..\obsidianlike_calendar
call npm run package
ECHO CODE 4
call code --profile "Obsidian like" --uninstall-extension angelCastro.obsidianlike-calendar
call code --profile "Obsidian like" --install-extension obsidianlike-calendar-0.0.1.vsix

cd ..\obsidianlike_search
call npm run package
ECHO CODE 5
call code --profile "Obsidian like" --uninstall-extension angelCastro.obsidianlike-search
call code --profile "Obsidian like" --install-extension obsidianlike-search-0.0.1.vsix

cd ..\obsidianlike_dataview
call npm run package
ECHO CODE 6
call code --profile "Obsidian like" --uninstall-extension angelCastro.obsidianlike-dataview
call code --profile "Obsidian like" --install-extension obsidianlike-dataview-0.1.0.vsix

cd ..\obsidianlike_dbfolder
call npm run package
ECHO CODE 7
call code --profile "Obsidian like" --uninstall-extension angelCastro.obsidianlike-dbfolder
call code --profile "Obsidian like" --install-extension obsidianlike-dbfolder-0.1.0.vsix

cd ..\obsidianlike
ECHO Matas
taskkill /IM code.exe /F
call code "C:\Users\Angel\Dropbox\Bóvedas\Finanzas" --profile "Obsidian like"