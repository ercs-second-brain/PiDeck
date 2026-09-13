/**
 * The daemon REST surface the scenarios assert on. Only the endpoints the
 * e2e needs: status, sessions, and the two settings writes the runner makes
 * before seeding. The review token rides in the PUT body over loopback only
 * and is never echoed.
 */

export class Api {
  constructor(base) {
    this.base = base;
    this.pending = new Set();
  }

  /** Resolves once every in-flight call has settled — used before teardown. */
  async quiesce() {
    await Promise.allSettled([...this.pending]);
  }

  call(method, path, body) {
    // Every call is tracked from spawn to settle so the runner can await
    // stragglers before killing the daemon; an un-awaited call's rejection
    // is absorbed here instead of surfacing as an unhandled rejection.
    const call = this.settle(method, path, body);
    this.pending.add(call);
    call.catch(() => {}).finally(() => this.pending.delete(call));
    return call;
  }

  async settle(method, path, body) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const json = text === "" ? null : JSON.parse(text);
    if (!response.ok) {
      throw new Error(`${method} ${path} failed (${response.status}): ${json?.error ?? text}`);
    }
    return json;
  }

  async status() {
    return this.call("GET", "/api/status");
  }

  async sessions() {
    return this.call("GET", "/api/sessions");
  }

  async putReviewAccount(username, token) {
    return this.call("PUT", "/api/settings", { reviewAccount: { username, token } });
  }

  async putProjectSettings(projectId, patch) {
    return this.call("PUT", `/api/projects/${projectId}/settings`, patch);
  }

  async createProject(input) {
    return this.call("POST", "/api/projects", input);
  }
}
