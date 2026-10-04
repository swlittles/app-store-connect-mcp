import { ascRequest, getAppStatus, listApps } from "./apps.js";
import { distributeBuild, getBuild, listBuilds, uploadBuild } from "./builds.js";
import type { AnyTool } from "./framework.js";
import { getListing, setReviewDetails, setWhatsNew, updateAgeRating, updateListing } from "./listing.js";
import { downloadReport, getReviews, replyToReview } from "./reviews.js";
import { deleteScreenshots, listScreenshots, reorderScreenshots, replaceScreenshot, uploadScreenshots } from "./screenshots.js";
import { cancelReviewSubmission, prepareVersion, submitForReview } from "./submission.js";
import { addFreeTrial, listSubscriptionsTool, removeIntroOffers } from "./subscriptions.js";
import { createBetaGroup, inviteTesters, listBetaGroups, listTesters, removeTesters } from "./testers.js";

/** Every tool, in the order clients list them: reads first, then workflows, then the escape hatch. */
export const TOOLS: readonly AnyTool[] = [
  // Read
  listApps,
  getAppStatus,
  listBuilds,
  getBuild,
  listBetaGroups,
  listTesters,
  getListing,
  listScreenshots,
  listSubscriptionsTool,
  getReviews,
  downloadReport,
  // TestFlight
  uploadBuild,
  distributeBuild,
  createBetaGroup,
  inviteTesters,
  removeTesters,
  // Store listing
  updateListing,
  setWhatsNew,
  updateAgeRating,
  uploadScreenshots,
  replaceScreenshot,
  reorderScreenshots,
  deleteScreenshots,
  // Release
  prepareVersion,
  setReviewDetails,
  submitForReview,
  cancelReviewSubmission,
  // Subscriptions and reviews
  removeIntroOffers,
  addFreeTrial,
  replyToReview,
  // Escape hatch
  ascRequest,
];
