/**
 * FCNPilot runs as one shared workspace. The stable UUID keeps the existing
 * UID-scoped storage layout usable without exposing registration or login.
 */
export const SHARED_ACCOUNT_UID = "00000000-0000-4000-8000-000000000000";
export const SHARED_ACCOUNT_USERNAME = "shared";

export const SHARED_ACCOUNT_IDENTITY = {
  uid: SHARED_ACCOUNT_UID,
  username: SHARED_ACCOUNT_USERNAME,
} as const;
