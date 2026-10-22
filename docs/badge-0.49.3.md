# 0.49.3: agenteconomy.report badge + Verified owner link

## Change
- Homepage footer (`worker/src/landing.js`): `<a href="https://agenteconomy.report/s/">` around
  `<img src="https://agenteconomy.report/s/api.402xagent.com.svg" width="180" height="20" loading="lazy" decoding="async" alt="Independently tracked by agenteconomy.report">`
  plus visible text "Independently tracked by agenteconomy.report" (shows even if the image fails). Fixed size = no layout shift. No grade commentary.
- /docs payment-status example (`worker/src/pages.js`), where our payTo `0x37cf…8674` is shown: "Verified owner" link to
  https://agenteconomy.report/api/claim/api.402xagent.com (JSON proof; claim API already returns claimed=true).
- VERSION 0.49.3 (lib.js, worker/package.json, server.json). Tests: new tests/badge_test.mjs (3); worker_test version assert bumped.
- Note: agenteconomy.report's owner block only appears after its rebuild ~9:56 PM PT 2026-10-22; the SVG currently returns empty, the visible text covers that.

## Deploy plan (not done in this change)
1. Tests: 178/178 (baseline 175 + 3).
2. Merge feat/0.49.3-badge to main after review.
3. `cd worker && npx wrangler deploy`; record the new version id.
4. Verify: `curl -s https://api.402xagent.com/health | jq .version` == 0.49.3; homepage HTML (Accept: text/html, 402xagent.com) contains the badge anchor; /docs contains "Verified owner".
5. After ~9:56 PM PT: badge SVG renders; claim JSON shows claimed=true.

## Rollback
`cd worker && npx wrangler rollback b4404f4b-59a1-428e-9e05-0625b54d2017` (0.49.2). No migrations, no KV/D1 changes.
