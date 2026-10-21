/** A failed follow-up attachment must not make a committed write retryable. */
export type SaveFeedback = {
  message: string;
  type: "success" | "error";
  persisted: boolean;
};
