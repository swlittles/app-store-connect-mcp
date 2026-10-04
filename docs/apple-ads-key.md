# Setting up Apple Ads keyword research (optional)

The Apple Ads tools (`keyword_popularity`, `search_term_trends`, `keyword_suggestions` and `ads_status`) use Apple's search popularity data to help you choose keywords for your App Store listing. They only read data: they never create campaigns or spend money.

They use the [Apple Ads Platform API](https://developer.apple.com/documentation/apple-ads-platform-api), which needs its own credentials, separate from your App Store Connect key. Setup takes about ten minutes.

## 1. Get an Apple Ads account

Sign in at [ads.apple.com](https://ads.apple.com) and choose **Advanced**. If your organization has no account yet, create one. Creating the account doesn't charge you anything.

## 2. Invite an API user with the read-only role

1. Sign in as an account administrator: **Sign In > Advanced**.
2. Choose **Account Settings > User Management**, then **Invite Users**.
3. Enter the person's name and **Apple Account**, and pick the role **API Account Read Only**. That's enough for everything this server does, and it can't change campaigns or budgets.
4. Click **Send Invite**.

Each Apple Account gets one role per ad account. To keep your own admin access separate, invite a different Apple Account as the API user, for example a second email address you control.

## 3. Accept the invitation and create a key pair

1. Open the invitation email with the API user's Apple Account, then follow the link and enter the code.
2. On your computer, create a private key and extract its public key:

   ```sh
   mkdir -p ~/.appleads && chmod 700 ~/.appleads && cd ~/.appleads
   openssl ecparam -genkey -name prime256v1 -noout -out private-key.pem
   openssl ec -in private-key.pem -pubout -out public-key.pem
   chmod 600 private-key.pem
   ```

3. Signed in to Apple Ads as the **API user**, go to **Account Settings > API**. Paste the contents of `public-key.pem`, including the `BEGIN` and `END` lines, and click **Save**.
4. Apple then shows three values above the public key field. Copy them:

   ```
   clientId SEARCHADS.…
   teamId   SEARCHADS.…
   keyId    …
   ```

Keep `private-key.pem` private: never commit it or paste it anywhere. The public key is the only part Apple ever sees.

## 4. Add the credentials to the server

Add these environment variables to the same MCP server entry as your App Store Connect key:

| Variable | Value |
| --- | --- |
| `ADS_CLIENT_ID` | `clientId` from step 3 |
| `ADS_TEAM_ID` | `teamId` from step 3 |
| `ADS_KEY_ID` | `keyId` from step 3 |
| `ADS_KEY_PATH` | `~/.appleads/private-key.pem` (or `ADS_KEY` with the PEM contents) |
| `ADS_AD_ACCOUNT_ID` | Optional. Only needed if the API user can access more than one ad account. |

For Claude Code, edit the `asc` server's `env` in `~/.claude.json`, or re-add the server with the extra `-e ADS_…=…` options. Restart your agent afterwards.

## 5. Check it

Ask your agent to run `ads_status`. It should show your org, the ad account, and the API user's role. Then try `keyword_popularity` with a few phrases.

## Notes

- Apple doesn't document which storefront the phrase popularity scores describe. `search_term_trends` is per country.
- `search_term_trends` only covers roughly the top 500 search terms per genre and country.
- `keyword_suggestions` generally needs an app that's live on the App Store.
- If Apple refuses the credentials, check the three IDs, that the public key in Apple Ads matches `ADS_KEY_PATH`, and that the API user accepted the invitation.
- Apple's older Campaign Management API (v5) shuts down on 2027-01-26. This server uses the newer Platform API.
