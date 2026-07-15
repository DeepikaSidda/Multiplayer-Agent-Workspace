import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";

import { ARTIFACT_TEXT_KEY } from "./ArtifactService.js";

/**
 * Property 17 — Concurrent edits converge and preserve every committed edit.
 *
 * The ArtifactService wraps a per-workspace `Y.Doc` whose collaborative content
 * lives in a `Y.Text` under {@link ARTIFACT_TEXT_KEY}. Convergence is the
 * foundational Yjs CRDT guarantee the service leans on: no matter how concurrent
 * edits are interleaved or in what order peers exchange their updates, every
 * replica ends at byte-identical content that still contains every committed
 * edit. This property exercises that guarantee directly at the Yjs level using
 * the exact `Y.Text` key the service uses.
 *
 * Test strategy:
 *  - Spin up N replica `Y.Doc`s (2..4), each editing the shared text key.
 *  - Apply a batch of *concurrent* edits: each edit inserts a UNIQUE single
 *    code point (so it can never be split by a later insertion) into one
 *    replica, before any updates are exchanged — so cross-replica edits are
 *    genuinely concurrent.
 *  - Exchange every replica's state with every other replica in an ARBITRARY
 *    permutation of deliveries (the interleaving under test).
 *  - Assert convergence (all replicas identical) and completeness (every unique
 *    committed marker survives, and the total length equals the edit count).
 */

// Each edit targets a replica and picks a relative insertion position.
interface EditSpec {
  readonly replicaSel: number;
  readonly posRatio: number;
}

const editArb: fc.Arbitrary<EditSpec> = fc.record({
  replicaSel: fc.nat(),
  posRatio: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
});

// Up to 4 replicas => at most 4*3 = 12 ordered delivery pairs. A fixed-length
// key vector lets us derive an arbitrary permutation of those deliveries.
const MAX_REPLICAS = 4;
const MAX_DELIVERIES = MAX_REPLICAS * (MAX_REPLICAS - 1);

/** A unique, unsplittable single-code-unit marker for the edit at `index`. */
function markerFor(index: number): string {
  // Circled-number block onward: all BMP, single UTF-16 units, printable, and
  // distinct per edit index (well beyond the 30-edit cap used here).
  return String.fromCodePoint(0x2460 + index);
}

describe("Artifact CRDT convergence (Yjs)", () => {
  // Feature: multiplayer-agent-workspace, Property 17: Concurrent edits converge and preserve every committed edit
  it("converges to identical content containing every committed edit under any interleaving", () => {
    // **Validates: Requirements 6.7**
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: MAX_REPLICAS }),
        fc.array(editArb, { minLength: 1, maxLength: 30 }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), {
          minLength: MAX_DELIVERIES,
          maxLength: MAX_DELIVERIES,
        }),
        (replicaCount, edits, orderSeed) => {
          const replicas = Array.from({ length: replicaCount }, () => new Y.Doc());
          try {
            // --- Concurrent local edits (no exchange yet) ------------------
            const markers: string[] = [];
            edits.forEach((edit, index) => {
              const marker = markerFor(index);
              markers.push(marker);

              const doc = replicas[edit.replicaSel % replicaCount];
              const text = doc.getText(ARTIFACT_TEXT_KEY);
              // Clamp an arbitrary relative position into [0, length].
              const pos = Math.min(text.length, Math.floor(edit.posRatio * (text.length + 1)));
              text.insert(pos, marker);
            });

            // Snapshot each replica's committed edits before any exchange.
            const snapshots = replicas.map((doc) => Y.encodeStateAsUpdate(doc));

            // --- Arbitrary interleaving of full pairwise exchange ----------
            const deliveries: Array<[number, number]> = [];
            for (let target = 0; target < replicaCount; target++) {
              for (let source = 0; source < replicaCount; source++) {
                if (target !== source) deliveries.push([target, source]);
              }
            }
            // Permute deliveries by the generated key vector: this is the
            // "any interleaving / any delivery order" under test.
            deliveries
              .map((pair, i) => ({ pair, key: orderSeed[i] }))
              .sort((a, b) => a.key - b.key)
              .forEach(({ pair: [target, source] }) => {
                Y.applyUpdate(replicas[target], snapshots[source]);
              });

            // --- Convergence -----------------------------------------------
            const contents = replicas.map((doc) => doc.getText(ARTIFACT_TEXT_KEY).toString());
            for (const content of contents) {
              expect(content).toBe(contents[0]);
            }

            // --- Completeness: every committed edit is preserved -----------
            const converged = contents[0];
            for (const marker of markers) {
              expect(converged.includes(marker)).toBe(true);
            }
            // No insertions were dropped or merged: one code unit per edit.
            expect(converged.length).toBe(edits.length);
          } finally {
            replicas.forEach((doc) => doc.destroy());
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
