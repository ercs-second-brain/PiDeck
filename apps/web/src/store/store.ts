/**
 * Live app state store (issue #13).
 *
 * Seam design: every UI component reads state exclusively through the
 * {@link BoardStore} interface — `subscribe()` + `getState()` — via
 * `useSyncExternalStore`, so no component knows where state comes from.
 *
 * Data source:
 * - REST bootstrap: project list; per-project kanban board, workers, and
 *   pull requests, fetched lazily when a board page mounts.
 * - WebSocket fan-out on `/api/ws`: `KanbanUpdateEvent`s (card moved,
 *   project updated, worker spawned / status changed) are applied to the
 *   current state as they arrive. Every payload is validated against the
 *   shared `wsServerEventSchema` before use.
 * - The socket reconnects with exponential backoff + jitter; while it is
 *   down a slow poll keeps the board roughly current.
 *
 * Kanban boards are **server-derived** (the daemon's `KanbanService` owns
 * column placement; the webapp renders what it returns).
 */

import { useSyncExternalStore } from "react";
import {
  terminalServerEventSchema,
  wsServerEventSchema,
  type KanbanBoard,
  type KanbanColumnSummary,
  type KanbanUpdateEvent,
  type NotificationEvent,
  type Project,
  type PullRequest,
  type TerminalServerEvent,
  type Worker,
} from "@pideck/shared";

import { apiGetKanban, apiListPullRequests, apiListProjects, apiListWorkers, errorMessage } from "../lib/api";
import { shareInFlight, type InFlight } from "../lib/in-flight";
import { nextBackoffMs } from "../lib/backoff";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/** WebSocket connection state of the store's daemon link (surfaced via the
 *  sidebar's daemon status; the kanban's live indicator was removed in
 *  issue #276). */
type ConnectionState = "connecting" | "online" | "offline";

export interface AppState {
  connection: ConnectionState;
  /** True once the initial project list fetch has completed (ok or failed). */
  loaded: boolean;
  /** Set when the project list fetch failed (daemon unreachable). */
  loadError: string | null;
  projects: Project[];
  /** Server-derived kanban board per project id. */
  boards: Record<string, KanbanBoard>;
  /** Worker list per project id. */
  workers: Record<string, Worker[]>;
  /** Pull requests per project id (card badges + diff links). */
  pullRequests: Record<string, PullRequest[]>;
}

export interface BoardStore {
  subscribe(listener: () => void): () => void;
  getState(): AppState;
  /** Fetches/refreshes one project's kanban, workers, and pull requests. */
  loadProject(projectId: string): Promise<void>;
  /** Refreshes the project list (and any already-loaded project data). */
  refresh(): Promise<void>;
  /** Seeds a just-registered project (issue #203): visible immediately, board load kicked. */
  upsertProject(project: Project): void;
}

const INITIAL_STATE: AppState = {
  connection: "connecting",
  loaded: false,
  loadError: null,
  projects: [],
  boards: {},
  workers: {},
  pullRequests: {},
};

/**
 * Terminal event types, derived from the schema so the /ws bridge (which owns
 * them) and this store cannot drift.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(
  terminalServerEventSchema.options.map((option) => option.shape.type.value),
);

function isTerminalEvent(event: { type: string }): event is TerminalServerEvent {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

// ---------------------------------------------------------------------------
// Pure event reduction — exported for unit tests
// ---------------------------------------------------------------------------

/** Insert-or-replace by id, immutably (the `project.updated` reducer and upsertProject). */
function upsertProjectList(projects: Project[], project: Project): Project[] {
  return projects.some((p) => p.id === project.id)
    ? projects.map((p) => (p.id === project.id ? project : p))
    : [...projects, project];
}

/** Applies one server `KanbanUpdateEvent` to the state, immutably. */
export function applyKanbanEvent(state: AppState, event: KanbanUpdateEvent): AppState {
  switch (event.type) {
    case "kanban.card.moved": {
      const board = state.boards[event.projectId];
      if (board === undefined) return state;
      const columns = board.columns.map((column: KanbanColumnSummary) => ({
        column: column.column,
        cards:
          column.column === event.to
            ? [...column.cards.filter((c) => c.id !== event.cardId), event.card]
            : column.cards.filter((c) => c.id !== event.cardId),
      }));
      return {
        ...state,
        boards: { ...state.boards, [event.projectId]: { ...board, columns, updatedAt: event.at } },
      };
    }
    case "project.updated":
      return { ...state, projects: upsertProjectList(state.projects, event.project) };
    case "worker.spawned": {
      const existing = state.workers[event.worker.projectId] ?? [];
      const workers = existing.some((w) => w.id === event.worker.id)
        ? existing.map((w) => (w.id === event.worker.id ? event.worker : w))
        : [...existing, event.worker];
      return { ...state, workers: { ...state.workers, [event.worker.projectId]: workers } };
    }
    case "worker.status.changed": {
      const existing = state.workers[event.projectId];
      if (existing === undefined || !existing.some((w) => w.id === event.workerId)) return state;
      const workers = existing.map((w) =>
        w.id === event.workerId ? { ...w, status: event.status, updatedAt: event.at } : w,
      );
      return { ...state, workers: { ...state.workers, [event.projectId]: workers } };
    }
  }
}

// ---------------------------------------------------------------------------
// Live store
// ---------------------------------------------------------------------------

/** Slow-poll interval while the websocket is down (or as a safety net). */
const POLL_INTERVAL_MS = 30_000;

