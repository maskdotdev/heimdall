import { type Static, Type } from "@sinclair/typebox";

export const Sha256Schema = Type.String({
  pattern: "^sha256:[a-f0-9]{64}$",
});
export type Sha256 = Static<typeof Sha256Schema>;

export const ContentHashSchema = Sha256Schema;
export type ContentHash = Sha256;
