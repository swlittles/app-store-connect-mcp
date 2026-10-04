# Security

## Reporting a vulnerability

Please report security problems privately through [GitHub's security advisories](https://github.com/swlittles/app-store-connect-mcp/security/advisories/new), not in public issues. Expect a reply within a week.

## How the server handles your key

- The `.p8` key is read once at startup, from `ASC_KEY_PATH` or `ASC_KEY`. It's used only to sign short-lived (19-minute) ES256 tokens.
- The key never appears in logs, tool results or error messages. Configuration errors name the variable at fault, never its contents.
- Tokens are only sent to `https://api.appstoreconnect.apple.com`, which is hard-coded. Pagination links that point anywhere else are refused. File uploads go to the presigned URLs Apple returns, without the token.
- `upload_build` with `method: "altool"` writes a temporary copy of the key, readable only by you, for `xcrun altool`, and deletes it when the upload finishes.
- The App Review demo password is never echoed back in tool output.

## Automatic updates

By default, installs update themselves to each new GitHub release of this repository, so you're trusting future releases the same way you trusted the one you installed. Releases are tagged from `main`, after CI passes. To review updates before they run, set `ASC_AUTO_UPDATE=0`, then update by checking out a tag yourself. The updater only talks to the `origin` remote you cloned from, and it never sends your key or any App Store Connect data anywhere.

## Recommendations

- Use a key with the **App Manager** role or narrower. Never use Admin.
- Keep `.p8` files out of repositories. This repository's `.gitignore` excludes `*.p8` and `*.pem`. Store the key with `chmod 600`.
- Leave `ASC_WRITE` unset unless you want the agent to make changes, and review dry-run plans before confirming destructive tools.
- Revoke a key in App Store Connect (Users and Access > Integrations) as soon as you suspect it leaked.

## Repository hygiene

Tests use synthetic data and a key generated fresh on each run. Never commit real keys, tester emails, vendor numbers or app IDs. Contributions with recorded fixtures must anonymize them.
