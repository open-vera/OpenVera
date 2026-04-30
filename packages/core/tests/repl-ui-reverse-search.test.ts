import { describe, expect, it } from "vitest";
import {
  acceptReverseSearch,
  emptyReverseSearch,
  moveReverseSearchSelection,
  reverseSearchMatches,
  startReverseSearch,
  updateReverseSearchQuery,
} from "../src/repl/ui/state/reverseSearch.js";

describe("reverseSearch", () => {
  it("matches history from newest to oldest", () => {
    expect(reverseSearchMatches(["alpha", "beta", "alphabet"], "alp")).toEqual(["alphabet", "alpha"]);
    expect(reverseSearchMatches(["alpha", "beta"], "")).toEqual(["beta", "alpha"]);
  });

  it("updates query and selection", () => {
    const state = updateReverseSearchQuery(startReverseSearch("a"), "be");
    expect(state).toEqual({ active: true, query: "be", selectedIndex: 0 });

    const moved = moveReverseSearchSelection(startReverseSearch("a"), ["alpha", "beta", "alphabet"], 1);
    expect(moved.selectedIndex).toBe(1);
    expect(acceptReverseSearch(moved, ["alpha", "beta", "alphabet"])).toBe("beta");
  });

  it("has an inactive empty state", () => {
    expect(emptyReverseSearch()).toEqual({ active: false, query: "", selectedIndex: 0 });
  });
});
