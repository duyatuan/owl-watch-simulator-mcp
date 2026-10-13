# Contributing

Issues and pull requests are welcome.

`npm test` runs everything that needs no simulator, including the
simulator-side flows against a fake helper (`test/fixtures/fake-helper.mjs`).
A change to input, layout or dialogs should also pass `npm run test:live`
against a real simulator:

```sh
CIQ_MCP_LIVE=1 CIQ_MCP_LIVE_PRG=/path/app.prg CIQ_MCP_LIVE_DEVICE=fenix843mm npm run test:live
```

Please say which macOS release and display you ran it on.