/** Default WebSocket URL: same origin, kanban hub path. */
function defaultKanbanWsUrl(): string {
  const secure = window.location.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${window.location.host}/api/ws`;
}

class LiveBoardStore implements BoardStore {
  private listeners = new Set<() => void>();
  private state: AppState = INITIAL_STATE;
  private readonly loadedProjects = new Set<string>();
  /** Single-flight per project (#88): concurrent loads share one fetch round. */
  private readonly projectLoads: InFlight<void> = new Map();
  /** Single-flight refresh (#88): poll ticks, events, and retries share one. */
  private readonly refreshes: InFlight<void> = new Map();
  private ws: WebSocket | null = null;
  private wsAttempt = 0;
  private wsTimer: number | undefined;
  private pollTimer: number | undefined;
  /** Notification-event subscribers (#111; the Toasts surface). */
  private readonly notificationListeners = new Set<(event: NotificationEvent) => void>();
  private stopped = false;

  start(): void {
    this.refresh().catch(() => {});
    this.connectWs();
    this.pollTimer = window.setInterval(() => {
      void this.refresh().catch(() => {});
    }, POLL_INTERVAL_MS);
  }

  /** Stops timers/sockets — used only by tests. */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    if (this.wsTimer !== undefined) window.clearTimeout(this.wsTimer);
    this.ws?.close();
    this.ws = null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): AppState => this.state;

  async refresh(): Promise<void> {
    await shareInFlight(this.refreshes, "refresh", () => this.runRefresh());
  }

  /** One refresh round: project list, then reload every already-loaded project. */
  private async runRefresh(): Promise<void> {
    try {
      const projects = await apiListProjects();
      this.setState({ projects, loaded: true, loadError: null });
      for (const id of this.loadedProjects) {
        void this.loadProject(id).catch(() => {});
      }
    } catch (err) {
      this.setState({ loaded: true, loadError: errorMessage(err) });
    }
  }

  loadProject(projectId: string): Promise<void> {
    // Single-flight (#88): a poll reload, a board mount, and a websocket
    // event hitting the same project share one fetch round instead of
    // stacking three requests each per caller.
    return shareInFlight(this.projectLoads, projectId, () => this.runProjectLoad(projectId));
  }

  /**
   * Issue #203: a successful `POST /api/projects` used to leave this store's
   * project list stale until the next poll, so the freshly registered project
   * rendered as "not found". Seeds the project into the list immediately and
   * reuses the single-flight `loadProject` so the board data follows without
   * a refresh and without stacking duplicate fetches.
   */
  upsertProject(project: Project): void {
    this.setState({ projects: upsertProjectList(this.state.projects, project) });
    void this.loadProject(project.id).catch(() => {});
  }

  private async runProjectLoad(projectId: string): Promise<void> {
    const [board, workers, pullRequests] = await Promise.all([
      apiGetKanban(projectId),
      apiListWorkers(projectId),
      apiListPullRequests(projectId),
    ]);
    this.loadedProjects.add(projectId);
    this.setState({
      boards: { ...this.state.boards, [projectId]: board },
      workers: { ...this.state.workers, [projectId]: workers },
      pullRequests: { ...this.state.pullRequests, [projectId]: pullRequests },
    });
  }

  private setState(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  // --- WebSocket ----------------------------------------------------------

  private connectWs(): void {
    if (this.stopped) return;
    const ws = new WebSocket(defaultKanbanWsUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.wsAttempt = 0;
      this.setState({ connection: "online" });
    };
    ws.onmessage = (event) => this.onWsMessage(String(event.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.wsAttempt += 1;
      this.setState({ connection: "offline" });
      this.wsTimer = window.setTimeout(() => this.connectWs(), nextBackoffMs(this.wsAttempt));
    };
    ws.onerror = () => ws.close();
  }

  private onWsMessage(payload: string): void {
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    const parsed = wsServerEventSchema.safeParse(json);
    if (!parsed.success) return;
    const event = parsed.data;
    if (isTerminalEvent(event)) {
      return; // terminal events: the /ws bridge, not this store
    }
    // User notifications (issue #111) are not board state: they fan out to
    // subscribers (the toast surface) and never touch AppState.
    if (event.type === "notification.pr.merged") {
      for (const listener of this.notificationListeners) listener(event);
      return;
    }
    this.apply(event);
  }

  /**
   * Subscribes to user-notification events (issue #111); returns the
   * unsubscribe function. Ephemeral by design — events fire once over the
   * socket and are not replayed.
   */
  onNotification(listener: (event: NotificationEvent) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  /** Applies one kanban update event (exposed for tests). */
  apply(event: KanbanUpdateEvent): void {
    const next = applyKanbanEvent(this.state, event);
    if (next === this.state) return;
    this.state = next;
    if (event.type === "project.updated") void this.loadProject(event.project.id).catch(() => {});
    this.emit();
  }
}

function createBoardStore(): BoardStore & {
  apply(event: KanbanUpdateEvent): void;
  start(): void;
  stop(): void;
  onNotification(listener: (event: NotificationEvent) => void): () => void;
} {
  return new LiveBoardStore();
}

/**
 * Single app-wide store instance. Connection/REST side effects start only
 * in a browser context, so importing this module in node tests stays inert.
 */
export const boardStore = createBoardStore();

if (typeof window !== "undefined" && typeof WebSocket !== "undefined") {
  boardStore.start();
}

/** React binding — the only store API UI components are allowed to use. */
export function useAppState(): AppState {
  return useSyncExternalStore(boardStore.subscribe, boardStore.getState);
}
