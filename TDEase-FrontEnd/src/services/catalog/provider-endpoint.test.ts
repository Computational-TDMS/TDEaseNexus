import { describe, expect, it } from "vitest";
import { getBaseUrlIssue, normalizeBaseUrlInput } from "./provider-endpoint";

describe("normalizeBaseUrlInput", () => {
  it.each([
    // Operation endpoints peel back to the service root the runtime wants.
    ["https://api.example.com/v1/chat/completions", "https://api.example.com/v1"],
    ["https://api.example.com/v1/messages", "https://api.example.com/v1"],
    ["https://api.example.com/v1/responses", "https://api.example.com/v1"],
    ["https://api.example.com/models", "https://api.example.com"],
    // Repeated/stacked suffixes and trailing slashes collapse in one pass.
    ["https://api.example.com/v1/chat/completions/", "https://api.example.com/v1"],
    ["https://api.example.com/v1/messages/messages", "https://api.example.com/v1"],
    // Suffix matching is case-insensitive; everything else stays verbatim.
    ["https://api.example.com/v1/Chat/Completions", "https://api.example.com/v1"],
    ["https://api.example.com/V1/models", "https://api.example.com/V1"],
    // Unknown paths, bare roots, and query-free roots pass through.
    ["https://api.example.com/v1", "https://api.example.com/v1"],
    ["https://api.example.com/conversations", "https://api.example.com/conversations"],
    ["https://api.example.com", "https://api.example.com"],
    // Peeling never eats the host: the whole suffix reaching the origin stays.
    ["https://api.example.com/models/models", "https://api.example.com"],
    // Whitespace and empties.
    ["  https://api.example.com/v1/messages  ", "https://api.example.com/v1"],
    ["", ""],
    ["   ", ""],
  ])("normalize %j → %j", (input, expected) => {
    expect(normalizeBaseUrlInput(input)).toBe(expected);
  });
});

describe("getBaseUrlIssue", () => {
  it.each([
    [null, "https://api.example.com/v1"],
    [null, "http://localhost:8080/api"],
    [null, ""],
    [null, "   "],
    ["scheme", "not a url"],
    ["scheme", "ftp://api.example.com"],
    ["scheme", "api.example.com/v1"],
    ["userinfo", "https://user:secret@api.example.com/v1"],
    ["userinfo", "https://user@api.example.com"],
    ["query", "https://api.example.com/v1?key=abc"],
    ["hash", "https://api.example.com/v1#section"],
  ])("issue(%j) → %j", (expected, input) => {
    expect(getBaseUrlIssue(input)).toBe(expected);
  });
});
