# Contributing

Issues and pull requests are welcome.

## Running from a checkout

```sh
git clone https://github.com/duyatuan/owl-watch-simulator-mcp.git
cd owl-watch-simulator-mcp
npm install        # also compiles the native helper
npm run doctor
claude mcp add owl-watch-simulator -- node "$PWD/src/index.js"
```

## Tests

`npm test` runs everything that needs no simulator, including the
simulator-side flows against a fake helper (`test/fixtures/fake-helper.mjs`).
A change to input, layout or dialogs should also pass `npm run test:live`
against a real simulator. Please say which macOS release and display you ran
it on.

```sh
npm test                 # unit tests; no simulator needed
npm run check            # syntax check
npm run build:native     # recompile the helper
node scripts/call-tools.mjs run_app '{"prg":"/path/app.prg","device":"fenix7"}' tap '{"x":100,"y":100}'

# End to end against a real simulator:
CIQ_MCP_LIVE=1 CIQ_MCP_LIVE_PRG=/path/app.prg CIQ_MCP_LIVE_DEVICE=fenix843mm npm run test:live
```

`scripts/call-tools.mjs` starts the server and calls tools in order over real
MCP, saving returned images; with no arguments it lists the tools.

## How it works

The simulator's own remote interface (a TCP shell on port 1234) can push files
and start apps, and nothing else. There is no protocol for input or
screenshots. So the server combines three things:

1. **Garmin's tools for building and launching.** `monkeyc` builds; `monkeydo`
   pushes the app, starts it and relays its output. Using them unmodified keeps
   the server working across SDK releases.
2. **A small native helper** (`native/helper.swift`, compiled on install, kept
   running while the server runs) for everything the SDK cannot do:
   - *Text* comes from Apple's on-device Vision framework.
   - *Screenshots* read the simulator window's own contents through
     ScreenCaptureKit, with `screencapture` as a fallback (which cannot
     capture a covered or off-screen window).
   - *Input* is mouse events posted directly to the simulator process. A button
     press is a click on that button in the device picture, at the position the
     device's `simulator.json` gives.
   - *Menus and dialogs* use the macOS Accessibility API.
3. **Measurement instead of assumption.** The helper finds the device picture
   inside the window by matching it against the device's PNG, so title bar
   height and macOS version do not matter. If the window is too small it is
   enlarged.

While the screen is locked, macOS hides window contents from Accessibility, so
windows are found through the window server and dialogs are answered through
their picture (`dialog_click`, `dialog_type`) instead of their controls
(`dialog_action`). A sleeping display is woken before a capture; that shows the
lock screen and unlocks nothing.

Delivering a click to a background window relies on two things Apple does not
document: the `CGEventSetWindowLocation` function and the event field that
carries the window number. Finding windows on other desktops uses
`_AXUIElementCreateWithRemoteToken`. All three are looked up at run time, so a
macOS that removes one produces a clear `unsupported_os` error, not a crash.

## Layout

```text
src/index.js       entry point, --doctor
src/server.js      tool definitions
src/simulator.js   window, layout, screenshots, input, menus, dialogs
src/session.js     monkeydo process and its log buffer
src/build.js       monkeyc and diagnostics parsing
src/devices.js     device definitions and button resolution
src/text.js        matching and describing recognised screen text
src/sdk.js         SDK, Java and developer key discovery
src/helper.js      builds and runs the native helper
native/helper.swift
```
