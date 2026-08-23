# Ranked LeetCode

A 1v1 version of [LeetCode](https://leetcode.com).Send a challenge, get matched, and race
someone on the same problem. Python runs on your browser.

- Challenge lobby with quick match, or pick a problem by number, slug or URL
- Live spectating — watch both players type, run and submit
- Veto, rematch, and win–loss records tied to verified LeetCode usernames
- Judged on the problem's example tests, or on real LeetCode submissions if you connect them

## Running locally

```
npm start
```

Then open http://localhost:8080 in two tabs to test a match. `npm run dev` uses bundled
fixtures instead of LeetCode, and `npm test` runs the suites.

## Deploying on Director (TJHSST)

Pick a Node.js 18+ Alpine image with `git` added as a package, clone this repo into `/site`,
mark `run.sh` executable, and restart the site process. There are no dependencies to install.
To update: `git pull`, restart the process, hard-refresh.

## Linking a LeetCode account

Optional, and credential-free: you put a one-time code on your LeetCode profile and the
server checks it. That locks your display name to your username and starts your record.

Judging on real LeetCode submissions is a separate opt-in that needs your `LEETCODE_SESSION`
cookie, because LeetCode publishes no OAuth or submit API. It's encrypted at rest, never
shown again, and can be disconnected on its own.