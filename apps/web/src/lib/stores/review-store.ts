import type { Finding, ReviewRun } from "@heimdall/contracts";
import { create } from "zustand";

type LoadState = "idle" | "submitting" | "complete" | "error";

type ReviewState = {
  error: string | null;
  findings: Finding[];
  reviewRun: ReviewRun | null;
  state: LoadState;
  url: string;
  resetForSubmit: () => void;
  setError: (error: string) => void;
  setReviewComplete: (reviewRun: ReviewRun, findings: Finding[]) => void;
  setUrl: (url: string) => void;
};

export const useReviewStore = create<ReviewState>((set) => ({
  error: null,
  findings: [],
  reviewRun: null,
  state: "idle",
  url: "",
  resetForSubmit: () =>
    set({
      error: null,
      findings: [],
      state: "submitting",
    }),
  setError: (error) =>
    set({
      error,
      state: "error",
    }),
  setReviewComplete: (reviewRun, findings) =>
    set({
      findings,
      reviewRun,
      state: "complete",
    }),
  setUrl: (url) => set({ url }),
}));
