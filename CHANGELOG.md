# Changelog

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
