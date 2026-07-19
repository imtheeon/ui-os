@echo off
pushd \\wsl.localhost\Ubuntu-24.04\home\urcapsule\ui-os

echo === typecheck %DATE% %TIME% === > tc_output.txt

REM Run tsc directly via node (avoids the .bin symlink issue)
node node_modules\typescript\bin\tsc --noEmit >> tc_output.txt 2>&1
set TC=%ERRORLEVEL%
echo TC_EXIT:%TC% >> tc_output.txt

if %TC%==0 (
    echo === typecheck PASSED - running git === >> tc_output.txt
    wsl git -C /home/urcapsule/ui-os add -A >> tc_output.txt 2>&1
    wsl git -C /home/urcapsule/ui-os commit -m "fix: resolveOrgFromSession uses profiles table; middleware hardcoded fallbacks" >> tc_output.txt 2>&1
    wsl git -C /home/urcapsule/ui-os push origin main >> tc_output.txt 2>&1
) else (
    echo === typecheck FAILED === >> tc_output.txt
)
echo === DONE === >> tc_output.txt
popd
