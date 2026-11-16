# Genera docs/demo/demo.gif:  vhs docs/demo/demo.tape   (desde la raíz del repo)
Output docs/demo/demo.gif
Output docs/demo/demo.mp4

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
Sleep 300ms

Type "npm run demo --silent"
Show
Sleep 400ms
Enter
Sleep 17s
Screenshot docs/demo/demo-final.png
Sleep 11s
