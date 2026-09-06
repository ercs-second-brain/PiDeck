/**
 * @agentskiss/web — placeholder module.
 *
 * The real web app (kanban board, browser tmux terminals, diff review) is
 * implemented in a later issue. This module only proves the workspace builds
 * and links against @agentskiss/shared.
 */

import { placeholder } from "@agentskiss/shared";

export const APP_NAME = "agentskiss-web";

export function describeApp(): string {
  return `${APP_NAME} placeholder (${placeholder()})`;
}
