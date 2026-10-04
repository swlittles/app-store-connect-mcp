// Friendly names for the generated App Store Connect schemas (src/generated/asc-api.ts).
import type { components } from "../generated/asc-api.js";
import type { Resource } from "./client.js";

type Schemas = components["schemas"];
type AttributesOf<K extends keyof Schemas> = Schemas[K] extends { attributes?: infer A } ? NonNullable<A> : never;

export type AppAttributes = AttributesOf<"App">;
export type AppInfoAttributes = AttributesOf<"AppInfo">;
export type AppInfoLocalizationAttributes = AttributesOf<"AppInfoLocalization">;
export type AgeRatingDeclarationAttributes = AttributesOf<"AgeRatingDeclaration">;
export type AppScreenshotAttributes = AttributesOf<"AppScreenshot">;
export type AppScreenshotSetAttributes = AttributesOf<"AppScreenshotSet">;
export type AppStoreReviewDetailAttributes = AttributesOf<"AppStoreReviewDetail">;
export type AppStoreVersionAttributes = AttributesOf<"AppStoreVersion">;
export type AppStoreVersionLocalizationAttributes = AttributesOf<"AppStoreVersionLocalization">;
export type BetaAppReviewSubmissionAttributes = AttributesOf<"BetaAppReviewSubmission">;
export type BetaBuildLocalizationAttributes = AttributesOf<"BetaBuildLocalization">;
export type BetaGroupAttributes = AttributesOf<"BetaGroup">;
export type BetaTesterAttributes = AttributesOf<"BetaTester">;
export type BuildAttributes = AttributesOf<"Build">;
export type BuildBetaDetailAttributes = AttributesOf<"BuildBetaDetail">;
export type BuildUploadAttributes = AttributesOf<"BuildUpload">;
export type BuildUploadFileAttributes = AttributesOf<"BuildUploadFile">;
export type CustomerReviewAttributes = AttributesOf<"CustomerReview">;
export type CustomerReviewResponseAttributes = AttributesOf<"CustomerReviewResponseV1">;
export type InAppPurchaseAttributes = AttributesOf<"InAppPurchaseV2">;
export type PrereleaseVersionAttributes = AttributesOf<"PrereleaseVersion">;
export type ReviewSubmissionAttributes = AttributesOf<"ReviewSubmission">;
export type ReviewSubmissionItemAttributes = AttributesOf<"ReviewSubmissionItem">;
export type SubscriptionAttributes = AttributesOf<"Subscription">;
export type SubscriptionGroupAttributes = AttributesOf<"SubscriptionGroup">;
export type SubscriptionIntroductoryOfferAttributes = AttributesOf<"SubscriptionIntroductoryOffer">;
export type SubscriptionLocalizationAttributes = AttributesOf<"SubscriptionLocalization">;
export type SubscriptionPriceAttributes = AttributesOf<"SubscriptionPrice">;
export type SubscriptionPricePointAttributes = AttributesOf<"SubscriptionPricePoint">;

export type ScreenshotDisplayType = Schemas["ScreenshotDisplayType"];
export type Platform = Schemas["Platform"];
export type UploadOperation = Schemas["DeliveryFileUploadOperation"];
export type AppMediaAssetState = Schemas["AppMediaAssetState"];

export type AppResource = Resource<AppAttributes>;
export type BuildResource = Resource<BuildAttributes>;
export type BetaGroupResource = Resource<BetaGroupAttributes>;
export type BetaTesterResource = Resource<BetaTesterAttributes>;
export type AppStoreVersionResource = Resource<AppStoreVersionAttributes>;
export type ScreenshotResource = Resource<AppScreenshotAttributes>;
export type ScreenshotSetResource = Resource<AppScreenshotSetAttributes>;

/** Every display type Apple accepts, from the spec, for input validation. */
export const SCREENSHOT_DISPLAY_TYPES = [
  "APP_IPHONE_67",
  "APP_IPHONE_61",
  "APP_IPHONE_65",
  "APP_IPHONE_58",
  "APP_IPHONE_55",
  "APP_IPHONE_47",
  "APP_IPHONE_40",
  "APP_IPHONE_35",
  "APP_IPAD_PRO_3GEN_129",
  "APP_IPAD_PRO_3GEN_11",
  "APP_IPAD_PRO_129",
  "APP_IPAD_105",
  "APP_IPAD_97",
  "APP_DESKTOP",
  "APP_WATCH_ULTRA",
  "APP_WATCH_SERIES_10",
  "APP_WATCH_SERIES_7",
  "APP_WATCH_SERIES_4",
  "APP_WATCH_SERIES_3",
  "APP_APPLE_TV",
  "APP_APPLE_VISION_PRO",
  "IMESSAGE_APP_IPHONE_67",
  "IMESSAGE_APP_IPHONE_61",
  "IMESSAGE_APP_IPHONE_65",
  "IMESSAGE_APP_IPHONE_58",
  "IMESSAGE_APP_IPHONE_55",
  "IMESSAGE_APP_IPHONE_47",
  "IMESSAGE_APP_IPHONE_40",
  "IMESSAGE_APP_IPAD_PRO_3GEN_129",
  "IMESSAGE_APP_IPAD_PRO_3GEN_11",
  "IMESSAGE_APP_IPAD_PRO_129",
  "IMESSAGE_APP_IPAD_105",
  "IMESSAGE_APP_IPAD_97",
] as const satisfies readonly ScreenshotDisplayType[];

// Compile-time check that the list above covers the spec's enum exactly.
type MissingDisplayTypes = Exclude<ScreenshotDisplayType, (typeof SCREENSHOT_DISPLAY_TYPES)[number]>;
const displayTypesComplete: MissingDisplayTypes extends never ? true : MissingDisplayTypes = true;
void displayTypesComplete;

export const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const satisfies readonly Platform[];
