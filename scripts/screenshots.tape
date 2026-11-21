# A tour of the demo (made-up sessions, no account needed), recorded with VHS: `npm run screenshots`.
# One run writes assets/demo.gif and the two README screenshots taken along the way (home, permission).

Output assets/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1400
Set Height 860
Set Padding 24
Set Theme "tokyonight"
Set WindowBar Colorful
Set Framerate 24
Set TypingSpeed 80ms

Hide
Type "clear && npx tsx scripts/demo.ts" Enter
Sleep 4s
Show

# The start screen: sessions on several machines, with what each one is doing.
Sleep 2.5s
Screenshot assets/home.png
# VHS saves the frame a moment later: keep the next key out of it.
Sleep 1s

# A finished turn offering reply choices: move the highlight to one and send it.
Type "rate"
Sleep 500ms
Enter
Sleep 2.5s
Down
Sleep 800ms
Down
Sleep 800ms
Up
Sleep 1s
Enter
Sleep 6s

# An agent at work on another machine: a turn in progress shows every tool, diffs included.
Ctrl+S
Sleep 1s
Type "arm64"
Sleep 500ms
Enter
Sleep 2s
Sleep 1.5s

# A permission request: allow it and the agent carries on.
Ctrl+S
Sleep 1s
Type "ranking"
Sleep 500ms
Enter
Sleep 2s
Screenshot assets/permission.png
Sleep 1s
Enter
Sleep 4s

# A question from the agent.
Ctrl+S
Sleep 1s
Type "dashboard"
Sleep 500ms
Enter
Sleep 2s
Down
Sleep 600ms
Enter
Sleep 4s

# Back to the start screen.
Ctrl+S
Sleep 3s

Hide
Ctrl+C
Ctrl+C
