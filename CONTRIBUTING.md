# Contributing

Use Node.js 22 or newer. Run `npm ci`, then `npm start` to open the app at
http://localhost:3000. Before opening a pull request, run:

```sh
npm run check
npm test
```

Explain the player-visible change and how you checked it. For visual changes,
include screenshots at desktop and phone sizes. For simulation changes, add a
regression test that exercises the rule or bug being changed. Keep the server
responsible for cell behavior, tissue changes, resource budgets, and round state;
clients send input and render snapshots. Biological rules live in `bone.js`.

The game is a qualitative model of direct bone repair and remodeling.
Distinguish game balance from biological claims, and provide sources if
introducing scientific explanations.

Please keep secrets and machine-specific files out of commits. Report security
issues privately to the repository maintainer rather than posting sensitive
exploit details in a public issue.
