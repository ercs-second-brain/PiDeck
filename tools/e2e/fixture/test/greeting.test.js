import assert from "node:assert/strict";
import { test } from "node:test";
import { greeting } from "../src/greeting.js";

test("greeting uses the agreed wording", () => {
  assert.equal(greeting(), "Hello, PiDeck!");
});
