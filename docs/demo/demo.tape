# Genera docs/demo/demo.gif:  vhs docs/demo/demo.tape   (desde la raíz del repo)
Output docs/demo/demo.gif

Set Shell "bash"
Set Theme "Dracula"
Set FontSize 17
Set Width 1200
Set Height 700
Set Padding 20
Set TypingSpeed 45ms
Set Framerate 20
Set PlaybackSpeed 1

Hide
Type "export PS1='$ ' DEMO_PAUSA_MS=1800 && clear"
Enter
Show

Sleep 600ms
Type "npm run demo --silent"
Sleep 400ms
Enter
Sleep 13s
Sleep 6s
