export const FEEDBACK_REASONS = [
  "inaccurate",
  "incomplete",
  "irrelevant",
  "hard_to_understand",
  "citation_issue",
  "unsafe",
  "other",
] as const;

export type FeedbackRating = "up" | "down";
export type FeedbackReason = typeof FEEDBACK_REASONS[number];

export interface MessageFeedback {
  sessionId: string;
  entryId: string;
  rating: FeedbackRating;
  reasons: FeedbackReason[];
  comment?: string;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageFeedbackInput {
  rating: FeedbackRating;
  reasons?: FeedbackReason[];
  comment?: string;
  provider?: string;
  model?: string;
}
