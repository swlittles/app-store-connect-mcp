# Changelog

## 0.4.0

- Optional Apple Ads keyword research through the Apple Ads Platform API: `ads_status`, `keyword_popularity`, `search_term_trends` and `keyword_suggestions`.
  - All read-only. They're offered when the `ADS_*` variables are set, and work without App Store Connect credentials.
  - `keyword_popularity` with `app` scores your keyword field and flags keywords that repeat words already in your name or subtitle.
  - OAuth tokens are cached and refreshed. Rate limits are respected through `Retry-After` and `RateLimit-*`. The ad account is found automatically.
  - Setup guide: `docs/apple-ads-key.md`.

- Fix: `update_age_rating` with `fill_unanswered` now also answers `messagingAndChat`, which Apple requires. Before this, Apple rejected the update with HTTP 409. The submission pre-flight counts it too (22 required questions).

### Fixes from a full review

Auto-update:
- A failed `npm ci` (offline, registry down) no longer leaves the install unable to start. The previous `node_modules` is kept aside and put back.
- An update interrupted part-way (agent closed, Ctrl-C) is finished on the next start instead of being reported as up to date.
- Works when the agent starts the server with a minimal `PATH`, as desktop apps do.
- A lock left by a crashed update no longer blocks updates for 10 minutes, and a tag deleted on GitHub is no longer followed.

TestFlight and builds:
- Without `platform`, build lookups prefer the iOS build when a Mac build has the same number or is newer.
- A build ID that belongs to a different app is refused instead of being distributed to this app's groups.
- A failed `upload_build` discards its attempt, so running it again works straight away instead of waiting an hour.
- Apps whose name is all digits can be found by name, and "no builds" messages name the version or platform filter that matched nothing.
- `get_app_status` shows open review submissions even when Apple lists old ones first.

Listing, screenshots and review:
- `replace_screenshot` on a full set: if the new image fails after the old one was deleted, re-running puts it in the old slot instead of replacing a second screenshot.
- `submit_for_review` can be re-run after it failed at the last step (the version was left in a draft submission), and `cancel_review_submission` can clear such a draft.
- `update_age_rating` sends every answer, as Apple requires, not just the changed ones.
- The submission pre-flight only counts screenshots Apple has processed, and only says "already submitted" when this version is in the submission.
- `reply_to_review` with `replace` no longer deletes the old reply first: Apple overwrites it, so a failed post keeps the old reply.
- Finance reports default to region `Z1` for `FINANCE_DETAIL`, which only accepts that.
- Subscription groups with more than 50 subscriptions, and territories with more than 10 price entries, are read in full.

Apple Ads:
- `search_term_trends` defaults to the latest week or month Apple has published, and rejects dates that don't exist.
- Retries after a server error back off normally instead of waiting for the rate-limit window.
- Keyword-field terms with doubled spaces are matched correctly.

Core:
- A collection with more than 100 pages is reported as an error instead of being returned partially.

## 0.3.0

- Automatic updates. A cloned install checks GitHub for a new release on start (at most every 30 minutes), installs it in the background, and uses it from the next start.
  - It only fast-forwards clean clones and leaves development copies alone.
  - If an install or build fails, it rolls back and doesn't retry that version.
  - `ASC_AUTO_UPDATE=0` turns it off. `ASC_UPDATE_CHANNEL=main` follows unreleased code.
- `--update` updates now; `--check` shows the version and last update result.
- The agent is told when the server was just updated, or when an update failed.

## 0.2.0

- `ASC_TOOLS` and `ASC_DISABLED_TOOLS` choose which tools the server offers, by tool name or by group (`read`, `testflight`, `listing`, `screenshots`, `release`, `subscriptions`, `reviews`, `raw`, `destructive`, `all`). An unknown entry makes every tool refuse to run, so a typo can't leave one switched on.
- `--check` reports which tools are on.

## 0.1.0

First release. Install it from GitHub; it isn't published to npm.

- Read tools: `list_apps`, `get_app_status`, `list_builds`, `get_build`, `list_beta_groups`, `list_testers`, `get_listing`, `list_screenshots`, `list_subscriptions`, `get_reviews`, `download_report`.
- Workflow tools: `upload_build` (build upload API or altool), `distribute_build`, `create_beta_group`, `invite_testers`, `remove_testers`, `update_listing`, `set_whats_new`, `update_age_rating`, `upload_screenshots`, `replace_screenshot`, `reorder_screenshots`, `delete_screenshots`, `prepare_version`, `set_review_details`, `submit_for_review`, `cancel_review_submission`, `remove_intro_offers`, `add_free_trial`, `reply_to_review`.
- `asc_request` escape hatch: GET only unless `ASC_WRITE=1`; DELETE needs `confirm: true`.
- Read-only by default; destructive tools dry-run by default.
- Types generated from App Store Connect API spec 4.5.
- Tested against a real App Store Connect account, which turned up these fixes:
  - Xcode's placeholder build uploads are ignored.
  - What's New on a first version gets a clear explanation.
  - The age rating questionnaire is answered all at once (`fill_unanswered`).
  - Editing App Review details needs a complete contact.
  - Fields are cleared with `null`.
  - Tester lists use a single relationship filter.
  - Rejected screenshot uploads are removed and reported as errors.
