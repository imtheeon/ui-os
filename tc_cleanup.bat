@echo off
wsl git -C /home/urcapsule/ui-os rm --force tc_output.txt tc_push.bat tc_push.sh tc_cleanup.bat
wsl git -C /home/urcapsule/ui-os commit -m "chore: remove build helper scripts"
wsl git -C /home/urcapsule/ui-os push origin main
echo CLEANUP_EXIT:%ERRORLEVEL% > \\wsl.localhost\Ubuntu-24.04\home\urcapsule\ui-os\cleanup_result.txt
