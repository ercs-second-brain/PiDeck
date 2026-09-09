import { wsServerEventSchema, type WsServerEvent } from "@pideck/shared";

/**
 * Parses one raw WebSocket frame into a validated `WsServerEvent`.
 * Returns `null` for non-JSON payloads and schema mismatches — both are
 * protocol noise the caller may silently drop.
 */
export function parseWsServerEvent(payload: string): WsServerEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = wsServerEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
