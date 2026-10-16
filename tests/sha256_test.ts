// Tests for the synchronous SHA-256. The vectors come from FIPS 180-4 and from
// `shasum -a 256` for the longer and non-ASCII inputs.

import { assertEquals } from "@std/assert";
import { sha256Hex } from "../src/core/sha256.ts";

Deno.test("sha256 of the empty string", () => {
  assertEquals(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

Deno.test("sha256 of abc", () => {
  assertEquals(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("sha256 of a message that needs two blocks", () => {
  assertEquals(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

Deno.test("sha256 handles the padding boundaries at 55, 56, and 64 bytes", () => {
  assertEquals(
    sha256Hex("a".repeat(55)),
    "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
  );
  assertEquals(
    sha256Hex("a".repeat(56)),
    "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
  );
  assertEquals(
    sha256Hex("a".repeat(64)),
    "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
  );
  assertEquals(
    sha256Hex("a".repeat(1000)),
    "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
  );
});

Deno.test("sha256 hashes the UTF-8 bytes of non-ASCII text", () => {
  assertEquals(
    sha256Hex("é€😀"),
    "df9226927fd572c1ee66eec85de1bb139497614899f36e4e90474cb71f6ef9d0",
  );
});
