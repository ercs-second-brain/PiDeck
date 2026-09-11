import { z } from "zod";
import { SessionViewSchema } from "./session.js";

export const SessionsChangedSchema = z.object({
  type: z.literal("sessions.changed"),
  projectId: z.string(),
  sessions: z.array(SessionViewSchema),
});
export type SessionsChanged = z.infer<typeof SessionsChangedSchema>;

export const TerminalAttachSchema = z.object({
  type: z.literal("terminal.attach"),
  sessionId: z.string(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});
export type TerminalAttach = z.infer<typeof TerminalAttachSchema>;

export const TerminalDataSchema = z.object({
  type: z.literal("terminal.data"),
  sessionId: z.string(),
  data: z.string(),
});
export type TerminalData = z.infer<typeof TerminalDataSchema>;

export const TerminalResizeSchema = z.object({
  type: z.literal("terminal.resize"),
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalResize = z.infer<typeof TerminalResizeSchema>;

export const TerminalDetachSchema = z.object({
  type: z.literal("terminal.detach"),
  sessionId: z.string(),
});
export type TerminalDetach = z.infer<typeof TerminalDetachSchema>;

export const WsClientMessageSchema = z.discriminatedUnion("type", [
  TerminalAttachSchema,
  TerminalDataSchema,
  TerminalResizeSchema,
  TerminalDetachSchema,
]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

export const WsServerMessageSchema = z.discriminatedUnion("type", [
  SessionsChangedSchema,
  TerminalDataSchema,
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
