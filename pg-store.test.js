import { test } from "node:test";
import assert from "node:assert/strict";
import { isSeatConflict } from "../src/db/pg-store.js";

/* The error mapping is the adapter's one piece of real logic, and it is
   testable without a database. Everything else is SQL the contract covers. */

test("a unique violation on a seat index is a seat conflict", () => {
  assert.equal(isSeatConflict({ code: "23505", constraint: "seat_held_unique" }), true);
  assert.equal(isSeatConflict({ code: "23505", constraint: "seat_confirmed_unique" }), true);
});

test("an unrelated unique violation is not swallowed as a seat conflict", () => {
  // A duplicate locator must surface as an internal error, not as "seat taken".
  assert.equal(isSeatConflict({ code: "23505", constraint: "booking_locator_key" }), false);
});

test("other database errors pass through untouched", () => {
  for (const err of [null, undefined, {}, { code: "23503" }, { code: "40001" }, new Error("boom")]) {
    assert.equal(isSeatConflict(err), false);
  }
});
