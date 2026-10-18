import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError } from '@mindlog/core';
import type { PdClient } from '@mindlog/multiraft';
import type { PdService } from '@mindlog/pd';
import { InProcessPdClient } from '@mindlog/pd';
import type { SimNetwork } from './sim-network.js';

/**
 * Lets simulated nodes reach the placement driver: a call goes to whichever PD
 * replica currently leads and is on the caller's side of any partition, as a
 * network call would. Checks that timestamps never go back, whoever served them.
 */
export class PdSwitchboard {
  readonly #services = new Map<bigint, PdService>();
  readonly #net: SimNetwork;
  readonly #violate: (what: string) => void;
  #lastTso = 0n;
  tsoCalls = 0;

  constructor(net: SimNetwork, violate: (what: string) => void) {
    this.#net = net;
    this.#violate = violate;
  }

  /** A PD replica came up (or went down: pass `undefined`). */
  set(node: bigint, service: PdService | undefined): void {
    if (service) this.#services.set(node, service);
    else this.#services.delete(node);
  }

  /** What the PD leader last decided, for failure reports (no reads: the simulated world has stopped). */
  describe(): string {
    for (const [id, service] of this.#services) {
      if (!service.leading) continue;
      const plans = [...service.explanations()].map(([k, p]) => `${k}: ${p.explanation}`);
      return `PD leader n${id}\n  ${plans.join('\n  ')}`;
    }
    return 'no PD leader';
  }

  /** The PD client of `self`. */
  client(self: bigint): PdClient {
    const leader = (): PdService | undefined => {
      for (const [id, service] of this.#services)
        if (service.leading && this.#net.reachable(self, id)) return service;
      return undefined;
    };
    const unavailable = (): Result<never, MindlogError> =>
      err(mindlogError('NOT_LEADER', 'no placement driver leader is reachable'));
    const via = async <T>(
      call: (c: InProcessPdClient) => Promise<Result<T, MindlogError>>,
    ): Promise<Result<T, MindlogError>> => {
      const service = leader();
      return service ? call(new InProcessPdClient(service)) : unavailable();
    };
    return {
      allocIds: (n) => via((c) => c.allocIds(n)),
      tso: async (n) => {
        const r = await via((c) => c.tso(n));
        if (r.ok) {
          this.tsoCalls++;
          if (r.value <= this.#lastTso)
            this.#violate(`timestamp ${r.value} is not above the last one, ${this.#lastTso}`);
          this.#lastTso = r.value;
        }
        return r;
      },
      getRange: (key) => via((c) => c.getRange(key)),
      scanRanges: (start, limit) => via((c) => c.scanRanges(start, limit)),
      storeHeartbeat: (s) => via((c) => c.storeHeartbeat(s)),
      rangeHeartbeat: (s) => via((c) => c.rangeHeartbeat(s)),
    };
  }
}
