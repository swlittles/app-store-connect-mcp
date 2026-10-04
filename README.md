# App Store Connect MCP

An [MCP](https://modelcontextprotocol.io) server that lets coding agents (Claude Code, Cursor, Codex and others) manage your apps in App Store Connect: TestFlight builds and testers, the store listing, screenshots, subscriptions, App Review submission, customer reviews and sales reports.

Apple doesn't ship an MCP server for App Store Connect. Xcode's `xcrun mcpbridge` covers building, testing and previews, not App Store Connect. Most community servers expose one tool per REST endpoint and leave the agent to chain them correctly. This one is built differently:

- **Workflows as tools.** "Ship this build to these groups with these notes" is one call, and so is "replace screenshot 3". The server handles the ordering, the waiting and the edge cases that agents get wrong.
- **Safe by default.** The server is read-only until you set `ASC_WRITE=1`. Anything destructive is a dry run until the agent confirms it, and the docs recommend a least-privilege API key.
- **Reliable.** Every step checks the current state first, so you can re-run a tool after a timeout or a dropped connection. Tools poll Apple's asynchronous processing, back off on rate limits, and return errors that say what to do next.

> **Status: 0.1.** Every tool is tested against an in-memory App Store Connect that checks each request against Apple's OpenAPI spec (v4.5). The workflows have also been run against a real App Store Connect account on a sandbox app: build upload through the API, distribution, groups and testers, listing edits, the whole screenshot lifecycle (including a full set of 10 and an image Apple rejects), version prep and the review pre-flight. Submitting to App Review and Beta App Review was only dry-run, because those send the app to Apple. Please report anything that behaves differently for you.

## Quick start

**1. Create an API key with the App Manager role.** In [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api), go to **Users and Access > Integrations > App Store Connect API > Team Keys** and generate a key with **App Manager** access. Never use Admin. Download the `.p8` file (Apple only lets you download it once), and note the **Key ID** and the **Issuer ID**. The full walkthrough, including where to keep the key, is in [docs/api-key.md](docs/api-key.md).

**2. Download and build it.** You need [Node.js](https://nodejs.org) 20 or later and git.

```sh
git clone https://github.com/swlittles/app-store-connect-mcp.git ~/app-store-connect-mcp
cd ~/app-store-connect-mcp
npm ci                 # installs the exact locked dependencies and builds dist/index.js
```

You can clone it anywhere. The examples below assume `~/app-store-connect-mcp`.

**3. Check the key:**

```sh
ASC_KEY_ID=YOUR_KEY_ID ASC_ISSUER_ID=YOUR_ISSUER_ID ASC_KEY_PATH=~/.appstoreconnect/AuthKey_YOUR_KEY_ID.p8 \
  node ~/app-store-connect-mcp/dist/index.js --check
```

It lists the apps the key can see.

**4. Add it to your agent.** Point the agent at `dist/index.js`, using absolute paths.

Claude Code:

```sh
claude mcp add asc --scope user \
  -e ASC_KEY_ID=YOUR_KEY_ID \
  -e ASC_ISSUER_ID=YOUR_ISSUER_ID \
  -e ASC_KEY_PATH=$HOME/.appstoreconnect/AuthKey_YOUR_KEY_ID.p8 \
  -- node $HOME/app-store-connect-mcp/dist/index.js
```

Add `-e ASC_WRITE=1` when you want the agent to make changes, and `-e ASC_APP_ID=com.example.app` to set a default app.

Cursor (`~/.cursor/mcp.json`) and other clients that use the `mcpServers` JSON format:

```json
{
  "mcpServers": {
    "asc": {
      "command": "node",
      "args": ["/Users/you/app-store-connect-mcp/dist/index.js"],
      "env": {
        "ASC_KEY_ID": "YOUR_KEY_ID",
        "ASC_ISSUER_ID": "YOUR_ISSUER_ID",
        "ASC_KEY_PATH": "/Users/you/.appstoreconnect/AuthKey_YOUR_KEY_ID.p8"
      }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.asc]
command = "node"
args = ["/Users/you/app-store-connect-mcp/dist/index.js"]
env = { ASC_KEY_ID = "YOUR_KEY_ID", ASC_ISSUER_ID = "YOUR_ISSUER_ID", ASC_KEY_PATH = "/Users/you/.appstoreconnect/AuthKey_YOUR_KEY_ID.p8" }
```

**Updates are automatic.** Each time your agent starts the server, the server checks GitHub for a newer release (at most every 30 minutes) and installs it in the background. The update is used from the next time the agent starts the server; the running server isn't interrupted. See [Updates](#updates).

**Trying it without cloning:** `npx -y github:swlittles/app-store-connect-mcp --check` (with the same environment variables) downloads and builds it in npm's cache. That's fine for a quick try. For everyday use, clone it: npx rebuilds on first launch, which can be slower than an agent waits for a server to start.

This project is distributed only through GitHub. It isn't published to npm, so a package with this name on npm isn't this project.

Then ask for things in plain language:

- "What's the status of my app? Is the latest build ready for testers?"
- "Ship build 202610041200 to the Friends and Public Beta groups with the notes 'New daily puzzles, please try the hint button'."
- "Replace the third iPhone screenshot with ~/Desktop/shot-3.png."
- "Upload everything in ./fastlane/screenshots/en-US/iphone as the 6.9-inch iPhone screenshots."
- "Remove the free trial from the yearly subscription in every country."
- "Reply to this week's 1-star reviews."
- "Create version 1.2, attach the latest build, update What's New, and show me what's missing before we submit."

## Configuration

| Variable | |
| --- | --- |
| `ASC_KEY_ID` | API key ID. Required. |
| `ASC_ISSUER_ID` | Issuer ID for team keys. Leave it unset for an individual key, which signs with `sub: "user"`. |
| `ASC_KEY_PATH` | Path to the `.p8` file. `~` is expanded. |
| `ASC_KEY` | The PEM contents instead of a path. Literal `\n` sequences are accepted. |
| `ASC_WRITE` | `1` allows changes. Without it the server is read-only, and write tools only return plans. |
| `ASC_APP_ID` | Default app, as an app ID, bundle ID or exact name. If it's unset and the key can see only one app, that app is used. |
| `ASC_VENDOR_NUMBER` | Vendor number for `download_report` (shown in Payments and Financial Reports). |
| `ASC_TOOLS` | Only offer these tools or groups. Default: all. See [Turning tools off](#turning-tools-off). |
| `ASC_DISABLED_TOOLS` | Never offer these tools or groups. |
| `ASC_AUTO_UPDATE` | `0` turns off automatic updates. On by default. |
| `ADS_CLIENT_ID`, `ADS_TEAM_ID`, `ADS_KEY_ID`, `ADS_KEY_PATH` (or `ADS_KEY`), `ADS_AD_ACCOUNT_ID` | Optional Apple Ads credentials for keyword research. See [Keyword research with Apple Ads](#keyword-research-with-apple-ads-optional). |
| `ASC_UPDATE_CHANNEL` | `release` (default) follows GitHub releases; `main` follows the newest code on the main branch, including unreleased changes. |

The key is only used to sign tokens. The server never logs it or puts it in tool output or error messages, and it only sends tokens to `api.appstoreconnect.apple.com`. That host is fixed and can't be overridden.

If the configuration is incomplete, the server still starts, and every tool returns an error explaining what's missing. Your client won't just show "failed to connect".

## Keyword research with Apple Ads (optional)

To help pick the words for your 100-character keyword field, the server can read Apple's App Store search popularity data through the [Apple Ads Platform API](https://developer.apple.com/documentation/apple-ads-platform-api). It only reads: nothing here creates campaigns or spends money. Set it up with [docs/apple-ads-key.md](docs/apple-ads-key.md). The tools appear once the `ADS_*` variables are set, and they work without `ASC_WRITE`.

| Tool | What it does |
| --- | --- |
| `ads_status` | Checks the connection: org, ad accounts, roles, and the account the tools use. |
| `keyword_popularity` | Apple's 0-100 popularity for phrases you name, or for phrases containing some text. With `app`, it scores your current keyword field and flags keywords that repeat words already in your name or subtitle, which Apple indexes anyway. |
| `search_term_trends` | The most-searched terms in a genre and country, weekly or monthly, with rank and popularity. Only covers roughly the top 500 terms per genre and country. |
| `keyword_suggestions` | Apple's keyword ideas for an app, most popular first. Generally needs an app that's live on the App Store. |

They're in the `ads` group, so `ASC_DISABLED_TOOLS=ads` hides them.

## Updates

Clones of this repository update themselves:

- **When:** on each server start, the server checks GitHub at most every 30 minutes. It does this in the background after starting, so the agent never waits on it.
- **What:** with the default `release` channel, the newest version tag (`v0.3.0`, `v0.4.0`, …). With `ASC_UPDATE_CHANNEL=main`, the newest commit on `main`.
- **How:** `git fetch`, then switch to the new version. Then it rebuilds, which takes seconds and works offline. `npm ci` runs instead when dependencies changed. The new version is used from the next start.
- **Safe to leave on:**
  - It only moves forward to the newer version, and never touches a copy with local edits or its own commits, such as a development clone.
  - If installing or building fails, it switches back to the previous version and rebuilds it. It won't retry the failed version until a newer one is published.
  - Two servers starting at once can't both update; one waits for the next check.
- **Check status:** `node ~/app-store-connect-mcp/dist/index.js --check` prints the version and the last update result.
- **Update now:** `node ~/app-store-connect-mcp/dist/index.js --update`.
- **Turn it off or pin a version:** set `ASC_AUTO_UPDATE=0`, then pick a version yourself, for example `git checkout v0.3.0 && npm ci`.

Copies installed before v0.3.0 don't have the updater yet. Update those once by hand: `cd ~/app-store-connect-mcp && git checkout -- package-lock.json && git fetch --tags && git checkout v0.3.0 && npm ci`.

## Turning tools off

There's no settings screen: the server runs in the background of your agent app. Choose its tools with two environment variables, set in the same place as the key:

- `ASC_TOOLS` is an allowlist. Only the tools listed are offered. Without it, every tool is offered.
- `ASC_DISABLED_TOOLS` is a denylist. It's applied after `ASC_TOOLS`.

Both take tool names and group names, separated by commas or spaces. Turned-off tools aren't shown to the agent at all, so it can't call them.

| Group | Tools |
| --- | --- |
| `read` | Every read-only tool: `list_apps`, `get_app_status`, `list_builds`, `get_build`, `list_beta_groups`, `list_testers`, `get_listing`, `list_screenshots`, `list_subscriptions`, `get_reviews`, `download_report` |
| `testflight` | `upload_build`, `distribute_build`, `create_beta_group`, `invite_testers`, `remove_testers` |
| `listing` | `update_listing`, `set_whats_new`, `update_age_rating` |
| `screenshots` | `upload_screenshots`, `replace_screenshot`, `reorder_screenshots`, `delete_screenshots` |
| `release` | `prepare_version`, `set_review_details`, `submit_for_review`, `cancel_review_submission` |
| `subscriptions` | `remove_intro_offers`, `add_free_trial` |
| `reviews` | `reply_to_review` |
| `raw` | `asc_request` |
| `ads` | `ads_status`, `keyword_popularity`, `search_term_trends`, `keyword_suggestions` (offered only when Apple Ads is configured; also in `read`) |
| `destructive` | Everything that deletes or can't be taken back: `remove_testers`, `upload_screenshots`, `replace_screenshot`, `delete_screenshots`, `submit_for_review`, `cancel_review_submission`, `remove_intro_offers`, `reply_to_review`, `asc_request` |
| `all` | Everything |

Examples:

```sh
-e ASC_TOOLS=read                                 # look, never touch
-e ASC_TOOLS=read,testflight                      # TestFlight only, plus reading
-e ASC_DISABLED_TOOLS=destructive                 # everything except deleting and submitting
-e ASC_DISABLED_TOOLS=submit_for_review,raw       # no App Review submissions, no raw API calls
```

If an entry isn't a known tool or group, every tool refuses to run until it's fixed. That way a typo in `ASC_DISABLED_TOOLS` can't leave a tool switched on. `--check` prints which tools are on.

`ASC_WRITE` still applies on top: without it, even enabled write tools only return dry-run plans. Your agent app may also let you block tools; for example, Claude Code's `permissions.deny` takes names like `mcp__asc__submit_for_review`.

## Tools

Tools take an `app` argument, which can be an app ID, a bundle ID or a name. Results are short, readable text that includes the IDs a follow-up call needs.

**Read** (always available):

| Tool | What it does |
| --- | --- |
| `list_apps` | Apps the key can see, with IDs, bundle IDs and SKUs. |
| `get_app_status` | One-call overview: versions and their states, the attached build, the latest builds and their TestFlight states, uploads still processing, and review submissions. |
| `list_builds` | Recent builds with processing and TestFlight states. |
| `get_build` | One build: compliance, beta review, groups, What to Test, App Store version. Use `wait_minutes` to wait for processing. |
| `list_beta_groups` | TestFlight groups: internal or external, public link, tester count. |
| `list_testers` | Testers of an app or a group, with status and groups. |
| `get_listing` | Name, subtitle, categories, age rating, localized description, keywords, promotional text, What's New and URLs (with character counts), and App Review details. |
| `list_screenshots` | Screenshot sets in display order, with positions, sizes, states and IDs. |
| `list_subscriptions` | Subscription groups, subscriptions, price in a territory, introductory offers summarized across territories, and in-app purchases. |
| `get_reviews` | Customer reviews with your replies. |
| `download_report` | Sales or finance report: unzipped, totaled, optionally saved as TSV. |

**Workflows** (these change things, so they need `ASC_WRITE=1`; any of them can be called with `dry_run: true` to see the plan):

| Tool | Writes | What it does |
| --- | --- | --- |
| `upload_build` | yes | Uploads an `.ipa`/`.pkg` through Apple's build upload API, or with `xcrun altool`. |
| `distribute_build` | yes | Waits for processing, answers export compliance (if you say how), sets What to Test, adds the build to groups, and submits for beta review when an external group needs it. |
| `create_beta_group` | yes | Creates a group (or returns the existing one with that name), optionally with a public link. |
| `invite_testers` | yes | Invites new testers and adds existing ones to a group; people who were already invited elsewhere aren't an error. |
| `remove_testers` | destructive | Removes testers from a group or from the app. |
| `update_listing` | yes | Edits localized metadata, categories and game subcategories, showing old → new for each field and changing only what differs. |
| `set_whats_new` | yes | App Store "What's New" or TestFlight "What to Test". |
| `update_age_rating` | yes | Changes answers in the age rating questionnaire. |
| `upload_screenshots` | destructive | Makes a screenshot set match a folder or list of files (`replace`), or appends to it (`append`). |
| `replace_screenshot` | destructive | Replaces one screenshot (by position or ID), without a gap in the listing. |
| `reorder_screenshots` | yes | Reorders a set. |
| `delete_screenshots` | destructive | Deletes screenshots by position or ID. |
| `prepare_version` | yes | Creates or renames the version being prepared, attaches a build, sets the release type. |
| `set_review_details` | yes | App Review contact, demo account and notes. The password is never echoed back. |
| `submit_for_review` | destructive | Pre-flight checks, then submits through `reviewSubmissions`. |
| `cancel_review_submission` | destructive | Withdraws an active submission. |
| `remove_intro_offers` | destructive | Bulk-deletes introductory offers (e.g. a free trial) across territories. |
| `add_free_trial` | yes | Bulk-adds a free trial in every territory that lacks an introductory offer. |
| `reply_to_review` | destructive | Publishes a public reply to a customer review; `replace: true` changes an existing one. |

**Escape hatch:** `asc_request(method, path, query, body)` calls any App Store Connect endpoint. GET works in read-only mode. POST, PATCH and DELETE need `ASC_WRITE=1`, and DELETE also needs `confirm: true`.

## How it stays safe

- **Read-only by default.** Without `ASC_WRITE=1`, write tools refuse to change anything, but they still return a plan if called with `dry_run: true`.
- **Destructive means dry run first.** Tools that delete things (screenshots, offers, testers) or can't be taken back (submitting for review) default to `dry_run: true`. The agent gets the plan, shows it to you, and calls again with `dry_run: false`. The tools carry MCP `destructiveHint` and `readOnlyHint` annotations, so clients can ask before running them.
- **Order that never leaves a gap.** When `replace_screenshot` replaces an image, it uploads the new one, waits until Apple has processed it, puts it in place, and only then deletes the old one. If Apple rejects the image, nothing in the live listing changes. The one exception is a full set of 10. Apple won't allow an 11th screenshot even briefly, so the old one has to be deleted first, and the dry run says so.
- **Least privilege.** See below.

## Choosing a key role

Use **App Manager** unless you have a reason not to. Step-by-step instructions are in [docs/api-key.md](docs/api-key.md).


| Role | Enough for |
| --- | --- |
| **App Manager** | Everything here except sales and finance reports. Recommended. |
| **Marketing** | Listing metadata and screenshots, if that's all the agent should touch. |
| **Customer Support** | Reading and replying to customer reviews. |
| **Finance** or **Sales** | `download_report`. |
| **Admin** | Never needed. Don't use it: an Admin key can manage users and other keys. |

If a tool needs more access than the key has, the error says so. Keep keys out of repositories: store the `.p8` somewhere like `~/.appstoreconnect/` with `chmod 600`, and revoke any key you think has leaked under Users and Access.

## Long-running jobs

Apple processes builds (usually 5 to 30 minutes) and images (usually seconds) asynchronously. Tools that wait take `wait_minutes`, and they send MCP progress notifications while they wait. When time runs out, they don't fail. They return a status such as "still processing; run distribute_build again with the same arguments". Re-running is always safe:

- `distribute_build` skips groups the build is already in, notes that already match, and beta reviews already submitted. It treats Apple's "already submitted" response as success.
- Screenshot tools match files to existing screenshots by MD5, so an image uploaded by an interrupted run isn't uploaded again. Each delete, reorder and commit is its own request. If a step fails partway, the error lists the steps that finished and gives the exact call that finishes the job. For `replace_screenshot`, that call includes the `screenshot_id`, because positions can shift between runs. Leftovers from broken uploads never block a set; replacing or uploading to it cleans them up.
- Bulk jobs (`remove_intro_offers`, `add_free_trial`, `invite_testers`) keep going past individual failures and report what succeeded, what failed and what wasn't tried. They stop early when the hourly rate limit (about 3,600 requests per key) runs low. Running them again finishes the job.

HTTP retries: the server retries GETs, PATCHes and DELETEs on 5xx errors and connection resets, with jittered exponential backoff. It retries POSTs only when Apple says the request didn't happen (429 or 503), because a reset POST may have gone through. It honors `Retry-After` and refreshes the token once on a 401.

## Uploading builds

`upload_build` uploads an exported `.ipa`. Make one with:

```sh
xcodebuild archive -scheme MyApp -archivePath build/MyApp.xcarchive -destination 'generic/platform=iOS'
xcodebuild -exportArchive -archivePath build/MyApp.xcarchive -exportPath build -exportOptionsPlist ExportOptions.plist
```

The `ExportOptions.plist` needs `method` set to `app-store-connect` and `destination` set to `export`. (With `destination` set to `upload`, Xcode uploads the build itself, and you can skip `upload_build`.)

- `method: "api"` (the default) uses App Store Connect's build upload API (`buildUploads` and `buildUploadFiles`, added in API 4.1). It needs no Xcode, so it works on Linux CI too.
- `method: "altool"` runs `xcrun altool --upload-app` with the same API key, on a Mac.

`xcodebuild -exportArchive` registers a placeholder upload with App Store Connect even when it only exports. `upload_build` recognizes these placeholders and ignores them.

Every upload needs a new, higher `CFBundleVersion`. A timestamp such as `YYYYMMDDHHMM` works well. Add `ITSAppUsesNonExemptEncryption = NO` to Info.plist if it applies to your app, and TestFlight will never ask about export compliance.

## Apple's rules worth knowing

These came up when testing against the real API. The tools handle each one, but they explain why a change is refused:

- **What's New** can't be set on an app's first version.
- The **age rating questionnaire** starts with every answer empty, and Apple won't accept any change until all 21 questions are answered. `update_age_rating` with `fill_unanswered: true` answers the rest NONE/false. Check those answers with whoever owns the app.
- Once **App Review details** exist, every edit needs the full contact: first and last name, email, and phone with `+` and the country code.
- Fields are cleared with `null`, not an empty string. Pass `""` to the tools, and they send `null`.
- Apple reports a wrong-size screenshot only as `ASSET_FAILED`, so the tools check image sizes before uploading. They also delete the rejected upload, so it doesn't take up one of the set's 10 slots.
- External testers aren't emailed until a build passes Beta App Review.

## What the API can't do

These still need the App Store Connect website. This list was checked against API spec 4.5:

- **The App Privacy questionnaire** ("nutrition labels"). The public API has no endpoints for it.
- **Creating a new app record.** `POST /v1/apps` doesn't exist. Create the app on the website, then manage it from here.
- **Agreements, tax and banking**, including accepting updated Paid Apps agreements. When an agreement is missing, API calls fail with an error that this server explains.
- **Export compliance documentation** for apps that use non-exempt encryption.
- **Paid introductory offers**, which need a price point per territory. This server only covers free trials, so use `asc_request` for paid offers. App pricing, Game Center and in-app purchase editing are also in the API but not wrapped yet; `asc_request` reaches them.

## Development

```sh
npm install
npm test               # unit and workflow tests against a spec-checked fake App Store Connect
npm run typecheck
npm run build          # dist/index.js
```

**API types** are generated from Apple's OpenAPI spec, which is pinned in `spec/openapi.oas.json.gz`. Its version and SHA-256 are in `spec/VERSION.json`.

- `npm run spec:update` downloads the latest spec from Apple and regenerates the types in `src/generated/asc-api.ts`.
- `npm run spec:generate` regenerates the types from the pinned spec.

Only the schemas listed in `scripts/spec-schemas.json` (and what they reference) are generated.

**Tests** run against `test/helpers/fake-asc.ts`, an in-memory App Store Connect. It supports JSON:API includes, filters, sorting, pagination, relationship endpoints and fault injection (connection resets, 409s, 429s). It also checks every request's path, method and query parameters against the pinned spec, so a typo in an endpoint fails a test. All fixture data is synthetic.

`scripts/call-tool.mjs` calls one tool on the built server over stdio, which is handy against a real account:

```sh
npm run build && node scripts/call-tool.mjs get_app_status '{"app": "com.example.app"}'
```

**Live tests** are opt-in. They run against a real account, ideally a sandbox app:

```sh
ASC_LIVE_TEST=1 ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=… ASC_LIVE_APP_ID=… npm run test:live
```

They're read-only and dry runs unless you also set `ASC_WRITE=1` and `ASC_LIVE_WRITE=1`. Then they also set and restore the promotional text of the live version.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Apple. App Store Connect and TestFlight are trademarks of Apple Inc.
