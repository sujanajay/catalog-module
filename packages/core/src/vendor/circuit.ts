/**
 * M7-F2-R3 circuit breaker per route: it opens after `failures` failures within `windowMs`, then lets calls through
 * again (a probe) once `openMs` has passed; a success closes it, a failed probe opens it for another `openMs`.
 * The state is per worker process: an outage costs each instance at most one open window, and no database write
 * sits on the call path.
 */
export interface CircuitOptions { failures: number; windowMs: number; openMs: number; now: () => number }
export const CIRCUIT_DEFAULTS = {failures: 5, windowMs: 120_000, openMs: 60_000} as const;
interface Circuit { failures: number[]; openedAt: number | null }

export class CircuitBreakers {
  private readonly circuits = new Map<string, Circuit>();
  private readonly options: CircuitOptions;
  constructor(options: Partial<CircuitOptions> = {}) {
    this.options = {...CIRCUIT_DEFAULTS, now: Date.now, ...options};
  }
  private circuit(id: string): Circuit {
    let circuit = this.circuits.get(id);
    if (!circuit) { circuit = {failures: [], openedAt: null}; this.circuits.set(id, circuit); }
    return circuit;
  }
  /** False while the route's circuit is open; true when closed or when the open window has passed (a probe). */
  canCall(id: string): boolean {
    const {openedAt} = this.circuit(id);
    return openedAt === null || this.options.now() - openedAt >= this.options.openMs;
  }
  /** `open` while calls are refused, `probing` after the open window, else `closed`. */
  state(id: string): "closed" | "open" | "probing" {
    const {openedAt} = this.circuit(id);
    return openedAt === null ? "closed" : this.canCall(id) ? "probing" : "open";
  }
  success(id: string): void {
    const circuit = this.circuit(id);
    circuit.failures = []; circuit.openedAt = null;
  }
  failure(id: string): void {
    const circuit = this.circuit(id), now = this.options.now();
    if (circuit.openedAt !== null) { circuit.openedAt = now; return; }
    circuit.failures = [...circuit.failures.filter(at => now - at < this.options.windowMs), now];
    if (circuit.failures.length >= this.options.failures) { circuit.openedAt = now; circuit.failures = []; }
  }
}
