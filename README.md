# owl-watch-simulator-mcp

[![npm](https://img.shields.io/npm/v/owl-watch-simulator-mcp)](https://www.npmjs.com/package/owl-watch-simulator-mcp)
[![test](https://github.com/duyatuan/owl-watch-simulator-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/duyatuan/owl-watch-simulator-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

**An [MCP](https://modelcontextprotocol.io) server for Garmin Connect IQ.** It lets an AI coding agent such as Claude Code, Cursor or GitHub Copilot build, run, see and drive Garmin watch apps written in Monkey C, in the Connect IQ simulator on macOS.

Use it to let an agent check its own UI changes, reproduce a bug from a description, or run the same flow on several watch models and compare the screens.

![An agent launches a Garmin Connect IQ transit app on a fēnix 8 in the simulator, sets the GPS position, waits for the stop, taps "Trains" by its label, opens a departure, then runs the same flow on a fēnix 7 and a Venu 3](https://raw.githubusercontent.com/duyatuan/owl-watch-simulator-mcp/main/docs/demo.gif)

*A real session with [Next Depart NSW](https://owleryworks.com.au/next-depart-nsw/), our Connect IQ app for NSW public transport departures.*

- **The screen as text.** A watch display has no element tree, so every result carries the text recognised on it with tap-ready positions, such as `"Trains" (129,140)`. `tap_text` presses by label; `wait_for` waits on what the screen says, not on sleeps.
- **One call, one round trip.** `run_app` builds, launches and returns the screen; every action returns the next one. `run_steps` runs a whole flow, and `run_on_devices` repeats it on several watches.
- **Out of your way.** The simulator works in the background, on another desktop, even with the screen locked. Input goes straight to its process, not through your pointer and keyboard.
- **Device pixels.** A screenshot is exactly the watch display, so the coordinates an agent reads off the picture are the ones it taps.

*Owl* is the OwleryWorks Library: open-source tools from [The Owlery Works](https://owleryworks.com.au/). Not affiliated with or endorsed by Garmin.

## Install

You need macOS 14 or later, Node.js 20 or later, the Connect IQ SDK with at least one device (from Garmin's SDK Manager), a Java runtime, a Connect IQ developer key and the Xcode Command Line Tools (`xcode-select --install`).

```sh
claude mcp add owl-watch-simulator -- npx -y owl-watch-simulator-mcp
npx -y owl-watch-simulator-mcp --doctor   # checks SDK, Java, key, helper and permissions
```

Claude Desktop, Cursor, Windsurf and most other clients take this JSON; VS Code (`.vscode/mcp.json`) takes the same entry under `servers` instead of `mcpServers`:

```json
{
  "mcpServers": {
    "owl-watch-simulator": { "command": "npx", "args": ["-y", "owl-watch-simulator-mcp"] }
  }
}
```

macOS asks for **Accessibility** (input, menus, dialogs) and **Screen & System Audio Recording** (screenshots), both for the app that launches the server: your terminal, IDE or Claude. Grant them in System Settings > Privacy & Security, then restart that app.

The SDK, Java and key are found automatically; override with `CIQ_SDK_HOME`, `CIQ_JAVA_HOME`, `CIQ_DEVELOPER_KEY` or `CIQ_DEVICES_DIR`. To let an agent run unattended in Claude Code, add `"permissions": { "allow": ["mcp__owl-watch-simulator"] }` to the project's `.claude/settings.json`.

## Tools

| Tool | What it does |
| --- | --- |
| `run_app` | build (or take a `.prg`), start the simulator if needed, launch, return the screen |
| `build_app`, `run_tests` | compile with errors by file and line; run unit tests |
| `screenshot` | the display with its text, the whole watch, or the simulator window |
| `tap_text`, `wait_for` | tap by label; wait for text to appear or disappear, or the screen to settle |
| `tap`, `long_press`, `swipe` | touch input in device pixels |
| `press_button` | physical buttons by function (`select`, `back`, `next`, `previous`, `menu`) or key id |
| `run_steps`, `run_on_devices` | a flow in one call; the same flow on several devices, one screen each |
| `get_logs` | `System.println` output, errors and crash reports |
| `set_position`, `list_menu`, `select_menu` | GPS position; simulator settings such as connectivity, language and battery |
| `inspect_dialogs`, `dialog_action`, `dialog_click`, `dialog_type` | answer the dialogs those settings open |
| `simulator_status`, `start_simulator`, `stop_simulator`, `stop_app`, `list_devices` | state, lifecycle and installed devices |

Errors come back with a code and a hint the agent can act on.

## Limits

- **macOS only.** Tested on macOS 27 on Apple silicon with a 2x Retina display.
- **Long presses move the pointer.** The simulator checks where the real pointer is during a hold, so `long_press` and held buttons park it on the target for about a second, then put it back.
- **The app ends when the server stops**, and Connect IQ runs one simulator at a time.
- **Text recognition is good, not perfect.** Curved titles and tiny glyphs can come out slightly wrong, so the picture is always returned too; icons need `tap` with coordinates.
- **Locked screen.** Dialog controls cannot be read, so dialogs are answered by clicking their picture, and system file panels cannot be answered at all; `dialog_click` refuses buttons that open one.
- **Undocumented macOS APIs** deliver clicks to a background window. They are looked up at run time, so a macOS that drops one gives a clear `unsupported_os` error.

| Symptom | Fix |
| --- | --- |
| `accessibility_denied`, `screen_recording_denied` | Grant the permission to the launching app and restart it |
| Screenshot shows the launcher icon | The app exited or crashed; see `get_logs` |
| `simulatorRestarted` in a `run_app` result | The simulator kept the previous device, so it was restarted; set the GPS position again |
| Web requests fail with -1001 | Untick Settings > Use Device HTTPS Requirements |
| `helper_build_failed` | Install the Xcode Command Line Tools, then `npm run build:native` |

## More

[CONTRIBUTING.md](CONTRIBUTING.md) covers running from a checkout, tests and how it works. Report security problems privately, as [SECURITY.md](SECURITY.md) describes.

Provided as is, without warranty of any kind. You use it at your own risk: The Owlery Works and the contributors accept no liability for anything it, or your AI agent with it, does to your Mac, simulator, projects or data. MIT licence. Connect IQ is a trademark of Garmin Ltd.
