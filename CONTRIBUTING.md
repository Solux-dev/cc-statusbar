# Contributing

Thank you for being here. This is a small, one-person project, so the most
valuable thing you can send is not always code.

## The three things that help most

1. **A wrong number.** If the quota, context, cache or token-equivalent figure
   disagrees with reality, that is the bug worth reporting above all others —
   the whole point of this extension is that its numbers can be trusted. Say
   what it showed, what it should have shown, and how you know.
2. **A number that stopped appearing.** The quota endpoints are undocumented and
   Anthropic can change them without notice. If a reading goes blank, a report
   is often the first signal that something upstream moved.
3. **A translation that reads badly.** Every string exists in English and
   Russian. If one of them sounds like a machine wrote it, say so — a better
   sentence is a real contribution.

## Reporting a bug

Open an issue using the **Bug report** template. Please include the extension
version, your OS, and your editor (VS Code, Cursor, Windsurf, VSCodium…) — the
same code runs in all of them and they do not always behave alike.

Security problems go **privately** instead: see [SECURITY.md](SECURITY.md).

## Working on the code

```bash
npm install
npm run compile        # tsc -p ./
npm test               # node --test out/test/logic.test.js
npm run package        # produces cc-statusbar-<version>.vsix
```

Node 24 is what CI uses. TypeScript is the only dependency; there is no bundler,
no lint step and no test framework beyond Node's built-in `node:test`.

To try your build in a real editor:

```bash
npm run package
code --install-extension cc-statusbar-<version>.vsix
```

Then reload the window. The item appears at the right of the status bar.

## How this codebase is arranged

- **`src/metrics.ts`** — pure arithmetic: token counters, cache weights, pace
  levels. No I/O.
- **`src/render.ts`** — pure rendering: metrics in, status-bar text / hover
  markdown / panel HTML out. **No VS Code imports**, which is what makes the
  whole display layer unit-testable.
- **`src/extension.ts`** — the only file that talks to VS Code.
- **`src/i18n.ts`** — every user-visible string, EN and RU.
- **`src/test/logic.test.ts`** — one file, ~190 tests, all pure.

## What a pull request needs

- **A test.** If it changes behaviour, a test must fail without your change.
  The suite is pure logic, so this is usually easy: build the inputs, call the
  function, assert the output.
- **Both languages.** A new user-visible string is added to `EN` *and* `RU` in
  `src/i18n.ts`. TypeScript will not let you forget, but a machine-translated
  Russian sentence is worse than asking for help with it — ask.
- **Comments that say *why*, not *what*.** The code in this repo explains the
  reasoning behind a decision, especially where the obvious approach was tried
  and rejected. Please match that. `// increment i` is noise; `// ordering by
  recency would hide the biggest spender below the cut` is the reason someone
  will need in a year.
- **No new dependencies** without discussing it first. The extension reads
  credentials; every dependency added is a new party you are asking users to
  trust.
- **No telemetry, ever.** Not optional, not opt-in, not "anonymous".

## Things that are deliberate, not oversights

Please open an issue to discuss before changing these — each was decided on
purpose and the reasoning is written down in `docs/`:

- **No score, grade or efficiency verdict.** The extension reports; it does not
  judge how you work.
- **The collapsed status-bar item shows quota only.** Analytical numbers live in
  the hover and the panel.
- **No history or persistence** of past sessions.
- **A figure is never smoothed or guessed.** When a value is unknown it is shown
  as unknown, with the reason — an invented number is worse than a blank.

## Good first issues

Issues tagged [`good first issue`](https://github.com/Solux-dev/cc-statusbar/labels/good%20first%20issue)
are self-contained and do not require understanding the whole codebase. If one
is unclear, say so in the issue — that is useful feedback about the issue, not a
failing on your part.

## License

By contributing you agree that your work is released under this project's
[MIT license](LICENSE).
