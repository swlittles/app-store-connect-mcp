# Creating an App Store Connect API key

The server signs every request with an App Store Connect API key. These steps take about two minutes.

## Use the App Manager role

Every API key has a role, and the role decides what the key, and so the agent, can do. **Choose App Manager.**

- **App Manager** covers everything this server does: TestFlight builds, groups and testers; the store listing and screenshots; versions and App Review submission; subscriptions; and replies to customer reviews.
- **Don't choose Admin.** An Admin key can also manage your team's users and other API keys, which this server never needs. If an Admin key leaked, someone could lock you out of your own account.
- Narrower roles work if you only want part of the server. **Marketing** covers listing metadata and screenshots, **Customer Support** covers customer reviews, and **Finance** or **Sales** covers `download_report`. App Manager can't download sales and finance reports, so create a second Finance or Sales key if you need those.

## Steps

You need to be the team's **Account Holder** or an **Admin** to create keys. The key itself should still be App Manager.

1. Sign in to [App Store Connect](https://appstoreconnect.apple.com). Keys aren't created on developer.apple.com.
2. Go to **Users and Access**, open the **Integrations** tab, and choose **App Store Connect API** in the sidebar. The direct link is <https://appstoreconnect.apple.com/access/integrations/api>.
3. Choose **Team Keys**.
   - The first time anyone on your team uses the API, App Store Connect shows **Request Access** instead. The Account Holder has to click it and accept the terms. Access is usually granted right away.
4. Click **Generate API Key** (or **+** if you already have keys).
   - **Name:** anything that tells you later what it's for, for example `MCP server`.
   - **Access:** **App Manager**.
5. Click **Generate**, then **Download** in the key's row. You get a file named `AuthKey_YOUR_KEY_ID.p8`.
   - **Apple only lets you download a key once.** If you lose the file, revoke the key and create a new one.
6. Copy two values from the same page:
   - the **Key ID**, shown in the key's row and in the file name
   - the **Issuer ID**, the UUID shown above the list of keys, with a **Copy** button
7. Move the key somewhere private, outside every project folder, so it can never be committed:

   ```sh
   mkdir -p ~/.appstoreconnect && chmod 700 ~/.appstoreconnect
   mv ~/Downloads/AuthKey_*.p8 ~/.appstoreconnect/
   chmod 600 ~/.appstoreconnect/AuthKey_*.p8
   ```

8. Check that it works:

   ```sh
   ASC_KEY_ID=YOUR_KEY_ID ASC_ISSUER_ID=YOUR_ISSUER_ID ASC_KEY_PATH=~/.appstoreconnect/AuthKey_YOUR_KEY_ID.p8 \
     npx -y app-store-connect-mcp --check
   ```

   It prints the apps the key can see and how many API requests are left this hour.

## Individual keys

App Store Connect also offers **Individual Keys**, which act as your own user account rather than a team role. They work too: set `ASC_KEY_ID` and `ASC_KEY_PATH`, and leave `ASC_ISSUER_ID` unset. Team keys with App Manager are still the better choice, because their access is limited to the role and doesn't change when your own permissions do.

## Keeping the key safe

- Never commit a `.p8` file or paste its contents into a chat, an issue or a config file in a repository. Point `ASC_KEY_PATH` at the file instead.
- The server never prints the key, and it only sends signed tokens to `api.appstoreconnect.apple.com`.
- Leave `ASC_WRITE` unset unless you want the agent to make changes.
- If a key might have leaked, revoke it straight away: open the same page, click the key, then **Revoke**. Then create a new one.
